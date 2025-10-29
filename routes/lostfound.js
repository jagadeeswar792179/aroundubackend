const express = require("express");
const router = express.Router();
const pool = require("../config/db"); // your Postgres pool
const auth = require("../middlewares/authMiddleware");
const generatePresignedUrl = require("../config/generatePresignedUrl");

// -----------------------------------
// GET /api/lostfound?filter=lost|found|my&page=1&limit=10
// -----------------------------------
router.get("/", auth, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const page = parseInt(req.query.page || "1", 10);
    const pageSize = parseInt(req.query.limit || "10", 10); // ← now dynamic
    const offset = (page - 1) * pageSize;
    const filter = (req.query.filter || "lost").toLowerCase();
    const requesterUniversity = req.user.university || null;

    let sql = `
      SELECT
        l.id,
        l.item_name,
        l.item_description,
        l.item_location,
        l.status,
        l.reported_by,
        COALESCE(NULLIF(l.reporter_name, ''), (u.first_name || ' ' || u.last_name)) AS reporter_name,
        l.reported_at,
        l.university,
        l.resolved_at,
        u.course,
        u.profile AS reporter_profile_key,
        (l.reported_by = $1) AS is_owner
      FROM lost_and_found l
      LEFT JOIN users u ON u.id = l.reported_by
      WHERE 1=1
    `;
    const params = [currentUserId];

    if (filter === "lost" || filter === "found") {
      params.push(filter);
      sql += ` AND l.status = $${params.length}`;
      if (requesterUniversity) {
        params.push(requesterUniversity);
        sql += ` AND l.university = $${params.length}`;
      }
    } else if (filter === "my") {
      params.push(currentUserId);
      sql += ` AND l.reported_by = $${params.length}`;
    }

    params.push(offset);
    params.push(pageSize);
    sql += ` ORDER BY l.reported_at DESC OFFSET $${
      params.length - 1
    }::bigint LIMIT $${params.length}::bigint`;

    const result = await pool.query(sql, params);
    const rows = result.rows;

    // Enrich with presigned avatar URL if profile is a key
    const enriched = await Promise.all(
      rows.map(async (r) => {
        let avatarUrl = null;
        if (r.reporter_profile_key) {
          try {
            avatarUrl = await generatePresignedUrl(r.reporter_profile_key);
          } catch {
            avatarUrl = null;
          }
        }
        return {
          id: r.id,
          item_name: r.item_name,
          item_description: r.item_description,
          item_location: r.item_location,
          status: r.status,
          reported_by: r.reported_by,
          reporter_name: r.reporter_name,
          reporter_profile_url: avatarUrl,
          reporter_course: r.course,
          reported_at: r.reported_at,
          university: r.university,
          resolved_at: r.resolved_at,
          is_owner: r.is_owner, // optional for frontend menu
        };
      })
    );

    res.json({ items: enriched });
  } catch (err) {
    console.error("❌ Failed to fetch lost & found items:", err);
    res.status(500).json({ error: "Failed to fetch lost & found items" });
  }
});

// -----------------------------------
// POST /api/lostfound  (Create)
// -----------------------------------
router.post("/", auth, async (req, res) => {
  try {
    const { item_name, item_description, item_location, status } = req.body;
    const reported_by = req.user.id;

    if (!item_name || !item_description || !item_location || !status) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const sql = `
      INSERT INTO lost_and_found
        (item_name, item_description, item_location, status, reported_by)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `;
    const result = await pool.query(sql, [
      item_name,
      item_description,
      item_location,
      status,
      reported_by,
    ]);

    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    console.error("❌ Failed to create lost & found item:", err);
    res.status(500).json({ error: "Failed to create item" });
  }
});

// -----------------------------------
// PATCH /api/lostfound/:id  (Edit)
// Only the owner can edit
// -----------------------------------
router.patch("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const me = req.user.id;
    const { item_name, item_description, item_location, status } = req.body;

    const owner = await pool.query(
      "SELECT reported_by FROM lost_and_found WHERE id=$1",
      [id]
    );
    if (!owner.rows[0]) return res.status(404).json({ error: "Not found" });
    if (owner.rows[0].reported_by !== me)
      return res.status(403).json({ error: "Forbidden" });

    const result = await pool.query(
      `UPDATE lost_and_found
       SET item_name=$1, item_description=$2, item_location=$3, status=$4
       WHERE id=$5
       RETURNING *`,
      [item_name, item_description, item_location, status, id]
    );

    res.json({ item: result.rows[0] });
  } catch (e) {
    console.error("❌ Failed to edit item:", e);
    res.status(500).json({ error: "Failed to edit item" });
  }
});

// -----------------------------------
// DELETE /api/lostfound/:id  (Delete)
// Only the owner can delete
// -----------------------------------
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const me = req.user.id;

    const owner = await pool.query(
      "SELECT reported_by FROM lost_and_found WHERE id=$1",
      [id]
    );
    if (!owner.rows[0]) return res.status(404).json({ error: "Not found" });
    if (owner.rows[0].reported_by !== me)
      return res.status(403).json({ error: "Forbidden" });

    await pool.query("DELETE FROM lost_and_found WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Failed to delete item:", e);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// -----------------------------------
// POST /api/lostfound/claim  (Claim item)
// Keeps your trigger-based flow
// -----------------------------------
router.post("/claim", auth, async (req, res) => {
  try {
    const { reported_item_id } = req.body;
    const claimed_person_id = req.user.id;

    if (!reported_item_id)
      return res.status(400).json({ error: "Item ID is required" });

    const sql = `
      INSERT INTO claims (reported_item_id, claimed_person_id)
      VALUES ($1,$2)
      RETURNING *
    `;
    const result = await pool.query(sql, [reported_item_id, claimed_person_id]);

    res.status(201).json({ claim: result.rows[0] });
  } catch (err) {
    console.error("❌ Failed to claim item:", err);
    res.status(500).json({ error: "Failed to claim item" });
  }
});

router.put("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const me = req.user.id;

    // Fetch item and verify ownership
    const find = await pool.query(
      "SELECT id, reported_by, status FROM lost_and_found WHERE id = $1",
      [id]
    );
    if (find.rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    const item = find.rows[0];
    if (item.reported_by !== me) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const {
      item_name,
      item_description,
      item_location,
      status, // optional; only allow 'lost' or 'found' (not 'claimed' manually)
    } = req.body || {};

    const allowedStatus = status
      ? ["lost", "found"].includes(String(status).toLowerCase())
        ? String(status).toLowerCase()
        : null
      : null;

    // Build dynamic update
    const sets = [];
    const vals = [];
    let idx = 1;

    if (item_name != null) {
      sets.push(`item_name = $${idx++}`);
      vals.push(item_name);
    }
    if (item_description != null) {
      sets.push(`item_description = $${idx++}`);
      vals.push(item_description);
    }
    if (item_location != null) {
      sets.push(`item_location = $${idx++}`);
      vals.push(item_location);
    }
    if (allowedStatus != null) {
      sets.push(`status = $${idx++}`);
      vals.push(allowedStatus);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    vals.push(id);

    const sql = `
      UPDATE lost_and_found
         SET ${sets.join(", ")}
       WHERE id = $${idx}
       RETURNING *
    `;
    const up = await pool.query(sql, vals);
    return res.json({ item: up.rows[0] });
  } catch (err) {
    console.error("❌ Failed to update lost & found item:", err);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// -----------------------------------
// DELETE /api/lostfound/:id
// Delete an item (owner-only)
// -----------------------------------
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const me = req.user.id;

    // owner check
    const find = await pool.query(
      "SELECT id, reported_by FROM lost_and_found WHERE id = $1",
      [id]
    );
    if (find.rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    if (find.rows[0].reported_by !== me) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await pool.query("DELETE FROM lost_and_found WHERE id = $1", [id]);
    return res.status(204).send();
  } catch (err) {
    console.error("❌ Failed to delete lost & found item:", err);
    res.status(500).json({ error: "Failed to delete item" });
  }
});
module.exports = router;

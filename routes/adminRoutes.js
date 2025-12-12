const express = require("express");
const router = express.Router();
const pool = require("../config/db");

router.get("/bug-reports", async (req, res) => {
  try {
    const q = `
      SELECT br.id,
             u.first_name || ' ' || u.last_name AS user,
             br.type,
             br.description,
             br.created_at
      FROM bug_reports br
      JOIN users u ON u.id = br.reporter_id
      ORDER BY br.created_at DESC
    `;

    const { rows } = await pool.query(q);
    return res.json(rows);
  } catch (err) {
    console.error("admin/bug-reports error:", err);
    return res.status(500).json({ error: "Failed to fetch bug reports" });
  }
});

router.get("/reported-users", async (req, res) => {
  try {
    const q = `
      SELECT ur.id,
             r.first_name || ' ' || r.last_name AS reporter,
             t.first_name || ' ' || t.last_name AS reported,
             ur.type,
             ur.reason,
             ur.created_at
      FROM user_reports ur
      JOIN users r ON r.id = ur.reporter_id
      JOIN users t ON t.id = ur.reported_user_id
      ORDER BY ur.created_at DESC
    `;

    const { rows } = await pool.query(q);
    return res.json(rows);
  } catch (err) {
    console.error("admin/reported-users error:", err);
    return res.status(500).json({ error: "Failed to fetch reported users" });
  }
});

router.get("/reported-posts", async (req, res) => {
  try {
    const q = `
      SELECT pr.id,
             u.first_name || ' ' || u.last_name AS reporter,
             pr.post_id,
             pr.type,
             pr.reason,
             pr.created_at
      FROM post_reports pr
      JOIN users u ON u.id = pr.reporter_id
      ORDER BY pr.created_at DESC
    `;

    const { rows } = await pool.query(q);
    return res.json(rows);
  } catch (err) {
    console.error("admin/reported-posts error:", err);
    return res.status(500).json({ error: "Failed to fetch reported posts" });
  }
});

router.get("/professors", async (req, res) => {
  try {
    const q = `
      SELECT id,
             first_name,
             last_name,
             email,
             verified,
             university,
             specialization,
             created_at
      FROM users
      WHERE user_type = 'professor'
      ORDER BY created_at DESC
    `;

    const { rows } = await pool.query(q);
    return res.json(rows);
  } catch (err) {
    console.error("admin/professors error:", err);
    return res.status(500).json({ error: "Failed to fetch professors" });
  }
});

router.patch("/professors/:id/verify", async (req, res) => {
  try {
    const professorId = req.params.id;

    const r = await pool.query(
      `
      UPDATE users
      SET verified = true
      WHERE id = $1 AND user_type = 'professor'
      RETURNING id
      `,
      [professorId]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ msg: "Professor not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("admin/verify-professor error:", err);
    return res.status(500).json({ error: "Failed to verify professor" });
  }
});

module.exports = router;

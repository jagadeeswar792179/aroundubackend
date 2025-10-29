// routes/profileViews.js
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const auth = require("../middlewares/authMiddleware"); // sets req.user.id
const generatePresignedUrl = require("../config/generatePresignedUrl");

// Helper: parse pagination query params
function parsePaging(q) {
  const page = Math.max(parseInt(q.page || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt(q.limit || "12", 10), 1), 200);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * POST /api/profile-views
 * Insert-only: always create a new profile_views row for each view.
 */
router.post("/", auth, async (req, res) => {
  try {
    const viewerId = req.user && req.user.id;
    const { target_id: targetId } = req.body;

    if (!viewerId) return res.status(401).json({ error: "Unauthorized" });
    if (!targetId) return res.status(400).json({ error: "target_id required" });
    if (viewerId === targetId) return res.status(204).send(); // optional: skip self-view

    const ip =
      (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() ||
      null;
    const userAgent = req.get("user-agent") || null;

    const insertSql = `
      INSERT INTO profile_views (viewer_id, target_id, ip, user_agent)
      VALUES ($1, $2, $3, $4)
      RETURNING id, created_at
    `;
    const { rows } = await pool.query(insertSql, [
      viewerId,
      targetId,
      ip,
      userAgent,
    ]);

    return res.status(201).json({
      id: rows[0].id,
      created_at: rows[0].created_at,
    });
  } catch (err) {
    console.error("profile-views insert error:", err);
    return res.status(500).json({ error: "internal" });
  }
});

/**
 * GET /api/profile-views/me
 * Unique viewers (one per viewer) with last_viewed_at, ordered newest first.
 * Query: ?page=1&limit=12
 */
router.get("/me", auth, async (req, res) => {
  try {
    const targetId = req.user.id;
    const { page, limit, offset } = parsePaging(req.query);

    const viewersSql = `
      SELECT 
        u.id, 
        u.first_name, 
        u.last_name, 
        u.profile AS profile_url,
        u.university,
        u.course,
        MAX(pv.created_at) AS last_viewed_at
      FROM profile_views pv
      JOIN users u ON u.id = pv.viewer_id
      WHERE pv.target_id = $1
      GROUP BY 
        u.id, u.first_name, u.last_name, u.profile, u.university, u.course
      ORDER BY last_viewed_at DESC
      LIMIT $2 OFFSET $3
    `;
    const viewersRes = await pool.query(viewersSql, [targetId, limit, offset]);

    // Direct presigning (no helper)
    const viewers = await Promise.all(
      viewersRes.rows.map(async (row) => {
        let signedUrl = row.profile_url;

        // Only presign if NOT an http/https URL and not null/empty
        if (
          typeof row.profile_url === "string" &&
          row.profile_url !== "" &&
          !row.profile_url.startsWith("http")
        ) {
          try {
            signedUrl = await generatePresignedUrl(row.profile_url);
          } catch (err) {
            console.error("Error presigning profile:", row.profile_url, err);
            signedUrl = null; // or "/avatar.jpg"
          }
        }

        return { ...row, profile_url: signedUrl };
      })
    );

    const countSql = `
      SELECT COUNT(DISTINCT viewer_id) AS unique_viewers
      FROM profile_views
      WHERE target_id = $1
    `;
    const countRes = await pool.query(countSql, [targetId]);

    return res.json({
      viewers,
      pagination: { page, limit },
      total_unique: parseInt(countRes.rows[0].unique_viewers, 10) || 0,
    });
  } catch (err) {
    console.error("GET /api/profile-views/me error:", err);
    return res.status(500).json({ error: "internal" });
  }
});

/**
 * GET /api/profile-views/me/all
 * Returns every view (not deduped). Query: ?page=1&limit=20
 */
router.get("/me/all", auth, async (req, res) => {
  try {
    const targetId = req.user.id;
    const { page, limit, offset } = parsePaging(req.query);

    const sql = `
      SELECT pv.id, pv.viewer_id, pv.created_at, pv.ip, pv.user_agent,
             u.first_name, u.last_name, u.profile AS profile_url
      FROM profile_views pv
      LEFT JOIN users u ON u.id = pv.viewer_id
      WHERE pv.target_id = $1
      ORDER BY pv.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(sql, [targetId, limit, offset]);

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM profile_views WHERE target_id = $1`,
      [targetId]
    );

    return res.json({
      views: result.rows,
      pagination: { page, limit },
      total: parseInt(countRes.rows[0].total, 10) || 0,
    });
  } catch (err) {
    console.error("GET /api/profile-views/me/all error:", err);
    return res.status(500).json({ error: "internal" });
  }
});

module.exports = router;

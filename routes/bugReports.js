// routes/bugReports.js
const express = require("express");
const router = express.Router();
const pool = require("../config/db"); // your pg Pool
const auth = require("../middlewares/authMiddleware"); // must set req.user.id

// POST /api/bug-reports
router.post("/", auth, async (req, res) => {
  try {
    const reporterId = req.user && req.user.id;
    const { title, type, description } = req.body;

    if (!reporterId) return res.status(401).json({ error: "Unauthorized" });
    if (!title || !description)
      return res.status(400).json({ error: "title and description required" });

    // Basic validation for type (optional): ensure one of allowed values
    const allowed = ["ui", "crash", "performance", "security", "other"];
    const bugType = allowed.includes(type) ? type : "other";

    const sql = `
      INSERT INTO bug_reports (reporter_id, type, title, description)
      VALUES ($1, $2, $3, $4)
      RETURNING id, created_at
    `;
    const { rows } = await pool.query(sql, [
      reporterId,
      bugType,
      title,
      description,
    ]);

    return res
      .status(201)
      .json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (err) {
    console.error(
      "POST /api/bug-reports error:",
      err && err.stack ? err.stack : err
    );
    return res.status(500).json({ error: "internal" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const { query } = require("../config/db");

/**
 * GET /api/universities?search=har
 * Used by RegisterForm CustomSelect
 */
router.get("/", async (req, res) => {
  const search = (req.query.search || "").trim();

  try {
    const { rows } = await query(
      `
      SELECT name, domain
      FROM universities
      WHERE name ILIKE $1
      ORDER BY name
      LIMIT 20
      `,
      [`%${search}%`]
    );

    res.json(rows);
  } catch (err) {
    console.error("University search error:", err);
    res.status(500).json({ msg: "Failed to fetch universities" });
  }
});

module.exports = router;

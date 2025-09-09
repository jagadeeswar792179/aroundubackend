const express = require("express");
const router = express.Router();
const pool = require("../config/db"); // your pg pool
const verifyToken = require("../middlewares/authMiddleware"); // optional for auth

// Return all users except the current logged-in one
router.get("/all", verifyToken, async (req, res) => {
  try {
    const me = req.user.id;
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email 
       FROM users 
       WHERE id <> $1
       ORDER BY first_name, last_name`,
      [me]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

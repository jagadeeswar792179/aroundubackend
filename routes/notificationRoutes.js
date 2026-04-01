const express = require("express");
const router = express.Router();
const auth = require("../middlewares/authMiddleware");
const pool = require("../config/db");

// ✅ Get notifications
router.get("/", auth, async (req, res) => {
  const userId = req.user.id;

  const { rows } = await pool.query(
    `SELECT *
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId],
  );

  res.json(rows);
});

// ✅ unread count
router.get("/unread-count", auth, async (req, res) => {
  const userId = req.user.id;

  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM notifications
     WHERE user_id = $1 AND read = false`,
    [userId],
  );

  res.json({ count: parseInt(rows[0].count) });
});

// ✅ mark all read
router.patch("/read", auth, async (req, res) => {
  const userId = req.user.id;

  await pool.query(
    `UPDATE notifications
     SET read = true
     WHERE user_id = $1`,
    [userId],
  );

  res.json({ success: true });
});

// ✅ delete single notification (optional future)
router.delete("/:id", auth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  await pool.query(
    `DELETE FROM notifications
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );

  res.json({ success: true });
});

module.exports = router;

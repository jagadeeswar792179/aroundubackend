// routes/moderationRoutes.js
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const auth = require("../middlewares/authMiddleware");

/**
 * POST /api/moderation/report/post/:postId
 * Body: { type: 'spam' | 'harassment' | 'hate_speech' | 'violent_content' | 'sexual_content' | 'misinformation' | 'copyright' | 'other', reason?: string }
 */
// POST /api/moderation/report/post/:postId
router.post("/report/post/:postId", auth, async (req, res) => {
  const { postId } = req.params;
  const { type, reason } = req.body;
  const reporterId = req.user.id;

  if (!type) {
    return res.status(400).json({ error: "Report type is required" });
  }

  try {
    await pool.query(
      `
      INSERT INTO post_reports (reporter_id, post_id, type, reason)
      VALUES ($1, $2, $3, $4)
      `,
      [reporterId, postId, type, reason || null]
    );

    return res.status(201).json({ msg: "Post reported. Thank you." });
  } catch (err) {
    console.error("Error reporting post:", err);
    return res.status(500).json({ error: "Failed to report post" });
  }
});

// POST /api/moderation/report/user/:userId
router.post("/report/user/:userId", auth, async (req, res) => {
  const { userId } = req.params;
  const { type, reason } = req.body;
  const reporterId = req.user.id;

  if (!type) {
    return res.status(400).json({ error: "Report type is required" });
  }
  if (userId === reporterId) {
    return res.status(400).json({ error: "You cannot report yourself" });
  }

  try {
    await pool.query(
      `
      INSERT INTO user_reports (reporter_id, reported_user_id, type, reason)
      VALUES ($1, $2, $3, $4)
      `,
      [reporterId, userId, type, reason || null]
    );

    return res.status(201).json({ msg: "User reported. Thank you." });
  } catch (err) {
    console.error("Error reporting user:", err);
    return res.status(500).json({ error: "Failed to report user" });
  }
});

// POST /api/moderation/block/:userId
router.post("/block/:userId", auth, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  const blockerId = req.user.id;

  if (userId === blockerId) {
    return res.status(400).json({ error: "You cannot block yourself" });
  }

  try {
    await pool.query(
      `
      INSERT INTO blocks (blocker_id, blocked_id, reason)
      VALUES ($1, $2, $3)
      ON CONFLICT (blocker_id, blocked_id) DO NOTHING
      `,
      [blockerId, userId, reason || null]
    );

    return res.status(201).json({ msg: "User blocked" });
  } catch (err) {
    console.error("Error blocking user:", err);
    return res.status(500).json({ error: "Failed to block user" });
  }
});
// DELETE /api/moderation/block/:userId
router.delete("/block/:userId", auth, async (req, res) => {
  const { userId } = req.params;
  const blockerId = req.user.id;

  if (userId === blockerId) {
    return res.status(400).json({ error: "You cannot unblock yourself" });
  }

  try {
    await pool.query(
      `DELETE FROM blocks
       WHERE blocker_id = $1 AND blocked_id = $2`,
      [blockerId, userId]
    );

    return res.json({ msg: "User unblocked" });
  } catch (err) {
    console.error("Error unblocking user:", err);
    return res.status(500).json({ error: "Failed to unblock user" });
  }
});

module.exports = router;

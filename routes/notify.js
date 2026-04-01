const pool = require("../config/db");

module.exports = async function notify(
  io,
  { toUserId, actorId, type, entityId, entityType, data = {} },
) {
  try {
    // ❌ 1. prevent self notifications
    if (!toUserId || !actorId || toUserId === actorId) {
      return null;
    }

    // ❌ 2. prevent duplicate notifications (optional but recommended)
    // Example: multiple rapid likes → avoid spam
    if (type === "like") {
      const existing = await pool.query(
        `SELECT id FROM notifications
         WHERE user_id = $1
         AND actor_id = $2
         AND type = $3
         AND entity_id = $4
         LIMIT 1`,
        [toUserId, actorId, type, entityId],
      );

      if (existing.rows.length > 0) {
        return null;
      }
    }

    // ✅ 3. insert into DB
    const result = await pool.query(
      `INSERT INTO notifications
       (user_id, actor_id, type, entity_id, entity_type, data)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [toUserId, actorId, type, entityId, entityType, data],
    );

    const notification = result.rows[0];

    // ✅ 4. realtime emit via socket
    if (io) {
      io.to(toUserId).emit("notification:new", notification);
    }

    return notification;
  } catch (err) {
    console.error("❌ notify error:", err.message);
    return null;
  }
};

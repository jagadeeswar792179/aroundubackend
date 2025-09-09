// utils/notify.js
const pool = require("../config/db");

/**
 * notify(io, { toUserId, actorId, type, entityId, entityType, data })
 *
 * - toUserId     : UUID of recipient (string)
 * - actorId      : UUID of the user who caused the notification (nullable)
 * - type         : string e.g. 'like','comment','follow_request','follow_accept','profile_view'
 * - entityId     : UUID of related entity (post/comment/follow_request) (nullable)
 * - entityType   : string e.g. 'post','comment','follow_request','user' (nullable)
 * - data         : object to store extra payload (JSON-serializable)
 *
 * Returns the inserted notification row or null on error.
 */
async function notify(
  io,
  {
    toUserId,
    actorId = null,
    type,
    entityId = null,
    entityType = null,
    data = {},
  }
) {
  if (!toUserId || !type) {
    console.warn("notify: missing toUserId or type", { toUserId, type });
    return null;
  }

  try {
    const insertQ = `
      INSERT INTO notifications (user_id, actor_id, type, entity_id, entity_type, data)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, user_id, actor_id, type, entity_id, entity_type, data, read, created_at
    `;
    const vals = [toUserId, actorId, type, entityId, entityType, data || {}];
    const { rows } = await pool.query(insertQ, vals);
    const notif = rows[0] || null;

    // Emit over socket.io to the recipient's room (room name = userId)
    try {
      if (io && toUserId) {
        // emit event name 'notification' with payload (the inserted notification)
        io.to(String(toUserId)).emit("notification", notif);
      }
    } catch (emitErr) {
      // Log and continue — don't fail the main operation
      console.warn(
        "notify: socket emit failed",
        emitErr && emitErr.message ? emitErr.message : emitErr
      );
    }

    return notif;
  } catch (err) {
    console.error(
      "notify: db insert failed",
      err && err.message ? err.message : err
    );
    return null;
  }
}

module.exports = notify;

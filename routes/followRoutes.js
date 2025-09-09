// routes/followRoutes.js
const express = require("express");

/**
 * Router factory - pass your socket.io instance (io)
 * Usage: const followRoutes = require('./routes/followRoutes')(io)
 */
const routerFactory = (io) => {
  const router = express.Router();
  const pool = require("../config/db"); // adjust path to your pg pool
  const auth = require("../middlewares/authMiddleware"); // your auth middleware
  const notify = require("./notify"); // notification helper - adjust path if needed

  // ---------- Helpers ----------
  function emitToUser(userId, event, payload) {
    if (!io) return;
    try {
      io.to(String(userId)).emit(event, payload);
    } catch (err) {
      console.warn("emit error", err);
    }
  }

  function isValidUUID(uuid) {
    return (
      typeof uuid === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        uuid
      )
    );
  }

  // Enforce allowed page sizes: initial must be 5, subsequent should be 6 (but backend verifies)
  function sanitizeLimit(qLimit, initial = false) {
    const parsed = parseInt(qLimit, 10);
    if (Number.isNaN(parsed)) return initial ? 5 : 6;
    // allow only 5 (initial) or 6 (subsequent) to match client UX
    if (initial) return parsed === 5 ? 5 : 5;
    return parsed === 6 ? 6 : 6;
  }

  // ---------- 1) Batch statuses endpoint ----------
  // POST /api/follow/statuses
  router.post("/statuses", auth, async (req, res) => {
    const me = req.user.id;
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds : [];
    if (!userIds.length) return res.json({ statuses: {} });

    try {
      const q = `
        SELECT requester_id, target_id, status
        FROM follow_requests
        WHERE (requester_id = $1 AND target_id = ANY($2::uuid[]))
           OR (target_id = $1 AND requester_id = ANY($2::uuid[]))
      `;
      const { rows } = await pool.query(q, [me, userIds]);

      const map = {};
      userIds.forEach(
        (u) => (map[u] = { myStatus: null, incomingStatus: null })
      );
      rows.forEach((r) => {
        const { requester_id, target_id, status } = r;
        if (requester_id === me) map[target_id].myStatus = status;
        else if (target_id === me) map[requester_id].incomingStatus = status;
      });

      const out = {};
      for (const u of userIds) {
        const { myStatus, incomingStatus } = map[u] || {};
        const myAccepted = myStatus === "accepted";
        const incomingAccepted = incomingStatus === "accepted";
        const myPending = myStatus === "pending";

        if (myAccepted && incomingAccepted) out[u] = "friends";
        else if (myPending) out[u] = "requested";
        else out[u] = "follow";
      }

      return res.json({ statuses: out });
    } catch (err) {
      console.error("statuses error", err);
      return res.status(500).json({ error: "Failed to fetch statuses" });
    }
  });

  // ---------- 2) GET pending requests (keyset pagination) ----------
  // GET /api/follow/pending?limit=5&last_created_at=...&last_id=...
  // - initial request: limit=5  -> server will return 5
  // - subsequent: limit=6 & pass last_created_at + last_id -> server returns next 6
  router.get("/pending", auth, async (req, res) => {
    const targetId = req.user.id;
    const lastCreatedAt = req.query.last_created_at || null;
    const lastId = req.query.last_id || null;

    // determine if this is initial page
    const isInitial = !lastCreatedAt || !lastId;
    const limit = sanitizeLimit(req.query.limit, isInitial);

    try {
      let rows;
      if (isInitial) {
        const q = `
          SELECT fr.id, fr.requester_id, u.first_name, u.last_name, u.avatar_url, fr.status, fr.created_at
          FROM follow_requests fr
          JOIN users u ON u.id = fr.requester_id
          WHERE fr.target_id = $1 AND fr.status = 'pending'
          ORDER BY fr.created_at DESC, fr.id DESC
          LIMIT $2;
        `;
        ({ rows } = await pool.query(q, [targetId, limit]));
      } else {
        // validate last_id
        if (!isValidUUID(lastId))
          return res.status(400).json({ error: "Invalid last_id" });

        const q = `
          SELECT fr.id, fr.requester_id, u.first_name, u.last_name, u.avatar_url, fr.status, fr.created_at
          FROM follow_requests fr
          JOIN users u ON u.id = fr.requester_id
          WHERE fr.target_id = $1
            AND fr.status = 'pending'
            AND (
              (fr.created_at < $2)
              OR (fr.created_at = $2 AND fr.id < $3)
            )
          ORDER BY fr.created_at DESC, fr.id DESC
          LIMIT $4;
        `;
        ({ rows } = await pool.query(q, [
          targetId,
          lastCreatedAt,
          lastId,
          limit,
        ]));
      }

      const last = rows.length ? rows[rows.length - 1] : null;
      const next_cursor = last
        ? { last_created_at: last.created_at.toISOString(), last_id: last.id }
        : null;

      return res.json({
        items: rows,
        next_cursor,
        count: rows.length,
      });
    } catch (err) {
      console.error("pending requests error", err);
      return res
        .status(500)
        .json({ error: "Failed to fetch pending requests" });
    }
  });

  // ---------- 3) Accept follow request (target accepts request from requester) ----------
  // POST /api/follow/:requesterId/accept
  router.post("/:requesterId/accept", auth, async (req, res) => {
    const target = req.user.id;
    const requester = req.params.requesterId;
    if (!requester || !target)
      return res.status(400).json({ error: "Missing user" });
    if (!isValidUUID(requester))
      return res.status(400).json({ error: "Invalid requester id" });
    if (requester === target)
      return res.status(400).json({ error: "Invalid operation" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const upd = await client.query(
        `UPDATE follow_requests
         SET status='accepted', updated_at=now()
         WHERE requester_id=$1 AND target_id=$2 AND status='pending'
         RETURNING id;`,
        [requester, target]
      );

      if (upd.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No pending request to accept" });
      }

      await client.query(
        `UPDATE users SET followers_count = GREATEST(followers_count + 1, 0) WHERE id = $1`,
        [target]
      );
      await client.query(
        `UPDATE users SET following_count = GREATEST(following_count + 1, 0) WHERE id = $1`,
        [requester]
      );

      await client.query("COMMIT");

      // emit real-time event to requester
      emitToUser(requester, "follow_request_accepted", {
        by: target,
        ts: new Date().toISOString(),
      });

      // persist notification
      try {
        await notify(io, {
          toUserId: requester,
          actorId: target,
          type: "follow_accept",
          entityId: upd.rows[0]?.id || null,
          entityType: "follow_request",
          data: { message: "accepted your follow request" },
        });
      } catch (err) {
        console.warn("notify follow_accept failed", err && err.message);
      }

      return res.json({ status: "accepted" });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("accept error", err);
      return res.status(500).json({ error: "Failed to accept request" });
    } finally {
      client.release();
    }
  });

  // ---------- 4) Reject pending request ----------
  // POST /api/follow/:requesterId/reject
  router.post("/:requesterId/reject", auth, async (req, res) => {
    const target = req.user.id;
    const requester = req.params.requesterId;
    if (!isValidUUID(requester))
      return res.status(400).json({ error: "Invalid requester id" });

    try {
      const { rowCount } = await pool.query(
        `UPDATE follow_requests SET status='rejected', updated_at=now()
         WHERE requester_id=$1 AND target_id=$2 AND status='pending'`,
        [requester, target]
      );
      if (rowCount === 0)
        return res.status(400).json({ error: "No pending request to reject" });

      emitToUser(requester, "follow_request_rejected", {
        by: target,
        ts: new Date().toISOString(),
      });

      try {
        await notify(io, {
          toUserId: requester,
          actorId: target,
          type: "follow_reject",
          entityId: null,
          entityType: "follow_request",
          data: { message: "rejected your follow request" },
        });
      } catch (err) {
        console.warn("notify follow_reject failed", err && err.message);
      }

      return res.json({ status: "rejected" });
    } catch (err) {
      console.error("reject error", err);
      return res.status(500).json({ error: "Failed to reject request" });
    }
  });

  // ---------- 5) Cancel request (requester cancels their pending request) ----------
  // POST /api/follow/:targetId/cancel
  router.post("/:targetId/cancel", auth, async (req, res) => {
    const requester = req.user.id;
    const target = req.params.targetId;
    if (!isValidUUID(target))
      return res.status(400).json({ error: "Invalid target id" });

    try {
      const { rowCount } = await pool.query(
        `UPDATE follow_requests SET status='cancelled', updated_at=now()
         WHERE requester_id=$1 AND target_id=$2 AND status='pending'`,
        [requester, target]
      );
      if (rowCount === 0)
        return res.status(400).json({ error: "No pending request to cancel" });

      emitToUser(target, "follow_request_cancelled", {
        by: requester,
        ts: new Date().toISOString(),
      });

      try {
        await notify(io, {
          toUserId: target,
          actorId: requester,
          type: "follow_cancel",
          entityId: null,
          entityType: "follow_request",
          data: { message: "cancelled a follow request" },
        });
      } catch (err) {
        console.warn("notify follow_cancel failed", err && err.message);
      }

      return res.json({ status: "cancelled" });
    } catch (err) {
      console.error("cancel error", err);
      return res.status(500).json({ error: "Failed to cancel request" });
    }
  });

  // ---------- 6) Unfollow (if current user had an accepted relation requester->target) ----------
  // POST /api/follow/:targetId/unfollow
  router.post("/:targetId/unfollow", auth, async (req, res) => {
    const requester = req.user.id;
    const target = req.params.targetId;
    if (!isValidUUID(target))
      return res.status(400).json({ error: "Invalid target id" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const upd = await client.query(
        `UPDATE follow_requests
         SET status='cancelled', updated_at=now()
         WHERE requester_id=$1 AND target_id=$2 AND status='accepted'
         RETURNING id;`,
        [requester, target]
      );
      if (upd.rowCount === 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "No accepted follow to unfollow" });
      }

      await client.query(
        `UPDATE users SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = $1`,
        [target]
      );
      await client.query(
        `UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = $1`,
        [requester]
      );

      await client.query("COMMIT");

      emitToUser(target, "unfollowed", {
        by: requester,
        ts: new Date().toISOString(),
      });

      try {
        await notify(io, {
          toUserId: target,
          actorId: requester,
          type: "unfollow",
          entityId: null,
          entityType: "user",
          data: { message: "unfollowed you" },
        });
      } catch (err) {
        console.warn("notify unfollow failed", err && err.message);
      }

      return res.json({ status: "cancelled" });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("unfollow error", err);
      return res.status(500).json({ error: "Failed to unfollow" });
    } finally {
      client.release();
    }
  });

  // ---------- 7) Send follow request (generic last route to avoid route capture) ----------
  // POST /api/follow/:targetId
  router.post("/:targetId", auth, async (req, res) => {
    const requester = req.user.id;
    const target = req.params.targetId;
    if (!requester || !target)
      return res.status(400).json({ error: "Missing user" });
    if (!isValidUUID(target))
      return res.status(400).json({ error: "Invalid target id" });
    if (requester === target)
      return res.status(400).json({ error: "Cannot follow yourself" });

    try {
      const q = `
        INSERT INTO follow_requests (requester_id, target_id, status)
        VALUES ($1, $2, 'pending')
        ON CONFLICT (requester_id, target_id) DO UPDATE
          SET status = EXCLUDED.status, updated_at = now()
          WHERE follow_requests.status IN ('rejected','cancelled')
        RETURNING id, status;
      `;
      const { rows } = await pool.query(q, [requester, target]);

      // determine status in case ON CONFLICT didn't return row (edge)
      let status = rows[0]?.status;
      if (!status) {
        const cur = await pool.query(
          `SELECT status FROM follow_requests WHERE requester_id=$1 AND target_id=$2 LIMIT 1`,
          [requester, target]
        );
        status = cur.rows[0]?.status || "pending";
      }

      emitToUser(target, "follow_request_received", {
        from: requester,
        status,
        ts: new Date().toISOString(),
      });

      try {
        await notify(io, {
          toUserId: target,
          actorId: requester,
          type: "follow_request",
          entityId: rows[0]?.id || null,
          entityType: "follow_request",
          data: { message: "sent you a follow request" },
        });
      } catch (err) {
        console.warn("notify follow_request failed", err && err.message);
      }

      return res.json({ status });
    } catch (err) {
      console.error("send follow error", err);
      return res.status(500).json({ error: "Failed to send follow request" });
    }
  });

  return router;
};

module.exports = routerFactory;

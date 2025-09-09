const pool = require("../config/db");
const generatePresignedUrl = require("../config/generatePresignedUrl"); // adjust path

module.exports = (io) => {
  return {
    // A) List my conversations: peer info, last message, unread count + profile URL
    listMyConversations: async (req, res) => {
      try {
        const me = req.user.id;
        const q = `
          WITH my_convos AS (
            SELECT c.id,
                   CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END AS peer_id,
                   c.last_message_id,
                   c.last_message_at
            FROM conversations c
            WHERE c.user1_id = $1 OR c.user2_id = $1
          ),
          last_msg AS (
            SELECT m.id, m.conversation_id, m.body, m.sender_id, m.created_at
            FROM messages m
            WHERE m.id IN (SELECT last_message_id FROM my_convos WHERE last_message_id IS NOT NULL)
          ),
          unread AS (
            SELECT conversation_id, COUNT(*) AS unread_count
            FROM messages
            WHERE conversation_id IN (SELECT id FROM my_convos)
              AND sender_id <> $1
              AND seen = false
            GROUP BY conversation_id
          )
          SELECT mc.id AS conversation_id,
                 u.id   AS peer_id,
                 u.first_name, u.last_name, u.email,
                 u.profile,  -- profile key
                 lm.body AS last_message,
                 lm.sender_id AS last_sender_id,
                 mc.last_message_at,
                 COALESCE(ur.unread_count, 0) AS unread_count
          FROM my_convos mc
          JOIN users u ON u.id = mc.peer_id
          LEFT JOIN last_msg lm ON lm.conversation_id = mc.id
          LEFT JOIN unread ur ON ur.conversation_id = mc.id
          ORDER BY mc.last_message_at DESC NULLS LAST
          LIMIT 50;
        `;
        const { rows } = await pool.query(q, [me]);

        const dataWithProfile = rows.map((r) => ({
          ...r,
          profile: r.profile ? generatePresignedUrl(r.profile) : null,
        }));

        res.json(dataWithProfile);
      } catch (e) {
        res
          .status(500)
          .json({ msg: "listMyConversations failed", error: e.message });
      }
    },

    // B) Ensure conversation between me and peer exists; return id
    ensureConversation: async (req, res) => {
      try {
        const me = req.user.id;
        const { peerId } = req.body;
        if (!peerId || peerId === me) {
          return res.status(400).json({ msg: "Invalid peerId" });
        }

        const found = await pool.query(
          `SELECT id FROM conversations
           WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)`,
          [me, peerId]
        );
        if (found.rows.length) return res.json(found.rows[0]);

        const created = await pool.query(
          `INSERT INTO conversations(user1_id, user2_id)
           VALUES ($1,$2) RETURNING id`,
          [me, peerId]
        );
        res.status(201).json(created.rows[0]);
      } catch (e) {
        res
          .status(500)
          .json({ msg: "ensureConversation failed", error: e.message });
      }
    },

    // C) Fetch latest messages (with sender profile URL)
    fetchMessages: async (req, res) => {
      try {
        const me = req.user.id;
        const { conversationId } = req.params;
        const { before } = req.query;

        const ok = await pool.query(
          `SELECT 1 FROM conversations
           WHERE id=$1 AND (user1_id=$2 OR user2_id=$2)`,
          [conversationId, me]
        );
        if (!ok.rows.length)
          return res.status(403).json({ msg: "Not in conversation" });

        const params = [conversationId];
        let q = `
          SELECT m.id, m.sender_id, m.body, m.created_at, m.seen,
                 u.profile AS sender_profile
          FROM messages m
          JOIN users u ON m.sender_id = u.id
          WHERE m.conversation_id=$1
        `;
        if (before) {
          q += ` AND m.created_at < $2 `;
          params.push(before);
        }
        q += ` ORDER BY m.created_at DESC LIMIT 30;`;

        const { rows } = await pool.query(q, params);

        const messagesWithProfile = rows.map((m) => ({
          ...m,
          sender_profile: m.sender_profile
            ? generatePresignedUrl(m.sender_profile)
            : null,
        }));

        res.json(messagesWithProfile);
      } catch (e) {
        res.status(500).json({ msg: "fetchMessages failed", error: e.message });
      }
    },

    // D) Send message: insert -> update conversation -> emit to peer (with sender profile)
    sendMessage: async (req, res) => {
      try {
        const me = req.user.id;
        const { conversationId } = req.params;
        const { body } = req.body;
        if (!body?.trim())
          return res.status(400).json({ msg: "Empty message" });

        const conv = await pool.query(
          `SELECT user1_id, user2_id FROM conversations WHERE id=$1`,
          [conversationId]
        );
        if (!conv.rows.length)
          return res.status(404).json({ msg: "Conversation not found" });
        const { user1_id, user2_id } = conv.rows[0];
        if (![user1_id, user2_id].includes(me))
          return res.status(403).json({ msg: "Not in conversation" });
        const peerId = me === user1_id ? user2_id : user1_id;

        // insert message
        const ins = await pool.query(
          `INSERT INTO messages (conversation_id, sender_id, body)
           VALUES ($1, $2, $3)
           RETURNING *;`,
          [conversationId, me, body.trim()]
        );
        const msg = ins.rows[0];

        // fetch sender profile
        const sender = await pool.query(
          `SELECT profile FROM users WHERE id=$1`,
          [me]
        );
        const msgWithProfile = {
          ...msg,
          sender_profile: sender.rows[0].profile
            ? generatePresignedUrl(sender.rows[0].profile)
            : null,
        };

        // update conversation last_message fields
        await pool.query(
          `UPDATE conversations
           SET last_message_id = $2,
               last_message_at = $3
           WHERE id=$1`,
          [conversationId, msg.id, msg.created_at]
        );

        // emit real-time
        io.to(peerId).emit("message:new", {
          ...msgWithProfile,
          conversation_id: conversationId,
        });

        res
          .status(201)
          .json({ ...msgWithProfile, conversation_id: conversationId });
      } catch (e) {
        res.status(500).json({ msg: "sendMessage failed", error: e.message });
      }
    },

    // E) Mark messages from peer as seen
    markSeen: async (req, res) => {
      try {
        const me = req.user.id;
        const { conversationId } = req.params;
        await pool.query(
          `UPDATE messages
           SET seen = true
           WHERE conversation_id=$1 AND sender_id <> $2 AND seen = false`,
          [conversationId, me]
        );
        res.json({ msg: "seen updated" });
      } catch (e) {
        res.status(500).json({ msg: "markSeen failed", error: e.message });
      }
    },
  };
};

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
         c.type,
         c.title,
         c.last_message_id,
         c.last_message_at
  FROM conversations c
  JOIN conversation_members cm
    ON cm.conversation_id = c.id
  WHERE cm.user_id = $1
),

peer AS (
  SELECT
    cm.conversation_id,
    u.id AS peer_id,
    u.first_name,
    u.last_name,
    u.email,
    u.profile
  FROM conversation_members cm
  JOIN users u ON u.id = cm.user_id
  WHERE cm.user_id <> $1
),

last_msg AS (
  SELECT m.id, m.conversation_id, m.body, m.sender_id, m.created_at
  FROM messages m
  WHERE m.id IN (
    SELECT last_message_id
    FROM my_convos
    WHERE last_message_id IS NOT NULL
  )
),

unread AS (
  SELECT conversation_id, COUNT(*) AS unread_count
  FROM messages
  WHERE conversation_id IN (SELECT id FROM my_convos)
    AND sender_id <> $1
    AND seen = false
  GROUP BY conversation_id
)

SELECT DISTINCT ON (mc.id)
  mc.id AS conversation_id,
  mc.type,
  mc.title,
  mc.last_message_id,
  p.peer_id,
  p.first_name,
  p.last_name,
  p.email,
  p.profile,

  lm.body AS last_message,
  lm.sender_id AS last_sender_id,
  mc.last_message_at,

  COALESCE(ur.unread_count,0) AS unread_count,

  -- ⭐ member count
  (
    SELECT COUNT(*)
    FROM conversation_members
    WHERE conversation_id = mc.id
  ) AS member_count

FROM my_convos mc
LEFT JOIN peer p ON p.conversation_id = mc.id
LEFT JOIN last_msg lm ON lm.conversation_id = mc.id
LEFT JOIN unread ur ON ur.conversation_id = mc.id

ORDER BY mc.id, mc.last_message_at DESC NULLS LAST
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

    createGroup: async (req, res) => {
      try {
        const me = req.user.id;
        const { title, members } = req.body;

        if (!title || !members || members.length === 0) {
          return res.status(400).json({ msg: "Invalid group data" });
        }

        // create group conversation
        const convo = await pool.query(
          `INSERT INTO conversations(type,title,created_by)
       VALUES('group',$1,$2)
       RETURNING id`,
          [title, me],
        );

        const conversationId = convo.rows[0].id;

        const allMembers = [...new Set([me, ...members])];

        for (const userId of allMembers) {
          await pool.query(
            `INSERT INTO conversation_members(conversation_id,user_id,role)
     VALUES($1,$2,$3)`,
            [conversationId, userId, userId === me ? "admin" : "member"],
          );
        }

        res.json({ conversation_id: conversationId });
      } catch (e) {
        console.error("createGroup error:", e);
        res.status(500).json({ error: e.message });
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

        // 1️⃣ Check if conversation exists
        const found = await pool.query(
          `SELECT id FROM conversations
       WHERE (user1_id=$1 AND user2_id=$2)
          OR (user1_id=$2 AND user2_id=$1)`,
          [me, peerId],
        );

        let conversationId;

        if (found.rows.length) {
          conversationId = found.rows[0].id;
        } else {
          // 2️⃣ Create new conversation
          const created = await pool.query(
            `INSERT INTO conversations(user1_id, user2_id)
         VALUES ($1,$2)
         RETURNING id`,
            [me, peerId],
          );

          conversationId = created.rows[0].id;
        }

        // 3️⃣ 🔥 IMPORTANT: ensure members exist
        await pool.query(
          `INSERT INTO conversation_members(conversation_id, user_id)
       VALUES ($1,$2), ($1,$3)
       ON CONFLICT DO NOTHING`,
          [conversationId, me, peerId],
        );

        return res.json({ id: conversationId });
      } catch (e) {
        res.status(500).json({
          msg: "ensureConversation failed",
          error: e.message,
        });
      }
    },

    // C) Fetch latest messages (with sender profile URL)
    fetchMessages: async (req, res) => {
      try {
        const me = req.user.id;
        const { conversationId } = req.params;
        const { before } = req.query;

        const member = await pool.query(
          `SELECT 1
   FROM conversation_members
   WHERE conversation_id=$1
   AND user_id=$2`,
          [conversationId, me],
        );

        if (!member.rows.length) {
          return res.status(403).json({ msg: "Not in conversation" });
        }

        const params = [conversationId];
        let q = `
          SELECT m.id, m.sender_id, m.body, m.created_at, m.seen,m.deleted,
                 u.profile AS sender_profile,u.first_name,
       u.last_name
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
          first_name: m.first_name,
          last_name: m.last_name,
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

        const members = await pool.query(
          `SELECT user_id
   FROM conversation_members
   WHERE conversation_id=$1`,
          [conversationId],
        );

        const memberIds = members.rows.map((r) => r.user_id);

        if (!memberIds.includes(me)) {
          return res.status(403).json({ msg: "Not in conversation" });
        }

        // insert message
        const ins = await pool.query(
          `INSERT INTO messages (conversation_id, sender_id, body)
           VALUES ($1, $2, $3)
           RETURNING *;`,
          [conversationId, me, body.trim()],
        );
        const msg = ins.rows[0];

        // fetch sender profile
        const sender = await pool.query(
          `SELECT profile, first_name, last_name
   FROM users
   WHERE id=$1`,
          [me],
        );
        const msgWithProfile = {
          ...msg,
          sender_profile: sender.rows[0].profile
            ? generatePresignedUrl(sender.rows[0].profile)
            : null,
          first_name: sender.rows[0].first_name,
          last_name: sender.rows[0].last_name,
        };

        // update conversation last_message fields
        await pool.query(
          `UPDATE conversations
           SET last_message_id = $2,
               last_message_at = $3
           WHERE id=$1`,
          [conversationId, msg.id, msg.created_at],
        );

        memberIds.forEach((uid) => {
          if (uid !== me) {
            io.to(uid).emit("message:new", {
              ...msgWithProfile,
              conversation_id: conversationId,
            });
          }
        });

        res
          .status(201)
          .json({ ...msgWithProfile, conversation_id: conversationId });
      } catch (e) {
        res.status(500).json({ msg: "sendMessage failed", error: e.message });
      }
    },

    deleteMessage: async (req, res) => {
      try {
        const me = req.user.id;
        const { messageId } = req.params;

        // get message info
        const msg = await pool.query(
          `SELECT sender_id, conversation_id
       FROM messages
       WHERE id=$1`,
          [messageId],
        );

        if (!msg.rows.length) {
          return res.status(404).json({ msg: "Message not found" });
        }

        const { sender_id, conversation_id } = msg.rows[0];

        // check if user is admin in group
        const role = await pool.query(
          `SELECT role
   FROM conversation_members
   WHERE conversation_id=$1
   AND user_id=$2`,
          [conversation_id, me],
        );

        const userRole = role.rows[0]?.role;

        // allow if sender OR admin
        if (sender_id !== me && userRole !== "admin") {
          return res
            .status(403)
            .json({ msg: "Not allowed to delete this message" });
        }

        // soft delete message
        await pool.query(
          `UPDATE messages
       SET deleted = true,
           deleted_by = $2
       WHERE id = $1`,
          [messageId, me],
        );
        // after delete
        const members = await pool.query(
          `SELECT user_id FROM conversation_members WHERE conversation_id=$1`,
          [conversation_id],
        );
        members.rows.forEach(({ user_id }) => {
          io.to(user_id).emit("message:deleted", {
            messageId,
            conversation_id,
          });
        });
        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ msg: "deleteMessage failed", error: e.message });
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
          [conversationId, me],
        );

        // 🔥 ADD THIS BLOCK
        const members = await pool.query(
          `SELECT user_id FROM conversation_members WHERE conversation_id=$1`,
          [conversationId],
        );

        members.rows.forEach(({ user_id }) => {
          if (user_id !== me) {
            io.to(user_id).emit("message:seen", {
              conversation_id: conversationId,
            });
          }
        });

        res.json({ msg: "seen updated" });
      } catch (e) {
        res.status(500).json({ msg: "markSeen failed", error: e.message });
      }
    },
    leaveGroup: async (req, res) => {
      try {
        const me = req.user.id;
        const { conversationId } = req.params;

        // check membership
        const member = await pool.query(
          `SELECT role
       FROM conversation_members
       WHERE conversation_id=$1
       AND user_id=$2`,
          [conversationId, me],
        );

        if (!member.rows.length) {
          return res.status(403).json({ msg: "Not a group member" });
        }

        const role = member.rows[0].role;

        // remove user
        await pool.query(
          `DELETE FROM conversation_members
       WHERE conversation_id=$1
       AND user_id=$2`,
          [conversationId, me],
        );

        // if admin left → assign new admin
        if (role === "admin") {
          const nextAdmin = await pool.query(
            `SELECT user_id
         FROM conversation_members
         WHERE conversation_id=$1
         ORDER BY joined_at ASC
         LIMIT 1`,
            [conversationId],
          );

          if (nextAdmin.rows.length > 0) {
            await pool.query(
              `UPDATE conversation_members
           SET role='admin'
           WHERE conversation_id=$1
           AND user_id=$2`,
              [conversationId, nextAdmin.rows[0].user_id],
            );
          }
        }

        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ msg: "leaveGroup failed", error: e.message });
      }
    },
    addMembers: async (req, res) => {
      try {
        const me = req.user.id;
        const { conversationId } = req.params;
        const { members } = req.body;

        if (!members || !members.length) {
          return res.status(400).json({ msg: "No members provided" });
        }

        // check if user is admin
        const role = await pool.query(
          `SELECT role
       FROM conversation_members
       WHERE conversation_id=$1
       AND user_id=$2`,
          [conversationId, me],
        );

        if (!role.rows.length || role.rows[0].role !== "admin") {
          return res.status(403).json({ msg: "Only admin can add members" });
        }

        // insert new members
        for (const userId of members) {
          await pool.query(
            `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
            [conversationId, userId],
          );
        }

        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ msg: "addMembers failed", error: e.message });
      }
    },

    removeMember: async (req, res) => {
      try {
        const me = req.user.id;
        const { conversationId, userId } = req.params;

        // check if requester is admin
        const role = await pool.query(
          `SELECT role
       FROM conversation_members
       WHERE conversation_id=$1
       AND user_id=$2`,
          [conversationId, me],
        );

        if (!role.rows.length || role.rows[0].role !== "admin") {
          return res.status(403).json({ msg: "Only admin can remove members" });
        }

        // prevent admin removing himself here
        if (me === userId) {
          return res.status(400).json({ msg: "Use leave group instead" });
        }

        // remove the member
        await pool.query(
          `DELETE FROM conversation_members
       WHERE conversation_id=$1
       AND user_id=$2`,
          [conversationId, userId],
        );

        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ msg: "removeMember failed", error: e.message });
      }
    },
    getGroupMembers: async (req, res) => {
      try {
        const me = req.user.id;
        const { conversationId } = req.params;
        const { q = "", page = 1 } = req.query;

        const limit = 10;
        const offset = (page - 1) * limit;

        // ensure requester is member
        const memberCheck = await pool.query(
          `SELECT 1
       FROM conversation_members
       WHERE conversation_id=$1
       AND user_id=$2`,
          [conversationId, me],
        );

        if (!memberCheck.rows.length) {
          return res.status(403).json({ msg: "Not allowed" });
        }

        const params = [conversationId];
        let idx = 2;

        let search = "";

        if (q.trim()) {
          search = `AND (
        LOWER(u.first_name) LIKE LOWER($${idx})
        OR LOWER(u.last_name) LIKE LOWER($${idx})
      )`;
          params.push(`%${q}%`);
          idx++;
        }

        params.push(limit);
        params.push(offset);

        const members = await pool.query(
          `
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.profile,
        cm.role,
        cm.joined_at
      FROM conversation_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id=$1
      AND cm.role != 'admin'
      ${search}
      ORDER BY cm.joined_at ASC
      LIMIT $${idx} OFFSET $${idx + 1}
      `,
          params,
        );

        const data = members.rows.map((m) => ({
          ...m,
          profile: m.profile ? generatePresignedUrl(m.profile) : null,
        }));

        res.json({
          members: data,
          page: Number(page),
          count: data.length,
        });
      } catch (e) {
        res.status(500).json({
          msg: "getGroupMembers failed",
          error: e.message,
        });
      }
    },
  };
};

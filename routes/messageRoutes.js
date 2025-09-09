// routes/messageRoutes.js
const express = require("express");
const verifyToken = require("../middlewares/authMiddleware");
const ctrlFactory = require("../controllers/messageController");

// Export a factory so we can pass `io` from index.js
module.exports = (io) => {
  const router = express.Router();
  const ctrl = ctrlFactory(io);

  // A) list people I’ve chatted with (last message + unread)
  router.get("/conversations", verifyToken, ctrl.listMyConversations);

  // B) ensure/open conversation with a peer (returns conversation id)
  router.post("/conversation", verifyToken, ctrl.ensureConversation);

  // C) fetch messages for a conversation (cursor pagination-ready)
  router.get("/:conversationId", verifyToken, ctrl.fetchMessages);

  // D) send a message (stores + emits to peer in real time)
  router.post("/:conversationId/send", verifyToken, ctrl.sendMessage);

  // E) mark messages from peer as seen
  router.post("/:conversationId/seen", verifyToken, ctrl.markSeen);

  return router;
};

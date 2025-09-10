// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const followRoutesFactory = require("./routes/followRoutes");
const exploreRoutes = require("./routes/exploreRoutes");
// routes
const searchRoutes = require("./routes/searchRoutes");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const messageRoutesFactory = require("./routes/messageRoutes"); // will receive io
const testUserRoutes = require("./routes/testUserRoutes");
const postRoutes = require("./routes/postRoutes");
const app = express();
const profileViewsRouter = require("./routes/profileViews");
const bugReportsRouter = require("./routes/bugReports");
const allowedOrigins = [
  "http://localhost:3000",
  "https://arounduapp.netlify.app",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
  })
);

app.use(express.json());

// ---- create HTTP server and attach socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // in prod: set to your frontend origin
  transports: ["websocket"], // prefer pure websockets
  pingInterval: 20000,
  pingTimeout: 20000,
});

// ---- sockets: each client joins a room with their userId
io.on("connection", (socket) => {
  socket.on("join", (userId) => {
    if (userId) {
      socket.join(userId); // now io.to(userId).emit(...) will DM that user
    }
  });

  socket.on("disconnect", () => {
    // optional: presence cleanup later
  });
});
app.use("/api/posts", postRoutes);

app.use("/api/test-users", testUserRoutes);
// ---- REST routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/messages", messageRoutesFactory(io)); // pass io to messages routes
app.use("/api/follow", followRoutesFactory(io));
app.use("/api/explore", exploreRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/profile-views", profileViewsRouter);
app.use("/api/bug-reports", bugReportsRouter);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`Server + Socket.IO running on port ${PORT}`)
);

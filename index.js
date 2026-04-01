// index.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const followRoutesFactory = require("./routes/followRoutes");
const exploreRoutes = require("./routes/exploreRoutes");
// routes
const searchRoutes = require("./routes/searchRoutes");
const forgotPasswordRoutes = require("./routes/forgotPasswordRoutes");
const authRoutes = require("./routes/authRoutes");
const otpRoutes = require("./routes/otpRoutes");
const userRoutes = require("./routes/userRoutes");
const messageRoutesFactory = require("./routes/messageRoutes"); // will receive io
const testUserRoutes = require("./routes/testUserRoutes");
const postRoutes = require("./routes/postRoutes");
const marketplaceRoutes = require("./routes/marketplaceRoutes");
const settingRoutes = require("./routes/settingsRoutes");

const app = express();
const profileViewsRouter = require("./routes/profileViews");
const bugReportsRouter = require("./routes/bugReports");
const bookingRoutes = require("./routes/bookingRoutes");
const lostfoundRoutes = require("./routes/lostfound");
const moderationRoutes = require("./routes/moderationRoutes");
const adminRoutes = require("./routes/adminRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const allowedOrigins = [
  "http://localhost:3000",
  "https://aroundu.me",
  "https://aroundu-admin.netlify.app",
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow mobile apps (no origin)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: false, // you are NOT using cookies
  }),
);

app.use(express.json());

// ---- create HTTP server and attach socket.io
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "https://aroundu.me",
      "https://aroundu-admin.netlify.app",
      "capacitor://localhost",
      "http://localhost",
      "https://localhost",
    ],
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

app.set("io", io);
io.on("connection", (socket) => {
  const userId = socket.handshake.auth?.userId;

  if (userId) {
    socket.join(userId); // 🔥 AUTO JOIN
    console.log("User auto joined:", userId);
  }

  socket.on("disconnect", () => {});
});
app.use("/api/universities", require("./routes/universities"));
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/test-users", testUserRoutes);
app.use("/api/lostfound", lostfoundRoutes); // <-- add this here
// ---- REST routes
app.use("/api", bookingRoutes);
app.use("/api/moderation", moderationRoutes);
app.use("/api/settings", settingRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/AuthOtp", otpRoutes);
app.use("/api/forgot-password", forgotPasswordRoutes);
app.use("/api/messages", messageRoutesFactory(io)); // pass io to messages routes
app.use("/api/follow", followRoutesFactory(io));
app.use("/api/explore", exploreRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/profile-views", profileViewsRouter);
app.use("/api/bug-reports", bugReportsRouter);
app.use("/api/notifications", notificationRoutes);
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`Server + Socket.IO running on port ${PORT}`),
);

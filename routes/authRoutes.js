const express = require("express");
const pool = require("../config/db");
const generatePresignedUrl = require("../config/generatePresignedUrl");
const auth = require("../middlewares/authMiddleware");
const router = express.Router();
const {
  registerUser,
  loginUser,
  resetPassword,
  checkEmailExists,
  userDetails
} = require("../controllers/authController");

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/reset-password", resetPassword);
router.post("/check-email", checkEmailExists);
// GET current user profile
router.get("/me", auth, async (req, res) => {
  const userId = req.user.id;

  const result = await pool.query(
    `SELECT
       id,
       first_name,
       last_name,
       email,
       university,
       course,
       location,
       profile
     FROM users
     WHERE id = $1`,
    [userId]
  );

  if (!result.rows.length) {
    return res.status(404).json({ msg: "User not found" });
  }

  const user = result.rows[0];

  user.profile = user.profile
    ? await generatePresignedUrl(user.profile)
    : null;

  res.json(user);
});

module.exports = router;

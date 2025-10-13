const express = require("express");
const router = express.Router();
const {
  registerUser,
  loginUser,
  resetPassword,
  checkEmailExists,
} = require("../controllers/authController");

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/reset-password", resetPassword);
router.post("/check-email", checkEmailExists);
module.exports = router;

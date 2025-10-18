const express = require("express");
const { Resend } = require("resend"); // <-- destructure here
const router = express.Router();
const pool = require("../config/db");
const resend = new Resend(process.env.RESEND_API_KEY);
// In-memory store (for production use DB/Redis)
const otpStoreForgot = new Map();
const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();
const OTP_EXPIRY = 5 * 60 * 1000; // 5 minutes

// Send OTP for forgot password
router.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ msg: "Email is required" });

  try {
    const checkEmail = await pool.query(
      "SELECT 1 FROM users WHERE email = $1",
      [email]
    );
    if (checkEmail.rows.length === 0) {
      return res.status(400).json({ msg: "Email is not  registered" });
    }

    const otp = generateOtp();
    otpStoreForgot.set(email, { otp, expires: Date.now() + OTP_EXPIRY });
    await resend.emails.send({
      from: "Aroundu@aroundu.me", // must be verified in Resend
      to: email,
      subject: "Your Forgot Password OTP",
      text: `Your OTP code is ${otp}. It expires in 5 minutes.`,
    });
    res.json({ msg: "OTP sent successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Failed to send OTP" });
  }
});

// Verify OTP
router.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp)
    return res.status(400).json({ msg: "Email and OTP required" });

  const record = otpStoreForgot.get(email);
  if (!record) return res.json({ verified: false, msg: "OTP not found" });

  if (Date.now() > record.expires) {
    otpStoreForgot.delete(email);
    return res.json({ verified: false, msg: "OTP expired" });
  }

  if (record.otp !== otp)
    return res.json({ verified: false, msg: "Invalid OTP" });

  otpStoreForgot.delete(email);
  res.json({ verified: true });
});

module.exports = router;

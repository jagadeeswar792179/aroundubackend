// otpRoutes.js
const express = require("express");
const crypto = require("crypto");
const { Resend } = require("resend"); // <-- destructure here
const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

// In-memory OTP store
const otpStore = new Map(); // key: email, value: { otp, expires }

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
const OTP_EXPIRY = 5 * 60 * 1000; // 5 minutes

// Send OTP
router.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ msg: "Email is required" });

  try {
    const otp = generateOtp();
    const expires = Date.now() + OTP_EXPIRY;

    otpStore.set(email, { otp, expires });

    await resend.emails.send({
      from: "AroundU@aroundu.me", // change to your verified sender
      to: email,
      subject: "Your OTP Code",
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

  const record = otpStore.get(email);
  if (!record)
    return res.status(400).json({ verified: false, msg: "OTP not found" });

  if (Date.now() > record.expires) {
    otpStore.delete(email);
    return res.status(400).json({ verified: false, msg: "OTP expired" });
  }

  if (record.otp !== otp)
    return res.status(400).json({ verified: false, msg: "Invalid OTP" });

  otpStore.delete(email);
  res.json({ verified: true });
});

module.exports = router;

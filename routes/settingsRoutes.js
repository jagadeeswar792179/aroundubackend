const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const auth = require("../middlewares/authMiddleware");
const bcrypt = require("bcrypt");


// CHECK existing recovery email
router.get("/recovery-email/check", auth, async (req, res) => {

  const userId = req.user.id;

  try {

    const result = await pool.query(
      "SELECT recovery_email FROM users WHERE id = $1",
      [userId]
    );

    res.json(result.rows[0] || { recovery_email: null });

  } catch (err) {

    console.error(err);
    res.status(500).json({ msg: "Server error" });

  }

});


// UPDATE recovery email
router.put("/recovery-email", auth, async (req, res) => {

  const userId = req.user.id;
  const { recoveryEmail } = req.body;

  if (!recoveryEmail) {
    return res.status(400).json({ msg: "Recovery email required" });
  }

  try {

    await pool.query(
      "UPDATE users SET recovery_email = $1 WHERE id = $2",
      [recoveryEmail, userId]
    );

    res.json({ success: true });

  } catch (err) {

    console.error(err);
    res.status(500).json({ msg: "Server error" });

  }

});
router.put("/change-password", auth, async (req, res) => {

  const userId = req.user.id;
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ msg: "All fields required" });
  }

  try {

    const user = await pool.query(
      "SELECT password FROM users WHERE id=$1",
      [userId]
    );

    if (!user.rows.length) {
      return res.status(404).json({ msg: "User not found" });
    }

    const match = await bcrypt.compare(
      oldPassword,
      user.rows[0].password
    );

    if (!match) {
      return res.status(400).json({ msg: "Incorrect old password" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE users SET password=$1 WHERE id=$2",
      [hashed, userId]
    );

    res.json({ success: true });

  } catch (err) {

    console.error(err);
    res.status(500).json({ msg: "Server error" });

  }

});

// CHECK phone number
router.get("/phone-number/check", auth, async (req, res) => {

  const userId = req.user.id;

  try {

    const result = await pool.query(
      "SELECT phone_number FROM users WHERE id=$1",
      [userId]
    );

    res.json(result.rows[0] || { phone_number: null });

  } catch (err) {

    console.error(err);
    res.status(500).json({ msg: "Server error" });

  }

});


// UPDATE phone number
router.put("/phone-number", auth, async (req, res) => {

  const userId = req.user.id;
  const { phoneNumber } = req.body;

  try {

    await pool.query(
      "UPDATE users SET phone_number=$1 WHERE id=$2",
      [phoneNumber, userId]
    );

    res.json({ success: true });

  } catch (err) {

    console.error(err);
    res.status(500).json({ msg: "Server error" });

  }

});
module.exports = router;
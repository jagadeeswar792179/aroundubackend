// controllers/authController.js
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const generatePresignedUrl = require("../config/generatePresignedUrl");

// REGISTER CONTROLLER
const registerUser = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      gender,
      userType,
      dob,
      university,
      interests,
      course,
      duration,
      specialization,
    } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ msg: "Missing required fields" });
    }

    // 🔽 Normalize email
    const emailLower = email.toLowerCase().trim();

    const existing = await pool.query("SELECT * FROM users WHERE email = $1", [
      emailLower,
    ]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ msg: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (
        first_name, last_name, email, password, gender, user_type, dob,
        university, interests, course, duration, specialization
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, first_name, last_name, email, university, course, user_type`,
      [
        firstName,
        lastName,
        emailLower, // ⬅️ store lowercase
        hashed,
        gender,
        userType,
        dob,
        university,
        interests,
        course || null,
        duration || null,
        specialization || null,
      ]
    );

    const user = result.rows[0];

    // create token with extra fields (id, university, course)
    const token = jwt.sign(
      { id: user.id, university: user.university, course: user.course },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.status(201).json({
      msg: "User registered",
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        university: user.university,
        course: user.course,
        user_type: user.user_type,
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ msg: "Registration failed", error: err.message });
  }
};

// LOGIN CONTROLLER
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ msg: "Email and password are required" });
    }

    // Normalize email
    const emailLower = email.toLowerCase().trim();

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      emailLower,
    ]);
    const user = result.rows[0];

    if (!user) return res.status(404).json({ msg: "User not found" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ msg: "Incorrect password" });

    // Get signed profile URL if exists
    let profileurl = null;
    try {
      profileurl = user.profile
        ? await generatePresignedUrl(user.profile)
        : null;
    } catch (e) {
      profileurl = null;
    }

    // 🔥 STORE FULL USER DATA IN TOKEN
    const token = jwt.sign(
      {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        user_type: user.user_type,
        university: user.university,
        course: user.course,
        location: user.location,
        profile: profileurl,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" } // token valid for 7 days
    );

    res.json({
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        user_type: user.user_type,
        profile: profileurl,
        university: user.university,
        course: user.course,
        location: user.location,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ msg: "Login failed", error: err.message });
  }
};

// RESET PASSWORD CONTROLLER
const resetPassword = async (req, res) => {
  try {
    const { email, password, confirmPassword } = req.body;

    // Validate input
    if (!email || !password || !confirmPassword) {
      return res.status(400).json({ msg: "All fields are required" });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ msg: "Passwords do not match" });
    }

    // 🔽 Normalize email
    const emailLower = email.toLowerCase().trim();

    // Check if user exists
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      emailLower,
    ]);
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    // Hash new password
    const hashed = await bcrypt.hash(password, 10);

    // Update password in DB
    await pool.query("UPDATE users SET password = $1 WHERE email = $2", [
      hashed,
      emailLower,
    ]);

    res.json({ msg: "Password reset successfully" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ msg: "Password reset failed", error: err.message });
  }
};

// CHECK EMAIL EXISTS CONTROLLER
const checkEmailExists = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ msg: "Email is required" });
    }

    // 🔽 Normalize email
    const emailLower = email.toLowerCase().trim();

    const result = await pool.query("SELECT id FROM users WHERE email = $1", [
      emailLower,
    ]);

    if (result.rows.length > 0) {
      return res.json({ exists: true, msg: "Email already registered" });
    } else {
      return res.json({ exists: false, msg: "Email not found" });
    }
  } catch (err) {
    console.error("Check email error:", err);
    res.status(500).json({ msg: "Server error", error: err.message });
  }
};

module.exports = {
  registerUser,
  loginUser,
  resetPassword,
  checkEmailExists,
};

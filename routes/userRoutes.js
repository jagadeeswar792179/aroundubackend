// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const pool = require("../config/db"); // pg Pool instance
const auth = require("../middlewares/authMiddleware"); // verifies JWT, sets req.user.id
const multer = require("multer");
const upload = multer();
const uploadToS3 = require("../config/s3Upload");
const generatePresignedUrl = require("../config/generatePresignedUrl");
// GET /api/users/me
// GET /api/users/me

router.put("/update-location", auth, async (req, res) => {
  try {
    const userId = req.user.id; // from auth middleware
    const { location } = req.body;

    if (!location || location.trim() === "") {
      return res.status(400).json({ msg: "Location is required" });
    }

    await pool.query("UPDATE users SET location = $1 WHERE id = $2", [
      location.trim(),
      userId,
    ]);

    res.json({ msg: "Location updated", location });
  } catch (err) {
    console.error("Update location error:", err);
    res.status(500).json({ msg: "Failed to update location" });
  }
});

router.get("/me", auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         first_name,
         last_name,
         location,
         email,
         gender,
         dob,
         user_type,
         university,
         course,
         duration,
         specialization,
         profile,
         verified,     -- ✅ ADD THIS
         blog_link,    -- ✅ ADD THIS
         COALESCE(interests, ARRAY[]::text[]) AS interests,
         COALESCE(experience, '[]'::jsonb) AS experience,
         COALESCE(projects, '[]'::jsonb) AS projects,
         COALESCE(skills, ARRAY[]::text[]) AS skills,
         COALESCE(education, '[]'::jsonb) AS education,
         COALESCE(about, '') AS about,
         created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    // ✅ presign avatar if stored as key
    if (user.profile) {
      user.profile = generatePresignedUrl(user.profile);
    }

    res.json(user);
  } catch (err) {
    console.error("❌ /me failed:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/users/upload-profile
router.post(
  "/upload-profile",
  auth,
  upload.single("profile_pic"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const key = await uploadToS3(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      await pool.query("UPDATE users SET profile = $1 WHERE id = $2", [
        key,
        req.user.id,
      ]);

      res.json({ key });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// GET /api/users/profile-url?key=...
router.get("/profile-url", auth, async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "Missing key" });

    const url = generatePresignedUrl(key);
    res.json({ url });
  } catch (err) {
    console.error("Error generating presigned URL:", err);
    res.status(500).json({ error: "Could not generate URL" });
  }
});

// PATCH /api/profile/about { about }
router.patch("/about", auth, async (req, res) => {
  try {
    const { about } = req.body;
    if (!about && about.trim() == "")
      return res.status(404).json({ error: "field is empty" });
    if (about.length > 150)
      return res.status(404).json({ error: "only less than 150 characters" });
    const { rows } = await pool.query(
      "UPDATE users SET about = $1 WHERE id = $2 RETURNING id, about",
      [about || null, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    return res.json(rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

router.patch("/experience", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const newExperienceArray = req.body; // expecting an array of objects

    // Validate array format
    if (!Array.isArray(newExperienceArray)) {
      return res.status(400).json({ error: "Invalid experience data" });
    }

    // Update JSONB field
    const updatedUser = await pool.query(
      "UPDATE users SET experience = $1 WHERE id = $2 RETURNING experience",
      [JSON.stringify(newExperienceArray), userId]
    );

    res.json({ experience: updatedUser.rows[0].experience });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.patch("/education", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const newEducationArray = req.body; // expecting an array of objects

    // Validate array format
    if (!Array.isArray(newEducationArray)) {
      return res.status(400).json({ error: "Invalid experience data" });
    }

    // Update JSONB field
    const updatedUser = await pool.query(
      "UPDATE users SET education = $1 WHERE id = $2 RETURNING education",
      [JSON.stringify(newEducationArray), userId]
    );

    res.json({ education: updatedUser.rows[0].education });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.patch("/projects", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const newProjectsArray = req.body; // expecting an array of objects

    // Validate array format
    if (!Array.isArray(newProjectsArray)) {
      return res.status(400).json({ error: "Invalid experience data" });
    }

    // Update JSONB field
    const updatedUser = await pool.query(
      "UPDATE users SET projects = $1 WHERE id = $2 RETURNING projects",
      [JSON.stringify(newProjectsArray), userId]
    );

    res.json({ projects: updatedUser.rows[0].projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// PATCH /api/user/skills
router.patch("/skills", auth, async (req, res) => {
  try {
    const { skills } = req.body; // expects { skills: ["React","Node.js"] }

    if (!Array.isArray(skills)) {
      return res.status(400).json({ error: "Skills must be an array" });
    }
    if (skills.length > 15) {
      return res.status(400).json({ error: "Max 15 skills allowed" });
    }

    // Optionally normalize (trim) and dedupe
    const cleaned = [
      ...new Set(skills.map((s) => String(s).trim()).filter(Boolean)),
    ].slice(0, 15);

    // Update text[] column
    const { rows } = await pool.query(
      "UPDATE users SET skills = $1 WHERE id = $2 RETURNING skills",
      [cleaned, req.user.id] // pg will coerce JS array -> text[]
    );

    res.json({ skills: rows[0].skills });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});
router.patch("/interests", auth, async (req, res) => {
  try {
    const { interests } = req.body; // expects { skills: ["React","Node.js"] }

    if (!Array.isArray(interests)) {
      return res.status(400).json({ error: "interests must be an array" });
    }
    if (interests.length > 7) {
      return res.status(400).json({ error: "Max 7 interests allowed" });
    }

    // Optionally normalize (trim) and dedupe
    const cleaned = [
      ...new Set(interests.map((s) => String(s).trim()).filter(Boolean)),
    ].slice(0, 15);

    // Update text[] column
    const { rows } = await pool.query(
      "UPDATE users SET interests = $1 WHERE id = $2 RETURNING interests",
      [cleaned, req.user.id] // pg will coerce JS array -> text[]
    );

    res.json({ interests: rows[0].interests });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/saved-posts", auth, async (req, res) => {
  const userId = req.user.id; // from JWT
  const { page = 1 } = req.query;
  const pageSize = 15;
  const offset = (page - 1) * pageSize;

  try {
    const result = await pool.query(
      `
      SELECT 
        p.*,
        u.first_name,
        u.last_name,
        u.profile,
        u.course,
        u.university,

        -- count likes
        COUNT(DISTINCT pl.id) AS like_count,

        -- check if current user liked
        BOOL_OR(pl.user_id = $1) AS liked_by_me,

        -- check if current user saved
        BOOL_OR(sp2.user_id = $1) AS saved_by_me,

        -- collect list of liked users (limit 20)
        COALESCE(
          ARRAY_AGG(DISTINCT u2.first_name || ' ' || u2.last_name) 
          FILTER (WHERE pl.user_id IS NOT NULL), 
          '{}'
        ) AS liked_users,

        -- count comments
        COUNT(DISTINCT c.id) AS comment_count

      FROM saved_posts sp
      JOIN posts p ON sp.post_id = p.id
      JOIN users u ON p.user_id = u.id
      LEFT JOIN post_likes pl ON p.id = pl.post_id
      LEFT JOIN users u2 ON pl.user_id = u2.id
      LEFT JOIN comments c ON p.id = c.post_id
      LEFT JOIN saved_posts sp2 ON p.id = sp2.post_id
      WHERE sp.user_id = $1
      GROUP BY p.id, u.id, sp.created_at
      ORDER BY sp.created_at DESC
      LIMIT $2 OFFSET $3;
      `,
      [userId, pageSize, offset]
    );

    const posts = result.rows.map((post) => ({
      ...post,
      image_url: post.image_url ? generatePresignedUrl(post.image_url) : null,
      user: {
        first_name: post.first_name,
        last_name: post.last_name,
        avatar_url: post.profile ? generatePresignedUrl(post.profile) : null,
        course: post.course,
        university: post.university,
      },
      like_count: Number(post.like_count),
      comment_count: Number(post.comment_count),
      liked_by_me: post.liked_by_me,
      saved_by_me: post.saved_by_me,
      liked_users: post.liked_users,
    }));

    res.json({
      posts,
      hasMore: result.rows.length === pageSize,
    });
  } catch (err) {
    console.error("❌ Error fetching saved posts:", err);
    res.status(500).json({ error: "Failed to fetch saved posts" });
  }
});

// ✅ Get all posts of a user with pagination
router.get("/activity", auth, async (req, res) => {
  const { userId } = req.query;
  // const userId = req.user.id;
  const limit = parseInt(req.query.limit) || 3; // default 3
  const offset = parseInt(req.query.offset) || 0; // default 0

  try {
    const result = await pool.query(
      `SELECT p.*,u.first_name,u.last_name
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const posts = await Promise.all(
      result.rows.map(async (post) => ({
        ...post,
        avatar_url: post.profile
          ? await generatePresignedUrl(post.profile)
          : null,
        image_url: post.image_url
          ? await generatePresignedUrl(post.image_url)
          : null,
      }))
    );

    res.json(posts);
  } catch (err) {
    console.error("Error fetching user posts:", err);
    res.status(500).json({ error: "Server error fetching posts" });
  }
});

router.delete("/delete/:id", auth, async (req, res) => {
  const userId = req.user.id; // ✅ from token
  const { id: postId } = req.params; // ✅ from route

  try {
    // Check if post exists and belongs to user
    const check = await pool.query("SELECT user_id FROM posts WHERE id = $1", [
      postId,
    ]);

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    if (check.rows[0].user_id !== userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to delete this post" });
    }

    // Delete the post
    await pool.query("DELETE FROM posts WHERE id = $1 AND user_id = $2", [
      postId,
      userId,
    ]);

    return res.json({ message: "Post deleted successfully" });
  } catch (err) {
    console.error("Error deleting post:", err);
    res.status(500).json({ error: "Server error deleting post" });
  }
});

// GET /api/user/profile/:userId
// GET /api/user/profile/:userId
router.get("/profile/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const viewerId = req.user.id; // logged-in user

    const { rows } = await pool.query(
      `SELECT
         u.id,
         u.first_name,
         u.last_name,
         u.location,
         u.university,
         u.course,
         u.duration,
         u.specialization,
         u.profile,
         COALESCE(u.interests, ARRAY[]::text[]) AS interests,
         COALESCE(u.experience, '[]'::jsonb) AS experience,
         COALESCE(u.projects, '[]'::jsonb) AS projects,
         COALESCE(u.skills, ARRAY[]::text[]) AS skills,
         COALESCE(u.education, '[]'::jsonb) AS education,
         COALESCE(u.about, '') AS about,
         u.created_at,

         -- 🔹 NEW FIELDS
         u.user_type,
         u.blog_link,
         u.verified,

         -- 👇 already there: did *I* block this user?
         EXISTS (
           SELECT 1 FROM blocks b
           WHERE b.blocker_id = $2
             AND b.blocked_id = u.id
         ) AS is_blocked_by_me
       FROM users u
       WHERE u.id = $1`,
      [userId, viewerId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    if (user.profile) {
      user.profile = generatePresignedUrl(user.profile);
    }

    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;

// // routes/postRoutes.js
const express = require("express");
const multer = require("multer");
const uploadToS3 = require("../config/s3Upload");
const pool = require("../config/db"); // your PostgreSQL pool
const router = express.Router();
const auth = require("../middlewares/authMiddleware"); // verifies JWT, sets req.user.id
const generatePresignedUrl = require("../config/generatePresignedUrl");

// notification helper
const notify = require("./notify");

const storage = multer.memoryStorage();
const upload = multer({ storage });

// POST /api/posts/upload
router.post("/upload", auth, upload.single("image"), async (req, res) => {
  try {
    const userId = req.user.id;
    const { caption, tags } = req.body;

    const imageBuffer = req.file.buffer;
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;

    // Upload image and get its key
    const s3Key = await uploadToS3(imageBuffer, fileName, mimeType);

    // Save only key to DB
    const query = `
      INSERT INTO posts (user_id, image_url, caption, tags, is_boosted)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const values = [
      userId,
      s3Key,
      caption,
      Array.isArray(tags) ? tags : JSON.parse(tags || "[]"),
      false,
    ];
    const result = await pool.query(query, values);

    // Generate signed URL for immediate frontend display (await)
    const signedUrl = await generatePresignedUrl(s3Key);

    res.status(201).json({ post: { ...result.rows[0], image_url: signedUrl } });
  } catch (err) {
    console.error("posts.upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// GET /api/posts/feed
router.get("/feed/all", auth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    const result = await pool.query(
      `
      SELECT 
        posts.*, 
        users.first_name, 
        users.last_name, 
        users.profile, 
        users.course, 
        users.university,

        -- follow_request rows (if any) in both directions
        (SELECT status FROM follow_requests 
           WHERE requester_id = $3 AND target_id = posts.user_id
           LIMIT 1
        ) AS my_follow_status,

        (SELECT status FROM follow_requests 
           WHERE requester_id = posts.user_id AND target_id = $3
           LIMIT 1
        ) AS incoming_follow_status,

        -- count likes
        COUNT(DISTINCT pl.id) AS like_count,

        -- check if current user liked
        BOOL_OR(pl.user_id = $3) AS liked_by_me,

        -- check if current user saved
        BOOL_OR(sp.user_id = $3) AS saved_by_me,

        -- collect list of liked users (limit 20 for performance)
        COALESCE(
          ARRAY_AGG(DISTINCT u2.first_name || ' ' || u2.last_name) 
          FILTER (WHERE pl.user_id IS NOT NULL), 
          '{}'
        ) AS liked_users,

        -- count comments
        COUNT(DISTINCT c.id) AS comment_count

      FROM posts
      JOIN users ON posts.user_id = users.id
      LEFT JOIN post_likes pl ON posts.id = pl.post_id
      LEFT JOIN users u2 ON pl.user_id = u2.id
      LEFT JOIN comments c ON posts.id = c.post_id
      LEFT JOIN saved_posts sp ON posts.id = sp.post_id

      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $1 LIMIT $2;
      `,
      [offset, pageSize, req.user.id]
    );

    const posts = await Promise.all(
      result.rows.map(async (post) => {
        // DB statuses can be: null | 'pending' | 'accepted' | 'rejected' | 'cancelled'
        const myStatus = post.my_follow_status;
        const incomingStatus = post.incoming_follow_status;

        // Simplified mapping:
        let follow_status = "follow";
        const myAccepted = myStatus === "accepted";
        const incomingAccepted = incomingStatus === "accepted";
        const myPending = myStatus === "pending";

        if (myAccepted && incomingAccepted) {
          follow_status = "friends";
        } else if (myPending) {
          follow_status = "requested";
        } else {
          follow_status = "follow";
        }

        // presign image & avatar (await)
        let imageUrl = null;
        try {
          imageUrl = post.image_url
            ? await generatePresignedUrl(post.image_url)
            : null;
        } catch (err) {
          console.warn(
            "presign post image failed",
            post.id,
            err && err.message
          );
          imageUrl = null;
        }
        let avatarUrl = null;
        try {
          avatarUrl = post.profile
            ? await generatePresignedUrl(post.profile)
            : null;
        } catch (err) {
          console.warn(
            "presign avatar failed",
            post.user_id,
            err && err.message
          );
          avatarUrl = null;
        }

        return {
          // explicit clarity for frontend
          owner_id: post.user_id,

          ...post,
          loggedinUser: req.user.id,
          image_url: imageUrl,
          user: {
            first_name: post.first_name,
            last_name: post.last_name,
            avatar_url: avatarUrl,
            course: post.course,
            university: post.university,
          },
          like_count: Number(post.like_count),
          comment_count: Number(post.comment_count),
          liked_by_me: post.liked_by_me,
          saved_by_me: post.saved_by_me,
          liked_users: post.liked_users,
          // simplified follow status: 'follow' | 'requested' | 'friends'
          follow_status,
          my_follow_status: post.my_follow_status,
          incoming_follow_status: post.incoming_follow_status,
        };
      })
    );

    res.json({ posts });
  } catch (err) {
    console.error("❌ Failed to fetch feed:", err);
    res.status(500).json({ error: "Failed to load posts" });
  }
});
// ✅ Get posts matching user interests
router.get("/feed/interests", auth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    // fetch current user interests
    const intRes = await pool.query(
      `SELECT interests FROM users WHERE id = $1`,
      [req.user.id]
    );
    const interests = intRes.rows[0]?.interests || [];

    const result = await pool.query(
      `
      SELECT posts.*, users.first_name, users.last_name, users.profile, users.course, users.university,
             (SELECT status FROM follow_requests WHERE requester_id = $3 AND target_id = posts.user_id LIMIT 1) AS my_follow_status,
             (SELECT status FROM follow_requests WHERE requester_id = posts.user_id AND target_id = $3 LIMIT 1) AS incoming_follow_status,
             COUNT(DISTINCT pl.id) AS like_count,
             BOOL_OR(pl.user_id = $3) AS liked_by_me,
             BOOL_OR(sp.user_id = $3) AS saved_by_me,
             COALESCE(ARRAY_AGG(DISTINCT u2.first_name || ' ' || u2.last_name) FILTER (WHERE pl.user_id IS NOT NULL), '{}') AS liked_users,
             COUNT(DISTINCT c.id) AS comment_count
      FROM posts
      JOIN users ON posts.user_id = users.id
      LEFT JOIN post_likes pl ON posts.id = pl.post_id
      LEFT JOIN users u2 ON pl.user_id = u2.id
      LEFT JOIN comments c ON posts.id = c.post_id
      LEFT JOIN saved_posts sp ON posts.id = sp.post_id
      WHERE posts.tags && $4::text[]   -- ✅ match at least one interest
      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $1 LIMIT $2;
      `,
      [offset, pageSize, req.user.id, interests]
    );

    res.json({ posts: await mapPosts(result.rows, req.user.id) });
  } catch (err) {
    console.error("❌ Failed to fetch interests feed:", err);
    res.status(500).json({ error: "Failed to load posts" });
  }
});

// helper (same mapping logic you had before)
async function mapPosts(rows, loggedInUserId) {
  return Promise.all(
    rows.map(async (post) => {
      let follow_status = "follow";
      if (
        post.my_follow_status === "accepted" &&
        post.incoming_follow_status === "accepted"
      ) {
        follow_status = "friends";
      } else if (post.my_follow_status === "pending") {
        follow_status = "requested";
      }

      let imageUrl = null;
      try {
        imageUrl = post.image_url
          ? await generatePresignedUrl(post.image_url)
          : null;
      } catch {}
      let avatarUrl = null;
      try {
        avatarUrl = post.profile
          ? await generatePresignedUrl(post.profile)
          : null;
      } catch {}

      return {
        owner_id: post.user_id,
        ...post,
        loggedinUser: loggedInUserId,
        image_url: imageUrl,
        user: {
          first_name: post.first_name,
          last_name: post.last_name,
          avatar_url: avatarUrl,
          course: post.course,
          university: post.university,
        },
        like_count: Number(post.like_count),
        comment_count: Number(post.comment_count),
        liked_by_me: post.liked_by_me,
        saved_by_me: post.saved_by_me,
        liked_users: post.liked_users,
        follow_status,
      };
    })
  );
}
// POST /api/posts/:postId/comments
router.post("/:postId/comments", auth, async (req, res) => {
  const { postId } = req.params;
  const { content } = req.body;
  const userId = req.user.id;

  if (!content || content.trim() === "") {
    return res.status(400).json({ error: "Comment cannot be empty" });
  }

  try {
    const insertResult = await pool.query(
      `INSERT INTO comments (post_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [postId, userId, content]
    );

    const commentRow = insertResult.rows[0];

    // Fetch commenter info
    const userResult = await pool.query(
      `SELECT first_name, last_name, profile FROM users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0];

    // Notify the post owner (if not self)
    const postOwnerRes = await pool.query(
      "SELECT user_id FROM posts WHERE id = $1 LIMIT 1",
      [postId]
    );
    const postOwner = postOwnerRes.rows[0]?.user_id;
    const io = req.app && req.app.get && req.app.get("io");

    if (postOwner && postOwner !== userId) {
      try {
        await notify(io, {
          toUserId: postOwner,
          actorId: userId,
          type: "comment",
          entityId: commentRow.id,
          entityType: "comment",
          data: { postId, commentText: commentRow.content },
        });
      } catch (err) {
        console.warn("notify comment -> owner failed", err && err.message);
      }
    }

    // Optionally notify recent commenters (avoid notifying the owner again and the commenter themself)
    try {
      const recentCommentersRes = await pool.query(
        `SELECT DISTINCT user_id FROM comments WHERE post_id = $1 AND user_id <> $2 LIMIT 5`,
        [postId, userId]
      );
      for (const r of recentCommentersRes.rows) {
        const recip = r.user_id;
        if (!recip || recip === postOwner || recip === userId) continue;
        try {
          await notify(io, {
            toUserId: recip,
            actorId: userId,
            type: "comment_mention",
            entityId: postId,
            entityType: "post",
            data: { commentId: commentRow.id, commentText: commentRow.content },
          });
        } catch (err) {
          console.warn(
            "notify comment -> recent commenter failed",
            recip,
            err && err.message
          );
        }
      }
    } catch (err) {
      console.warn("fetch recent commenters failed", err && err.message);
    }

    res.json({
      id: commentRow.id,
      content: commentRow.content,
      created_at: commentRow.created_at,
      user: {
        id: userId,
        name: `${user.first_name} ${user.last_name}`,
        avatar_url: user.profile
          ? await generatePresignedUrl(user.profile)
          : null,
      },
    });
  } catch (err) {
    console.error("Error adding comment:", err);
    res.status(500).json({ error: "Failed to add comment" });
  }
});

// GET /api/posts/:postId/comments?page=1
router.get("/:postId/comments", auth, async (req, res) => {
  const { postId } = req.params;
  const { page = 1 } = req.query;
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  const userId = req.user.id; // logged in user

  try {
    const result = await pool.query(
      `
      SELECT 
        c.id,
        c.content,
        c.created_at,
        c.user_id,
        u.first_name,
        u.last_name,
        u.profile,
        -- like count
        COALESCE(COUNT(cl.id), 0) AS like_count,
        -- check if current user liked
        COALESCE(BOOL_OR(cl.user_id = $4), false) AS liked_by_me
      FROM comments c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN comment_likes cl ON cl.comment_id = c.id
      WHERE c.post_id = $1
      GROUP BY c.id, u.id
      ORDER BY c.created_at DESC
      OFFSET $2 LIMIT $3
      `,
      [postId, offset, pageSize, userId]
    );

    const comments = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        content: row.content,
        created_at: row.created_at,
        like_count: Number(row.like_count), // ensure integer
        liked_by_me: row.liked_by_me === true, // force boolean
        user: {
          id: row.user_id,
          name: `${row.first_name} ${row.last_name}`,
          avatar_url: row.profile
            ? await generatePresignedUrl(row.profile)
            : null,
        },
      }))
    );

    res.json({ comments });
  } catch (err) {
    console.error("❌ Failed to fetch paginated comments", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// PATCH /api/posts/:id/like
router.patch("/:id/like", auth, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    // Check if user already liked this post
    const existing = await pool.query(
      "SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2",
      [postId, userId]
    );

    const io = req.app && req.app.get && req.app.get("io");

    if (existing.rows.length > 0) {
      // Already liked → remove like
      await pool.query(
        "DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2",
        [postId, userId]
      );
    } else {
      // Not liked → add like
      await pool.query(
        "INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)",
        [postId, userId]
      );

      // notify the post owner (if not self)
      try {
        const pRes = await pool.query(
          "SELECT user_id FROM posts WHERE id = $1 LIMIT 1",
          [postId]
        );
        const postOwner = pRes.rows[0]?.user_id;
        if (postOwner && postOwner !== userId) {
          await notify(io, {
            toUserId: postOwner,
            actorId: userId,
            type: "like",
            entityId: postId,
            entityType: "post",
            data: { message: "liked your post" },
          });
        }
      } catch (err) {
        console.warn("notify like failed", err && err.message);
      }
    }

    // Return updated count + whether this user likes it
    const { rows } = await pool.query(
      `SELECT 
         COUNT(*)::int AS like_count,
         BOOL_OR(user_id = $2) AS liked_by_me
       FROM post_likes
       WHERE post_id = $1`,
      [postId, userId]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("Error toggling like:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/posts/:id/likes?page=1
router.get("/:id/likes", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1 } = req.query;
    const pageSize = 20;
    const offset = (page - 1) * pageSize;

    const result = await pool.query(
      `
      SELECT u.id, u.first_name, u.last_name, u.profile, u.course, u.university
      FROM post_likes pl
      JOIN users u ON pl.user_id = u.id
      WHERE pl.post_id = $1
      ORDER BY pl.created_at DESC
      OFFSET $2 LIMIT $3
      `,
      [id, offset, pageSize]
    );

    const users = await Promise.all(
      result.rows.map(async (u) => ({
        id: u.id,
        name: `${u.first_name} ${u.last_name}`,
        avatar_url: u.profile ? await generatePresignedUrl(u.profile) : null,
        course: u.course,
        university: u.university,
      }))
    );

    res.json({ users });
  } catch (err) {
    console.error("❌ Failed to fetch likes:", err);
    res.status(500).json({ error: "Failed to load likes" });
  }
});

// POST /api/comments/:commentId/like
router.post("/comments/:commentId/like", auth, async (req, res) => {
  const { commentId } = req.params;
  const userId = req.user.id;

  try {
    const existing = await pool.query(
      "SELECT id FROM comment_likes WHERE comment_id=$1 AND user_id=$2",
      [commentId, userId]
    );

    if (existing.rows.length > 0) {
      // Unlike
      await pool.query(
        "DELETE FROM comment_likes WHERE comment_id=$1 AND user_id=$2",
        [commentId, userId]
      );

      const countRes = await pool.query(
        "SELECT COUNT(*) FROM comment_likes WHERE comment_id=$1",
        [commentId]
      );

      return res.json({
        liked: false,
        like_count: parseInt(countRes.rows[0].count, 10),
      });
    } else {
      // Like
      await pool.query(
        "INSERT INTO comment_likes (comment_id, user_id) VALUES ($1, $2)",
        [commentId, userId]
      );

      const countRes = await pool.query(
        "SELECT COUNT(*) FROM comment_likes WHERE comment_id=$1",
        [commentId]
      );

      return res.json({
        liked: true,
        like_count: parseInt(countRes.rows[0].count, 10),
      });
    }
  } catch (err) {
    console.error("❌ Failed to toggle comment like:", err);
    res.status(500).json({ error: "Failed to like comment" });
  }
});

// Toggle save/unsave a post
router.post("/:postId/save", auth, async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.id;

  try {
    // Check if post already saved
    const existing = await pool.query(
      `SELECT id FROM saved_posts WHERE user_id = $1 AND post_id = $2`,
      [userId, postId]
    );

    if (existing.rows.length > 0) {
      // Unsave (delete row)
      await pool.query(
        `DELETE FROM saved_posts WHERE user_id = $1 AND post_id = $2`,
        [userId, postId]
      );
      return res.json({ saved: false });
    } else {
      // Save (insert row)
      await pool.query(
        `INSERT INTO saved_posts (user_id, post_id) VALUES ($1, $2)`,
        [userId, postId]
      );
      return res.json({ saved: true });
    }
  } catch (err) {
    console.error("Error toggling save:", err);
    res.status(500).json({ error: "Failed to toggle save" });
  }
});

// GET /api/posts/tag/:tag?page=N
router.get("/tag/:tag", auth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const pageSize = 9; // 9 posts per page
    const offset = (page - 1) * pageSize;
    const tag = req.params.tag;

    const result = await pool.query(
      `
      SELECT 
        posts.*, 
        users.first_name, 
        users.last_name, 
        users.profile, 
        users.course, 
        users.university,

        -- counts / aggregates (DISTINCT to avoid duplication)
        COUNT(DISTINCT pl.id) AS like_count,
        BOOL_OR(pl.user_id = $3) AS liked_by_me,
        BOOL_OR(sp.user_id = $3) AS saved_by_me,
        COALESCE(
          ARRAY_AGG(DISTINCT u2.first_name || ' ' || u2.last_name) 
            FILTER (WHERE pl.user_id IS NOT NULL),
          '{}'
        ) AS liked_users,
        COUNT(DISTINCT c.id) AS comment_count

      FROM posts
      JOIN users ON posts.user_id = users.id
      LEFT JOIN post_likes pl ON posts.id = pl.post_id
      LEFT JOIN users u2 ON pl.user_id = u2.id
      LEFT JOIN comments c ON posts.id = c.post_id
      LEFT JOIN saved_posts sp ON posts.id = sp.post_id

      /* filter by tag (posts.tags is a text[] column) */
      WHERE $4 = ANY(posts.tags)

      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $1 LIMIT $2;
      `,
      [offset, pageSize, req.user.id, tag]
    );

    const posts = await Promise.all(
      result.rows.map(async (post) => ({
        // keep the DB row, but normalize/shape fields for client
        id: post.id,
        user_id: post.user_id,
        image_url: post.image_url
          ? await generatePresignedUrl(post.image_url)
          : null,
        caption: post.caption,
        tags: post.tags || [],
        is_boosted: post.is_boosted,
        created_at: post.created_at,
        // user sub-object
        user: {
          first_name: post.first_name,
          last_name: post.last_name,
          avatar_url: post.profile
            ? await generatePresignedUrl(post.profile)
            : null,
          course: post.course,
          university: post.university,
        },
        // engagement fields (cast to numbers / booleans)
        like_count: Number(post.like_count) || 0,
        comment_count: Number(post.comment_count) || 0,
        liked_by_me: Boolean(post.liked_by_me),
        saved_by_me: Boolean(post.saved_by_me),
        liked_users: post.liked_users || [],
      }))
    );

    res.json({ posts });
  } catch (err) {
    // log full stack for debugging
    console.error("❌ Failed to fetch posts by tag:", err.stack || err);
    return res.status(500).json({ error: "Failed to load posts for tag" });
  }
});

module.exports = router;

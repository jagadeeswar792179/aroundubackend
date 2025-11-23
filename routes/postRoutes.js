// routes/postRoutes.js
const express = require("express");
const multer = require("multer");
const uploadToS3 = require("../config/s3Upload");
const pool = require("../config/db");
const router = express.Router();
const auth = require("../middlewares/authMiddleware");
const generatePresignedUrl = require("../config/generatePresignedUrl");

// notification helper
const notify = require("./notify");

const storage = multer.memoryStorage();
const upload = multer({ storage });

/**
 * Helper: Build visibility clause for queries.
 * For feeds we only return posts that are either public OR
 * (visibility = 'university' AND users.university = requester's university)
 *
 * We always fetch requester's university from DB where needed.
 */
function safeEscapeSingleQuote(str) {
  return (str || "").replace(/'/g, "''");
}

/**
 * UPLOAD: POST /api/posts/upload
 * Accepts: image (file), caption, tags (JSON string or array), visibility ('public' | 'university')
 */
router.post("/upload", auth, upload.single("image"), async (req, res) => {
  try {
    const userId = req.user.id;
    const visibility =
      req.body.visibility === "university" ? "university" : "public";
    const caption = req.body.caption || null;
    const rawTags = req.body.tags || "[]";
    const tagsArray = Array.isArray(rawTags) ? rawTags : JSON.parse(rawTags);

    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    // Upload to S3
    const imageBuffer = req.file.buffer;
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const s3Key = await uploadToS3(imageBuffer, fileName, mimeType);
    const postype = "photo";

    // Insert into DB
    const insertSql = `
      INSERT INTO posts (user_id, image_url, caption, tags, is_boosted, post_type, visibility)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const insertVals = [
      userId,
      s3Key,
      caption,
      tagsArray,
      false,
      postype,
      visibility,
    ];
    const result = await pool.query(insertSql, insertVals);
    const created = result.rows[0];

    // Fetch user info
    const userRes = await pool.query(
      `SELECT id, first_name, last_name, profile, course, university, user_type
       FROM users WHERE id = $1`,
      [userId]
    );
    const userRow = userRes.rows[0];

    // Presign URLs
    const signedPostUrl = created.image_url
      ? await generatePresignedUrl(created.image_url)
      : null;
    const signedAvatarUrl = userRow.profile
      ? await generatePresignedUrl(userRow.profile)
      : null;

    // Normalize post like in feed
    const normalizedPost = {
      id: created.id,
      user_id: created.user_id,
      caption: created.caption,
      tags: created.tags || [],
      is_boosted: created.is_boosted,
      created_at: created.created_at,
      visibility: created.visibility,
      like_count: 0,
      comment_count: 0,
      liked_by_me: false,
      saved_by_me: false,
      liked_users: [],
      image_url: signedPostUrl,
      post_type: created.post_type,
      user: {
        id: userRow.id,
        first_name: userRow.first_name,
        last_name: userRow.last_name,
        avatar_url: signedAvatarUrl,
        course: userRow.course,
        university: userRow.university,
        role: userRow.user_type, // ENUM: student|professor
      },
      owner_id: created.user_id,
      follow_status: "follow", // new post starts with default
    };

    return res.status(201).json({
      msg: "✅ Post uploaded successfully",
      post: normalizedPost,
    });
  } catch (err) {
    console.error("posts.upload error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

router.post("/discussion", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { content, visibility, tags } = req.body;

    // normalize visibility
    const vis = visibility === "university" ? "university" : "public";

    // handle tags (must be array, max 7)
    const tagsArray = Array.isArray(tags)
      ? tags.slice(0, 7)
      : typeof tags === "string"
      ? JSON.parse(tags).slice(0, 7)
      : [];

    // validate content
    if (
      !content ||
      typeof content !== "string" ||
      content.trim().length === 0
    ) {
      return res.status(400).json({ error: "Content is required" });
    }

    // insert into DB
    const insertSql = `
      INSERT INTO posts (user_id, image_url, caption, tags, is_boosted, visibility, post_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const insertVals = [
      userId,
      null,
      content.trim(),
      tagsArray,
      false,
      vis,
      "discussion",
    ];
    const result = await pool.query(insertSql, insertVals);
    const created = result.rows[0];

    // fetch user info
    const userRes = await pool.query(
      `SELECT id, first_name, last_name, profile, course, university, user_type
       FROM users WHERE id = $1`,
      [userId]
    );
    const userRow = userRes.rows[0];

    // presign profile URL
    const signedAvatarUrl = userRow.profile
      ? await generatePresignedUrl(userRow.profile)
      : null;

    // normalized response
    const normalizedPost = {
      id: created.id,
      user_id: created.user_id,
      caption: created.caption, // discussion content
      tags: created.tags || [],
      post_type: created.post_type,
      is_boosted: created.is_boosted,
      created_at: created.created_at,
      visibility: created.visibility,
      like_count: 0,
      comment_count: 0,
      liked_by_me: false,
      saved_by_me: false,
      liked_users: [],
      image_url: null,
      user: {
        id: userRow.id,
        first_name: userRow.first_name,
        last_name: userRow.last_name,
        avatar_url: signedAvatarUrl,
        course: userRow.course,
        university: userRow.university,
        role: userRow.user_type,
      },
      owner_id: created.user_id,
      follow_status: "follow",
    };

    return res.status(201).json({
      msg: "✅ Discussion created successfully",
      post: normalizedPost,
    });
  } catch (err) {
    console.error("posts.discussion error:", err);
    return res.status(500).json({ error: "Failed to create discussion" });
  }
});

/**
 * Helper: mapRows -> normalized posts with presigned URLs
 * Expects rows as returned by SQL queries selecting posts.* plus user fields
 */
async function mapPosts(rows, loggedInUserId) {
  return Promise.all(
    rows.map(async (post) => {
      // compute follow_status
      let follow_status = "follow";
      if (
        post.my_follow_status === "accepted" &&
        post.incoming_follow_status === "accepted"
      ) {
        follow_status = "friends";
      } else if (post.my_follow_status === "pending") {
        follow_status = "requested";
      }

      // presign post image & avatar if present
      let imageUrl = null;
      try {
        imageUrl = post.image_url
          ? await generatePresignedUrl(post.image_url)
          : null;
      } catch (e) {
        imageUrl = null;
      }
      let avatarUrl = null;
      try {
        avatarUrl = post.profile
          ? await generatePresignedUrl(post.profile)
          : null;
      } catch (e) {
        avatarUrl = null;
      }

      return {
        // base post props (keep DB fields like id, created_at, visibility)
        id: post.id,
        user_id: post.user_id,
        caption: post.caption,
        tags: post.tags || [],
        is_boosted: post.is_boosted,
        created_at: post.created_at,
        visibility: post.visibility,
        post_type: post.post_type,
        // engagement fields
        like_count: Number(post.like_count) || 0,
        comment_count: Number(post.comment_count) || 0,
        liked_by_me: Boolean(post.liked_by_me),
        saved_by_me: Boolean(post.saved_by_me),
        liked_users: post.liked_users || [],
        // imagemap
        image_url: imageUrl,
        loggedinUser: loggedInUserId,
        // follow status
        follow_status,
        my_follow_status: post.my_follow_status,
        incoming_follow_status: post.incoming_follow_status,
        // user subobject including role (user_type)
        user: {
          id: post.user_id,
          first_name: post.first_name,
          last_name: post.last_name,
          avatar_url: avatarUrl,
          course: post.course,
          university: post.university,
          role: post.user_type, // <-- enum from DB: 'student' | 'professor'
        },
      };
    })
  );
}

/**
 * FEED: /feed/all
 * Returns posts respecting visibility rules (public OR university posts if requester in same uni).
 * Supports optional ?page=N and optional ?university=.. or ?course=.. to filter further.
 */
router.get("/feed/all", auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const pageSize = 10;
    const offset = (page - 1) * pageSize;
    const filterUniversity = req.query.university || null;
    const filterCourse = req.query.course || null;
    const currentUserId = req.user.id;

    // get requester's university to allow university-visibility posts
    const meRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [currentUserId]
    );
    const requesterUniversity = meRes.rows[0]?.university || null;

    // Build visibility SQL fragment
    // If requester has a university, allow posts.visibility = 'university' AND users.university = requesterUniversity
    // Otherwise only public posts allowed
    let visClause;
    const params = [offset, pageSize, currentUserId]; // note: $1/$2 used for offset/limit in query; $3 is currentUserId
    if (requesterUniversity) {
      // We'll append requesterUniversity as $4
      visClause = `(posts.visibility = 'public' OR (posts.visibility = 'university' AND users.university = $4))`;
      params.push(requesterUniversity); // $4
    } else {
      visClause = `(posts.visibility = 'public')`;
    }

    // Build optional filters (university/course)
    let filterSql = "";
    if (filterUniversity) {
      // we need to append param for filterUniversity
      params.push(filterUniversity);
      const idx = params.length; // e.g., 5 or 4
      filterSql += ` AND users.university = $${idx}`;
    }
    if (filterCourse) {
      params.push(filterCourse);
      const idx = params.length;
      filterSql += ` AND users.course = $${idx}`;
    }

    // final param positions:
    // OFFSET $1::bigint LIMIT $2::bigint
    // follow subqueries use $3 (currentUserId)
    // optional: $4 requesterUniversity
    // then optional filters appended.

    const sql = `
      SELECT 
        posts.*,
        users.first_name,
        users.last_name,
        users.profile,
        users.course,
        users.university,
        users.user_type,
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
      WHERE ${visClause}
      ${filterSql}
      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $1::bigint LIMIT $2::bigint;
    `;

    // final params start with current params order: offset, limit, currentUserId, [requesterUniversity], [filterUniversity], [filterCourse]
    const finalParams = [offset, pageSize, currentUserId];
    if (requesterUniversity) finalParams.push(requesterUniversity);
    if (filterUniversity) finalParams.push(filterUniversity);
    if (filterCourse) finalParams.push(filterCourse);

    const result = await pool.query(sql, finalParams);
    const posts = await mapPosts(result.rows, currentUserId);

    res.json({ posts });
  } catch (err) {
    console.error(
      "❌ Failed to fetch feed (all):",
      err && err.stack ? err.stack : err
    );
    res.status(500).json({ error: "Failed to load posts" });
  }
});

/**
 * FEED: /feed/interests
 * Returns posts where posts.tags && user's interests (AND visibility rules)
 */
router.get("/feed/interests", auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const pageSize = 10;
    const offset = (page - 1) * pageSize;
    const filterUniversity = req.query.university || null;
    const filterCourse = req.query.course || null;
    const currentUserId = req.user.id;

    // fetch current user interests
    const intRes = await pool.query(
      `SELECT interests FROM users WHERE id = $1 LIMIT 1`,
      [currentUserId]
    );
    const interests = intRes.rows[0]?.interests || [];
    if (!Array.isArray(interests) || interests.length === 0) {
      return res.json({ posts: [] });
    }

    // fetch requester university (for visibility)
    const meRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [currentUserId]
    );
    const requesterUniversity = meRes.rows[0]?.university || null;

    let visClause;
    const params = [offset, pageSize, currentUserId, interests]; // position reserved: $4 for interests
    if (requesterUniversity) {
      visClause = `(posts.visibility = 'public' OR (posts.visibility = 'university' AND users.university = $5))`;
      params.push(requesterUniversity); // $5
    } else {
      visClause = `(posts.visibility = 'public')`;
    }

    // optional filters
    let filterSql = "";
    if (filterUniversity) {
      params.push(filterUniversity);
      filterSql += ` AND users.university = $${params.length}`;
    }
    if (filterCourse) {
      params.push(filterCourse);
      filterSql += ` AND users.course = $${params.length}`;
    }

    // Note: $4 is interests array for tags matching
    const sql = `
      SELECT
        posts.*,
        users.first_name,
        users.last_name,
        users.profile,
        users.course,
        users.university,
        users.user_type,
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
      WHERE ${visClause}
        AND posts.tags && $4::text[]
      ${filterSql}
      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $1::bigint LIMIT $2::bigint;
    `;

    const finalParams = [offset, pageSize, currentUserId, interests];
    if (requesterUniversity) finalParams.push(requesterUniversity);
    if (filterUniversity) finalParams.push(filterUniversity);
    if (filterCourse) finalParams.push(filterCourse);

    const result = await pool.query(sql, finalParams);
    const posts = await mapPosts(result.rows, currentUserId);
    res.json({ posts });
  } catch (err) {
    console.error(
      "❌ Failed to fetch interests feed:",
      err && err.stack ? err.stack : err
    );
    res.status(500).json({ error: "Failed to load posts" });
  }
});

/**
 * FEED: /feed/university
 * Returns posts created by users from the specified university.
 * Query: ?page=N&university=University%20Name
 * If university param omitted, the requester's university is used.
 */
router.get("/feed/university", auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const pageSize = 10;
    const offset = (page - 1) * pageSize;
    const qUniversity = req.query.university || null;
    const currentUserId = req.user.id;

    // fetch requester's university
    const meRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [currentUserId]
    );
    const requesterUniversity = meRes.rows[0]?.university || null;

    const targetUniversity = qUniversity || requesterUniversity;
    if (!targetUniversity) {
      return res.status(400).json({
        error: "university parameter is required (or set in your profile)",
      });
    }

    // Determine visibility: if requester belongs to that university they can see university-visibility posts for that uni.
    const allowUniVisibility =
      requesterUniversity && requesterUniversity === targetUniversity;

    // Build SQL and params
    // param order: $1 offset, $2 limit, $3 currentUserId, $4 targetUniversity (if allowUniVisibility)
    const params = [offset, pageSize, currentUserId];
    let visClause = `(posts.visibility = 'public')`;
    if (allowUniVisibility) {
      visClause = `(posts.visibility = 'public' OR (posts.visibility = 'university' AND users.university = $4))`;
      params.push(targetUniversity); // $4
    }

    // The users.university filter to restrict posts to targetUniversity:
    const userFilter = allowUniVisibility
      ? `AND users.university = $4`
      : `AND users.university = $${params.length + 1}`;
    if (!allowUniVisibility) params.push(targetUniversity);

    // Final SQL
    const sql = `
      SELECT
        posts.*,
        users.first_name,
        users.last_name,
        users.profile,
        users.course,
        users.university,
        users.user_type,
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
      WHERE ${visClause}
      ${userFilter}
      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $1::bigint LIMIT $2::bigint;
    `;

    const result = await pool.query(sql, params);
    const posts = await mapPosts(result.rows, currentUserId);
    res.json({ posts });
  } catch (err) {
    console.error(
      "❌ Failed to fetch university feed:",
      err && err.stack ? err.stack : err
    );
    res.status(500).json({ error: "Failed to load university posts" });
  }
});

/**
 * FEED: /feed/course
 * Returns posts created by users who have users.course = <course>.
 * Query: ?page=N&course=Course%20Name
 * Visibility: posts.visibility = 'public' OR (posts.visibility='university' AND requester's university matches post user's university)
 */
router.get("/feed/course", auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const pageSize = 10;
    const offset = (page - 1) * pageSize;
    const qCourse = req.query.course || null;
    const currentUserId = req.user.id;

    const targetCourse = qCourse;
    if (!targetCourse)
      return res.status(400).json({ error: "course parameter is required" });

    // fetch requester's university to allow uni-visibility posts
    const meRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [currentUserId]
    );
    const requesterUniversity = meRes.rows[0]?.university || null;

    // param positions: $1 offset, $2 limit, $3 currentUserId, $4 targetCourse, optional $5 requesterUniversity
    const params = [offset, pageSize, currentUserId, targetCourse];

    // visibility clause: public OR (visibility='university' AND users.university = requesterUniversity) [only if requesterUniversity present]
    let visibilityClause = `posts.visibility = 'public'`;
    if (requesterUniversity) {
      params.push(requesterUniversity); // $5
      visibilityClause = `(posts.visibility = 'public' OR (posts.visibility = 'university' AND users.university = $5))`;
    }

    const sql = `
      SELECT
        posts.*,
        users.first_name,
        users.last_name,
        users.profile,
        users.course,
        users.university,
        users.user_type,
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
      WHERE users.course = $4
        AND (${visibilityClause})
      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $1::bigint LIMIT $2::bigint;
    `;

    const result = await pool.query(sql, params);
    const posts = await mapPosts(result.rows, currentUserId);
    res.json({ posts });
  } catch (err) {
    console.error(
      "❌ Failed to fetch course feed:",
      err && err.stack ? err.stack : err
    );
    res.status(500).json({ error: "Failed to load course posts" });
  }
});

/**
 * TAG route: GET /api/posts/tag/:tag?page=N
 * Tag results respect visibility rules as well.
 */
router.get("/tag/:tag", auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1", 10);
    const pageSize = 9;
    const offset = (page - 1) * pageSize;
    const tag = req.params.tag;
    const filterUniversity = req.query.university || null;
    const filterCourse = req.query.course || null;
    const currentUserId = req.user.id;

    // fetch requester university for visibility
    const meRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [currentUserId]
    );
    const requesterUniversity = meRes.rows[0]?.university || null;

    const params = [offset, pageSize, currentUserId, tag]; // $4 = tag
    let visClause = `(posts.visibility = 'public')`;
    if (requesterUniversity) {
      visClause = `(posts.visibility = 'public' OR (posts.visibility = 'university' AND users.university = $5))`;
      params.push(requesterUniversity); // $5
    }

    if (filterUniversity) {
      params.push(filterUniversity);
    }
    if (filterCourse) {
      params.push(filterCourse);
    }

    // Build filters referencing correct param index positions
    const filterSqlParts = [];
    if (filterUniversity) {
      const idx = params.indexOf(filterUniversity) + 1; // 1-based param index for SQL placeholders
      filterSqlParts.push(`users.university = $${idx}`);
    }
    if (filterCourse) {
      const idx = params.indexOf(filterCourse) + 1;
      filterSqlParts.push(`users.course = $${idx}`);
    }
    const filterSql = filterSqlParts.length
      ? `AND ${filterSqlParts.join(" AND ")}`
      : "";

    const sql = `
      SELECT 
        posts.*, 
        users.first_name, 
        users.last_name, 
        users.profile, 
        users.course, 
        users.university,
        users.user_type,
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
      WHERE ${visClause}
        AND $4 = ANY(posts.tags)
      ${filterSql}
      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $1::bigint LIMIT $2::bigint;
    `;

    const finalParams = [offset, pageSize, currentUserId, tag];
    if (requesterUniversity) finalParams.push(requesterUniversity);
    if (filterUniversity) finalParams.push(filterUniversity);
    if (filterCourse) finalParams.push(filterCourse);

    const result = await pool.query(sql, finalParams);

    const posts = await mapPosts(result.rows, currentUserId);
    res.json({ posts });
  } catch (err) {
    console.error(
      "❌ Failed to fetch posts by tag:",
      err && err.stack ? err.stack : err
    );
    return res.status(500).json({ error: "Failed to load posts for tag" });
  }
});

/**
 * COMMENTS: POST /api/posts/:postId/comments
 */
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

    // Optionally notify recent commenters
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
    console.error("Error adding comment:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Failed to add comment" });
  }
});

/**
 * GET comments with pagination: GET /api/posts/:postId/comments?page=1
 */
router.get("/:postId/comments", auth, async (req, res) => {
  const { postId } = req.params;
  const { page = 1 } = req.query;
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  const userId = req.user.id;

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
        COALESCE(COUNT(cl.id), 0) AS like_count,
        COALESCE(BOOL_OR(cl.user_id = $4), false) AS liked_by_me
      FROM comments c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN comment_likes cl ON cl.comment_id = c.id
      WHERE c.post_id = $1
      GROUP BY c.id, u.id
      ORDER BY c.created_at DESC
      OFFSET $2::bigint LIMIT $3::bigint
      `,
      [postId, offset, pageSize, userId]
    );

    const comments = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        content: row.content,
        created_at: row.created_at,
        like_count: Number(row.like_count),
        liked_by_me: row.liked_by_me === true,
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
    console.error(
      "❌ Failed to fetch paginated comments",
      err && err.stack ? err.stack : err
    );
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

/**
 * LIKE toggle: PATCH /api/posts/:id/like
 */
router.patch("/:id/like", auth, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const existing = await pool.query(
      "SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2",
      [postId, userId]
    );
    const io = req.app && req.app.get && req.app.get("io");

    if (existing.rows.length > 0) {
      await pool.query(
        "DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2",
        [postId, userId]
      );
    } else {
      await pool.query(
        "INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)",
        [postId, userId]
      );

      // notify owner
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

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS like_count, BOOL_OR(user_id = $2) AS liked_by_me FROM post_likes WHERE post_id = $1`,
      [postId, userId]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("Error toggling like:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET likes for a post: GET /api/posts/:id/likes?page=1
 */
router.get("/:id/likes", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page || "1", 10);
    const pageSize = 20;
    const offset = (page - 1) * pageSize;

    const result = await pool.query(
      `
      SELECT u.id, u.first_name, u.last_name, u.profile, u.course, u.university, u.user_type
      FROM post_likes pl
      JOIN users u ON pl.user_id = u.id
      WHERE pl.post_id = $1
      ORDER BY pl.created_at DESC
      OFFSET $2::bigint LIMIT $3::bigint
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
        role: u.user_type,
      }))
    );

    res.json({ users });
  } catch (err) {
    console.error(
      "❌ Failed to fetch likes:",
      err && err.stack ? err.stack : err
    );
    res.status(500).json({ error: "Failed to load likes" });
  }
});

/**
 * COMMENT LIKE toggle: POST /api/posts/comments/:commentId/like
 * Note: in your previous file path was router.post("/comments/:commentId/like", ...) — keep consistent path usage.
 */
router.post("/comments/:commentId/like", auth, async (req, res) => {
  const { commentId } = req.params;
  const userId = req.user.id;

  try {
    const existing = await pool.query(
      "SELECT id FROM comment_likes WHERE comment_id=$1 AND user_id=$2",
      [commentId, userId]
    );

    if (existing.rows.length > 0) {
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
    console.error(
      "❌ Failed to toggle comment like:",
      err && err.stack ? err.stack : err
    );
    res.status(500).json({ error: "Failed to like comment" });
  }
});

/**
 * TOGGLE SAVE: POST /api/posts/:postId/save
 */
router.post("/:postId/save", auth, async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.id;

  try {
    const existing = await pool.query(
      `SELECT id FROM saved_posts WHERE user_id = $1 AND post_id = $2`,
      [userId, postId]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `DELETE FROM saved_posts WHERE user_id = $1 AND post_id = $2`,
        [userId, postId]
      );
      return res.json({ saved: false });
    } else {
      await pool.query(
        `INSERT INTO saved_posts (user_id, post_id) VALUES ($1, $2)`,
        [userId, postId]
      );
      return res.json({ saved: true });
    }
  } catch (err) {
    console.error("Error toggling save:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Failed to toggle save" });
  }
});

module.exports = router;

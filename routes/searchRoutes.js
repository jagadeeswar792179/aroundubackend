// routes/searchRoutes.js
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const auth = require("../middlewares/authMiddleware");
const generatePresignedUrl = require("../config/generatePresignedUrl"); // must be async and return URL or null

// Helper: parse page param
function parsePage(qs) {
  const page = Math.max(1, parseInt(qs.page || "1", 10));
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

/**
 * GET /api/search/students?q=...&page=1
 */
router.get("/students", auth, async (req, res) => {
  try {
    const rawQ = (req.query.q || "").toString().trim();
    if (!rawQ) return res.json({ results: [] });

    const { offset, pageSize } = parsePage(req.query);
    const queryLike = `%${rawQ}%`;

    const sql = `
      SELECT id, first_name, last_name, course, university, profile
      FROM users
      WHERE user_type = 'student'
        AND (
          first_name ILIKE $1 OR
          last_name ILIKE $1 OR
          university ILIKE $1 OR
          course ILIKE $1
        )
      ORDER BY created_at DESC
      OFFSET $2 LIMIT $3
    `;
    const dbRes = await pool.query(sql, [queryLike, offset, pageSize]);

    // Presign profile images for each student
    const students = await Promise.all(
      dbRes.rows.map(async (stu) => {
        let avatarUrl = null;
        try {
          avatarUrl = stu.profile
            ? await generatePresignedUrl(stu.profile)
            : null;
        } catch (err) {
          console.warn(
            "presign student profile failed",
            stu.id,
            err && err.message
          );
          avatarUrl = null;
        }

        return {
          ...stu,
          avatar_url: avatarUrl,
        };
      })
    );

    return res.json({ results: students });
  } catch (err) {
    console.error("❌ /api/search/students failed:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

/**
 * GET /api/search/professors?q=...&page=1
 */
router.get("/professors", auth, async (req, res) => {
  try {
    const rawQ = (req.query.q || "").toString().trim();
    if (!rawQ) return res.json({ results: [] });
    const { offset, pageSize } = parsePage(req.query);
    const queryLike = `%${rawQ}%`;

    const sql = `
      SELECT id, first_name, last_name, specialization, university, profile
      FROM users
      WHERE user_type = 'professor'
        AND (
          first_name ILIKE $1 OR
          last_name ILIKE $1 OR
          university ILIKE $1 OR
          specialization ILIKE $1
        )
      ORDER BY created_at DESC
      OFFSET $2 LIMIT $3
    `;
    const dbRes = await pool.query(sql, [queryLike, offset, pageSize]);

    // Presign profile images
    const professors = await Promise.all(
      dbRes.rows.map(async (prof) => {
        let avatarUrl = null;
        try {
          avatarUrl = prof.profile
            ? await generatePresignedUrl(prof.profile)
            : null;
        } catch (err) {
          console.warn(
            "presign professor profile failed",
            prof.id,
            err && err.message
          );
        }

        return {
          ...prof,
          avatar_url: avatarUrl, // frontend can use this directly
        };
      })
    );

    return res.json({ results: professors });
  } catch (err) {
    console.error("❌ /api/search/professors failed:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

/**
 * GET /api/search/posts?q=...&page=1
 *
 * Returns enriched post objects (same shape as /api/posts/feed) for tag-based search.
 * First tries strict case-insensitive element equality (fast). If that returns no rows,
 * falls back to array_to_string substring, then tags::text match (very forgiving).
 */
router.get("/posts", auth, async (req, res) => {
  try {
    const rawQ = (req.query.q || "").toString();
    let normalized = rawQ.trim();
    if (!normalized) return res.json({ results: [] });
    if (normalized.startsWith("#")) normalized = normalized.slice(1);
    normalized = normalized.trim();
    if (!normalized) return res.json({ results: [] });

    const { offset, pageSize } = parsePage(req.query);

    // exact-match SQL (fast)
    const sqlExact = `
      SELECT 
        posts.*,
        users.first_name,
        users.last_name,
        users.profile,
        users.course,
        users.university,
        (SELECT status FROM follow_requests WHERE requester_id = $4 AND target_id = posts.user_id LIMIT 1) AS my_follow_status,
        (SELECT status FROM follow_requests WHERE requester_id = posts.user_id AND target_id = $4 LIMIT 1) AS incoming_follow_status,
        COUNT(DISTINCT pl.id) AS like_count,
        BOOL_OR(pl.user_id = $4) AS liked_by_me,
        BOOL_OR(sp.user_id = $4) AS saved_by_me,
        COALESCE(ARRAY_AGG(DISTINCT u2.first_name || ' ' || u2.last_name) FILTER (WHERE pl.user_id IS NOT NULL), '{}') AS liked_users,
        COUNT(DISTINCT c.id) AS comment_count
      FROM posts
      JOIN users ON posts.user_id = users.id
      LEFT JOIN post_likes pl ON posts.id = pl.post_id
      LEFT JOIN users u2 ON pl.user_id = u2.id
      LEFT JOIN comments c ON posts.id = c.post_id
      LEFT JOIN saved_posts sp ON posts.id = sp.post_id
      WHERE EXISTS (SELECT 1 FROM unnest(posts.tags) AS t WHERE lower(t) = lower($1))
      GROUP BY posts.id, users.id
      ORDER BY posts.created_at DESC
      OFFSET $2 LIMIT $3
    `;

    // console.log("SEARCH POSTS params:", {
    //   normalized,
    //   offset,
    //   pageSize,
    //   userId: req.user && req.user.id,
    // });

    let dbRes = await pool.query(sqlExact, [
      normalized,
      offset,
      pageSize,
      req.user.id,
    ]);
    let rows = dbRes.rows || [];
    let usedFallback = false;

    if (!rows.length) {
      // fallback 1: array_to_string substring match
      usedFallback = true;
      console.warn(
        "SEARCH POSTS: exact-match returned 0 rows — trying fallback array_to_string ILIKE."
      );
      const sqlFallback = `
        SELECT 
          posts.*,
          users.first_name,
          users.last_name,
          users.profile,
          users.course,
          users.university,
          (SELECT status FROM follow_requests WHERE requester_id = $4 AND target_id = posts.user_id LIMIT 1) AS my_follow_status,
          (SELECT status FROM follow_requests WHERE requester_id = posts.user_id AND target_id = $4 LIMIT 1) AS incoming_follow_status,
          COUNT(DISTINCT pl.id) AS like_count,
          BOOL_OR(pl.user_id = $4) AS liked_by_me,
          BOOL_OR(sp.user_id = $4) AS saved_by_me,
          COALESCE(ARRAY_AGG(DISTINCT u2.first_name || ' ' || u2.last_name) FILTER (WHERE pl.user_id IS NOT NULL), '{}') AS liked_users,
          COUNT(DISTINCT c.id) AS comment_count
        FROM posts
        JOIN users ON posts.user_id = users.id
        LEFT JOIN post_likes pl ON posts.id = pl.post_id
        LEFT JOIN users u2 ON pl.user_id = u2.id
        LEFT JOIN comments c ON posts.id = c.post_id
        LEFT JOIN saved_posts sp ON posts.id = sp.post_id
        WHERE array_to_string(posts.tags, ',') ILIKE '%' || $1 || '%'
        GROUP BY posts.id, users.id
        ORDER BY posts.created_at DESC
        OFFSET $2 LIMIT $3
      `;
      dbRes = await pool.query(sqlFallback, [
        normalized,
        offset,
        pageSize,
        req.user.id,
      ]);
      rows = dbRes.rows || [];
    }

    if (!rows.length) {
      // fallback 2: text-cast match
      console.warn(
        "SEARCH POSTS: array_to_string fallback returned 0 rows — trying tags::text match."
      );
      const sqlTextCast = `
        SELECT 
          posts.*,
          users.first_name,
          users.last_name,
          users.profile,
          users.course,
          users.university,
          (SELECT status FROM follow_requests WHERE requester_id = $4 AND target_id = posts.user_id LIMIT 1) AS my_follow_status,
          (SELECT status FROM follow_requests WHERE requester_id = posts.user_id AND target_id = $4 LIMIT 1) AS incoming_follow_status,
          COUNT(DISTINCT pl.id) AS like_count,
          BOOL_OR(pl.user_id = $4) AS liked_by_me,
          BOOL_OR(sp.user_id = $4) AS saved_by_me,
          COALESCE(ARRAY_AGG(DISTINCT u2.first_name || ' ' || u2.last_name) FILTER (WHERE pl.user_id IS NOT NULL), '{}') AS liked_users,
          COUNT(DISTINCT c.id) AS comment_count
        FROM posts
        JOIN users ON posts.user_id = users.id
        LEFT JOIN post_likes pl ON posts.id = pl.post_id
        LEFT JOIN users u2 ON pl.user_id = u2.id
        LEFT JOIN comments c ON posts.id = c.post_id
        LEFT JOIN saved_posts sp ON posts.id = sp.post_id
        WHERE tags::text ILIKE '%' || ('"' || $1 || '"') || '%'
        GROUP BY posts.id, users.id
        ORDER BY posts.created_at DESC
        OFFSET $2 LIMIT $3
      `;
      dbRes = await pool.query(sqlTextCast, [
        normalized,
        offset,
        pageSize,
        req.user.id,
      ]);
      rows = dbRes.rows || [];
    }

    // console.log(
    //   "SEARCH POSTS result count:",
    //   rows.length,
    //   "usedFallback:",
    //   usedFallback
    // );

    // presign and map
    const posts = await Promise.all(
      rows.map(async (post) => {
        const myStatus = post.my_follow_status;
        const incomingStatus = post.incoming_follow_status;
        let follow_status = "follow";
        if (myStatus === "accepted" && incomingStatus === "accepted")
          follow_status = "friends";
        else if (myStatus === "pending") follow_status = "requested";

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
          owner_id: post.user_id,
          ...post,
          image_url: imageUrl,
          user: {
            first_name: post.first_name,
            last_name: post.last_name,
            avatar_url: avatarUrl,
            course: post.course,
            university: post.university,
          },
          like_count: Number(post.like_count || 0),
          comment_count: Number(post.comment_count || 0),
          liked_by_me: !!post.liked_by_me,
          saved_by_me: !!post.saved_by_me,
          liked_users: post.liked_users || [],
          follow_status,
          my_follow_status: post.my_follow_status,
          incoming_follow_status: post.incoming_follow_status,
        };
      })
    );

    return res.json({ results: posts, posts });
  } catch (err) {
    console.error("❌ /api/search/posts failed:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

module.exports = router;

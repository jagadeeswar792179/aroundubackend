// routes/exploreRoutes.js
const express = require("express");
const router = express.Router();
const pool = require("../config/db"); // your pg pool
const auth = require("../middlewares/authMiddleware"); // your auth middleware
const generatePresignedUrl = require("../config/generatePresignedUrl"); // returns URL or null

/**
 * GET /api/explore/professors?page=1&same_university=true
 * - Page size = 4, max cap = 20
 * - same_university=true => only professors from the same university as current user
 * - same_university=false => only professors NOT from the same university (random)
 * - If user has no university:
 *    - same_university=true -> returns empty
 *    - same_university=false -> returns random professors (no exclusion)
 */
router.get("/professors", auth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const PAGE_SIZE = 4;
    const MAX_TOTAL = 20;
    const sameUniversityFlag = req.query.same_university === "true";

    const offset = (page - 1) * PAGE_SIZE;
    const remaining = Math.max(0, MAX_TOTAL - offset);
    const limit = Math.min(PAGE_SIZE, remaining);
    if (limit <= 0) {
      return res.json({ professors: [], hasMore: false, totalMatching: 0 });
    }

    // fetch current user's university
    const uRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [req.user.id]
    );
    const myUniversity = uRes.rows[0]?.university || null;

    // same_university requested but user has no university -> empty result
    if (sameUniversityFlag && !myUniversity) {
      return res.json({ professors: [], hasMore: false, totalMatching: 0 });
    }

    // Build queries depending on flag and whether current user has a university
    let countQuery, countParams;
    let dataQuery, dataParams;

    if (sameUniversityFlag) {
      countQuery = `
        SELECT COUNT(*)::int AS cnt
        FROM users
        WHERE user_type = 'professor' AND university = $1
      `;
      countParams = [myUniversity];

      dataQuery = `
        SELECT id, first_name, last_name, profile AS profile_key,
               university, specialization, about, course, followers_count, created_at
        FROM users
        WHERE user_type = 'professor' AND university = $3
        ORDER BY followers_count DESC NULLS LAST, created_at DESC
        OFFSET $1 LIMIT $2
      `;
      dataParams = [offset, limit, myUniversity];
    } else {
      if (myUniversity) {
        countQuery = `
          SELECT COUNT(*)::int AS cnt
          FROM users
          WHERE user_type = 'professor' AND (university IS NULL OR university <> $1)
        `;
        countParams = [myUniversity];

        dataQuery = `
          SELECT id, first_name, last_name, profile AS profile_key,
                 university, specialization, about, course, followers_count, created_at
          FROM users
          WHERE user_type = 'professor' AND (university IS NULL OR university <> $3)
          ORDER BY random()
          OFFSET $1 LIMIT $2
        `;
        dataParams = [offset, limit, myUniversity];
      } else {
        countQuery = `
          SELECT COUNT(*)::int AS cnt
          FROM users
          WHERE user_type = 'professor'
        `;
        countParams = [];

        dataQuery = `
          SELECT id, first_name, last_name, profile AS profile_key,
                 university, specialization, about, course, followers_count, created_at
          FROM users
          WHERE user_type = 'professor'
          ORDER BY random()
          OFFSET $1 LIMIT $2
        `;
        dataParams = [offset, limit];
      }
    }

    // get total matching (cap at MAX_TOTAL)
    const countRes = await pool.query(countQuery, countParams);
    const totalMatching = Math.min(
      Number(countRes.rows[0]?.cnt || 0),
      MAX_TOTAL
    );

    // fetch page
    const dataRes = await pool.query(dataQuery, dataParams);
    const rows = dataRes.rows || [];

    // presign profile keys in parallel (generatePresignedUrl should accept key or full url)
    const presignPromises = rows.map((r) =>
      generatePresignedUrl(r.profile_key)
    );
    const presigned = await Promise.all(presignPromises);

    const professors = rows.map((r, idx) => ({
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      avatar_url: presigned[idx] || null,
      university: r.university,
      specialization: r.specialization,
      about: r.about,
      course: r.course,
      followers_count: r.followers_count || 0,
    }));

    const loadedSoFar = offset + professors.length;
    const hasMore = loadedSoFar < totalMatching && loadedSoFar < MAX_TOTAL;

    return res.json({ professors, hasMore, totalMatching });
  } catch (err) {
    console.error("❌ explore/professors error", err);
    return res.status(500).json({ error: "Failed to fetch professors" });
  }
});

// GET /api/explore/people?page=1&same_university=true|false
router.get("/people", auth, async (req, res) => {
  try {
    const PAGE_SIZE = 6;
    const MAX_TOTAL = 30;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const sameUniversity = req.query.same_university === "true";

    const offset = (page - 1) * PAGE_SIZE;
    const remaining = Math.max(0, MAX_TOTAL - offset);
    const limit = Math.min(PAGE_SIZE, remaining);
    if (limit <= 0)
      return res.json({ people: [], hasMore: false, totalMatching: 0 });

    const meId = req.user.id;

    // fetch current user's university (text)
    const uRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [meId]
    );
    const myUniversity = uRes.rows[0]?.university || null;

    // If sameUniversity requested but user has no university -> empty
    if (sameUniversity && !myUniversity) {
      return res.json({ people: [], hasMore: false, totalMatching: 0 });
    }

    // Build count and data queries with explicit param order
    let countSql, countParams;
    let dataSql, dataParams;

    if (sameUniversity) {
      // Count: users from same university, excluding me and excluding already requested/followed
      countSql = `
        SELECT COUNT(DISTINCT u.id)::int AS cnt
        FROM users u
        WHERE u.id <> $1
          AND u.university = $2
          AND NOT EXISTS (
            SELECT 1 FROM follow_requests fr WHERE fr.requester_id = $1 AND fr.target_id = u.id
          )
      `;
      countParams = [meId, myUniversity];

      // Data: same university, ordered by followers_count desc (trending)
      dataSql = `
        SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
               u.university, u.specialization, u.about, u.course, u.interests, u.followers_count
        FROM users u
        WHERE u.id <> $1
          AND u.university = $2
          AND NOT EXISTS (
            SELECT 1 FROM follow_requests fr WHERE fr.requester_id = $1 AND fr.target_id = u.id
          )
        ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
        OFFSET $3 LIMIT $4
      `;
      dataParams = [meId, myUniversity, offset, limit];
    } else {
      // other universities (exclude myUniversity if present)
      if (myUniversity) {
        countSql = `
          SELECT COUNT(DISTINCT u.id)::int AS cnt
          FROM users u
          WHERE u.id <> $1
            AND (u.university IS NULL OR u.university <> $2)
            AND NOT EXISTS (SELECT 1 FROM follow_requests fr WHERE fr.requester_id = $1 AND fr.target_id = u.id)
        `;
        countParams = [meId, myUniversity];

        dataSql = `
          SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
                 u.university, u.specialization, u.about, u.course, u.interests, u.followers_count
          FROM users u
          WHERE u.id <> $1
            AND (u.university IS NULL OR u.university <> $2)
            AND NOT EXISTS (SELECT 1 FROM follow_requests fr WHERE fr.requester_id = $1 AND fr.target_id = u.id)
          ORDER BY random()
          OFFSET $3 LIMIT $4
        `;
        dataParams = [meId, myUniversity, offset, limit];
      } else {
        // user has no university -> don't exclude by university
        countSql = `
          SELECT COUNT(DISTINCT u.id)::int AS cnt
          FROM users u
          WHERE u.id <> $1
            AND NOT EXISTS (SELECT 1 FROM follow_requests fr WHERE fr.requester_id = $1 AND fr.target_id = u.id)
        `;
        countParams = [meId];

        dataSql = `
          SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
                 u.university, u.specialization, u.about, u.course, u.interests, u.followers_count
          FROM users u
          WHERE u.id <> $1
            AND NOT EXISTS (SELECT 1 FROM follow_requests fr WHERE fr.requester_id = $1 AND fr.target_id = u.id)
          ORDER BY random()
          OFFSET $2 LIMIT $3
        `;
        dataParams = [meId, offset, limit];
      }
    }

    // get total (capped)
    const countRes = await pool.query(countSql, countParams);
    const totalMatching = Math.min(
      Number(countRes.rows[0]?.cnt || 0),
      MAX_TOTAL
    );
    if (totalMatching === 0)
      return res.json({ people: [], hasMore: false, totalMatching: 0 });

    // get paged data
    const dataRes = await pool.query(dataSql, dataParams);
    const rows = dataRes.rows || [];

    const people = rows.map((r) => ({
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      avatar_url: r.profile_key ? generatePresignedUrl(r.profile_key) : null,
      university: r.university,
      specialization: r.specialization,
      about: r.about,
      course: r.course,
      interests: r.interests || [],
      followers_count: r.followers_count || 0,
    }));

    const loadedSoFar = offset + people.length;
    const hasMore = loadedSoFar < totalMatching && loadedSoFar < MAX_TOTAL;

    res.json({ people, hasMore, totalMatching });
  } catch (err) {
    console.error("❌ explore/people error", err);
    // If it's a PG error, return a safe message
    return res.status(500).json({ error: "Failed to fetch people" });
  }
});

module.exports = router;

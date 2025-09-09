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

// routes/exploreRoutes.js  - replace your existing /professors handler with this
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

    // fetch current user's university (safe access)
    const uRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [req.user.id]
    );
    const myUniversity = uRes.rows?.[0]?.university || null;

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

        /* REPLACED ORDER BY random() -> deterministic ordering so pagination is stable */
        dataQuery = `
          SELECT id, first_name, last_name, profile AS profile_key,
                 university, specialization, about, course, followers_count, created_at
          FROM users
          WHERE user_type = 'professor' AND (university IS NULL OR university <> $3)
          ORDER BY followers_count DESC NULLS LAST, created_at DESC
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

        /* REPLACED ORDER BY random() -> deterministic ordering */
        dataQuery = `
          SELECT id, first_name, last_name, profile AS profile_key,
                 university, specialization, about, course, followers_count, created_at
          FROM users
          WHERE user_type = 'professor'
          ORDER BY followers_count DESC NULLS LAST, created_at DESC
          OFFSET $1 LIMIT $2
        `;
        dataParams = [offset, limit];
      }
    }

    // get total matching (cap at MAX_TOTAL)
    const countRes = await pool.query(countQuery, countParams);
    const totalMatching = Math.min(
      Number(countRes.rows?.[0]?.cnt || 0),
      MAX_TOTAL
    );

    // fetch page
    const dataRes = await pool.query(dataQuery, dataParams);
    const rows = Array.isArray(dataRes.rows) ? dataRes.rows : [];

    // Defensive presigning:
    // - support async generatePresignedUrl (await)
    // - if presign fails for a row, log warning and return null for avatar_url (don't 500)
    const presigned = await Promise.all(
      rows.map(async (r) => {
        try {
          if (!r.profile_key) return null;
          const url = await generatePresignedUrl(r.profile_key);
          return url || null;
        } catch (err) {
          console.warn(
            "explore/professors: presign failed for key",
            r.profile_key,
            err?.message || err
          );
          return null;
        }
      })
    );

    const professors = rows.map((r) => ({
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      avatar_url: r.profile_key ? generatePresignedUrl(r.profile_key) : null,
      university: r.university,
      specialization: r.specialization,
      about: r.about,
      course: r.course,
      followers_count: r.followers_count || 0,
    }));

    const loadedSoFar = offset + professors.length;
    const hasMore = loadedSoFar < totalMatching && loadedSoFar < MAX_TOTAL;

    // optional debug: log fetched ids (remove in production)
    console.debug(
      "explore/professors: page",
      page,
      "fetchedIds:",
      professors.map((p) => p.id)
    );

    return res.json({ professors, hasMore, totalMatching });
  } catch (err) {
    console.error("❌ explore/professors error:", err?.stack || err);
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

    // fetch current user's university (text) and normalize
    const uRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [meId]
    );
    const rawUniv = uRes.rows?.[0]?.university;
    const myUniversity =
      typeof rawUniv === "string" && rawUniv.trim() !== ""
        ? rawUniv.trim()
        : null;

    // If sameUniversity requested but user has no university -> empty
    if (sameUniversity && !myUniversity) {
      return res.json({ people: [], hasMore: false, totalMatching: 0 });
    }

    // Build count and data queries (students only) with explicit param order
    let countSql, countParams;
    let dataSql, dataParams;

    if (sameUniversity) {
      // students from same university (exclude me only)
      countSql = `
        SELECT COUNT(*)::int AS cnt
        FROM users u
        WHERE u.user_type = 'student'
          AND u.id <> $1
          AND u.university = $2
      `;
      countParams = [meId, myUniversity];

      dataSql = `
        SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
               u.university, u.specialization, u.about, u.course, u.interests, u.followers_count, u.created_at
        FROM users u
        WHERE u.user_type = 'student'
          AND u.id <> $1
          AND u.university = $2
        ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
        OFFSET $3 LIMIT $4
      `;
      dataParams = [meId, myUniversity, offset, limit];
    } else {
      // Not sameUniversity -> choose students from other universities (if user has one)
      if (myUniversity) {
        countSql = `
          SELECT COUNT(*)::int AS cnt
          FROM users u
          WHERE u.user_type = 'student'
            AND u.id <> $1
            AND (u.university IS NULL OR u.university <> $2)
        `;
        countParams = [meId, myUniversity];

        dataSql = `
          SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
                 u.university, u.specialization, u.about, u.course, u.interests, u.followers_count, u.created_at
          FROM users u
          WHERE u.user_type = 'student'
            AND u.id <> $1
            AND (u.university IS NULL OR u.university <> $2)
          ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
          OFFSET $3 LIMIT $4
        `;
        dataParams = [meId, myUniversity, offset, limit];
      } else {
        // user has no university -> return students from everywhere (exclude me)
        countSql = `
          SELECT COUNT(*)::int AS cnt
          FROM users u
          WHERE u.user_type = 'student'
            AND u.id <> $1
        `;
        countParams = [meId];

        dataSql = `
          SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
                 u.university, u.specialization, u.about, u.course, u.interests, u.followers_count, u.created_at
          FROM users u
          WHERE u.user_type = 'student'
            AND u.id <> $1
          ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
          OFFSET $2 LIMIT $3
        `;
        dataParams = [meId, offset, limit];
      }
    }

    // get total (capped)
    const countRes = await pool.query(countSql, countParams);
    const totalMatching = Math.min(
      Number(countRes.rows?.[0]?.cnt || 0),
      MAX_TOTAL
    );
    if (totalMatching === 0)
      return res.json({ people: [], hasMore: false, totalMatching: 0 });

    // get paged data
    const dataRes = await pool.query(dataSql, dataParams);
    const rows = Array.isArray(dataRes.rows) ? dataRes.rows : [];

    // Defensive presigning (async): do not throw whole route on presign failure
    const presigned = await Promise.all(
      rows.map(async (r) => {
        try {
          if (!r.profile_key) return null;
          const url = await generatePresignedUrl(r.profile_key);
          return url || null;
        } catch (err) {
          console.warn(
            "explore/people: presign failed for key",
            r.profile_key,
            err?.message || err
          );
          return null;
        }
      })
    );

    const people = rows.map((r, idx) => ({
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      avatar_url: presigned[idx] || null,
      university: r.university,
      specialization: r.specialization,
      about: r.about,
      course: r.course,
      interests: r.interests || [],
      followers_count: r.followers_count || 0,
    }));

    const loadedSoFar = offset + people.length;
    const hasMore = loadedSoFar < totalMatching && loadedSoFar < MAX_TOTAL;

    return res.json({ people, hasMore, totalMatching });
  } catch (err) {
    console.error("❌ explore/people error:", err?.stack || err);
    return res.status(500).json({ error: "Failed to fetch people" });
  }
});

module.exports = router;

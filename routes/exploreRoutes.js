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

    const meId = req.user.id;

    // fetch current user's university (safe access)
    const uRes = await pool.query(
      "SELECT university FROM users WHERE id = $1 LIMIT 1",
      [meId]
    );
    const myUniversity =
      typeof uRes.rows?.[0]?.university === "string"
        ? uRes.rows[0].university.trim()
        : null;

    // same_university requested but user has no university -> empty result
    if (sameUniversityFlag && !myUniversity) {
      return res.json({ professors: [], hasMore: false, totalMatching: 0 });
    }

    let countQuery, countParams;
    let dataQuery, dataParams;

    if (sameUniversityFlag) {
      // 🔹 Professors from SAME university, excluding blocked in both directions
      countQuery = `
        SELECT COUNT(*)::int AS cnt
        FROM users u
        WHERE u.user_type = 'professor'
          AND u.university = $2
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = $1)
          )
      `;
      countParams = [meId, myUniversity];

      dataQuery = `
        SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
               u.university, u.specialization, u.about, u.course,
               u.followers_count, u.created_at
        FROM users u
        WHERE u.user_type = 'professor'
          AND u.university = $2
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = $1)
          )
        ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
        OFFSET $3 LIMIT $4
      `;
      dataParams = [meId, myUniversity, offset, limit];
    } else {
      if (myUniversity) {
        // 🔹 Professors from OTHER universities, excluding blocked in both directions
        countQuery = `
          SELECT COUNT(*)::int AS cnt
          FROM users u
          WHERE u.user_type = 'professor'
            AND (u.university IS NULL OR u.university <> $2)
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
        `;
        countParams = [meId, myUniversity];

        dataQuery = `
          SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
                 u.university, u.specialization, u.about, u.course,
                 u.followers_count, u.created_at
          FROM users u
          WHERE u.user_type = 'professor'
            AND (u.university IS NULL OR u.university <> $2)
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
          ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
          OFFSET $3 LIMIT $4
        `;
        dataParams = [meId, myUniversity, offset, limit];
      } else {
        // 🔹 User has no university -> any professor, excluding blocked in both directions
        countQuery = `
          SELECT COUNT(*)::int AS cnt
          FROM users u
          WHERE u.user_type = 'professor'
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
        `;
        countParams = [meId];

        dataQuery = `
          SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
                 u.university, u.specialization, u.about, u.course,
                 u.followers_count, u.created_at
          FROM users u
          WHERE u.user_type = 'professor'
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
          ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
          OFFSET $2 LIMIT $3
        `;
        dataParams = [meId, offset, limit];
      }
    }

    // get total matching (cap at MAX_TOTAL)
    const countRes = await pool.query(countQuery, countParams);
    const totalMatching = Math.min(
      Number(countRes.rows?.[0]?.cnt || 0),
      MAX_TOTAL
    );

    const dataRes = await pool.query(dataQuery, dataParams);
    const rows = Array.isArray(dataRes.rows) ? dataRes.rows : [];

    // presign avatars (safe)
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
      // 🔹 Students from same university, exclude me, exclude blocks (both ways)
      countSql = `
        SELECT COUNT(*)::int AS cnt
        FROM users u
        WHERE u.user_type = 'student'
          AND u.id <> $1
          AND u.university = $2
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = $1)
          )
      `;
      countParams = [meId, myUniversity];

      dataSql = `
        SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
               u.university, u.specialization, u.about, u.course,
               u.interests, u.followers_count, u.created_at
        FROM users u
        WHERE u.user_type = 'student'
          AND u.id <> $1
          AND u.university = $2
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = $1)
          )
        ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
        OFFSET $3 LIMIT $4
      `;
      dataParams = [meId, myUniversity, offset, limit];
    } else {
      if (myUniversity) {
        // 🔹 Students from other universities, exclude me, exclude blocks (both ways)
        countSql = `
          SELECT COUNT(*)::int AS cnt
          FROM users u
          WHERE u.user_type = 'student'
            AND u.id <> $1
            AND (u.university IS NULL OR u.university <> $2)
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
        `;
        countParams = [meId, myUniversity];

        dataSql = `
          SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
                 u.university, u.specialization, u.about, u.course,
                 u.interests, u.followers_count, u.created_at
          FROM users u
          WHERE u.user_type = 'student'
            AND u.id <> $1
            AND (u.university IS NULL OR u.university <> $2)
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
          ORDER BY u.followers_count DESC NULLS LAST, u.created_at DESC
          OFFSET $3 LIMIT $4
        `;
        dataParams = [meId, myUniversity, offset, limit];
      } else {
        // 🔹 User has no university – all students, exclude me, exclude blocks (both ways)
        countSql = `
          SELECT COUNT(*)::int AS cnt
          FROM users u
          WHERE u.user_type = 'student'
            AND u.id <> $1
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
        `;
        countParams = [meId];

        dataSql = `
          SELECT u.id, u.first_name, u.last_name, u.profile AS profile_key,
                 u.university, u.specialization, u.about, u.course,
                 u.interests, u.followers_count, u.created_at
          FROM users u
          WHERE u.user_type = 'student'
            AND u.id <> $1
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
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

    // Defensive presigning (async)
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

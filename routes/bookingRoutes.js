// routes/bookingRoutes.js
const express = require("express");
const pool = require("../config/db");
const auth = require("../middlewares/authMiddleware");
const router = express.Router();

// try to require generatePresignedUrl if available
let generatePresignedUrl = null;
try {
  generatePresignedUrl = require("../config/generatePresignedUrl");
} catch (err) {
  generatePresignedUrl = null;
}

/* Helper middleware */
function requireProfessor(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  // optional: enforce role if you want in future (commented out intentionally)
  // if (req.user.user_type !== "professor") return res.status(403).json({ error: "Professor role required" });
  next();
}

/* Utility: iso date string YYYY-MM-DD for today (server timezone) */
function todayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split("T")[0];
}

/* ----------------------------
 GET /api/week?start=YYYY-MM-DD
 Returns slot_instances for start..start+6 (week)
----------------------------- */
router.get("/week", auth, async (req, res) => {
  try {
    const start = req.query.start;
    if (!start)
      return res
        .status(400)
        .json({ error: "start query param required (YYYY-MM-DD)" });

    const startDate = new Date(start);
    if (isNaN(startDate.getTime()))
      return res.status(400).json({ error: "Invalid start date" });
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    const startIso = start;
    const endIso = endDate.toISOString().split("T")[0];

    const sql = `
      SELECT si.*, s.professor_id AS template_professor_id, s.notes AS template_notes, s.capacity AS template_capacity,
             COALESCE(si.created_by, s.professor_id) AS owner_id,
             u.first_name, u.last_name
      FROM slot_instances si
      LEFT JOIN slots s ON si.slot_id = s.id
      LEFT JOIN users u ON COALESCE(si.created_by, s.professor_id) = u.id
      WHERE si.date BETWEEN $1::date AND $2::date
      ORDER BY si.date, si.start_ts;
    `;
    const { rows } = await pool.query(sql, [startIso, endIso]);

    // counts
    const ids = rows.map((r) => r.id);
    let pendingCounts = {};
    let acceptedCounts = {};
    if (ids.length > 0) {
      const pc = await pool.query(
        `SELECT slot_instance_id, COUNT(*)::int as cnt FROM booking_requests WHERE slot_instance_id = ANY($1) AND status = 'pending' GROUP BY slot_instance_id`,
        [ids]
      );
      pc.rows.forEach(
        (r) => (pendingCounts[r.slot_instance_id] = Number(r.cnt))
      );
      const ac = await pool.query(
        `SELECT slot_instance_id, COUNT(*)::int as cnt FROM bookings WHERE slot_instance_id = ANY($1) GROUP BY slot_instance_id`,
        [ids]
      );
      ac.rows.forEach(
        (r) => (acceptedCounts[r.slot_instance_id] = Number(r.cnt))
      );
    }

    const instances = rows.map((r) => ({
      id: r.id,
      slot_id: r.slot_id,
      date: r.date,
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      capacity: r.capacity || r.template_capacity || 0,
      notes: r.notes || r.template_notes || null,
      created_by: r.created_by || null,
      professor: r.first_name
        ? {
            id: r.created_by || r.template_professor_id,
            first_name: r.first_name,
            last_name: r.last_name,
          }
        : null,
      pending_count: pendingCounts[r.id] || 0,
      accepted_count: acceptedCounts[r.id] || 0,
    }));

    res.json({ instances });
  } catch (err) {
    console.error("GET /week error", err);
    res.status(500).json({ error: "Failed to fetch week" });
  }
});

/* ----------------------------
 GET /api/slot-instances?date=YYYY-MM-DD
 Returns instances for a single date — secure: requires mine=true or professorId
----------------------------- */
router.get("/slot-instances", auth, async (req, res) => {
  try {
    const date = req.query.date;
    if (!date)
      return res
        .status(400)
        .json({ error: "date query param required (YYYY-MM-DD)" });

    // query flags
    const mine = req.query.mine === "true";
    const professorIdParam = req.query.professorId || null;

    // must pass either mine=true (and be authenticated) OR professorId (student viewing a professor)
    if (!mine && !professorIdParam) {
      // safer: return 400 rather than returning everyone
      return res.status(400).json({
        error: "Either mine=true or professorId=<id> query param is required",
      });
    }

    const params = [date];
    let whereExtra = "";

    if (mine) {
      // require authenticated user
      if (!req.user || !req.user.id)
        return res.status(401).json({ error: "Not authenticated" });

      params.push(req.user.id);
      // owner = COALESCE(si.created_by, s.professor_id)
      whereExtra = ` AND COALESCE(si.created_by, s.professor_id) = $${params.length}`;
    } else if (professorIdParam) {
      // if professorId param provided, return instances owned by that professor
      params.push(professorIdParam);
      whereExtra = ` AND COALESCE(si.created_by, s.professor_id) = $${params.length}`;
    }

    const sql = `
      SELECT si.*,
             s.professor_id AS template_professor_id,
             COALESCE(si.created_by, s.professor_id) AS owner_id,
             (SELECT COUNT(*) FROM booking_requests br WHERE br.slot_instance_id = si.id AND br.status = 'pending') AS pending_count
      FROM slot_instances si
      LEFT JOIN slots s ON si.slot_id = s.id
      WHERE si.date = $1::date
      ${whereExtra}
      ORDER BY si.start_ts;
    `;

    const { rows } = await pool.query(sql, params);
    const mapped = rows.map((r) => ({
      id: r.id,
      slot_id: r.slot_id,
      date: r.date,
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      capacity: r.capacity,
      notes: r.notes,
      created_by: r.created_by,
      owner_id: r.owner_id,
      pending_count: parseInt(r.pending_count, 10) || 0,
    }));

    return res.json({ instances: mapped });
  } catch (err) {
    console.error("GET /slot-instances error", err);
    res.status(500).json({ error: "Failed to fetch slot instances" });
  }
});

/* ----------------------------
 GET /api/requests?status=pending&limit=10&offset=0&search=...&slotInstanceId=...
 - returns incoming requests for authenticated professor with pagination, search and optional slotInstance filter
----------------------------- */
/* ----------------------------
 GET /api/requests?status=pending&limit=10&offset=0&search=...&slotInstanceId=...
 - returns incoming requests for authenticated professor with pagination, search and optional slotInstance filter
----------------------------- */
// GET /api/requests?status=pending&limit=10&offset=0&search=...&slotInstanceId=...
router.get("/requests", auth, async (req, res) => {
  try {
    const status = req.query.status || null; // e.g. 'pending'
    let limit = parseInt(req.query.limit || "10", 10);
    const offset = parseInt(req.query.offset || "0", 10);
    const search = (req.query.search || "").trim();

    // enforce sensible cap
    if (Number.isNaN(limit) || limit <= 0) limit = 10;
    limit = Math.min(limit, 100);

    // authentication
    if (!req.user || !req.user.id)
      return res.status(401).json({ error: "Not authenticated" });
    const professorId = req.user.id;

    // build WHERE clauses and params dynamically
    const whereClauses = [`COALESCE(s.professor_id, si.created_by) = $1`];
    const params = [professorId];

    if (status) {
      params.push(status);
      whereClauses.push(`br.status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      whereClauses.push(
        `(u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length} OR u.university ILIKE $${params.length} OR u.course ILIKE $${params.length})`
      );
    }

    // optional slotInstanceId filter (frontend uses slotInstanceId)
    const slotInstanceId =
      req.query.slotInstanceId || req.query.slot_instance_id || null;
    if (slotInstanceId) {
      params.push(slotInstanceId);
      whereClauses.push(`br.slot_instance_id = $${params.length}`);
    }

    // pagination params (limit, offset)
    params.push(limit);
    params.push(offset);

    const whereSql = whereClauses.length
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    const sql = `
      SELECT br.id as request_id,
             br.slot_instance_id,
             br.requester_id,
             br.requester_message,
             br.status,
             br.created_at,
             u.first_name, u.last_name, u.profile AS profile_key, u.university, u.course,
             si.start_ts, si.end_ts,
             COUNT(*) OVER() AS total_count
      FROM booking_requests br
      JOIN slot_instances si ON br.slot_instance_id = si.id
      LEFT JOIN slots s ON si.slot_id = s.id                -- LEFT JOIN here (important)
      JOIN users u ON br.requester_id = u.id
      ${whereSql}
      ORDER BY br.created_at ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await pool.query(sql, params);

    // Convert rows: produce profile_presigned by calling generatePresignedUrl(profile_key) if util present
    const results = await Promise.all(
      rows.map(async (r) => {
        let presigned = null;
        try {
          if (generatePresignedUrl && r.profile_key) {
            presigned = await generatePresignedUrl(r.profile_key);
          }
        } catch (err) {
          console.warn(
            "generatePresignedUrl failed for",
            r.profile_key,
            err && err.message
          );
          presigned = null;
        }
        return {
          id: r.request_id,
          slot_instance_id: r.slot_instance_id,
          requester_id: r.requester_id,
          requester_message: r.requester_message,
          status: r.status,
          created_at: r.created_at,
          first_name: r.first_name,
          last_name: r.last_name,
          profile_presigned: presigned,
          profile_key: r.profile_key || null,
          university: r.university || null,
          course: r.course || null,
          slot_start: r.start_ts,
          slot_end: r.end_ts,
        };
      })
    );

    const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
    return res.json({ requests: results, total });
  } catch (err) {
    console.error("GET /requests error", err);
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

/* ----------------------------
 POST /api/slot-instances/batch
 Professor-only: create multiple instances for a date (transactional)
 Body: { date: "YYYY-MM-DD", ranges: [{ start_ts, end_ts, capacity?, notes?, slot_id? }, ...] }
----------------------------- */
router.post(
  "/slot-instances/batch",
  auth,
  requireProfessor,
  async (req, res) => {
    const professorId = req.user.id;
    const { date, ranges } = req.body;
    try {
      if (!date || !Array.isArray(ranges) || ranges.length === 0) {
        return res
          .status(400)
          .json({ error: "date and non-empty ranges array required" });
      }

      // server-side: reject past dates
      const today = todayIso();
      if (date < today)
        return res
          .status(400)
          .json({ error: "Cannot create slot instances for past dates" });

      // validate each range timestamps
      for (const r of ranges) {
        if (!r.start_ts || !r.end_ts)
          return res
            .status(400)
            .json({ error: "Each range must include start_ts and end_ts" });
        const s = new Date(r.start_ts);
        const e = new Date(r.end_ts);
        if (isNaN(s.getTime()) || isNaN(e.getTime()) || s >= e)
          return res
            .status(400)
            .json({ error: "Invalid start/end timestamps" });
        // ensure both timestamps fall on the provided date (date string)
        const sDate = s.toISOString().split("T")[0];
        const eDate = e.toISOString().split("T")[0];
        if (sDate !== date || eDate !== date)
          return res.status(400).json({
            error: "start_ts and end_ts must both be on the provided date",
          });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Fetch existing instances for this professor on that date (either created_by or from template owned by professor)
        const existingRes = await client.query(
          `
        SELECT si.id, si.start_ts, si.end_ts
        FROM slot_instances si
        LEFT JOIN slots s ON si.slot_id = s.id
        WHERE si.date = $1::date
          AND (COALESCE(si.created_by, s.professor_id) = $2)
      `,
          [date, professorId]
        );

        const existing = existingRes.rows.map((r) => ({
          start: new Date(r.start_ts),
          end: new Date(r.end_ts),
        }));

        // overlap helper
        const overlaps = (aStart, aEnd, bStart, bEnd) =>
          !(aEnd <= bStart || bEnd <= aStart);

        // check overlaps between new ranges and existing + between ranges themselves
        for (let i = 0; i < ranges.length; i++) {
          const ri = ranges[i];
          const sI = new Date(ri.start_ts),
            eI = new Date(ri.end_ts);
          for (const ex of existing) {
            if (overlaps(sI, eI, ex.start, ex.end)) {
              await client.query("ROLLBACK");
              return res.status(409).json({
                error: `Submitted range ${ri.start_ts} - ${ri.end_ts} overlaps existing instance`,
              });
            }
          }
          for (let j = i + 1; j < ranges.length; j++) {
            const rj = ranges[j];
            const sJ = new Date(rj.start_ts),
              eJ = new Date(rj.end_ts);
            if (overlaps(sI, eI, sJ, eJ)) {
              await client.query("ROLLBACK");
              return res.status(409).json({
                error: `Submitted ranges ${i + 1} and ${j + 1} overlap`,
              });
            }
          }
        }

        // insert ranges
        const inserted = [];
        for (const r of ranges) {
          const slot_id = r.slot_id || null;
          const capacity = r.capacity || 0;
          const notes = r.notes || null;
          const insertRes = await client.query(
            `INSERT INTO slot_instances (slot_id, date, start_ts, end_ts, capacity, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [slot_id, date, r.start_ts, r.end_ts, capacity, notes, professorId]
          );
          inserted.push(insertRes.rows[0]);
        }

        await client.query("COMMIT");
        return res.status(201).json({ inserted });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("POST /slot-instances/batch error", err);
      return res.status(500).json({ error: "Failed to create slot instances" });
    }
  }
);

/* ----------------------------
 POST /api/slots   (create recurring template)
 Body: { weekday, start_time, end_time, capacity?, notes? }
----------------------------- */
router.post("/slots", auth, requireProfessor, async (req, res) => {
  try {
    const professorId = req.user.id;
    const {
      weekday,
      start_time,
      end_time,
      capacity = 0,
      notes = null,
    } = req.body;
    if (weekday == null || !start_time || !end_time)
      return res
        .status(400)
        .json({ error: "weekday,start_time,end_time required" });
    if (start_time >= end_time)
      return res
        .status(400)
        .json({ error: "start_time must be before end_time" });

    const { rows } = await pool.query(
      `INSERT INTO slots (professor_id, weekday, start_time, end_time, capacity, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [professorId, weekday, start_time, end_time, capacity, notes]
    );
    res.status(201).json({ slot: rows[0] });
  } catch (err) {
    console.error("POST /slots error", err);
    res.status(500).json({ error: "Failed to create slot template" });
  }
});

/* ----------------------------
 POST /api/slot-instances/:id/request  (authenticated user requests a slot)
 Body: { message? }
----------------------------- */
router.post("/slot-instances/:id/request", auth, async (req, res) => {
  try {
    if (!req.user || !req.user.id)
      return res.status(401).json({ error: "Not authenticated" });

    const instanceId = req.params.id;
    const message = req.body.message || null;

    // check instance exists
    const inst = await pool.query(
      "SELECT id, COALESCE(created_by, (SELECT professor_id FROM slots WHERE id = si.slot_id)) AS owner FROM slot_instances si WHERE id = $1",
      [instanceId]
    );
    if (inst.rows.length === 0)
      return res.status(404).json({ error: "Slot instance not found" });

    // prevent owner from requesting their own slot (optional)
    const ownerId = inst.rows[0].owner;
    if (ownerId && String(ownerId) === String(req.user.id)) {
      return res
        .status(403)
        .json({ error: "Owners cannot request their own slot" });
    }

    // prevent duplicates
    const exists = await pool.query(
      "SELECT id FROM booking_requests WHERE slot_instance_id = $1 AND requester_id = $2",
      [instanceId, req.user.id]
    );
    if (exists.rows.length > 0)
      return res.status(409).json({ error: "You already requested this slot" });

    const { rows } = await pool.query(
      "INSERT INTO booking_requests (slot_instance_id, requester_id, requester_message) VALUES ($1,$2,$3) RETURNING *",
      [instanceId, req.user.id, message]
    );
    res.status(201).json({ request: rows[0] });
  } catch (err) {
    console.error("POST /slot-instances/:id/request error", err);
    res.status(500).json({ error: "Failed to create request" });
  }
});

/* ----------------------------
 POST /api/requests/:id/accept
 professor accepts a request (transactional) -> creates bookings row, marks request accepted
----------------------------- */
router.post(
  "/requests/:id/accept",
  auth,
  requireProfessor,
  async (req, res) => {
    const requestId = req.params.id;
    const professorId = String(req.user.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 1) Lock the booking_requests row
      const reqRowRes = await client.query(
        `SELECT id, slot_instance_id, requester_id, status
       FROM booking_requests
       WHERE id = $1
       FOR UPDATE`,
        [requestId]
      );

      if (reqRowRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Request not found" });
      }

      const br = reqRowRes.rows[0];

      if (br.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Request not pending" });
      }

      if (!br.slot_instance_id) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Request has no slot instance" });
      }

      // 2) Lock the slot_instance row
      const siRes = await client.query(
        `SELECT id, slot_id, capacity, start_ts, end_ts, created_by
       FROM slot_instances
       WHERE id = $1
       FOR UPDATE`,
        [br.slot_instance_id]
      );

      if (siRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Slot instance not found" });
      }

      const si = siRes.rows[0];

      // 3) Optionally lock the slot template (if exists)
      let slot = null;
      if (si.slot_id) {
        const slotRes = await client.query(
          `SELECT id, professor_id, capacity
         FROM slots
         WHERE id = $1
         FOR UPDATE`,
          [si.slot_id]
        );
        if (slotRes.rows.length > 0) {
          slot = slotRes.rows[0];
        } else {
          slot = null;
        }
      }

      // 4) Determine professor owner:
      // Prefer using slot.professor_id if template exists; otherwise optionally use created_by on instance
      const ownerProfessorId = slot
        ? String(slot.professor_id)
        : si.created_by
        ? String(si.created_by)
        : null;

      if (!ownerProfessorId) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Slot instance missing owner/professor (data inconsistency)",
        });
      }

      if (ownerProfessorId !== professorId) {
        await client.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "Not authorized to accept this request" });
      }

      // 5) Capacity check: instance.capacity (if >0) else template.capacity (if >0) else unlimited
      const instanceCapacity =
        si.capacity && parseInt(si.capacity, 10) > 0
          ? parseInt(si.capacity, 10)
          : 0;
      const templateCapacity =
        slot && slot.capacity && parseInt(slot.capacity, 10) > 0
          ? parseInt(slot.capacity, 10)
          : 0;
      const capacity =
        instanceCapacity > 0 ? instanceCapacity : templateCapacity;

      if (capacity > 0) {
        const cntRes = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM bookings WHERE slot_instance_id = $1`,
          [si.id]
        );
        const cnt = parseInt(cntRes.rows[0].cnt, 10);
        if (cnt >= capacity) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Capacity full" });
        }
      }

      // 6) Ensure requester exists to avoid FK errors
      const requesterCheck = await client.query(
        `SELECT id FROM users WHERE id = $1`,
        [br.requester_id]
      );
      if (requesterCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Requester user not found" });
      }

      // 7) Create booking and mark request accepted
      const bookingRes = await client.query(
        `INSERT INTO bookings (slot_instance_id, request_id, user_id) VALUES ($1, $2, $3) RETURNING *`,
        [si.id, br.id, br.requester_id]
      );

      await client.query(
        `UPDATE booking_requests SET status = 'accepted', updated_at = now() WHERE id = $1`,
        [br.id]
      );

      await client.query("COMMIT");

      // success: return created booking
      return res.json({ booking: bookingRes.rows[0] });
    } catch (err) {
      // Rollback on any error
      try {
        await client.query("ROLLBACK");
      } catch (e) {
        // ignore rollback errors
      }
      console.error("POST /requests/:id/accept error", err);

      // Map common Postgres errors to clearer responses
      if (err.code === "23503") {
        // FK violation
        return res.status(400).json({
          error:
            "Foreign key violation: " + (isDev ? err.message : "Bad request"),
        });
      }
      if (err.code === "23505") {
        // unique violation
        return res
          .status(409)
          .json({ error: "Conflict: " + (isDev ? err.message : "Conflict") });
      }

      return res
        .status(500)
        .json({ error: isDev ? err.message : "Failed to accept request" });
    } finally {
      client.release();
    }
  }
);

/* ----------------------------
 POST /requests/:id/reject
 professor rejects a booking request
----------------------------- */
router.post(
  "/requests/:id/reject",
  auth,
  requireProfessor,
  async (req, res) => {
    try {
      const requestId = req.params.id;
      const professorId = req.user.id;
      // verify ownership (join to slot->professor)
      const r = await pool.query(
        `
      SELECT br.id, s.professor_id, br.status
      FROM booking_requests br
      JOIN slot_instances si ON br.slot_instance_id = si.id
      JOIN slots s ON si.slot_id = s.id
      WHERE br.id = $1
    `,
        [requestId]
      );
      if (r.rows.length === 0)
        return res.status(404).json({ error: "Request not found" });
      if (r.rows[0].professor_id !== professorId)
        return res.status(403).json({ error: "Not authorized" });
      if (r.rows[0].status !== "pending")
        return res.status(400).json({ error: "Request not pending" });

      await pool.query(
        `UPDATE booking_requests SET status = 'rejected', updated_at = now() WHERE id = $1`,
        [requestId]
      );
      res.json({ msg: "Request rejected" });
    } catch (err) {
      console.error("POST /requests/:id/reject error", err);
      res.status(500).json({ error: "Failed to reject request" });
    }
  }
);

/* ----------------------------
 DELETE /api/slot-instances/:id
 Only owner professor (created_by or template owner) can delete
----------------------------- */
router.delete(
  "/slot-instances/:id",
  auth,
  requireProfessor,
  async (req, res) => {
    try {
      const id = req.params.id;
      const professorId = req.user.id;

      // ensure that the instance is owned by this professor (either created_by or template's professor)
      const r = await pool.query(
        `
      SELECT si.id, COALESCE(si.created_by, s.professor_id) AS owner
      FROM slot_instances si
      LEFT JOIN slots s ON si.slot_id = s.id
      WHERE si.id = $1
    `,
        [id]
      );

      if (r.rows.length === 0)
        return res.status(404).json({ error: "Slot instance not found" });
      if (String(r.rows[0].owner) !== String(professorId))
        return res
          .status(403)
          .json({ error: "Not authorized to delete this instance" });

      await pool.query("DELETE FROM slot_instances WHERE id = $1", [id]);
      res.json({ msg: "Deleted" });
    } catch (err) {
      console.error("DELETE /slot-instances/:id error", err);
      res.status(500).json({ error: "Failed to delete instance" });
    }
  }
);

module.exports = router;

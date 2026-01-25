const express = require("express");
const router = express.Router();
const multer = require("multer");

const pool = require("../config/db");
const requireAuth = require("../middlewares/authMiddleware");

const uploadToS3 = require("../config/s3Upload");
const generatePresignedUrl = require("../config/generatePresignedUrl");

const upload = multer({ storage: multer.memoryStorage() });

/**
 * GET /api/marketplace
 * Feed: 12 items + infinite scroll (keyset pagination)
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "12", 10), 50);
    const cursor = req.query.cursor || null;
    const cursorId = req.query.id || null;

    const university = req.user.university;

    const { rows } = await pool.query(
      `
      SELECT
        ml.id,
        ml.title,
        ml.description,
        ml.price,
        ml.currency,
        ml.condition,
        ml.category,
        ml.location,
        ml.status,
        ml.visibility,
        ml.created_at,

        u.id AS seller_id,
        u.first_name,
        u.last_name,

        (
          SELECT mi.image_url
          FROM marketplace_listing_images mi
          WHERE mi.listing_id = ml.id
          ORDER BY mi.sort_order ASC, mi.created_at ASC
          LIMIT 1
        ) AS thumbnail
      FROM marketplace_listings ml
      JOIN users u ON u.id = ml.seller_id
      WHERE
        ml.status = 'available'
        AND (
          ml.visibility = 'public'
          OR (ml.visibility = 'university' AND ml.university = $1)
        )
        AND (
          $2::timestamptz IS NULL
          OR (ml.created_at, ml.id) < ($2::timestamptz, $3::uuid)
        )
      ORDER BY ml.created_at DESC, ml.id DESC
      LIMIT $4;
      `,
      [university, cursor, cursorId, limit]
    );

    // convert thumbnail key -> presigned URL
    const items = rows.map((r) => ({
      ...r,
      thumbnail: r.thumbnail ? generatePresignedUrl(r.thumbnail) : null,
    }));

    const last = rows[rows.length - 1];
    const nextCursor = last ? { cursor: last.created_at, id: last.id } : null;

    res.json({ items, nextCursor });
  } catch (err) {
    console.error("Marketplace feed error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/marketplace/search?q=...
 * Search title words
 */
router.get("/search", requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ items: [], nextCursor: null });

    const limit = Math.min(parseInt(req.query.limit || "12", 10), 50);
    const cursor = req.query.cursor || null;
    const cursorId = req.query.id || null;

    const university = req.user.university;

    const { rows } = await pool.query(
      `
      SELECT
        ml.id,
        ml.title,
        ml.description,
        ml.price,
        ml.currency,
        ml.condition,
        ml.category,
        ml.location,
        ml.status,
        ml.visibility,
        ml.created_at,

        u.id AS seller_id,
        u.first_name,
        u.last_name,

        (
          SELECT mi.image_url
          FROM marketplace_listing_images mi
          WHERE mi.listing_id = ml.id
          ORDER BY mi.sort_order ASC, mi.created_at ASC
          LIMIT 1
        ) AS thumbnail
      FROM marketplace_listings ml
      JOIN users u ON u.id = ml.seller_id
      WHERE
        ml.status = 'available'
        AND (
          ml.visibility = 'public'
          OR (ml.visibility = 'university' AND ml.university = $1)
        )
        AND ml.title ILIKE $2
        AND (
          $3::timestamptz IS NULL
          OR (ml.created_at, ml.id) < ($3::timestamptz, $4::uuid)
        )
      ORDER BY ml.created_at DESC, ml.id DESC
      LIMIT $5;
      `,
      [university, `%${q}%`, cursor, cursorId, limit]
    );

    const items = rows.map((r) => ({
      ...r,
      thumbnail: r.thumbnail ? generatePresignedUrl(r.thumbnail) : null,
    }));

    const last = rows[rows.length - 1];
    const nextCursor = last ? { cursor: last.created_at, id: last.id } : null;

    res.json({ items, nextCursor });
  } catch (err) {
    console.error("Marketplace search error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * POST /api/marketplace
 * Create listing + upload images
 * multipart/form-data:
 *  - fields: title, description, price(optional), condition, category, location, visibility(optional)
 *  - images[] files
 */
router.post("/", requireAuth, upload.array("images", 6), async (req, res) => {
  try {
    const sellerId = req.user.id;
    const university = req.user.university || "";

    const {
      title,
      description,
      price,
      currency,
      condition,
      category,
      location,
      visibility,
    } = req.body;

    if (!title || !description || !location) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ message: "At least 1 image is required" });
    }

    // ✅ 1) insert listing (include university to avoid NOT NULL issues)
    const listingRes = await pool.query(
      `
      INSERT INTO marketplace_listings
        (seller_id, title, description, price, currency, condition, category, location, visibility, university)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *;
      `,
      [
        sellerId,
        title.trim(),
        description.trim(),
        price ? Number(price) : null,
        (currency || "INR").toUpperCase(),
        condition || "good",
        category || null,
        location.trim(),
        visibility || "university",
        university,
      ]
    );

    const listing = listingRes.rows[0];

    // ✅ 2) upload images and insert rows
    const imageRows = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];

      const key = await uploadToS3(f.buffer, f.originalname, f.mimetype);

      const imgRes = await pool.query(
        `
        INSERT INTO marketplace_listing_images (listing_id, image_url, sort_order)
        VALUES ($1,$2,$3)
        RETURNING *;
        `,
        [listing.id, key, i]
      );

      imageRows.push(imgRes.rows[0]);
    }

    const images = imageRows.map((img) => ({
      ...img,
      presignedUrl: generatePresignedUrl(img.image_url),
    }));

    return res.status(201).json({ listing, images });
  } catch (err) {
    console.error("Create listing error:", err);
    return res.status(500).json({
      message: "Server error",
      error: err.message, // ✅ show the real reason if anything else fails
    });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const listingId = req.params.id;
    const university = req.user.university;



    const listingRes = await pool.query(
`
SELECT
ml.*,
u.id AS seller_id,
u.first_name,
u.last_name,
u.user_type as role,
u.course as c,
u.profile AS seller_profile,
u.university AS seller_university,
u.email AS seller_email
FROM marketplace_listings ml
JOIN users u ON u.id = ml.seller_id
WHERE ml.id = $1
AND (
ml.visibility = 'public'
OR (ml.visibility = 'university' AND ml.university = $2)
)
LIMIT 1;
`,
[listingId, university]
);
    if (listingRes.rows.length === 0) {
      return res.status(404).json({ message: "Listing not found" });
    }

    const listing = listingRes.rows[0];

    const imgRes = await pool.query(
      `
      SELECT id, listing_id, image_url, sort_order, created_at
      FROM marketplace_listing_images
      WHERE listing_id = $1
      ORDER BY sort_order ASC, created_at ASC;
      `,
      [listingId]
    );

    const images = imgRes.rows.map((img) => ({
      ...img,
      presignedUrl: generatePresignedUrl(img.image_url),
    }));

    res.json({
      listing,
      images,
      seller: {
id: listing.seller_id,
role:listing.role,
course:listing.c,
first_name: listing.first_name,
last_name: listing.last_name,
profile: listing.seller_profile ? generatePresignedUrl(listing.seller_profile) : null,
university: listing.seller_university || null,
email: listing.seller_email || null,
},
    });
  } catch (err) {
    console.error("Marketplace details error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});


router.get("/mine/list", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit || "12", 10), 50);
    const cursor = req.query.cursor || null;
    const cursorId = req.query.id || null;

    const { rows } = await pool.query(
      `
      SELECT
        ml.id, ml.title, ml.description, ml.price, ml.currency,
        ml.condition, ml.category, ml.location, ml.status, ml.visibility, ml.created_at,
        u.id AS seller_id, u.first_name, u.last_name,
        (
          SELECT mi.image_url
          FROM marketplace_listing_images mi
          WHERE mi.listing_id = ml.id
          ORDER BY mi.sort_order ASC, mi.created_at ASC
          LIMIT 1
        ) AS thumbnail
      FROM marketplace_listings ml
      JOIN users u ON u.id = ml.seller_id
      WHERE ml.seller_id = $1 AND ml.status <> 'deleted'
        AND (
          $2::timestamptz IS NULL
          OR (ml.created_at, ml.id) < ($2::timestamptz, $3::uuid)
        )
      ORDER BY ml.created_at DESC, ml.id DESC
      LIMIT $4;
      `,
      [userId, cursor, cursorId, limit]
    );

    const items = rows.map((r) => ({
      ...r,
      thumbnail: r.thumbnail ? generatePresignedUrl(r.thumbnail) : null,
    }));

    const last = rows[rows.length - 1];
    const nextCursor = last ? { cursor: last.created_at, id: last.id } : null;

    res.json({ items, nextCursor });
  } catch (err) {
    console.error("Marketplace mine error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});


router.put("/:id", requireAuth, async (req, res) => {
  try {
    const listingId = req.params.id;
    const userId = req.user.id;

    const {
      title,
      description,
      price,
      currency,
      condition,
      category,
      location,
      visibility,
      status,
    } = req.body;

    const r = await pool.query(
      `
      UPDATE marketplace_listings
      SET
        title = COALESCE($3, title),
        description = COALESCE($4, description),
        price = $5,
        currency = COALESCE($6, currency),
        condition = COALESCE($7, condition),
        category = $8,
        location = COALESCE($9, location),
        visibility = COALESCE($10, visibility),
        status = COALESCE($11, status),
        updated_at = now()
      WHERE id = $1 AND seller_id = $2
      RETURNING *;
      `,
      [
        listingId,
        userId,
        title?.trim() || null,
        description?.trim() || null,
        price === "" || price === undefined ? null : Number(price),
        currency ? String(currency).toUpperCase() : null,
        condition || null,
        category ?? null,
        location?.trim() || null,
        visibility || null,
        status || null,
      ]
    );

    if (r.rows.length === 0) {
      return res.status(403).json({ message: "Not allowed or not found" });
    }

    res.json({ listing: r.rows[0] });
  } catch (err) {
    console.error("Marketplace update error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});


router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const listingId = req.params.id;
    const userId = req.user.id;

    const r = await pool.query(
      `
      UPDATE marketplace_listings
      SET status = 'deleted'
      WHERE id = $1 AND seller_id = $2
      RETURNING id;
      `,
      [listingId, userId]
    );

    if (r.rows.length === 0) {
      return res.status(403).json({ message: "Not allowed or not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Marketplace delete error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});


module.exports = router;
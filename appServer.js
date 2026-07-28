// ============================================================
// HAIDOVILLE APP SERVER — GHL Media Proxy (Secured)
// ============================================================
// This router proxies GHL Media API calls so that the frontend
// never touches API keys directly. All endpoints are protected
// by the same session-hint middleware used across the backend.
// ============================================================

import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

// ---- Config (from .env) ----
const GHL_MEDIA_API_KEY      = process.env.GHL_MEDIA_API_KEY;
const GHL_MEDIA_LOCATION_ID  = process.env.GHL_MEDIA_LOCATION_ID;
const GHL_MEDIA_FOLDER_NAME  = process.env.GHL_MEDIA_FOLDER_NAME || "User-Uploads";
const GHL_MEDIA_BASE_URL     = process.env.GHL_MEDIA_BASE_URL || "https://services.leadconnectorhq.com";

const GHL_UPLOAD_URL     = GHL_MEDIA_BASE_URL + "/medias/upload-file";
const GHL_LIST_FILES_URL = GHL_MEDIA_BASE_URL + "/medias/files";

// ---- Internal Helpers ----
function ghlHeaders() {
  return {
    "Authorization": "Bearer " + GHL_MEDIA_API_KEY,
    "Version": "2021-07-28",
  };
}

function isConfigured() {
  return !!(GHL_MEDIA_API_KEY && GHL_MEDIA_LOCATION_ID);
}

// ---- Cached Folder ID ----
let _folderIdCache = null;
let _folderIdCacheTs = 0;
const FOLDER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function resolveFolderId() {
  const now = Date.now();
  if (_folderIdCache && now - _folderIdCacheTs < FOLDER_CACHE_TTL_MS) {
    return _folderIdCache;
  }
  if (!GHL_MEDIA_FOLDER_NAME) return null;

  try {
    const params = new URLSearchParams({
      offset: "0",
      limit: "50",
      sortBy: "createdAt",
      sortOrder: "desc",
      type: "folder",
      altType: "location",
      altId: GHL_MEDIA_LOCATION_ID,
    });
    const res = await fetch(GHL_LIST_FILES_URL + "?" + params.toString(), {
      method: "GET",
      headers: ghlHeaders(),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const folders = data.files || [];
    for (const folder of folders) {
      if (folder.name === GHL_MEDIA_FOLDER_NAME) {
        _folderIdCache = folder._id || folder.id || null;
        _folderIdCacheTs = now;
        return _folderIdCache;
      }
    }
    return null;
  } catch (e) {
    console.error("[App/GHL] Folder resolve error:", e.message);
    return null;
  }
}

// ============================================================
// RATE LIMITERS
// ============================================================
const listRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

// ============================================================
// MIDDLEWARE FACTORY — Attaches session hint middleware
// ============================================================
// The actual middleware is injected from server.js so we share
// the same session store and validation logic.
let _requireSessionHint = null;

export function setSessionHintMiddleware(mw) {
  _requireSessionHint = mw;
}

function requireSession(req, res, next) {
  if (!_requireSessionHint) {
    return res.status(500).json({ error: "Session middleware not initialized." });
  }
  _requireSessionHint(req, res, next);
}

// ============================================================
// GET /app/files — List photos from GHL Media
// ============================================================
router.get(
  "/files",
  listRateLimiter,
  requireSession,
  async (req, res) => {
    if (!isConfigured()) {
      return res.status(500).json({ error: "GHL Media API not configured." });
    }

    try {
      const folderId = await resolveFolderId();

      const params = new URLSearchParams({
        offset: "0",
        limit: String(Math.min(parseInt(req.query.limit) || 9, 50)),
        sortBy: "createdAt",
        sortOrder: "desc",
        type: "file",
        altType: "location",
        altId: GHL_MEDIA_LOCATION_ID,
      });
      if (folderId) {
        params.append("parentId", folderId);
      }

      const ghlRes = await fetch(GHL_LIST_FILES_URL + "?" + params.toString(), {
        method: "GET",
        headers: ghlHeaders(),
      });

      if (!ghlRes.ok) {
        const errText = await ghlRes.text();
        console.error("[App/GHL] List files error:", ghlRes.status, errText);
        return res.status(502).json({ error: "Could not retrieve files." });
      }

      const data = await ghlRes.json();
      const files = (data.files || [])
        .filter((f) => f.url && /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f.name || f.url))
        .map((f) => ({ url: f.url, name: f.name || "Guest photo" }));

      res.json({ files });
    } catch (err) {
      console.error("[App/GHL] List files exception:", err.message);
      res.status(500).json({ error: "Server error." });
    }
  }
);

// ============================================================
// POST /app/upload — Upload a file to GHL Media
// ============================================================
// The frontend sends the compressed image as a raw binary stream
// (application/octet-stream). We rebuild the FormData on the
// server so we can securely inject the parentId.
// ============================================================
router.post(
  "/upload",
  uploadRateLimiter,
  requireSession,
  async (req, res) => {
    if (!isConfigured()) {
      return res.status(500).json({ error: "GHL Media API not configured." });
    }

    try {
      const folderId = await resolveFolderId();
      const fileName = req.headers["x-file-name"] || `guest_${Date.now()}.jpg`;

      // Read raw binary body
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);

      if (fileBuffer.length === 0) {
        return res.status(400).json({ error: "Empty file payload." });
      }

      // Build a clean FormData for GHL
      const formData = new FormData();
      formData.append("file", new Blob([fileBuffer]), fileName);
      formData.append("hosted", "false");
      formData.append("fileUrl", "");
      formData.append("name", fileName);
      if (folderId) {
        formData.append("parentId", folderId);
      }

      const uploadUrl = GHL_UPLOAD_URL + "?altType=location&altId=" + GHL_MEDIA_LOCATION_ID;

      const ghlRes = await fetch(uploadUrl, {
        method: "POST",
        headers: ghlHeaders(), // fetch automatically sets multipart boundary headers
        body: formData,
      });

      if (!ghlRes.ok) {
        const errText = await ghlRes.text();
        console.error("[App/GHL] Upload error:", ghlRes.status, errText);
        return res.status(502).json({ error: "Upload failed." });
      }

      const result = await ghlRes.json();
      console.log("[App/GHL] Upload success:", result.id || result._id || "unknown", "in folder:", folderId);
      res.json({ success: true, fileId: result.id || result._id });
    } catch (err) {
      console.error("[App/GHL] Upload exception:", err.message);
      res.status(500).json({ error: "Server error." });
    }
  }
);

// ============================================================
// SMOOBU HMAC FETCH HELPER (mirrors server.js logic)
// ============================================================
const SMOOBU_API_LABEL  = process.env.SMOOBU_API_LABEL;
const SMOOBU_API_SECRET = process.env.SMOOBU_API_SECRET;

async function smoobuFetch(url, options = {}) {
  if (!SMOOBU_API_LABEL || !SMOOBU_API_SECRET) {
    throw new Error("SMOOBU_API_LABEL or SMOOBU_API_SECRET not configured");
  }

  const method = (options.method || "GET").toUpperCase();
  const parsed = new URL(url);
  const pathname = parsed.pathname;

  // Sort query params alphabetically
  const params = [...parsed.searchParams.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = uuidv4();

  const bodyStr = options.body || "";
  const bodyHash = crypto.createHash("sha256").update(bodyStr).digest("hex");

  const canonical = `${method}\n${pathname}\n${params}\n${timestamp}\n${nonce}\n${bodyHash}\n${SMOOBU_API_LABEL}`;

  const signature = crypto
    .createHmac("sha256", SMOOBU_API_SECRET)
    .update(canonical)
    .digest("base64");

  const headers = {
    ...options.headers,
    "X-API-Key": SMOOBU_API_LABEL,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
  };

  delete headers["Api-Key"];

  return fetch(url, { ...options, method, headers });
}

// ============================================================
// SMOOBU RESERVATION CACHE (60-second TTL)
// ============================================================
let _reservationCache = null;
let _reservationCacheTs = 0;
const RESERVATION_CACHE_TTL_MS = 60 * 1000; // 60 seconds

async function fetchAllBookedReservations() {
  const now = Date.now();
  if (_reservationCache && now - _reservationCacheTs < RESERVATION_CACHE_TTL_MS) {
    return _reservationCache;
  }

  const allBookings = [];
  let currentPage = 1;
  let totalPages = 1;

  while (currentPage <= totalPages) {
    const url = `https://login.smoobu.com/api/reservations?showCancellation=false&pageSize=100&page=${currentPage}`;
    const res = await smoobuFetch(url);

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[App/Smoobu] Reservations API error (page ${currentPage}):`, res.status, errText);
      break;
    }

    const data = await res.json();
    const bookings = data.bookings || [];
    allBookings.push(...bookings);

    totalPages = data.page_count || 1;
    currentPage++;
  }

  // Filter: only real guest reservations (not cancellations, not calendar blocks)
  const filtered = allBookings.filter(b =>
    b.type === "reservation" &&
    b["is-blocked-booking"] === false
  );

  _reservationCache = filtered;
  _reservationCacheTs = now;

  console.log(`[App/Smoobu] Cached ${filtered.length} active reservations (from ${allBookings.length} total across ${totalPages} page(s))`);
  return filtered;
}

// ============================================================
// POST /app/guest-access — Verify guest via Smoobu bookings
// ============================================================
router.post(
  "/guest-access",
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,                  // limit each IP to 20 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { access: false }, // Generic fail for rate limit
  }),
  async (req, res) => {
    // 1. CORS restriction (if ALLOWED_ORIGIN is set)
    const allowedOriginsEnv = process.env.ALLOWED_ORIGIN;
    const origin = (req.headers.origin || "").replace(/\/$/, "");
    if (allowedOriginsEnv && origin) {
      const allowedOrigins = allowedOriginsEnv.split(',').map(o => o.trim());
      const isTrustedGhl = origin.endsWith(".leadconnectorhq.com") || origin.endsWith(".gohighlevel.com") || origin.endsWith(".msgsndr.com");
      
      if (!allowedOrigins.includes(origin) && !isTrustedGhl) {
        console.error("[App/Smoobu] CORS blocked origin:", origin);
        return res.status(403).json({ access: false });
      }
    }

    // 2. Validate Smoobu credentials
    if (!SMOOBU_API_LABEL || !SMOOBU_API_SECRET) {
      console.error("[App/Smoobu] SMOOBU_API_LABEL or SMOOBU_API_SECRET not configured.");
      return res.status(500).json({ access: false });
    }

    const { firstName, email } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanName = (firstName || '').trim().toLowerCase();

    if (!cleanEmail && !cleanName) {
      return res.status(400).json({ access: false });
    }

    try {
      const reservations = await fetchAllBookedReservations();
      let matchedBooking = null;

      // 1. Try match by email first (case-insensitive, trimmed)
      if (cleanEmail) {
        matchedBooking = reservations.find(b => {
          const bEmail = (b.email || '').trim().toLowerCase();
          return bEmail && bEmail === cleanEmail;
        });
        if (matchedBooking) {
          console.log(`[App/Smoobu] Access granted via EMAIL for: ${cleanEmail}`);
        }
      }

      // 2. Fallback: fuzzy match by guest name (substring either direction)
      if (!matchedBooking && cleanName) {
        matchedBooking = reservations.find(b => {
          const guestName = (b["guest-name"] || '').trim().toLowerCase();
          if (!guestName) return false;
          return guestName.includes(cleanName) || cleanName.includes(guestName);
        });
        if (matchedBooking) {
          console.log(`[App/Smoobu] Access granted via NAME for: ${cleanName}`);
        }
      }

      // 3. Evaluate result
      if (matchedBooking) {
        // Extract first name from guest-name (take the first word)
        const guestFullName = matchedBooking["guest-name"] || '';
        const resolvedFirstName = guestFullName.split(/\s+/)[0] || firstName || '';

        // Optional: Fire automation webhook in background if configured
        const webhookUrl = process.env.GHL_GUEST_PORTAL_WEBHOOK_URL;
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              first_name: resolvedFirstName,
              email: matchedBooking.email || email || '',
              source: 'Mini App Gate',
              tag: 'guest-portal-access'
            })
          }).catch(err => console.error("[App/Smoobu] Background webhook failed:", err.message));
        }

        return res.json({
          access: true,
          firstName: resolvedFirstName,
          bookingId: matchedBooking.id,
          guestAppUrl: matchedBooking["guest-app-url"] || null,
        });
      }

      // No match found
      console.warn(`[App/Smoobu] Access denied for: Name="${firstName}", Email="${email}"`);
      return res.json({ access: false });

    } catch (err) {
      console.error("[App/Smoobu] Guest verification exception:", err.message);
      return res.status(500).json({ access: false });
    }
  }
);

export default router;

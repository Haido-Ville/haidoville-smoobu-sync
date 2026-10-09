// ============================================================
// HAIDOVILLE APP SERVER — GHL Media Proxy (Secured)
// ============================================================
// This router proxies GHL Media API calls so that the frontend
// never touches API keys directly. All endpoints are protected
// by the same session-hint middleware used across the backend.
// ============================================================

import express from "express";
import { v4 as uuidv4 } from "uuid";
import { limiter, secLog, fetchReservations } from "./shared.js";
import { generateGuestPass, verifyGuestPass } from "./encryption.js";

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

// Only guests verified by /guest-access may upload or see photos.
// 403 (not 401) so the app knows to relock instead of refreshing the session.
function requireGuestPass(req, res, next) {
  if (!verifyGuestPass(req.headers["x-guest-pass"])) {
    secLog(req, "missing or invalid guest pass");
    return res.status(403).json({ error: "Please verify your booking again." });
  }
  next();
}

// ============================================================
// GET /app/files — List photos from GHL Media
// ============================================================
router.get(
  "/files",
  limiter(60 * 1000, 20),
  requireSession,
  requireGuestPass,
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
        console.error("[App/GHL] List files error:", ghlRes.status);
        return res.status(502).json({ error: "Could not retrieve files." });
      }

      const data = await ghlRes.json();
      const files = (data.files || [])
        .filter((f) => f.url && /\.(jpg|jpeg|png|gif|webp)$/i.test(f.name || f.url)) // no SVG: it can carry script
        .map((f) => ({ url: f.url, name: f.name || "Guest photo" }));

      res.json({ files });
    } catch (err) {
      console.error("[App/GHL] List files exception:", err.message);
      res.status(500).json({ error: "Server error." });
    }
  }
);

// ============================================================
// POST /app/upload — Upload a photo to GHL Media
// ============================================================
// The frontend sends the compressed image as a raw binary body
// (application/octet-stream). We rebuild the FormData on the
// server so we can securely inject the parentId.
// ============================================================
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // the app compresses to ~1920px, well under this
const IMAGE_TYPES = [
  { ext: "jpg",  mime: "image/jpeg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png",  mime: "image/png",  is: (b) => b.readUInt32BE(0) === 0x89504e47 },
  { ext: "webp", mime: "image/webp", is: (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
];

router.post(
  "/upload",
  limiter(60 * 1000, 10),
  requireSession,
  requireGuestPass,
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), // 413 beyond the limit
  async (req, res) => {
    if (!isConfigured()) {
      return res.status(500).json({ error: "GHL Media API not configured." });
    }

    const fileBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (fileBuffer.length === 0) {
      return res.status(400).json({ error: "Empty file payload." });
    }
    // Trust the bytes, not the client's name or content type.
    const type = fileBuffer.length >= 12 && IMAGE_TYPES.find((t) => t.is(fileBuffer));
    if (!type) {
      secLog(req, "upload rejected: not a JPEG/PNG/WebP image");
      return res.status(415).json({ error: "Only JPEG, PNG or WebP images are allowed." });
    }
    const fileName = `guest_${Date.now()}_${uuidv4().slice(0, 8)}.${type.ext}`;

    try {
      const folderId = await resolveFolderId();

      // Build a clean FormData for GHL
      const formData = new FormData();
      formData.append("file", new Blob([fileBuffer], { type: type.mime }), fileName);
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
        console.error("[App/GHL] Upload error:", ghlRes.status);
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
// SMOOBU RESERVATION CACHE (60-second TTL)
// ============================================================
let _reservationCache = null;
let _reservationCacheTs = 0;
const RESERVATION_CACHE_TTL_MS = 60 * 1000;

const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

// Real guest reservations (no cancellations or blocks) for stays that haven't ended yet.
async function fetchActiveReservations() {
  const now = Date.now();
  if (_reservationCache && now - _reservationCacheTs < RESERVATION_CACHE_TTL_MS) {
    return _reservationCache;
  }
  const today = isoDay(0);
  const all = await fetchReservations(isoDay(-1), isoDay(365), { showCancellation: "false" });
  _reservationCache = all.filter((b) =>
    b.type === "reservation" && b["is-blocked-booking"] === false && (b.departure || "") >= today);
  _reservationCacheTs = now;
  return _reservationCache;
}

// Lowercase, strip accents, collapse spaces: "  José  Dela Cruz " -> "jose dela cruz"
const normName = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

// ============================================================
// POST /app/guest-access — Verify guest via Smoobu bookings
// ============================================================
// Grants access when the email matches exactly, or (for OTA guests
// whose Smoobu email is a relay address) the FULL name matches exactly.
// Only current/upcoming stays count. The response is yes/no plus a signed
// guest pass: no booking id, name or guest-app link is ever returned.
router.post(
  "/guest-access",
  limiter(15 * 60 * 1000, 20, { access: false }),
  async (req, res) => {
    // 1. Origin restriction (if ALLOWED_ORIGIN is set)
    const allowedOriginsEnv = process.env.ALLOWED_ORIGIN;
    const origin = (req.headers.origin || "").replace(/\/$/, "");
    if (allowedOriginsEnv && origin) {
      const allowedOrigins = allowedOriginsEnv.split(",").map((o) => o.trim());
      const isTrustedGhl = origin.endsWith(".leadconnectorhq.com") || origin.endsWith(".gohighlevel.com") || origin.endsWith(".msgsndr.com");
      if (!allowedOrigins.includes(origin) && !isTrustedGhl) {
        secLog(req, "guest-access blocked origin");
        return res.status(403).json({ access: false });
      }
    }

    // 2. Validate Smoobu credentials
    if (!process.env.SMOOBU_API_LABEL || !process.env.SMOOBU_API_SECRET) {
      console.error("[App/Smoobu] SMOOBU_API_LABEL or SMOOBU_API_SECRET not configured.");
      return res.status(500).json({ access: false });
    }

    const body = req.body || {};
    const cleanEmail = String(body.email || "").trim().toLowerCase();
    const cleanName = normName(body.firstName);
    // A full name (2+ words) is required for the name path; one word is too easy to guess.
    const nameUsable = cleanName.split(" ").length >= 2;

    if (!cleanEmail && !nameUsable) {
      return res.status(400).json({ access: false });
    }

    try {
      const reservations = await fetchActiveReservations();
      const matchedBooking =
        (cleanEmail && reservations.find((b) => String(b.email || "").trim().toLowerCase() === cleanEmail)) ||
        (nameUsable && reservations.find((b) => normName(b["guest-name"]) === cleanName));

      if (!matchedBooking) {
        secLog(req, "guest-access denied");
        return res.json({ access: false });
      }

      console.log(`[App/Smoobu] Guest access granted (booking ${matchedBooking.id})`);

      // Optional: fire automation webhook in background if configured
      const webhookUrl = process.env.GHL_GUEST_PORTAL_WEBHOOK_URL;
      if (webhookUrl) {
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            first_name: (matchedBooking["guest-name"] || "").split(/\s+/)[0] || "",
            email: matchedBooking.email || cleanEmail,
            source: "Mini App Gate",
            tag: "guest-portal-access",
          }),
        }).catch((err) => console.error("[App/Smoobu] Background webhook failed:", err.message));
      }

      // The pass unlocks /files and /upload until 2 days after checkout (Manila time).
      const exp = Date.parse(matchedBooking.departure + "T00:00:00+08:00") + 2 * 86400000;
      return res.json({ access: true, pass: generateGuestPass(exp) });
    } catch (err) {
      console.error("[App/Smoobu] Guest verification exception:", err.message);
      return res.status(500).json({ access: false });
    }
  }
);

export default router;

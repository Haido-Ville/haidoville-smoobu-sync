// ============================================================
// HAIDOVILLE APP SERVER — GHL Media Proxy (Secured)
// ============================================================
// This router proxies GHL Media API calls so that the frontend
// never touches API keys directly. All endpoints are protected
// by the same session-hint middleware used across the backend.
// ============================================================

import express from "express";
import rateLimit from "express-rate-limit";

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
// The frontend sends the compressed image as multipart/form-data.
// We forward it to GHL with the server-side API key.
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

      // Read the raw body as a buffer to forward to GHL
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) {
        return res.status(400).json({ error: "Expected multipart/form-data." });
      }

      // Stream the entire request body to GHL
      const uploadUrl = GHL_UPLOAD_URL + "?altType=location&altId=" + GHL_MEDIA_LOCATION_ID;

      // We need to reconstruct the FormData for GHL.
      // Since express doesn't parse multipart by default, we'll
      // pipe the raw request body directly to GHL.
      const headers = {
        ...ghlHeaders(),
        "content-type": contentType,
      };
      // Remove content-length as it may differ after proxying
      delete headers["content-length"];

      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      const ghlRes = await fetch(uploadUrl, {
        method: "POST",
        headers,
        body,
      });

      if (!ghlRes.ok) {
        const errText = await ghlRes.text();
        console.error("[App/GHL] Upload error:", ghlRes.status, errText);
        return res.status(502).json({ error: "Upload failed." });
      }

      const result = await ghlRes.json();
      console.log("[App/GHL] Upload success:", result.id || result._id || "unknown");
      res.json({ success: true, fileId: result.id || result._id });
    } catch (err) {
      console.error("[App/GHL] Upload exception:", err.message);
      res.status(500).json({ error: "Server error." });
    }
  }
);

export default router;

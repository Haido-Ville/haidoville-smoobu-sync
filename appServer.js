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
// POST /app/guest-access — Verify guest login via GHL tags (API v2)
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
  requireSession,
  async (req, res) => {
    // 1. CORS restriction (if ALLOWED_ORIGIN is set)
    const allowedOriginsEnv = process.env.ALLOWED_ORIGIN;
    const origin = req.headers.origin;
    if (allowedOriginsEnv && origin) {
      const allowedOrigins = allowedOriginsEnv.split(',').map(o => o.trim());
      if (!allowedOrigins.includes(origin)) {
        console.error("[App/GHL] CORS blocked origin:", origin);
        return res.status(403).json({ access: false, debug: "CORS blocked" });
      }
    }

    // 2. Keys & Configuration
    const apiKey = process.env.GHL_CONTACTS_API_KEY;
    const locationId = process.env.GHL_MEDIA_LOCATION_ID || process.env.GHL_LOCATION_ID;
    
    if (!apiKey || !locationId) {
      console.error("[App/GHL] GHL_CONTACTS_API_KEY or location ID not configured.");
      return res.status(500).json({ access: false, debug: "Missing env vars" });
    }

    const { firstName, email } = req.body;
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({ access: false, debug: "Invalid email format" });
    }

    // Comma-separated allowed tags or default
    const tagsEnv = process.env.ACCESS_TAGS;
    const ALLOWED_TAGS = tagsEnv 
      ? tagsEnv.split(',').map(t => t.trim().toLowerCase())
      : ['direct', 'newreservation', 'agoda', 'upsell-ready', 'airbnb', 'booking.com', 'vrbo', 'website', 'updatereservation', 'hv-booked', 'fully-paid'];

    try {
      // 3. Search GHL using API v2
      const searchBody = {
        locationId: locationId,
        query: email
      };

      const ghlRes = await fetch("https://services.leadconnectorhq.com/contacts/search", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Version": "2021-07-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(searchBody)
      });

      if (!ghlRes.ok) {
        const errorText = await ghlRes.text();
        console.error("[App/GHL] Contact lookup failed:", ghlRes.status, errorText);
        return res.status(502).json({ access: false, debug: "GHL API Error: " + ghlRes.status }); 
      }

      const data = await ghlRes.json();
      const contacts = data.contacts || [];

      if (contacts.length > 0) {
        // Take the first matching contact (most relevant by email)
        const contact = contacts[0];
        const contactTags = (contact.tags || []).map(t => t.toLowerCase());
        
        // 4. Check tags
        const hasAccess = contactTags.some(tag => ALLOWED_TAGS.includes(tag));

        if (hasAccess) {
          console.log(`[App/GHL] Access granted for: ${email}`);
          
          // Optional: Fire automation webhook in background if configured
          const webhookUrl = process.env.GHL_GUEST_PORTAL_WEBHOOK_URL;
          if (webhookUrl) {
             fetch(webhookUrl, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({
                 first_name: firstName || contact.firstName || '',
                 email: email,
                 source: 'Mini App Gate',
                 tag: 'guest-portal-access'
               })
             }).catch(err => console.error("[App/GHL] Background webhook failed:", err.message));
          }

          // 5. Respond success (never leak why it was approved vs denied)
          return res.json({ access: true, firstName: contact.firstName || firstName });
        }
      }

      // If no contact found or no valid tags
      console.warn(`[App/GHL] Access denied for: ${email} (No valid tags or not found)`);
      return res.json({ access: false }); // Fail securely (never leak existence)

    } catch (err) {
      console.error("[App/GHL] Guest verification exception:", err.message);
      return res.status(500).json({ access: false }); // Fail closed securely
    }
  }
);

export default router;

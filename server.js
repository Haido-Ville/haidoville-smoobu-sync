// ============================================================
// HAIDOVILLE × SMOOBU SYNC - Render.com Server v4.1
// ============================================================
// v4.1 CHANGES (on top of v4.0):
// - FIX: Double startup rotation so JWT_SECRET is never present
//        in JWT_PREV_SEC after boot. Both CURR and PREV are now
//        fresh random keys from the first request onward.
// - FIX: /bookings query params (from/to) now validated with
//        the same isValidDate() used in /bookings/create.
// ============================================================

import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Resend } from "resend";
import "dotenv/config"; 

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import {
  generateHint,
  verifyHint,
} from "./encryption.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },

  contentSecurityPolicy: {
    useDefaults: false, // take full control
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "'unsafe-eval'"],  // fixes script-src violation
      styleSrc:       ["'self'", "'unsafe-inline'"],
      connectSrc:     ["'self'", "https://haidoville.com"],            // fixes connect-src 'none' blocking Cloudflare RUM
      imgSrc:         ["'self'", "data:", "https:"],
      fontSrc:        ["'self'", "https:", "data:"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'self'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      upgradeInsecureRequests: [],
    },
    reportOnly: false, // ← set to true only when testing; false enforces the policy
  },

  // X-XSS-Protection
  xssFilter: true,

  // X-Content-Type-Options
  noSniff: true,

  // X-Frame-Options
  frameguard: { action: "sameorigin" },

  // Strict-Transport-Security
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },

  // Referrer-Policy
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

// Permissions-Policy — must be added manually, helmet doesn't set this header
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    [
      "accelerometer=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "usb=()",
    ].join(", ")
  );
  next();
});
const PORT = process.env.PORT || 3000;

// ---- Config ----
const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL || "";
const GHL_INQUIRY_WEBHOOK_URL = process.env.GHL_INQUIRY_WEBHOOK_URL || "";
const CACHE_DURATION_MS = 5 * 60 * 1000;
const CREATE_SMOOBU_DRAFT = process.env.CREATE_SMOOBU_DRAFT === "true";

// ---- Secure Configuration Keys ----
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const CALENDAR_ACCESS_TOKEN = process.env.CALENDAR_ACCESS_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
let JWT_CURR_SEC = JWT_SECRET;
let JWT_PREV_SEC = JWT_SECRET;
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || "90s";
const JWT_ROTATE_MS = process.env.JWT_ROTATE_MS ? parseInt(process.env.JWT_ROTATE_MS, 10) : 12 * 60 * 60 * 1000;

function rotateJwtKeys() {
  JWT_PREV_SEC = JWT_CURR_SEC;
  JWT_CURR_SEC = crypto.randomBytes(32).toString('hex');
  console.log(`[JWT] Keys rotated at ${new Date().toISOString()}. Previous key retired, new key generated.`);
}
// FIX: Rotate TWICE on startup so JWT_SECRET is flushed from both
// CURR and PREV. After two rotations both are random — JWT_SECRET
// is never used as a verification key from the very first request.
rotateJwtKeys();
rotateJwtKeys();
setInterval(rotateJwtKeys, JWT_ROTATE_MS);

// ============================================================
// PERSISTENT REFERENCE NUMBER STORE (Dedup)
// ============================================================
const REF_FILE = path.join(__dirname, "data", "processed_refs.json");
let processedReferenceNumbers = new Set();

try {
  if (fs.existsSync(REF_FILE)) {
    const data = JSON.parse(fs.readFileSync(REF_FILE, "utf8"));
    processedReferenceNumbers = new Set(data);
  } else {
    fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
    fs.writeFileSync(REF_FILE, JSON.stringify([]));
  }
} catch (e) {
  console.error("Error loading reference numbers:", e.message);
}

async function isRefAlreadyUsed(refNum) {
  return processedReferenceNumbers.has(refNum);
}

async function markRefAsUsed(refNum) {
  processedReferenceNumbers.add(refNum);
  if (processedReferenceNumbers.size > 10000) {
    const it = processedReferenceNumbers.values();
    processedReferenceNumbers.delete(it.next().value);
  }
  try {
    fs.writeFileSync(REF_FILE, JSON.stringify([...processedReferenceNumbers]));
  } catch(e) {
    console.error("Error saving reference numbers:", e.message);
  }
}

// ---- Holy Week Date Helper ----
function getEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

function isHolyWeekDate(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const easter = getEaster(d.getFullYear());
  const diffDays = Math.floor((easter.getTime() - d.getTime()) / 86400000);
  return diffDays >= 0 && diffDays <= 7;
}

// ---- Shared date validation helper (used in /bookings and /bookings/create) ----
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(str) {
  if (!DATE_REGEX.test(str)) return false;
  const d = new Date(str + 'T00:00:00');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

// ---- Booking ID generator ----
async function generateUniqueBookingId() {
  const now = new Date();
  const yymm =
    String(now.getFullYear()).slice(-2) +
    String(now.getMonth() + 1).padStart(2, "0");
  const uniquePart = uuidv4().split('-')[0].toUpperCase();
  return `HV-${yymm}-${uniquePart}`;
}

// ---- Server-Side Pricing Function ----
function calculateRoomPrice(roomName, pax, nights, checkIn, checkOut) {
  nights = Math.max(1, nights);
  pax = Math.max(1, pax);

  switch (roomName) {
    case "Bunk Beds": {
      if (pax < 1 || pax > 6) throw new Error("Bunk Beds max is 6 beds.");
      if (checkIn && checkOut) {
        let total = 0;
        const start = new Date(checkIn + "T00:00:00");
        const end = new Date(checkOut + "T00:00:00");
        const msPerDay = 86400000;
        const numNights = Math.round((end - start) / msPerDay);
        for (let i = 0; i < numNights; i++) {
          const night = new Date(start.getTime() + i * msPerDay);
          total += (isHolyWeekDate(night) ? 600 : 500) * pax;
        }
        return total;
      }
      return 500 * pax * nights;
    }
    case "Couple Room":
      if (pax <= 2) return 1200 * nights;
      if (pax === 3) return 1500 * nights;
      throw new Error("Couple Room max pax is 3.");
    case "Barkada Room":
      if (pax >= 6 && pax <= 7) return 3500 * nights;
      if (pax >= 8 && pax <= 9) return 500 * pax * nights;
      throw new Error("Barkada Room pax must be 6–9.");
    case "Family Room 1":
    case "Family Room 2":
      if (pax >= 1 && pax <= 5) return 2500 * nights;
      if (pax === 6) return 3000 * nights;
      throw new Error("Family Room max pax is 6.");
    default:
      throw new Error(`Unknown room: ${roomName}`);
  }
}

// ---- Apartment Mapping ----
const APARTMENT_MAP = {
  3261782: "barkada",
  3261742: "couple",
  3261662: { roomId: "family", unit: "Family Room 1" },
  3261737: { roomId: "family", unit: "Family Room 2" },
  3261752: { roomId: "bunk", beds: 1 },
  3261757: { roomId: "bunk", beds: 1 },
  3261762: { roomId: "bunk", beds: 1 },
  3261767: { roomId: "bunk", beds: 1 },
  3261772: { roomId: "bunk", beds: 1 },
  3261777: { roomId: "bunk", beds: 1 },
};

const ROOM_NAME_TO_APT_ID = {
  "Barkada Room": 3261782,
  "Couple Room": 3261742,
  "Family Room 1": 3261662,
  "Family Room 2": 3261737,
  "Bunk Beds": [3261752, 3261757, 3261762, 3261767, 3261772, 3261777],
};

const NON_BUNK_ROOM_APT_IDS = {
  "Barkada Room": 3261782,
  "Couple Room": 3261742,
  "Family Room 1": 3261662,
  "Family Room 2": 3261737,
};

const BUNK_APARTMENT_IDS = ROOM_NAME_TO_APT_ID["Bunk Beds"];

// ---- Cache & In-Memory Booking Log ----
let cache = { data: null, timestamp: 0 };
const pendingBookings = [];

// ---- Middleware ----
app.use(express.json({ limit: "1mb" }));

// Strict CORS
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowedOrigins = [
    "https://haidoville.com",
    "https://app.haidoville.com",
    "https://www.haidoville.com",
  ];
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-API-Key, X-Calendar-Access, Authorization, X-Session-Hint, X-Timestamp"
    );
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://haidoville.com");
  }
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

const requireApiKey = (req, res, next) => {
  const clientKey = req.headers["x-api-key"];
  if (!clientKey || clientKey !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const requireCalendarAccess = (req, res, next) => {
  const calToken = req.headers["x-calendar-access"];
  if (!calToken || calToken !== CALENDAR_ACCESS_TOKEN) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
};

// ============================================================
// TIMESTAMP DRIFT MIDDLEWARE (Replay Attack Prevention)
// ============================================================
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

const requireFreshTimestamp = (req, res, next) => {
  const raw = req.headers["x-timestamp"];
  if (!raw) return res.status(400).json({ error: "Unauthorized" });
  const incoming = parseInt(raw, 10);
  if (isNaN(incoming)) return res.status(400).json({ error: "Unauthorized" });
  if (Math.abs(Date.now() - incoming) > MAX_TIMESTAMP_DRIFT_MS) {
    return res.status(400).json({ error: "Unauthorized" });
  }
  next();
};

// ============================================================
// ONE-TIME USE JWT VALIDATION (persisted to disk)
// ============================================================
const USED_TOKENS_FILE = path.join(__dirname, "data", "used_tokens.json");
const usedTokens = new Map();

try {
  if (fs.existsSync(USED_TOKENS_FILE)) {
    const stored = JSON.parse(fs.readFileSync(USED_TOKENS_FILE, "utf8"));
    const now = Date.now();
    for (const [jti, exp] of stored) {
      if (now < exp) usedTokens.set(jti, exp);
    }
    console.log(`[JWT] Loaded ${usedTokens.size} unexpired JTIs from disk.`);
  }
} catch (e) {
  console.error("[JWT] Error loading used tokens:", e.message);
}

function persistUsedTokens() {
  try {
    const now = Date.now();
    const entries = [];
    for (const [jti, exp] of usedTokens) {
      if (now < exp) entries.push([jti, exp]);
      else usedTokens.delete(jti);
    }
    fs.writeFileSync(USED_TOKENS_FILE, JSON.stringify(entries));
  } catch (e) {
    console.error("[JWT] Error persisting used tokens:", e.message);
  }
}

const requireJwtToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_CURR_SEC);
  } catch (e1) {
    try {
      decoded = jwt.verify(token, JWT_PREV_SEC);
    } catch (e2) {
      return res.status(403).json({ error: "Invalid or expired token." });
    }
  }

  if (usedTokens.has(decoded.jti)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  usedTokens.set(decoded.jti, decoded.exp * 1000);
  persistUsedTokens();
  next();
};

// ============================================================
// RATE LIMITING
// ============================================================
const bookingRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

const tokenRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

const pingRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

const availabilityRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

const inquiryRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

// ============================================================
// GET /ping — Public keep-alive endpoint (no auth)
// ============================================================
app.get("/ping", pingRateLimiter, (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ============================================================
// POST /internal/rotate-jwt — Manually trigger JWT key rotation
// ============================================================
app.post("/internal/rotate-jwt", requireApiKey, (req, res) => {
  rotateJwtKeys();
  res.json({ ok: true, message: "JWT keys rotated successfully.", ts: Date.now() });
});

// ============================================================
// GET / — Protected health check (internal use only)
// ============================================================
app.get("/", requireApiKey, (req, res) => {
  res.json({
    service: "HaidoVille Smoobu Sync",
    version: "4.1",
    status: "online",
    features: {
      smoobuSync: !!SMOOBU_API_KEY,
      email: !!RESEND_API_KEY && !!ADMIN_EMAIL,
      ghlWebhook: !!GHL_WEBHOOK_URL,
      smoobuDraft: CREATE_SMOOBU_DRAFT && !!SMOOBU_API_KEY,
    },
    endpoints: {
      ping: "GET /ping",
      availability: "GET /availability",
      bookings: "GET /bookings",
      bookingToken: "GET /booking-token",
      apartments: "GET /apartments-list",
      createBooking: "POST /bookings/create",
      inquiry: "POST /inquiry",
    },
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// GET /apartments-list
// ============================================================
app.get("/apartments-list", requireApiKey, async (req, res) => {
  if (!SMOOBU_API_KEY)
    return res.status(500).json({ error: "SMOOBU_API_KEY not configured" });
  try {
    const response = await fetch("https://login.smoobu.com/api/apartments", {
      headers: { "Api-Key": SMOOBU_API_KEY, "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    const data = await response.json();
    const apartments = data.apartments || [];
    const sampleMapping = {};
    apartments.forEach((apt) => {
      sampleMapping[apt.id] = `'${apt.name}'`;
    });
    res.json({
      instructions: "Copy IDs at gamitin sa APARTMENT_MAP",
      totalApartments: apartments.length,
      apartments,
      sampleMapping,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /bookings (protected calendar sync — internal/admin use)
// ============================================================
app.get("/bookings", requireCalendarAccess, async (req, res) => {
  if (!SMOOBU_API_KEY)
    return res.status(500).json({ error: "SMOOBU_API_KEY not configured" });

  const nocache = req.query.nocache === "1";
  const now = Date.now();
  if (!nocache && cache.data && now - cache.timestamp < CACHE_DURATION_MS) {
    res.setHeader("X-Cache", "HIT");
    res.setHeader("X-Cache-Age", Math.floor((now - cache.timestamp) / 1000));
    return res.json(cache.data);
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const oneYearLater = new Date();
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    const toDate = oneYearLater.toISOString().slice(0, 10);

    // FIX: Validate query param dates before passing to Smoobu
    const rawFrom = typeof req.query.from === "string" ? req.query.from.slice(0, 10) : null;
    const rawTo   = typeof req.query.to   === "string" ? req.query.to.slice(0, 10)   : null;

    if (rawFrom && !isValidDate(rawFrom)) {
      return res.status(400).json({ error: "Invalid 'from' date format. Use YYYY-MM-DD." });
    }
    if (rawTo && !isValidDate(rawTo)) {
      return res.status(400).json({ error: "Invalid 'to' date format. Use YYYY-MM-DD." });
    }

    const fromDate = rawFrom || today;
    const endDate  = rawTo   || toDate;

    const allBookings = [];
    let page = 1;
    let totalPages = 1;
    const maxPages = 20;

    do {
      const url = new URL("https://login.smoobu.com/api/reservations");
      url.searchParams.set("from", fromDate);
      url.searchParams.set("to", endDate);
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("page", String(page));
      url.searchParams.set("excludeBlocked", "false");

      const smoobuRes = await fetch(url.toString(), {
        headers: { "Api-Key": SMOOBU_API_KEY, "Cache-Control": "no-cache" },
      });

      if (!smoobuRes.ok) {
        const errText = await smoobuRes.text();
        return res.status(smoobuRes.status).json({
          error: "Smoobu API error",
          status: smoobuRes.status,
          detail: errText,
        });
      }

      const data = await smoobuRes.json();
      if (data.bookings && data.bookings.length)
        allBookings.push(...data.bookings);
      totalPages = data.page_count || 1;
      page++;
    } while (page <= totalPages && page <= maxPages);

    const result = buildAvailabilityResult(allBookings);
    cache = { data: result, timestamp: now };
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

// ============================================================
// SESSION TOKENS — capped uses, self-expiring
// ============================================================
const sessionTokens = new Map();
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS) || 10 * 60 * 1000;
const SESSION_MAX_USES = parseInt(process.env.SESSION_MAX_USES) || 15;

function cleanupSessionTokens() {
  const now = Date.now();
  for (const [hint, session] of sessionTokens) {
    if (now > session.exp || session.usesLeft <= 0) sessionTokens.delete(hint);
  }
}

const requireValidSessionHint = (req, res, next) => {
  const header = req.headers["x-session-hint"] || "";
  const parts = header.split(".");
  if (parts.length !== 3) return res.status(400).json({ error: "Unauthorized" });
  const [hint, ts, sig] = parts;
  try {
    verifyHint(hint, ts, sig);
    const session = sessionTokens.get(hint);
    if (!session) return res.status(401).json({ error: "Session expired, reload the page" });
    if (Date.now() > session.exp) {
      sessionTokens.delete(hint);
      return res.status(401).json({ error: "Session expired, reload the page" });
    }
    const currentUa = req.headers["user-agent"] || "unknown";
    if (session.userAgent !== currentUa) {
      sessionTokens.delete(hint);
      return res.status(403).json({ error: "Session context mismatch. Token theft detected." });
    }
    req.sessionHint = hint;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Unauthorized" });
  }
};

const requireSessionHint = (req, res, next) => {
  const header = req.headers["x-session-hint"] || "";
  const parts = header.split(".");
  if (parts.length !== 3) return res.status(400).json({ error: "Unauthorized" });
  const [hint, ts, sig] = parts;
  try {
    verifyHint(hint, ts, sig);
    const session = sessionTokens.get(hint);
    if (!session) return res.status(401).json({ error: "Session expired, reload the page" });
    if (Date.now() > session.exp) {
      sessionTokens.delete(hint);
      return res.status(401).json({ error: "Session expired, reload the page" });
    }
    const currentUa = req.headers["user-agent"] || "unknown";
    if (session.userAgent !== currentUa || session.ip !== req.ip) {
      sessionTokens.delete(hint);
      return res.status(403).json({ error: "Session context mismatch. Token theft detected." });
    }
    if (session.usesLeft <= 0) {
      sessionTokens.delete(hint);
      return res.status(401).json({ error: "Session expired, reload the page" });
    }
    session.usesLeft -= 1;
    if (session.usesLeft <= 0) sessionTokens.delete(hint);
    if (sessionTokens.size > 500) cleanupSessionTokens();
    req.sessionHint = hint;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Unauthorized" });
  }
};

// ============================================================
// GET /api/session-hint — Issues a signed hint per page-load
// ============================================================
app.get("/api/session-hint", tokenRateLimiter, (req, res) => {
  const origin = req.headers.origin || "";
  const allowedOrigins = [
    "https://haidoville.com",
    "https://app.haidoville.com",
    "https://www.haidoville.com"
  ];
  if (!allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    const { hint, ts, sig } = generateHint();
    const csrfToken = uuidv4();
    sessionTokens.set(hint, {
      usesLeft: SESSION_MAX_USES,
      exp: Date.now() + SESSION_TTL_MS,
      userAgent: req.headers["user-agent"] || "unknown",
      ip: req.ip,
      csrfToken: csrfToken
    });
    res.json({ hint: `${hint}.${ts}.${sig}`, csrfToken });
  } catch (err) {
    console.error("[session-hint] Failed:", err.message);
    res.status(500).json({ error: "Could not generate session hint." });
  }
});

// ============================================================
// GET /api/payment-methods — Serves payment data
// ============================================================
app.get("/api/payment-methods", tokenRateLimiter, requireSessionHint, (req, res) => {
  res.json({
    payments: {
      gcash: { number: process.env.GCASH_NUMBER, owner: process.env.GCASH_OWNER },
      maya: { number: process.env.MAYA_NUMBER, owner: process.env.MAYA_OWNER },
      metrobank: { account: process.env.METROBANK_ACCOUNT, owner: process.env.METROBANK_OWNER },
      landbank: { account: process.env.LANDBANK_ACCOUNT, owner: process.env.LANDBANK_OWNER }
    }
  });
});

// ============================================================
// GET /availability (public — no auth, no PII)
// ============================================================
app.get("/availability", availabilityRateLimiter, requireValidSessionHint, async (req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_DURATION_MS) {
    res.setHeader("X-Cache", "HIT");
    res.setHeader("X-Cache-Age", Math.floor((now - cache.timestamp) / 1000));
    return res.json(cache.data);
  }

  if (!SMOOBU_API_KEY)
    return res.status(500).json({ error: "SMOOBU_API_KEY not configured" });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const oneYearLater = new Date();
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    const toDate = oneYearLater.toISOString().slice(0, 10);

    const allBookings = [];
    let page = 1, totalPages = 1;

    do {
      const url = new URL("https://login.smoobu.com/api/reservations");
      url.searchParams.set("from", today);
      url.searchParams.set("to", toDate);
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("page", String(page));
      url.searchParams.set("excludeBlocked", "false");

      const smoobuRes = await fetch(url.toString(), {
        headers: { "Api-Key": SMOOBU_API_KEY, "Cache-Control": "no-cache" },
      });
      if (!smoobuRes.ok)
        return res.status(smoobuRes.status).json({ error: "Smoobu error" });

      const data = await smoobuRes.json();
      if (data.bookings?.length) allBookings.push(...data.bookings);
      totalPages = data.page_count || 1;
      page++;
    } while (page <= totalPages && page <= 20);

    const result = buildAvailabilityResult(allBookings);
    cache = { data: result, timestamp: now };
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Shared helper — builds the availability result from Smoobu bookings array
function buildAvailabilityResult(allBookings) {
  const result = {
    bookedRanges: [],
    bunkBookings: [],
    familyBookedUnits: [],
    bunkTotal: BUNK_APARTMENT_IDS.length,
    updatedAt: new Date().toISOString(),
    totalBookings: allBookings.length,
  };

  for (const booking of allBookings) {
    if (booking.type === "cancellation") continue;
    const apartmentId = booking.apartment?.id;
    const arrival = booking.arrival;
    const departure = booking.departure;
    if (!apartmentId || !arrival || !departure) continue;

    const mapping = APARTMENT_MAP[apartmentId];
    if (!mapping) {
      result.bookedRanges.push({ _unmapped: true, ci: arrival, co: departure });
      continue;
    }

    const range = { ci: arrival, co: departure };

    if (typeof mapping === "string") {
      if (mapping === "bunk") result.bunkBookings.push({ ...range, beds: 1 });
      else result.bookedRanges.push({ ...range, room: mapping });
    } else if (typeof mapping === "object") {
      if (mapping.roomId === "bunk")
        result.bunkBookings.push({ ...range, beds: mapping.beds || 1 });
      else if (mapping.roomId === "family")
        result.familyBookedUnits.push({ ...range, unit: mapping.unit });
      else result.bookedRanges.push({ ...range, room: mapping.roomId });
    }
  }

  return result;
}

// ============================================================
// GET /booking-token (public — issues one-time JWT)
// ============================================================
app.get("/booking-token", tokenRateLimiter, requireSessionHint, (req, res) => {
  const jti = uuidv4();
  const token = jwt.sign({ jti }, JWT_CURR_SEC, { expiresIn: JWT_EXPIRATION });
  res.json({ token });
});

// ============================================================
// POST /bookings/create
// ============================================================
let bookingMutex = Promise.resolve();
app.post(
  "/bookings/create",
  requireJwtToken,
  requireSessionHint,
  requireFreshTimestamp,
  bookingRateLimiter,
  async (req, res) => {
    let releaseMutex = null;
    try {
      const rawData = req.body;

      if (!rawData || !rawData.bookingId || !rawData.guest || !rawData.rooms || !rawData.payment) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (!Array.isArray(rawData.rooms) || rawData.rooms.length === 0 || rawData.rooms.length > 5) {
        return res.status(400).json({ error: "Invalid room allocation parameters boundary." });
      }

      const clientRef = String(rawData.payment.referenceNumber || "").trim();
      if (rawData.payment.channel !== "cash") {
        if (!clientRef || clientRef.length < 5) {
          return res.status(400).json({ error: "Unauthorized" });
        }
        if (await isRefAlreadyUsed(clientRef)) {
          return res.status(409).json({ error: "Unauthorized" });
        }
      }

      const sanitizeText = (str, maxLen) => String(str || "").replace(/[<>\r\n]/g, "").trim().slice(0, maxLen);

      const sanitizedGuest = {
        name: sanitizeText(rawData.guest.name, 80),
        email: sanitizeText(rawData.guest.email, 80),
        phone: sanitizeText(rawData.guest.phone, 30),
        age: sanitizeText(rawData.guest.age, 10),
        nationality: sanitizeText(rawData.guest.nationality, 30),
        address: sanitizeText(rawData.guest.address, 200),
        arrivalTime: sanitizeText(rawData.guest.arrivalTime, 20),
        departureTime: sanitizeText(rawData.guest.departureTime, 20),
        port: sanitizeText(rawData.guest.port, 50),
        specialRequest: sanitizeText(rawData.guest.specialRequest, 500),
      };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitizedGuest.email)) {
        return res.status(400).json({ error: "Invalid email address." });
      }

      const VALID_ROOM_NAMES = Object.keys(ROOM_NAME_TO_APT_ID);

      for (const room of rawData.rooms) {
        if (!VALID_ROOM_NAMES.includes(String(room.name))) {
          return res.status(400).json({ error: "Invalid room name." });
        }
      }

      const todayStr = new Date().toISOString().slice(0, 10);

      const sanitizedRooms = rawData.rooms.map((room) => ({
        name: String(room.name),
        checkIn: String(room.checkIn).slice(0, 10),
        checkOut: String(room.checkOut).slice(0, 10),
        nights: Math.max(1, Math.min(30, parseInt(room.nights) || 1)),
        pax: Math.max(1, Math.min(9, parseInt(room.pax) || 1)),
        paxLabel: room.name === "Bunk Beds" ? "Beds" : "Guests",
      }));

      for (const room of sanitizedRooms) {
        if (!isValidDate(room.checkIn) || !isValidDate(room.checkOut)) {
          return res.status(400).json({ error: "Invalid date format." });
        }
        if (room.checkIn < todayStr) {
          return res.status(400).json({ error: "Check-in date cannot be in the past." });
        }
        if (room.checkOut <= room.checkIn) {
          return res.status(400).json({ error: "Check-out must be after check-in." });
        }
        const ci = new Date(room.checkIn + 'T00:00:00');
        const co = new Date(room.checkOut + 'T00:00:00');
        const stayNights = Math.round((co - ci) / 86400000);
        if (stayNights < 2) {
          return res.status(400).json({ error: 'Minimum stay is 2 nights.' });
        }
        room.nights = stayNights;
      }

      let calculatedGrandTotal = 0;
      const finalProcessedRooms = sanitizedRooms.map((room) => {
        const calculatedSubtotal = calculateRoomPrice(
          room.name, room.pax, room.nights, room.checkIn, room.checkOut,
        );
        calculatedGrandTotal += calculatedSubtotal;
        return { ...room, subtotal: calculatedSubtotal };
      });

      if (SMOOBU_API_KEY) {
        for (const room of sanitizedRooms) {
          if (room.name === "Bunk Beds") {
            const bedsNeeded = parseInt(room.pax) || 1;
            const freeApts = await findAvailableBunkApartments(room.checkIn, room.checkOut);
            if (freeApts.length < bedsNeeded) {
              console.warn(`[Availability] Bunk Beds: need ${bedsNeeded} beds, only ${freeApts.length} free for ${room.checkIn} → ${room.checkOut}.`);
              return res.status(409).json({
                error: `Not enough bunk beds available for the selected dates. Only ${freeApts.length} bed${freeApts.length !== 1 ? "s" : ""} left — you requested ${bedsNeeded}. Please adjust your dates or number of beds.`,
              });
            }
            continue;
          }
          const aptId = NON_BUNK_ROOM_APT_IDS[room.name];
          if (!aptId) continue;
          const isAvailable = await checkNonBunkAvailability(aptId, room.checkIn, room.checkOut);
          if (!isAvailable) {
            console.warn(`[Availability] ${room.name} is already booked for ${room.checkIn} → ${room.checkOut}.`);
            return res.status(409).json({
              error: `${room.name} is not available for the selected dates. Please choose different dates or a different room.`,
            });
          }
        }
      }

      const VALID_CHANNELS = ["gcash","maya","metro","land","cash"];
      const paymentChannel = String(rawData.payment.channel);
      if (!VALID_CHANNELS.includes(paymentChannel)) {
        return res.status(400).json({ error: "Unauthorized" });
      }

      const paymentType = String(rawData.payment.type) === "full" ? "full" : "dp";
      const finalAmountPaid = paymentType === "full"
        ? calculatedGrandTotal
        : Math.ceil(calculatedGrandTotal * 0.5);

      // Strict price validation — no tolerance
      const clientAmount = Number(rawData.payment.amount);
      const clientGrandTotal = Number(rawData.payment.grandTotal);
      if (clientAmount !== finalAmountPaid || clientGrandTotal !== calculatedGrandTotal) {
        return res.status(400).json({ error: "Unauthorized" });
      }

      const acquired = new Promise(r => releaseMutex = r);
      const prev = bookingMutex;
      bookingMutex = acquired;
      await prev;

      if (paymentChannel !== "cash" && await isRefAlreadyUsed(clientRef)) {
        return res.status(409).json({ error: "Unauthorized" });
      }

      const serverBookingId = await generateUniqueBookingId();

      const data = {
        bookingId: serverBookingId,
        source: String(rawData.source || "Website (Direct)").slice(0, 50),
        submittedAt: rawData.submittedAt || new Date().toISOString(),
        guest: sanitizedGuest,
        rooms: finalProcessedRooms,
        payment: {
          channel: paymentChannel,
          type: paymentType,
          referenceNumber: paymentChannel === "cash" ? `CASH-${Date.now()}` : clientRef,
          amount: finalAmountPaid,
          grandTotal: calculatedGrandTotal,
        },
      };

      if (paymentChannel !== "cash") {
        await markRefAsUsed(clientRef);
      }

      pendingBookings.push({ ...data, receivedAt: new Date().toISOString() });

      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      while (pendingBookings.length > 0 && new Date(pendingBookings[0].receivedAt).getTime() < weekAgo) {
        pendingBookings.shift();
      }

      console.log("[Booking Received]", data.bookingId, "-", data.guest.name, "(", data.guest.email, ") source:", data.source);

      if (GHL_WEBHOOK_URL) {
        forwardToGHL(data).catch((err) => console.error("[GHL Webhook Error]", err.message));
      }

      if (RESEND_API_KEY && ADMIN_EMAIL) {
        sendBookingEmail(data).catch((err) => console.error("[Email Error]", err.message));
      }

      if (CREATE_SMOOBU_DRAFT && SMOOBU_API_KEY) {
        createSmoobuDraft(data)
          .then(() => { cache = { data: null, timestamp: 0 }; })
          .catch((err) => console.error("[Smoobu Draft Error]", err.message));
      }

      res.json({
        success: true,
        bookingId: data.bookingId,
        message: paymentChannel === "cash"
          ? "Booking confirmed! Please pay in cash upon arrival."
          : "Booking reserved. Please complete payment.",
      });
    } catch (err) {
      console.error("[Booking Create Error]", err);
      res.status(500).json({ error: "Server error" });
    } finally {
      if (typeof releaseMutex === 'function') releaseMutex();
    }
  },
);

// ============================================================
// POST /inquiry — Proxy for GHL Inquiry Webhook
// ============================================================
app.post(
  "/inquiry",
  requireSessionHint,
  inquiryRateLimiter,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const header = req.headers["x-session-hint"] || "";
      const hint = header.split(".")[0];
      const session = sessionTokens.get(req.sessionHint);
      
      if (!req.body.csrfToken || req.body.csrfToken !== session.csrfToken) {
        return res.status(403).json({ error: "Invalid CSRF token" });
      }
      session.csrfToken = null;

      if (!GHL_INQUIRY_WEBHOOK_URL) {
        return res.status(500).json({ error: "Inquiry webhook not configured." });
      }

      const INQUIRY_ALLOWED_FIELDS = [
        'full_name', 'phone', 'email',
        'quote_checkin_date', 'quote_checkout_date',
        'quote_number_of_pax', 'quote_preferred_room_type',
        'quote_message'
      ];
      const params = new URLSearchParams();
      for (const key of INQUIRY_ALLOWED_FIELDS) {
        if (req.body[key] !== undefined) {
          params.append(key, String(req.body[key]).slice(0, 1000));
        }
      }

      const response = await fetch(GHL_INQUIRY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });

      if (!response.ok) {
        throw new Error("GHL responded with status " + response.status);
      }

      res.json({ success: true, message: "Inquiry sent successfully." });
    } catch (err) {
      console.error("[Inquiry Proxy Error]", err.message);
      res.status(500).json({ error: "Could not send inquiry at this time." });
    }
  }
);

// ============================================================
// HELPER: Check availability for a single non-bunk room
// ============================================================
async function checkNonBunkAvailability(apartmentId, checkIn, checkOut) {
  try {
    const url = new URL("https://login.smoobu.com/api/reservations");
    url.searchParams.set("from", checkIn);
    url.searchParams.set("to", checkOut);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("excludeBlocked", "false");

    const response = await fetch(url.toString(), {
      headers: { "Api-Key": SMOOBU_API_KEY, "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      console.warn(`[Availability] Smoobu fetch failed for apt ${apartmentId}. Blocking as precaution. Status:`, response.status);
      return false;
    }

    const data = await response.json();
    const bookings = data.bookings || [];

    for (const b of bookings) {
      if (b.type === "cancellation") continue;
      if (b.apartment?.id !== apartmentId) continue;
      if (b.arrival && b.departure && b.arrival < checkOut && b.departure > checkIn) {
        return false;
      }
    }

    return true;
  } catch (err) {
    console.error(`[Availability] Error checking apt ${apartmentId}:`, err.message);
    return false;
  }
}

// ============================================================
// HELPER: Find available Bunk apartments
// ============================================================
async function findAvailableBunkApartments(checkIn, checkOut) {
  if (!SMOOBU_API_KEY) return [];

  try {
    const url = new URL("https://login.smoobu.com/api/reservations");
    url.searchParams.set("from", checkIn);
    url.searchParams.set("to", checkOut);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("excludeBlocked", "false");

    const response = await fetch(url.toString(), {
      headers: { "Api-Key": SMOOBU_API_KEY, "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      console.warn("[Bunk Picker] Smoobu fetch failed — failing safe. Status:", response.status);
      return [];
    }

    const data = await response.json();
    const bookings = data.bookings || [];
    const bookedIds = new Set();

    for (const b of bookings) {
      if (b.type === "cancellation") continue;
      const aptId = b.apartment?.id;
      if (!BUNK_APARTMENT_IDS.includes(aptId)) continue;
      if (b.arrival && b.departure && b.arrival < checkOut && b.departure > checkIn) {
        bookedIds.add(aptId);
      }
    }

    const freeIds = BUNK_APARTMENT_IDS.filter((id) => !bookedIds.has(id));
    console.log("[Bunk Picker]", checkIn, "→", checkOut, "| booked:", bookedIds.size, "| free IDs:", freeIds);
    return freeIds;
  } catch (err) {
    console.error("[Bunk Picker] Error — failing safe:", err.message);
    return [];
  }
}

// ============================================================
// HELPER: Create Smoobu Draft Booking
// ============================================================
async function createSmoobuDraft(data) {
  if (!CREATE_SMOOBU_DRAFT || !SMOOBU_API_KEY) return;

  for (const room of data.rooms) {
    const isBunk = room.name === "Bunk Beds";
    const bedsNeeded = parseInt(room.pax) || 1;
    let apartmentIds = [];

    if (isBunk) {
      const freeApts = await findAvailableBunkApartments(room.checkIn, room.checkOut);
      if (freeApts.length === 0) {
        console.warn("[Smoobu Draft] No free bunk apartments, skipping.");
        continue;
      }
      apartmentIds = freeApts.slice(0, bedsNeeded);
    } else {
      const aptId = resolveApartmentId(room.name);
      if (!aptId) {
        console.warn("[Smoobu Draft] Unknown room:", room.name);
        continue;
      }
      apartmentIds = [aptId];
    }

    const nameParts = (data.guest.name || "").trim().split(/\s+/);
    const firstName = nameParts[0] || "Guest";
    const lastName = nameParts.slice(1).join(" ") || "(Pending)";
    const isMulti = apartmentIds.length > 1;
    const pricePerUnit = isBunk
      ? Math.round((room.subtotal || 0) / Math.max(1, bedsNeeded))
      : room.subtotal || 0;
    const adultsPerUnit = isBunk ? 1 : parseInt(room.pax) || 1;

    for (let i = 0; i < apartmentIds.length; i++) {
      const apartmentId = apartmentIds[i];
      const bedSuffix = isBunk && isMulti ? ` (Bed ${i + 1}/${apartmentIds.length})` : "";

      const payload = {
        arrivalDate: room.checkIn,
        departureDate: room.checkOut,
        apartmentId,
        channelId: 70,
        firstName,
        lastName: lastName + bedSuffix,
        email: data.guest.email,
        phone: data.guest.phone,
        adults: adultsPerUnit,
        price: pricePerUnit,
        priceStatus: 0,
        notice: `[WEBSITE ${data.bookingId}] ${data.payment.type.toUpperCase()} | ${data.payment.channel.toUpperCase()} | Ref: ${data.payment.referenceNumber} | ${data.payment.channel === "cash" ? "WALK-IN — CASH ON ARRIVAL" : "AWAITING RECEIPT VERIFICATION"}${bedSuffix ? " | " + bedSuffix.trim() : ""}`,
        language: "en",
      };

      try {
        const response = await fetch("https://login.smoobu.com/api/reservations", {
          method: "POST",
          headers: { "Api-Key": SMOOBU_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (response.ok) {
          console.log("[Smoobu Draft Created]", data.bookingId, "room:", room.name + bedSuffix, "aptId:", apartmentId, "smoobuId:", result.id);
        } else {
          console.warn("[Smoobu Draft Failed]", "aptId:", apartmentId, JSON.stringify(result));
        }
      } catch (err) {
        console.error("[Smoobu Draft Network Error]", err.message);
      }
    }
  }
}

function resolveApartmentId(roomName) {
  const mapping = ROOM_NAME_TO_APT_ID[roomName];
  if (!mapping) return null;
  if (Array.isArray(mapping)) return mapping[0];
  return mapping;
}

// ============================================================
// HELPER: Send Email Notification
// ============================================================
async function sendBookingEmail(data) {
  if (!RESEND_API_KEY) return;

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");

  const resend = new Resend(RESEND_API_KEY);
  const channelNames = {
    gcash: "GCash",
    maya: "Maya",
    metro: "Metrobank",
    land: "Landbank",
    cash: "Cash on Arrival (Walk-in)",
  };
  const payTypeNames = { full: "Full Payment", dp: "Downpayment (50%)" };
  const isCash = data.payment.channel === "cash";
  const actionNeededHtml = isCash
    ? `<strong>⏰ ACTION NEEDED (WALK-IN/CASH):</strong><br>The guest will pay in cash upon arrival. <strong>No payment receipt to verify.</strong>`
    : `<strong>⏰ ACTION NEEDED:</strong><br>Wait for customer's receipt via Messenger (m.me/haidoville), then verify payment and update Smoobu booking status to paid.`;

  const roomsHtml = data.rooms
    .map((r, i) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;">
        <strong>Room ${i + 1}: ${esc(r.name)}</strong><br>
        <small style="color:#666;">${esc(r.checkIn)} → ${esc(r.checkOut)} (${r.nights} nights)</small><br>
        <small style="color:#666;">${r.pax} ${esc(r.paxLabel)} • ₱${r.subtotal.toLocaleString()}</small>
      </td>
    </tr>
  `)
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
      <div style="background:linear-gradient(135deg,#C9A96E 0%,#b8935a 100%);color:#fff;padding:20px;border-radius:12px 12px 0 0;">
        <h2 style="margin:0;font-size:22px;">🏠 Secure HaidoVille Booking</h2>
        <p style="margin:6px 0 0;opacity:0.9;">Reference Code Verified: ${esc(data.bookingId)}</p>
        <p style="margin:4px 0 0;opacity:0.8;font-size:13px;">Source: ${esc(data.source || "Website (Direct)")}</p>
      </div>
      <div style="background:#f9f9f9;padding:20px;border-radius:0 0 12px 12px;">
        <h3 style="margin-top:0;color:#C9A96E;">👤 Guest Details</h3>
        <p style="margin:4px 0;"><strong>Name:</strong> ${esc(data.guest.name)}</p>
        <p style="margin:4px 0;"><strong>Email:</strong> ${esc(data.guest.email)}</p>
        <p style="margin:4px 0;"><strong>Phone:</strong> ${esc(data.guest.phone)}</p>
        ${data.guest.nationality ? `<p style="margin:4px 0;"><strong>Nationality:</strong> ${esc(data.guest.nationality)}</p>` : ""}
        ${data.guest.address ? `<p style="margin:4px 0;"><strong>Address:</strong> ${esc(data.guest.address)}</p>` : ""}
        ${data.guest.arrivalTime ? `<p style="margin:4px 0;"><strong>Arrival Time:</strong> ${esc(data.guest.arrivalTime)}</p>` : ""}
        ${data.guest.port ? `<p style="margin:4px 0;"><strong>Port:</strong> ${esc(data.guest.port)}</p>` : ""}
        ${data.guest.specialRequest ? `<p style="margin:4px 0;"><strong>Special Request:</strong> ${esc(data.guest.specialRequest)}</p>` : ""}
        <h3 style="color:#C9A96E;margin-top:20px;">🛏️ Rooms</h3>
        <table style="width:100%;border-collapse:collapse;">${roomsHtml}</table>
        <h3 style="color:#C9A96E;margin-top:20px;">💰 Payment Details (Server Verified)</h3>
        <p style="margin:4px 0;"><strong>Type:</strong> ${payTypeNames[data.payment.type]}</p>
        <p style="margin:4px 0;"><strong>Channel:</strong> ${channelNames[data.payment.channel]}</p>
        <p style="margin:4px 0;"><strong>Reference #:</strong> <code style="background:#fff;padding:3px 8px;border-radius:4px;">${data.payment.referenceNumber}</code></p>
        <p style="margin:4px 0;"><strong>Amount Paid:</strong> <span style="color:#C9A96E;font-size:18px;font-weight:bold;">₱${data.payment.amount.toLocaleString()}</span></p>
        <p style="margin:4px 0;"><strong>Grand Total:</strong> ₱${data.payment.grandTotal.toLocaleString()}</p>
        <div style="background:#fff;border-left:4px solid #C9A96E;padding:12px;margin-top:20px;border-radius:4px;">
          ${actionNeededHtml}
        </div>
      </div>
    </div>
  `;

  const safeSubjectName = String(data.guest.name).replace(/[\r\n]/g, " ").slice(0, 80);
  await resend.emails.send({
    from: `HaidoVille Booking <${FROM_EMAIL}>`,
    to: ADMIN_EMAIL,
    replyTo: data.guest.email,
    subject: `🏠 Verified Booking: ${data.bookingId} — ${safeSubjectName}${isCash ? " [WALK-IN/CASH]" : ""}`,
    html,
  });

  console.log("[Email Sent]", ADMIN_EMAIL, "-", data.bookingId);
}

// ============================================================
// HELPER: Forward to GHL Webhook
// ============================================================
async function forwardToGHL(data) {
  if (!GHL_WEBHOOK_URL) return;
  const payload = buildGhlPayload(data);
  const response = await fetch(GHL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GHL webhook failed (${response.status}): ${errText}`);
  }
  console.log("[GHL Webhook Sent]", data.bookingId, "source:", payload.source);
}

function buildGhlPayload(data) {
  const nameParts = (data.guest.name || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";
  const channelLabels = {
    gcash: "GCash/PayMaya",
    maya: "GCash/PayMaya",
    metro: "Metrobank",
    land: "Landbank",
    cash: "Cash on Arrival (Walk-in)",
  };
  const paymentMethod = channelLabels[data.payment.channel] || data.payment.channel;
  const firstRoom = data.rooms[0] || {};

  const fmtShortDate = (d) => {
    if (!d) return "";
    try {
      return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      });
    } catch (e) { return d; }
  };

  const confirmationDate = new Date(data.submittedAt || new Date()).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "Asia/Manila",
  });

  const fmtTime12 = (t) => {
    if (!t) return "";
    const parts = t.split(":");
    let h = parseInt(parts[0]);
    const m = parts[1];
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + m + " " + ampm;
  };

  const grandTotal = data.payment.grandTotal || 0;
  const dpAmount = data.payment.amount;
  const balance = grandTotal - dpAmount;
  let roomType = firstRoom.name || "";
  if (data.rooms.length > 1) roomType = data.rooms.map((r) => r.name).join(" + ");
  const totalPax = data.rooms.reduce((sum, r) => sum + (parseInt(r.pax) || 0), 0);
  const totalNights = Math.max(...data.rooms.map((r) => parseInt(r.nights) || 0));

  return {
    source: data.source || "Website (Direct)",
    email: data.guest.email || "",
    phone: data.guest.phone || "",
    first_name: firstName,
    last_name: lastName,
    name: data.guest.name || "",
    booking_id: data.bookingId,
    confirmation_date: confirmationDate,
    guest_name: data.guest.name || "",
    contact_number: data.guest.phone || "",
    email_address: data.guest.email || "",
    age: String(data.guest.age || ""),
    nationality: data.guest.nationality || "",
    complete_address: data.guest.address || "",
    room_type: roomType,
    check_in_date: fmtShortDate(firstRoom.checkIn),
    check_out_date: fmtShortDate(firstRoom.checkOut),
    arrival_time: fmtTime12(data.guest.arrivalTime),
    departure_time: fmtTime12(data.guest.departureTime),
    port_of_arrival: data.guest.port || "",
    no_of_nights: String(totalNights),
    primary_check_in: fmtShortDate(firstRoom.checkIn),
    primary_check_out: fmtShortDate(firstRoom.checkOut),
    no_of_guests: String(totalPax),
    payment_method: paymentMethod,
    payment_ref: data.payment.referenceNumber || "",
    total_amount: String(grandTotal),
    dp_amount: String(dpAmount),
    balance: String(balance),
    payment_type: data.payment.type === "full" ? "Full Payment" : "Downpayment (50%)",
    special_request: data.guest.specialRequest || "",
    room_count: String(data.rooms.length),
    all_rooms: data.rooms.map((r) => ({
      name: r.name,
      check_in: fmtShortDate(r.checkIn),
      check_out: fmtShortDate(r.checkOut),
      nights: String(r.nights),
      pax: String(r.pax),
      subtotal: String(r.subtotal),
    })),
  };
}

// ============================================================
// Start server
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 Secure HaidoVille Smoobu Sync running on port ${PORT}`);
  console.log(`   Smoobu API:    ${SMOOBU_API_KEY ? "✅" : "❌"}`);
  console.log(`   Email:         ${RESEND_API_KEY && ADMIN_EMAIL ? "✅" : "⚠️  disabled"}`);
  console.log(`   GHL Webhook:   ${GHL_WEBHOOK_URL ? "✅" : "⚠️  not configured"}`);
  console.log(`   Smoobu Drafts: ${CREATE_SMOOBU_DRAFT ? "✅ ON" : "❌ OFF"}`);
});
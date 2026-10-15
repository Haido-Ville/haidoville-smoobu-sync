// ============================================================
// HAIDOVILLE × SMOOBU SYNC - Render.com Server v4.3
// ============================================================
// v4.3 CHANGES (security audit 2026-09-29):
// - Rate limits keyed on the real client IP (CF-Connecting-IP).
// - Booking lock covers the availability check + Smoobu draft,
//   so two guests can't book the same room at once.
// - Payment references normalised, time-based dedup, restored
//   from Smoobu draft notices on startup.
// - Stricter validation (reference numbers, inquiries), bounded
//   in-memory stores, generic error responses, JSON error handler,
//   no guest PII in logs, [SEC] security event logs.
//
// v4.2: Smoobu API auth uses HMAC-SHA256 signed requests
//       (SMOOBU_API_LABEL + SMOOBU_API_SECRET).
// ============================================================

import express from "express";
import helmet from "helmet";
import { Resend } from "resend";
import "dotenv/config";

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { generateHint, verifyHint, HINT_TTL_MS, sealLink, openLink } from "./encryption.js";
import { limiter, secLog, safeEqual, smoobuFetch, fetchReservations, recordBooking, securityStatus } from "./shared.js";
import appServerRouter, { setSessionHintMiddleware } from "./appServer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    useDefaults: false, // take full control
    directives: {
      defaultSrc:     ["'none'"],
      scriptSrc:      ["'none'"],
      styleSrc:       ["'none'"],
      connectSrc:     ["'none'"],
      imgSrc:         ["'none'"],
      fontSrc:        ["'none'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'none'"],
      upgradeInsecureRequests: [],
    },
    reportOnly: false,
  },
  xssFilter: true,
  noSniff: true,
  frameguard: { action: "sameorigin" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

// Permissions-Policy — helmet doesn't set this header
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "accelerometer=(), gyroscope=(), magnetometer=(), microphone=(), usb=()");
  next();
});
const PORT = process.env.PORT || 3000;

// ---- Config ----
const SMOOBU_API_LABEL = process.env.SMOOBU_API_LABEL;
const SMOOBU_API_SECRET = process.env.SMOOBU_API_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL || "";
const GHL_INQUIRY_WEBHOOK_URL = process.env.GHL_INQUIRY_WEBHOOK_URL || "";
const CACHE_DURATION_MS = 5 * 60 * 1000;
const CREATE_SMOOBU_DRAFT = process.env.CREATE_SMOOBU_DRAFT === "true";
// Staff payment confirmation: the server calls these GHL workflows (see /staff/booking).
const GHL_ACTION_WEBHOOKS = {
  dp: process.env.GHL_DP_WEBHOOK_URL || "",       // "Mark DP Received"
  full: process.env.GHL_PAID_WEBHOOK_URL || "",   // "Mark Payment Received"
  issue: process.env.GHL_ISSUE_WEBHOOK_URL || "", // "Pay Issue"
};
// Base URL of this server, for links sent to GHL.
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || "https://haidoville-smoobu-sync.onrender.com").replace(/\/+$/, "");

// ---- Secure Configuration Keys ----
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const CALENDAR_ACCESS_TOKEN = process.env.CALENDAR_ACCESS_TOKEN;
// JWT signing keys are random per process and rotated; nothing is read from env.
let JWT_CURR_SEC, JWT_PREV_SEC;
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || "90s";
const JWT_ROTATE_MS = process.env.JWT_ROTATE_MS ? parseInt(process.env.JWT_ROTATE_MS, 10) : 12 * 60 * 60 * 1000;

function rotateJwtKeys() {
  JWT_PREV_SEC = JWT_CURR_SEC;
  JWT_CURR_SEC = crypto.randomBytes(32).toString("hex");
  console.log(`[JWT] Keys rotated at ${new Date().toISOString()}.`);
}

rotateJwtKeys();
rotateJwtKeys();
setInterval(rotateJwtKeys, JWT_ROTATE_MS).unref();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Phone in E.164 ("+639171234567"), or null. PH mobiles: 09…, 639…, +639….
// Foreign numbers need "+" and the country code.
// ponytail: foreign numbers only get a length check; use libphonenumber-js if GHL still rejects some.
const PHONE_MSG = "Please enter a valid mobile number (e.g. 0917 123 4567 or +63 917 123 4567).";
function normalizePhone(raw) {
  const s = String(raw ?? "").replace(/[\s().-]/g, "");
  if (/^09\d{9}$/.test(s)) return "+63" + s.slice(1);
  if (/^639\d{9}$/.test(s)) return "+" + s;
  if (s.startsWith("+63")) return /^\+639\d{9}$/.test(s) ? s : null;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

// HTML-escape guest text for emails and pages.
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const CHANNEL_NAMES = { gcash: "GCash", maya: "Maya", metro: "Metrobank", land: "Landbank", cash: "Cash on Arrival (Walk-in)" };
const PAY_TYPE_NAMES = { full: "Full Payment", dp: "Downpayment", cash: "Cash on Arrival" };
// Family Room for 6–7 guests needs HaidoVille's approval. "" when nothing needs it.
const approvalNote = (rooms) => rooms.filter((r) => r.name.startsWith("Family Room") && r.pax > 5)
  .map((r) => `${r.name} for ${r.pax} guests needs approval`).join("; ");
const peso = (n) => "₱" + Number(n || 0).toLocaleString("en-US");
// "2026-11-14" -> "Nov 14, 2026"
const fmtDay = (ymd) => new Date(ymd + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
// ISO time -> "Oct 14, 2026, 3:42 PM" (Manila)
const fmtManilaTime = (iso) => new Date(iso).toLocaleString("en-US", {
  timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
});
const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

// ============================================================
// PAYMENT REFERENCE STORE (Dedup)
// ============================================================
// Render's disk is wiped on every deploy/restart/spin-down, so the file only
// covers the current uptime. seedRefsFromSmoobu() restores references from
// Smoobu draft notices on startup (needs CREATE_SMOOBU_DRAFT=true).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const REF_FILE = path.join(DATA_DIR, "processed_refs.json");
const REF_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const processedRefs = new Map(); // normalised ref -> first seen (ms)

try {
  if (fs.existsSync(REF_FILE)) {
    for (const e of JSON.parse(fs.readFileSync(REF_FILE, "utf8"))) {
      const [ref, ts] = Array.isArray(e) ? e : [e, Date.now()]; // old format: plain strings
      processedRefs.set(normalizeRef(ref), ts);
    }
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REF_FILE, "[]");
  }
} catch (e) {
  console.error("Error loading reference numbers:", e.message);
}

// "abc 12-3" and "ABC12-3" are the same receipt.
function normalizeRef(ref) {
  return String(ref || "").replace(/\s+/g, "").toUpperCase();
}

function isRefAlreadyUsed(ref) {
  return processedRefs.has(ref);
}

function markRefAsUsed(ref) {
  const now = Date.now();
  processedRefs.set(ref, now);
  // Expire by age, not count, so flooding fake refs can't evict real ones.
  for (const [r, ts] of processedRefs) if (now - ts > REF_TTL_MS) processedRefs.delete(r);
  try {
    fs.writeFileSync(REF_FILE, JSON.stringify([...processedRefs]));
  } catch (e) {
    console.error("Error saving reference numbers:", e.message);
  }
}

async function seedRefsFromSmoobu() {
  if (!SMOOBU_API_LABEL || !SMOOBU_API_SECRET) return 0;
  let added = 0;
  for (const b of await fetchReservations(isoDay(-180), isoDay(365))) {
    const m = /Ref: ([^\s|]+)/.exec(b.notice || "");
    if (!m || m[1].startsWith("CASH-")) continue;
    const ref = normalizeRef(m[1]);
    if (!processedRefs.has(ref)) { processedRefs.set(ref, Date.now()); added++; }
  }
  return added;
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

// ---- Shared date validation helper ----
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(str) {
  if (!DATE_REGEX.test(str)) return false;
  const d = new Date(str + "T00:00:00Z"); // UTC, so the round-trip below works in any server timezone
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

// ---- Booker age (18+) ----
// The booker's age is always computed here from the birth date, on Manila's
// calendar day. The age sent by the browser is never trusted.
const UNDER_AGE_MSG = "The person making this booking must be 18 or older. Please ask an adult or guardian to book.";
const BAD_DOB_MSG = "Please enter a valid date of birth.";
const manilaToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD

// Whole years old today, or null for a missing, invalid or future date.
function bookerAge(birthDate) {
  if (typeof birthDate !== "string" || !isValidDate(birthDate)) return null;
  const today = manilaToday();
  if (birthDate > today) return null;
  // Feb 29 birthdays turn a year older on Mar 1 in non-leap years.
  return Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4)) - (today.slice(5) < birthDate.slice(5) ? 1 : 0);
}

// Error message when this booker can't book, or null.
function bookerError(birthDate, ageConfirmed) {
  const age = bookerAge(birthDate);
  if (age === null || age > 120) return BAD_DOB_MSG;
  if (age < 18) return UNDER_AGE_MSG;
  if (ageConfirmed !== true) return "Please confirm you understand the ID requirement.";
  return null;
}

// ---- Booking ID generator ----
function generateUniqueBookingId() {
  const now = new Date();
  const yymm = String(now.getFullYear()).slice(-2) + String(now.getMonth() + 1).padStart(2, "0");
  return `HV-${yymm}-${uuidv4().split("-")[0].toUpperCase()}`;
}

// ---- Server-Side Pricing Function ----
function calculateRoomPrice(roomName, pax, nights, checkIn, checkOut) {
  nights = Math.max(1, nights);
  pax = Math.max(1, pax);

  switch (roomName) {
    case "Bunk Beds": {
      if (pax < 1 || pax > 6) throw new Error("Bunk Beds max is 6 beds.");
      // ₱600/head/night for 1–2 nights, ₱500 for 3+; Holy Week nights +₱100.
      const rate = nights <= 2 ? 600 : 500;
      if (checkIn && checkOut) {
        let total = 0;
        const start = new Date(checkIn + "T00:00:00");
        for (let i = 0; i < nights; i++) {
          const night = new Date(start.getTime() + i * 86400000);
          total += (rate + (isHolyWeekDate(night) ? 100 : 0)) * pax;
        }
        return total;
      }
      return rate * pax * nights;
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
      // 5 standard; 6–7 only with HaidoVille's approval, at ₱500/head.
      if (pax >= 1 && pax <= 5) return 2500 * nights;
      if (pax <= 7) return 500 * pax * nights;
      throw new Error("Family Room max pax is 7.");
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

const NON_BUNK_ROOM_APT_IDS = {
  "Barkada Room": 3261782,
  "Couple Room": 3261742,
  "Family Room 1": 3261662,
  "Family Room 2": 3261737,
};
const BUNK_APARTMENT_IDS = [3261752, 3261757, 3261762, 3261767, 3261772, 3261777];
const VALID_ROOM_NAMES = [...Object.keys(NON_BUNK_ROOM_APT_IDS), "Bunk Beds"];

// ---- Cache & In-Memory Booking Log ----
let cache = { data: null, timestamp: 0 };
const pendingBookings = []; // last 7 days, capped
const MAX_PENDING_BOOKINGS = 1000;

// ---- Middleware ----
app.use(express.json({ limit: "100kb" }));

// Strict CORS
const ALLOWED_ORIGINS = [
  "https://haidoville.com",
  "https://app.haidoville.com",
  "https://www.haidoville.com",
  // Local development against the live API (the frontend hard-codes the Render URL).
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://sites.leadconnectorhq.com",
  "https://app.gohighlevel.com",
];
// GHL serves sites, previews and the guest app from these shared domains.
const isAllowedOrigin = (origin) =>
  ALLOWED_ORIGINS.includes(origin) ||
  origin.endsWith(".leadconnectorhq.com") || origin.endsWith(".msgsndr.com") || origin.endsWith(".gohighlevel.com");

app.use((req, res, next) => {
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  res.setHeader("Vary", "Origin");
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      // X-Timestamp is still sent by the booking modal; it is no longer checked.
      "Content-Type, X-API-Key, X-Calendar-Access, Authorization, X-Session-Hint, X-Guest-Pass, X-Booker-Pass, X-Timestamp, X-File-Name"
    );
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://haidoville.com");
  }
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

const adminLimiter = limiter(60 * 1000, 30);

// No key at all is crawler/scanner noise; a wrong key is someone guessing.
const requireApiKey = (req, res, next) => {
  if (!safeEqual(req.headers["x-api-key"], INTERNAL_API_KEY)) {
    secLog(req, req.headers["x-api-key"] ? "bad internal API key" : "internal endpoint without key");
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const requireCalendarAccess = (req, res, next) => {
  if (!safeEqual(req.headers["x-calendar-access"], CALENDAR_ACCESS_TOKEN)) {
    secLog(req, req.headers["x-calendar-access"] ? "bad calendar access token" : "internal endpoint without key");
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
};

// ============================================================
// ONE-TIME USE JWT VALIDATION (persisted to disk)
// ============================================================
const USED_TOKENS_FILE = path.join(DATA_DIR, "used_tokens.json");
const usedTokens = new Map();

try {
  if (fs.existsSync(USED_TOKENS_FILE)) {
    const stored = JSON.parse(fs.readFileSync(USED_TOKENS_FILE, "utf8"));
    const now = Date.now();
    for (const [jti, exp] of stored) {
      if (now < exp) usedTokens.set(jti, exp);
    }
  }
} catch (e) {
  console.error("[JWT] Error loading used tokens:", e.message);
}

function persistUsedTokens() {
  try {
    const now = Date.now();
    for (const [jti, exp] of usedTokens) if (now >= exp) usedTokens.delete(jti);
    fs.writeFileSync(USED_TOKENS_FILE, JSON.stringify([...usedTokens]));
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
  for (const key of [JWT_CURR_SEC, JWT_PREV_SEC]) {
    try { decoded = jwt.verify(token, key, { algorithms: ["HS256"] }); break; } catch { /* try previous key */ }
  }
  if (!decoded) {
    secLog(req, "invalid booking token");
    return res.status(403).json({ error: "Invalid or expired token." });
  }
  if (!decoded.jti) { // a booker pass is signed with the same key but is not a booking token
    secLog(req, "invalid booking token");
    return res.status(403).json({ error: "Invalid or expired token." });
  }
  if (usedTokens.has(decoded.jti)) {
    secLog(req, "booking token reused");
    return res.status(401).json({ error: "Unauthorized" });
  }
  usedTokens.set(decoded.jti, decoded.exp * 1000);
  persistUsedTokens();
  next();
};

// ---- Booker pass ----
// Issued by /booking/verify-booker once the booker is 18+. It carries the
// verified birth date, so the booking can't swap in a different one later.
// Payment details, the booking token and the booking itself all require it.
const BOOKER_PASS_TTL = "30m";
const signBookerPass = (birthDate) =>
  jwt.sign({ typ: "booker", bd: birthDate }, JWT_CURR_SEC, { expiresIn: BOOKER_PASS_TTL, algorithm: "HS256" });

const requireBookerPass = (req, res, next) => {
  const token = String(req.headers["x-booker-pass"] || "");
  let decoded;
  for (const key of [JWT_CURR_SEC, JWT_PREV_SEC]) {
    try { decoded = jwt.verify(token, key, { algorithms: ["HS256"] }); break; } catch { /* try previous key */ }
  }
  if (decoded?.typ !== "booker" || bookerError(decoded.bd, true)) {
    // Also an expired pass (30 min) or a server restart; the page re-checks the age and retries.
    secLog(req, "missing or invalid booker pass");
    return res.status(403).json({ error: "Please confirm your details again.", code: "BOOKER_PASS" });
  }
  req.bookerBirthDate = decoded.bd;
  req.bookerConfirmedAt = decoded.iat * 1000; // when the booker ticked "I Understand" (last re-check)
  next();
};

// ============================================================
// RATE LIMITING
// ============================================================
const bookingRateLimiter = limiter(60 * 60 * 1000, 10); // a guest books once or twice; retries included
const tokenRateLimiter = limiter(60 * 1000, 20);
const pingRateLimiter = limiter(60 * 1000, 12);
const availabilityRateLimiter = limiter(60 * 1000, 30);
const inquiryRateLimiter = limiter(15 * 60 * 1000, 5);

// ============================================================
// GET /ping — Public keep-alive endpoint (no auth)
// ============================================================
app.get("/ping", pingRateLimiter, (req, res) => {
  res.json({ ok: true });
});

// ============================================================
// POST /internal/rotate-jwt — Manually trigger JWT key rotation
// ============================================================
app.post("/internal/rotate-jwt", adminLimiter, requireApiKey, (req, res) => {
  rotateJwtKeys();
  res.json({ ok: true, message: "JWT keys rotated successfully." });
});

// ============================================================
// GET /internal/security — Attack monitor: flagged IPs, alerts, booking volume
// ============================================================
app.get("/internal/security", adminLimiter, requireApiKey, (req, res) => {
  res.json(securityStatus());
});

// ============================================================
// GET / — Protected health check (internal use only)
// ============================================================
app.get("/", adminLimiter, requireApiKey, (req, res) => {
  res.json({
    service: "HaidoVille Smoobu Sync",
    version: "4.3",
    status: "online",
    features: {
      smoobuSync: !!SMOOBU_API_LABEL && !!SMOOBU_API_SECRET,
      email: !!RESEND_API_KEY && !!ADMIN_EMAIL,
      ghlWebhook: !!GHL_WEBHOOK_URL,
      smoobuDraft: CREATE_SMOOBU_DRAFT && !!SMOOBU_API_LABEL,
    },
    endpoints: {
      ping: "GET /ping",
      availability: "GET /availability",
      bookings: "GET /bookings",
      bookingToken: "GET /booking-token",
      apartments: "GET /apartments-list",
      createBooking: "POST /bookings/create",
      inquiry: "POST /inquiry",
      security: "GET /internal/security",
    },
  });
});

// ============================================================
// GET /apartments-list
// ============================================================
app.get("/apartments-list", adminLimiter, requireApiKey, async (req, res) => {
  if (!SMOOBU_API_LABEL || !SMOOBU_API_SECRET)
    return res.status(500).json({ error: "Smoobu API credentials not configured" });
  try {
    const response = await smoobuFetch("https://login.smoobu.com/api/apartments", {
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      console.error("[apartments-list] Smoobu", response.status, await response.text());
      return res.status(502).json({ error: "Smoobu API error" });
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
    console.error("[apartments-list]", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
// GET /bookings (protected calendar sync — internal/admin use)
// ============================================================
app.get("/bookings", adminLimiter, requireCalendarAccess, async (req, res) => {
  if (!SMOOBU_API_LABEL || !SMOOBU_API_SECRET)
    return res.status(500).json({ error: "Smoobu API credentials not configured" });

  const nocache = req.query.nocache === "1";
  // A custom range must not read or overwrite the shared cache that /availability serves.
  const customRange = req.query.from !== undefined || req.query.to !== undefined;
  const now = Date.now();
  if (!nocache && !customRange && cache.data && now - cache.timestamp < CACHE_DURATION_MS) {
    res.setHeader("X-Cache", "HIT");
    return res.json(cache.data);
  }

  const rawFrom = typeof req.query.from === "string" ? req.query.from.slice(0, 10) : null;
  const rawTo   = typeof req.query.to   === "string" ? req.query.to.slice(0, 10)   : null;
  if (rawFrom && !isValidDate(rawFrom)) {
    return res.status(400).json({ error: "Invalid 'from' date format. Use YYYY-MM-DD." });
  }
  if (rawTo && !isValidDate(rawTo)) {
    return res.status(400).json({ error: "Invalid 'to' date format. Use YYYY-MM-DD." });
  }

  try {
    const result = buildAvailabilityResult(await fetchReservations(rawFrom || isoDay(0), rawTo || isoDay(365)));
    if (!customRange) cache = { data: result, timestamp: now };
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  } catch (err) {
    console.error("[bookings]", err.message);
    res.status(err.status ? 502 : 500).json({ error: err.status ? "Smoobu API error" : "Server error" });
  }
});

// ============================================================
// SESSION TOKENS — capped uses, self-expiring, bounded store
// ============================================================
const sessionTokens = new Map();
// A session can't outlive its signed hint, so cap the TTL at the hint lifetime.
const SESSION_TTL_MS = Math.min(parseInt(process.env.SESSION_TTL_MS) || HINT_TTL_MS, HINT_TTL_MS);
const SESSION_MAX_USES = parseInt(process.env.SESSION_MAX_USES) || 50;
const MAX_SESSIONS = 5000;

function cleanupSessionTokens() {
  const now = Date.now();
  for (const [hint, session] of sessionTokens) {
    if (now > session.exp || session.usesLeft <= 0) sessionTokens.delete(hint);
  }
}
setInterval(cleanupSessionTokens, 60 * 1000).unref();

// consume=true counts against the session's use limit.
const sessionHint = (consume) => (req, res, next) => {
  const parts = (req.headers["x-session-hint"] || "").split(".");
  if (parts.length !== 3) return res.status(400).json({ error: "Unauthorized" });
  const [hint, ts, sig] = parts;
  try {
    verifyHint(hint, ts, sig);
  } catch (err) {
    if (err.expired) return res.status(401).json({ error: "Session expired, reload the page" });
    secLog(req, "bad session hint signature");
    return res.status(403).json({ error: "Unauthorized" });
  }
  const session = sessionTokens.get(hint);
  if (!session || Date.now() > session.exp || session.usesLeft <= 0) {
    sessionTokens.delete(hint);
    return res.status(401).json({ error: "Session expired, reload the page" });
  }
  if (session.userAgent !== (req.headers["user-agent"] || "unknown")) {
    sessionTokens.delete(hint);
    secLog(req, "session used from a different user-agent");
    return res.status(403).json({ error: "Unauthorized" });
  }
  if (consume && --session.usesLeft <= 0) sessionTokens.delete(hint);
  req.sessionHint = hint;
  req.hvSession = session; // still valid for this request even if its last use just deleted it
  next();
};
const requireSessionHint = sessionHint(true);
const requireValidSessionHint = sessionHint(false);

setSessionHintMiddleware(requireSessionHint);
app.use("/app", appServerRouter);

// ============================================================
// GET /api/session-hint — Issues a signed hint per page-load
// ============================================================
app.get("/api/session-hint", tokenRateLimiter, (req, res) => {
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  if (!isAllowedOrigin(origin)) {
    secLog(req, "session hint blocked origin");
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    const { hint, ts, sig } = generateHint();
    const csrfToken = uuidv4();
    // Bounded store: evict the oldest; its owner gets a 401 and the frontend fetches a new hint.
    if (sessionTokens.size >= MAX_SESSIONS) cleanupSessionTokens();
    if (sessionTokens.size >= MAX_SESSIONS) sessionTokens.delete(sessionTokens.keys().next().value);
    sessionTokens.set(hint, {
      usesLeft: SESSION_MAX_USES,
      exp: Date.now() + SESSION_TTL_MS,
      userAgent: req.headers["user-agent"] || "unknown",
      csrfToken,
    });
    res.json({ hint: `${hint}.${ts}.${sig}`, csrfToken });
  } catch (err) {
    console.error("[session-hint] Failed:", err.message);
    res.status(500).json({ error: "Could not generate session hint." });
  }
});

// ============================================================
// POST /booking/verify-booker — Step 2 -> 3 age check (18+)
// ============================================================
// Doesn't use up the session: the page re-checks quietly when a pass expires.
app.post("/booking/verify-booker", tokenRateLimiter, requireValidSessionHint, (req, res) => {
  const { birthDate, ageConfirmed } = req.body || {};
  const error = bookerError(birthDate, ageConfirmed);
  if (error) return res.status(400).json({ error });
  res.json({ pass: signBookerPass(birthDate) });
});

// ============================================================
// GET /api/payment-methods — Serves payment data (verified booker only)
// ============================================================
app.get("/api/payment-methods", tokenRateLimiter, requireSessionHint, requireBookerPass, (req, res) => {
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
// GET /availability (public — no PII)
// ============================================================
app.get("/availability", availabilityRateLimiter, requireValidSessionHint, async (req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_DURATION_MS) {
    res.setHeader("X-Cache", "HIT");
    return res.json(cache.data);
  }

  if (!SMOOBU_API_LABEL || !SMOOBU_API_SECRET)
    return res.status(500).json({ error: "Smoobu API credentials not configured" });

  try {
    const result = buildAvailabilityResult(await fetchReservations(isoDay(0), isoDay(365)));
    cache = { data: result, timestamp: now };
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  } catch (err) {
    console.error("[availability]", err.message);
    res.status(err.status ? 502 : 500).json({ error: err.status ? "Smoobu error" : "Server error" });
  }
});

// Shared helper — builds the availability result from Smoobu bookings array
function buildAvailabilityResult(allBookings) {
  const result = {
    bookedRanges: [],
    bunkBookings: [],
    familyBookedUnits: [],
    bunkTotal: BUNK_APARTMENT_IDS.length,
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
// GET /booking-token (issues one-time JWT)
// ============================================================
app.get("/booking-token", tokenRateLimiter, requireSessionHint, requireBookerPass, (req, res) => {
  const token = jwt.sign({ jti: uuidv4() }, JWT_CURR_SEC, { expiresIn: JWT_EXPIRATION, algorithm: "HS256" });
  res.json({ token });
});

// ============================================================
// POST /bookings/create
// ============================================================
// Bookings run one at a time, so the availability check and the Smoobu
// draft that claims the room can't interleave with another booking.
let bookingQueue = Promise.resolve();
function withBookingLock(fn) {
  const run = bookingQueue.then(fn, fn);
  bookingQueue = run.catch(() => {});
  return run;
}

const VALID_CHANNELS = ["gcash", "maya", "metro", "land", "cash"];
const BOOKING_SOURCES = ["Website (Direct)"];
const MAX_BOOKINGS_PER_GUEST_PER_DAY = 3;
const REF_RE = /^[A-Z0-9-]{5,30}$/;

app.post(
  "/bookings/create",
  bookingRateLimiter,
  requireSessionHint,
  requireBookerPass, // before the token, so a re-checked pass can retry with the same token
  requireJwtToken,
  async (req, res) => {
    try {
      const rawData = req.body;

      if (!rawData || !rawData.bookingId || !rawData.guest || !rawData.rooms || !rawData.payment) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      if (!Array.isArray(rawData.rooms) || rawData.rooms.length === 0 || rawData.rooms.length > 5) {
        return res.status(400).json({ error: "Invalid room allocation parameters boundary." });
      }

      const paymentChannel = String(rawData.payment.channel);
      if (!VALID_CHANNELS.includes(paymentChannel)) {
        return res.status(400).json({ error: "Invalid payment channel." });
      }
      const isCash = paymentChannel === "cash";
      const clientRef = normalizeRef(rawData.payment.referenceNumber);
      if (!isCash) {
        if (!REF_RE.test(clientRef)) {
          return res.status(400).json({ error: "Please enter the reference number exactly as shown on your receipt (5–30 letters or numbers)." });
        }
        if (isRefAlreadyUsed(clientRef)) {
          return res.status(409).json({ error: "This reference number was already used for another booking." });
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
      if (!EMAIL_RE.test(sanitizedGuest.email)) {
        return res.status(400).json({ error: "Invalid email address." });
      }
      sanitizedGuest.phone = normalizePhone(sanitizedGuest.phone);
      if (!sanitizedGuest.phone) return res.status(400).json({ error: PHONE_MSG });

      // The page only gets here after verify-booker, so a failure means a tampered request.
      const ageError = bookerError(rawData.guest.birthDate, rawData.guest.ageConfirmed);
      if (ageError || rawData.guest.birthDate !== req.bookerBirthDate) {
        secLog(req, "booker age details tampered");
        return res.status(400).json({ error: ageError || "Please confirm your details again." });
      }
      sanitizedGuest.birthDate = req.bookerBirthDate;
      sanitizedGuest.ageConfirmedAt = new Date(req.bookerConfirmedAt).toISOString();
      sanitizedGuest.age = String(bookerAge(req.bookerBirthDate)); // GHL "age" field

      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const emailKey = sanitizedGuest.email.toLowerCase();
      const recentByGuest = pendingBookings.filter((b) =>
        new Date(b.receivedAt).getTime() > dayAgo && b.guest.email.toLowerCase() === emailKey).length;
      if (recentByGuest >= MAX_BOOKINGS_PER_GUEST_PER_DAY) {
        secLog(req, "per-guest daily booking cap");
        return res.status(429).json({ error: "Too many bookings for this email today. Please message us on Messenger." });
      }

      for (const room of rawData.rooms) {
        if (!VALID_ROOM_NAMES.includes(String(room?.name))) {
          return res.status(400).json({ error: "Invalid room name." });
        }
      }

      const todayStr = isoDay(0);
      const sanitizedRooms = rawData.rooms.map((room) => ({
        name: String(room.name),
        checkIn: String(room.checkIn).slice(0, 10),
        checkOut: String(room.checkOut).slice(0, 10),
        nights: 1,
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
        const stayNights = Math.round((new Date(room.checkOut + "T00:00:00Z") - new Date(room.checkIn + "T00:00:00Z")) / 86400000);
        if (stayNights < 2) {
          return res.status(400).json({ error: "Minimum stay is 2 nights." });
        }
        room.nights = stayNights;
      }

      // Same room twice with overlapping dates in one request would double-book it.
      for (let i = 0; i < sanitizedRooms.length; i++) {
        for (let j = i + 1; j < sanitizedRooms.length; j++) {
          const a = sanitizedRooms[i], b = sanitizedRooms[j];
          if (a.name === b.name && a.checkIn < b.checkOut && b.checkIn < a.checkOut) {
            return res.status(400).json({ error: `${a.name} is listed twice for overlapping dates.` });
          }
        }
      }

      let calculatedGrandTotal = 0;
      let finalProcessedRooms;
      try {
        finalProcessedRooms = sanitizedRooms.map((room) => {
          const subtotal = calculateRoomPrice(room.name, room.pax, room.nights, room.checkIn, room.checkOut);
          calculatedGrandTotal += subtotal;
          return { ...room, subtotal };
        });
      } catch (e) {
        return res.status(400).json({ error: e.message }); // pax out of range for the room
      }

      // Strict price validation — no tolerance
      if (Number(rawData.payment.grandTotal) !== calculatedGrandTotal) {
        secLog(req, "booking price mismatch");
        return res.status(400).json({ error: "Price mismatch. Please refresh the page and try again." });
      }

      // "Amount already paid", as the guest says: cash on arrival is ₱0; otherwise any
      // whole-peso amount from 50% (rounded up) to 100% of the total. Nothing counts as
      // paid until Thor verifies it on the staff page.
      const minDownpayment = Math.ceil(calculatedGrandTotal * 0.5);
      const finalAmountPaid = isCash ? 0 : Number(rawData.payment.amount);
      if (!isCash && (!Number.isInteger(finalAmountPaid) || finalAmountPaid > calculatedGrandTotal || finalAmountPaid < minDownpayment)) {
        secLog(req, "booking price mismatch");
        return res.status(400).json({ error: `Amount already paid must be a whole amount from ₱${minDownpayment.toLocaleString()} (50%) to ₱${calculatedGrandTotal.toLocaleString()}.` });
      }
      const paymentType = isCash ? "cash" : finalAmountPaid === calculatedGrandTotal ? "full" : "dp";

      const source = BOOKING_SOURCES.includes(rawData.source) ? rawData.source : BOOKING_SOURCES[0];

      const outcome = await withBookingLock(async () => {
        if (!isCash && isRefAlreadyUsed(clientRef)) {
          return { status: 409, body: { error: "This reference number was already used for another booking." } };
        }
        if (SMOOBU_API_LABEL && SMOOBU_API_SECRET) {
          const unavailable = await findUnavailableRoom(sanitizedRooms);
          if (unavailable) return { status: 409, body: { error: unavailable } };
        }

        const data = {
          bookingId: generateUniqueBookingId(),
          source,
          submittedAt: new Date().toISOString(),
          guest: sanitizedGuest,
          rooms: finalProcessedRooms,
          payment: {
            channel: paymentChannel,
            type: paymentType,
            referenceNumber: isCash ? `CASH-${Date.now()}` : clientRef,
            amount: finalAmountPaid, // claimed by the guest, not verified
            grandTotal: calculatedGrandTotal,
          },
        };

        if (!isCash) markRefAsUsed(clientRef);
        pendingBookings.push({ ...data, receivedAt: data.submittedAt });
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        while (pendingBookings.length > MAX_PENDING_BOOKINGS ||
               (pendingBookings.length && new Date(pendingBookings[0].receivedAt).getTime() < weekAgo)) {
          pendingBookings.shift();
        }

        // Claim the room in Smoobu before the lock is released.
        // ponytail: with CREATE_SMOOBU_DRAFT=false nothing claims the room, so two
        // guests can still both be accepted; staff resolve it manually.
        if (CREATE_SMOOBU_DRAFT && SMOOBU_API_LABEL && SMOOBU_API_SECRET) {
          await createSmoobuDraft(data).catch((err) => console.error("[Smoobu Draft Error]", err.message));
          cache = { data: null, timestamp: 0 };
        }
        return { status: 200, data };
      });

      if (outcome.status !== 200) {
        console.warn("[Availability]", outcome.body.error);
        return res.status(outcome.status).json(outcome.body);
      }
      const data = outcome.data;
      // "normal" unless this IP also tripped security events (see shared.js).
      data.risk = recordBooking(req);
      console.log("[Booking Received]", data.bookingId, "source:", data.source, "risk:", data.risk.level);
      if (data.risk.level === "attack") {
        console.error("[ALERT] Booking", data.bookingId, "came from an IP flagged as an attack. Verify the receipt before confirming. |",
          JSON.stringify(data.risk.reasons));
      }

      if (GHL_WEBHOOK_URL) {
        forwardToGHL(data).catch((err) => console.error("[GHL Webhook Error]", err.message));
      }
      if (RESEND_API_KEY && ADMIN_EMAIL) {
        sendBookingEmail(data).catch((err) => console.error("[Email Error]", err.message));
      }

      res.json({
        success: true,
        bookingId: data.bookingId,
        message: isCash
          ? "Booking request received. Please pay in cash upon arrival."
          : "Booking request received. HaidoVille will verify your payment.",
      });
    } catch (err) {
      console.error("[Booking Create Error]", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ============================================================
// STAFF PAYMENT CONFIRMATION + BOOKING RECEIPT
// ============================================================
// The payment-check email (GHL) links each button to
//   /staff/booking/<sealed booking>?action=dp|full|issue&contact_id=<GHL id>
// GET only shows a confirm page, so email scanners that open links change
// nothing. POST calls the matching GHL workflow with a sealed receipt link.
// No database: the booking travels inside the sealed link (encryption.js).
const STAFF_LINK_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const RECEIPT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const STAFF_ACTIONS = {
  dp: { button: "Confirm DP received", done: "DP received", badge: "DOWNPAYMENT RECEIVED" },
  full: { button: "Confirm fully paid", done: "Fully paid", badge: "FULLY PAID" },
  issue: { button: "Flag payment issue", done: "Payment issue flagged" },
};
const CONTACT_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const linksEnabled = () => Boolean(process.env.RECEIPT_SECRET);

// Only what the confirm page and the receipt show.
function bookingSnapshot(data) {
  const g = data.guest;
  return {
    id: data.bookingId,
    at: data.submittedAt,
    guest: { name: g.name, email: g.email, phone: g.phone, birthDate: g.birthDate, age: g.age, ageConfirmedAt: g.ageConfirmedAt },
    rooms: data.rooms.map((r) => ({ name: r.name, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, pax: r.pax, paxLabel: r.paxLabel, subtotal: r.subtotal })),
    payment: {
      channel: data.payment.channel, type: data.payment.type, amount: data.payment.amount,
      grandTotal: data.payment.grandTotal, referenceNumber: data.payment.referenceNumber,
    },
  };
}

function staffLink(data) {
  if (!linksEnabled()) return "";
  return `${PUBLIC_API_URL}/staff/booking/${sealLink("staff", { b: bookingSnapshot(data) }, STAFF_LINK_TTL_MS)}`;
}

function paymentStatus(p) {
  if (p.channel === "cash") return `Cash on arrival — ${peso(p.grandTotal)} due at check-in`;
  return `${p.type === "full" ? "Full payment" : "Downpayment"} ${peso(p.amount)} sent — awaiting verification`;
}

// Amount box on the confirm page: the DP the guest claimed, or what's left for "full".
const suggestedAmount = (b, action) => (action === "dp" ? b.payment.amount
  : b.payment.grandTotal - (b.payment.type === "dp" ? b.payment.amount : 0));

// What a confirmed action means for the money: "full" = the whole total is in;
// "dp" = the amount Thor verified (older links have none: the claimed DP).
const paidFor = (b, s) => (s.action === "full" ? b.payment.grandTotal : s.amount ?? b.payment.amount);

// bookingId:action -> { receipt, guest } links ("" for issue). `true` = pending, blocks a double click.
// ponytail: in memory only; after a restart a repeat confirm calls GHL again
// (GHL may re-send the receipt email). A database would remove this.
const confirmedActions = new Map();
const MAX_CONFIRMED = 5000;

// Staff pages: no caching, no indexing, no referrer (the URL is the key), and a
// CSP that allows only inline styles, our own form, the logo and one nonce script.
const STAFF_FOOTER = "HaidoVille · Staff only · Don't forward this page outside the team.";
const GUEST_FOOTER = "HaidoVille Vacation Home Rental · Tourism Road, Brgy. Poblacion 3, General Luna, Siargao Island";
const PRINT_SCRIPT = 'document.getElementById("print").addEventListener("click", function () { window.print(); });';

function sendPage(res, status, title, body, { script = "", footer = STAFF_FOOTER } = {}) {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.status(status);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; img-src https://assets.cdn.filesafe.space; form-action 'self'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`);
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · HaidoVille</title>
<style>
  :root { --gold:#C9A96E; --ink:#1a1a1a; --mid:#6b6b6b; --line:#eceae3; }
  * { box-sizing:border-box; }
  body { margin:0; background:#f0efe9; color:var(--ink); font:14px/1.5 Arial, Helvetica, sans-serif; }
  .wrap { max-width:640px; margin:0 auto; padding:24px 16px; }
  .card { background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 8px 30px rgba(0,0,0,0.06); }
  .head { background:#0e0d0b; padding:22px 24px; text-align:center; }
  .head img { height:40px; }
  .band { background:linear-gradient(135deg,#C9A96E,#b8935a); padding:16px 24px; text-align:center; color:#1a1612; }
  .band small { display:block; font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; opacity:.7; }
  .band strong { font-size:22px; letter-spacing:2px; }
  .body { padding:24px; }
  h1 { font-size:20px; margin:0 0 6px; }
  p { margin:0 0 14px; color:var(--mid); }
  .badge { display:inline-block; padding:6px 14px; border-radius:50px; font-size:11px; font-weight:800; letter-spacing:1.5px; background:#e8f6ee; color:#1e7a46; }
  .badge.issue { background:#fdecea; color:#b42318; }
  h2 { font-size:11px; letter-spacing:2px; text-transform:uppercase; color:var(--gold); margin:22px 0 8px; }
  table { width:100%; border-collapse:collapse; }
  td { padding:9px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  td:first-child { color:var(--mid); width:45%; }
  .rooms td:first-child { width:auto; } /* room name + dates need the width */
  td:last-child { text-align:right; font-weight:700; }
  .total td { font-size:16px; border-bottom:0; }
  .check { list-style:none; padding:0; margin:0; }
  .check li { padding:8px 0 8px 30px; position:relative; border-bottom:1px solid var(--line); }
  .check li::before { content:""; position:absolute; left:0; top:8px; width:18px; height:18px; border:2px solid var(--ink); border-radius:4px; }
  .btn { display:block; width:100%; padding:15px; border:0; border-radius:50px; background:linear-gradient(135deg,#e8c98a,#C9A96E 55%,#b8924f); color:#1a1612;
    font:800 13px Arial, sans-serif; letter-spacing:1px; text-transform:uppercase; text-align:center; text-decoration:none; cursor:pointer; margin-top:18px; }
  .btn.issue { background:#c0392b; color:#fff; }
  .note { font-size:12px; color:#999; text-align:center; margin-top:12px; }
  .note a { color:#b8935a; }
  .notice { background:#fff8f0; border:1px solid rgba(201,169,110,0.35); border-left:4px solid var(--gold); border-radius:12px; padding:14px 16px; margin-top:22px; }
  .notice strong { display:block; color:#b8935a; margin-bottom:4px; }
  .notice ul { margin:0; padding-left:18px; color:var(--mid); }
  .id-alert { display:flex; gap:12px; align-items:flex-start; margin:16px 0 4px; padding:14px 16px; border-radius:12px;
    background:#fff4e0; border:1px solid rgba(201,169,110,0.5); border-left:5px solid var(--gold); }
  .id-alert svg { flex-shrink:0; width:28px; height:28px; color:#b8935a; }
  .id-alert b { display:block; font-size:14px; color:var(--ink); margin-bottom:2px; }
  .id-alert span { color:#5a4a2e; }
  .id-alert strong { color:var(--ink); }
  .foot { text-align:center; font-size:11px; color:#999; padding:16px; }
  /* One printed page: tighter spacing on paper. */
  @page { margin:10mm; }
  @media print {
    body { background:#fff; font-size:12px; } .wrap { padding:0; } .card { box-shadow:none; } .noprint { display:none; }
    .head { padding:10px; } .head img { height:28px; } .band { padding:8px; } .band strong { font-size:18px; }
    .body { padding:12px 16px; } h2 { margin:12px 0 4px; } td { padding:5px 0; } .check li { padding:5px 0 5px 28px; }
    .check li::before { top:5px; } .notice { margin-top:12px; padding:10px 12px; } .foot { padding:8px; }
  }
</style></head>
<body><div class="wrap"><div class="card">
<div class="head"><img src="https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69b8babe87f0f20a644bf122.png" alt="HaidoVille"></div>
${body}
</div><div class="foot">${esc(footer)}</div></div>
${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body></html>`);
}

const errorPage = (res, status, message) =>
  sendPage(res, status, "Link problem", `<div class="body"><h1>Can't open this page</h1><p>${esc(message)}</p></div>`);

const INVALID_LINK = "This link is invalid or expired. Open the latest email from GHL, or ask the admin.";

// Rows shared by the confirm page and the receipt.
function bookingRows(b) {
  const rooms = b.rooms.map((r) => `<tr><td>${esc(r.name)}<br><small>${esc(fmtDay(r.checkIn))} → ${esc(fmtDay(r.checkOut))} · ${esc(r.nights)} nights · ${esc(r.pax)} ${esc(r.paxLabel || "Guests")}</small></td><td>${esc(peso(r.subtotal))}</td></tr>`).join("");
  return {
    guest: `<tr><td>Name</td><td>${esc(b.guest.name)}</td></tr>
      <tr><td>Phone</td><td>${esc(b.guest.phone)}</td></tr>
      <tr><td>Email</td><td>${esc(b.guest.email)}</td></tr>`,
    rooms,
  };
}

// Opens the staff link and checks the query; sends the error page and returns null when invalid.
function readStaffRequest(req, res) {
  if (!linksEnabled()) { errorPage(res, 503, "Receipts are not set up on the server yet (RECEIPT_SECRET)."); return null; }
  const sealed = openLink("staff", req.params.token);
  if (!sealed) { secLog(req, "invalid staff or receipt link"); errorPage(res, 400, INVALID_LINK); return null; }
  const action = String(req.query.action || "");
  const contactId = String(req.query.contact_id || "");
  if (!Object.hasOwn(STAFF_ACTIONS, action) || !CONTACT_ID_RE.test(contactId)) {
    errorPage(res, 400, "This link is incomplete. Use the button in the GHL email.");
    return null;
  }
  return { b: sealed.b, action, contactId };
}

function confirmedPage(res, b, action, links, already) {
  const a = STAFF_ACTIONS[action];
  sendPage(res, 200, a.done, `<div class="band"><small>${already ? "Already confirmed" : "Done"}</small><strong>${esc(b.id)}</strong></div>
<div class="body">
  <h1>${already ? "Already confirmed: " : ""}${esc(a.done)}</h1>
  <p>${esc(b.guest.name)} · ${action === "issue" ? "The Pay Issue workflow in GHL has been started." : "GHL has been updated, the receipt was emailed to staff, and the guest's copy went to GHL."}</p>
  ${links.receipt ? `<a class="btn" href="${esc(links.receipt)}">View receipt</a>
  <p class="note"><a href="${esc(links.guest)}">View the guest's copy</a></p>` : ""}
</div>`);
}

app.get("/staff/booking/:token", adminLimiter, (req, res) => {
  const r = readStaffRequest(req, res);
  if (!r) return;
  const { b, action } = r;
  const done = confirmedActions.get(`${b.id}:${action}`);
  if (typeof done === "object") return confirmedPage(res, b, action, done, true);

  const a = STAFF_ACTIONS[action];
  const rows = bookingRows(b);
  sendPage(res, 200, a.button, `<div class="band"><small>Payment check</small><strong>${esc(b.id)}</strong></div>
<div class="body">
  <h1>${esc(a.button)}?</h1>
  <p>Check the guest's payment first. Confirming updates GHL${action === "issue" ? "." : " and emails the receipt to staff."}</p>
  <h2>Guest</h2><table>${rows.guest}</table>
  <h2>Stay</h2><table class="rooms">${rows.rooms}</table>
  <h2>Payment</h2><table>
    <tr><td>Channel</td><td>${esc(CHANNEL_NAMES[b.payment.channel] || b.payment.channel)}</td></tr>
    <tr><td>Reference #</td><td>${esc(b.payment.referenceNumber)}</td></tr>
    <tr><td>Grand total</td><td>${esc(peso(b.payment.grandTotal))}</td></tr>
    <tr><td>${b.payment.channel === "cash" ? "To pay on arrival" : "Guest says they sent"}</td><td>${esc(peso(b.payment.channel === "cash" ? b.payment.grandTotal : b.payment.amount))}</td></tr>
  </table>
  <form method="post">${action === "issue" ? "" : `
    <h2><label for="amount">Amount you verified (₱)</label></h2>
    <input id="amount" name="amount" inputmode="numeric" required pattern="[0-9,]+" value="${esc(suggestedAmount(b, action) || "")}"
      style="width:100%;padding:12px 14px;font:700 18px Arial,sans-serif;border:1px solid var(--line);border-radius:12px">
    <p class="note" style="text-align:left">Pre-filled with ${action === "dp" ? "what the guest says they paid" : "the rest of the total"}. Change it if your GCash or bank app shows a different amount.</p>`}
    <button class="btn${action === "issue" ? " issue" : ""}" type="submit">${esc(a.button)}</button></form>
  <p class="note">Opening this page changes nothing. Only the button above does.</p>
</div>`);
});

app.post("/staff/booking/:token", adminLimiter, express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
  const r = readStaffRequest(req, res);
  if (!r) return;
  const { b, action, contactId } = r;
  const key = `${b.id}:${action}`;
  const done = confirmedActions.get(key);
  if (typeof done === "object") return confirmedPage(res, b, action, done, true);
  if (done) return errorPage(res, 409, "This confirmation is already in progress. Refresh in a moment.");

  const webhook = GHL_ACTION_WEBHOOKS[action];
  if (!webhook) return errorPage(res, 503, "This GHL workflow is not set up on the server yet.");

  // The amount Thor checked in GCash / the bank. GHL adds it to Verified Paid Total.
  const amount = Number(String(req.body?.amount ?? "").replace(/,/g, ""));
  if (action !== "issue" && !(Number.isInteger(amount) && amount >= 1 && amount <= b.payment.grandTotal)) {
    return errorPage(res, 400, `Enter the amount you verified, in whole pesos from ₱1 to ${peso(b.payment.grandTotal)}. Go back and try again.`);
  }

  // Staff receipt (/receipt) and the guest's copy (/guest-receipt): same booking, sealed as different kinds.
  const s = { action, verifiedAt: new Date().toISOString(), ...(action !== "issue" && { amount }) };
  const receiptFor = (kind) => (action === "issue" ? "" : `${PUBLIC_API_URL}/${kind}/${sealLink(kind, { b, s }, RECEIPT_TTL_MS)}`);
  const links = { receipt: receiptFor("receipt"), guest: receiptFor("guest-receipt") };

  confirmedActions.set(key, true); // pending: a double click waits for this one
  try {
    const url = new URL(webhook);
    url.searchParams.set("contact_id", contactId); // the workflows' Find Contact reads this
    url.searchParams.set("booking_id", b.id);
    url.searchParams.set("receipt_link", links.receipt);
    url.searchParams.set("guest_receipt_link", links.guest); // for the guest's GHL email
    if (s.amount) url.searchParams.set("verified_amount", String(s.amount)); // GHL Math steps
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`GHL responded ${response.status}`);
  } catch (err) {
    confirmedActions.delete(key); // nothing recorded, so a retry is safe
    console.error("[Staff Confirm] GHL webhook failed:", b.id, action, err.message);
    return errorPage(res, 502, "Could not update GHL. Nothing was changed. Please try again.");
  }

  if (confirmedActions.size > MAX_CONFIRMED) confirmedActions.delete(confirmedActions.keys().next().value);
  confirmedActions.set(key, links);
  console.log("[Staff Confirm]", b.id, action);
  confirmedPage(res, b, action, links, false);
});

// Staff receipt (/receipt) and the guest's copy (/guest-receipt). The guest copy
// leaves out staff-only details: phone, email, birth date and the check-in checklist.
function receiptRoute(kind, forGuest) {
  return (req, res) => {
    if (!linksEnabled()) return errorPage(res, 503, "Receipts are not set up on the server yet (RECEIPT_SECRET).");
    const sealed = openLink(kind, req.params.token);
    if (!sealed || !STAFF_ACTIONS[sealed.s?.action]?.badge) {
      secLog(req, "invalid staff or receipt link");
      return errorPage(res, 400, forGuest ? "This receipt link is invalid or expired. Please message HaidoVille on Facebook for a new one." : INVALID_LINK);
    }
    const { b, s } = sealed;
    const paid = paidFor(b, s);
    const balance = b.payment.grandTotal - paid;
    const rows = bookingRows(b);
    const guestRows = forGuest
      ? `<tr><td>Name</td><td>${esc(b.guest.name)}</td></tr>`
      : `${rows.guest}<tr><td>Birth date</td><td>${esc(b.guest.birthDate)} (age ${esc(b.guest.age)})</td></tr>`;
    const after = forGuest
      ? `<div class="notice"><strong>Before you arrive</strong><ul>
          ${balance > 0 ? `<li>Please settle the balance of ${esc(peso(balance))} at check-in.</li>` : ""}
          <li>Questions? Call or text 0997-958-3579, or message us on Facebook with your Booking ID.</li>
        </ul></div>`
      : `<h2>Check-in checklist</h2>
        <ul class="check">
          <li>Valid ID matches the name and birth date (18+)</li>
          ${balance > 0 ? `<li>Balance of ${esc(peso(balance))} collected</li>` : ""}
        </ul>`;
    sendPage(res, 200, `Receipt ${b.id}`, `<div class="band"><small>BOOKING RECEIPT</small><strong>${esc(b.id)}</strong></div>
<div class="body">
  <span class="badge">${esc(STAFF_ACTIONS[s.action].badge)}</span>
  <p style="margin-top:10px">Payment ${forGuest ? "confirmed" : "verified"} on ${esc(fmtManilaTime(s.verifiedAt))} · Booked on ${esc(fmtManilaTime(b.at))}</p>
  <div class="id-alert">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5.5 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14 10h4.5M14 13.5h3"/></svg>
    <div>${forGuest
      ? `<b>Bring a valid ID</b><span>The person who made this booking must be <strong>18 or older</strong> and present a <strong>valid ID</strong> matching the name on this receipt at check-in.</span>`
      : `<b>Check the booker's valid ID</b><span>The name and birth date on the ID must match this receipt (born ${esc(b.guest.birthDate)}, age ${esc(b.guest.age)}). The booker must be <strong>18 or older</strong>. If it does not match, do not cancel; flag it for review.</span>`}</div>
  </div>
  <h2>Guest</h2><table>${guestRows}</table>
  ${forGuest ? "" : `<p style="font-size:12px;margin-top:8px">Confirmed 18+ and the ID requirement on ${esc(b.guest.ageConfirmedAt ? fmtManilaTime(b.guest.ageConfirmedAt) : "—")}</p>`}
  <h2>Stay</h2><table class="rooms">${rows.rooms}</table>
  <h2>Payment</h2><table>
    <tr><td>Channel</td><td>${esc(CHANNEL_NAMES[b.payment.channel] || b.payment.channel)}</td></tr>
    <tr><td>Reference #</td><td>${esc(b.payment.referenceNumber)}</td></tr>
    <tr><td>Grand total</td><td>${esc(peso(b.payment.grandTotal))}</td></tr>
    <tr><td>Amount paid</td><td>${esc(peso(paid))}</td></tr>
    <tr class="total"><td>Balance due at check-in</td><td>${esc(peso(balance))}</td></tr>
  </table>
  ${after}
  <button class="btn noprint" id="print" type="button">Print receipt</button>
</div>`, { script: PRINT_SCRIPT, footer: forGuest ? GUEST_FOOTER : STAFF_FOOTER });
  };
}

app.get("/receipt/:token", adminLimiter, receiptRoute("receipt", false));
app.get("/guest-receipt/:token", adminLimiter, receiptRoute("guest-receipt", true));

// ============================================================
// POST /inquiry — Proxy for GHL Inquiry Webhook
// ============================================================
const INQUIRY_ALLOWED_FIELDS = [
  "full_name", "phone", "email",
  "quote_checkin_date", "quote_checkout_date",
  "quote_number_of_pax", "quote_preferred_room_type",
  "quote_message",
];
const INQUIRY_ROOMS = ["", "Bunk Beds", "Barkada Room", "Couple Room", "Family Room", "Not sure yet"];

// Returns the clean fields, or an error message string.
function validateInquiry(body) {
  const f = {};
  for (const k of INQUIRY_ALLOWED_FIELDS) f[k] = String(body[k] ?? "").replace(/[<>]/g, "").trim().slice(0, 1000);
  if (!f.full_name || f.full_name.length > 100) return "Please enter your name.";
  f.phone = normalizePhone(f.phone);
  if (!f.phone) return PHONE_MSG;
  if (f.email.length > 100 || !EMAIL_RE.test(f.email)) return "Please enter a valid email address.";
  if (!isValidDate(f.quote_checkin_date) || !isValidDate(f.quote_checkout_date) ||
      f.quote_checkout_date <= f.quote_checkin_date) return "Please check your dates.";
  if (!/^([1-9]|1[0-5]|16\+)$/.test(f.quote_number_of_pax)) return "Please select the number of guests.";
  if (!INQUIRY_ROOMS.includes(f.quote_preferred_room_type)) return "Please select a room type.";
  return f;
}

app.post(
  "/inquiry",
  requireSessionHint,
  inquiryRateLimiter,
  express.urlencoded({ extended: false, limit: "20kb" }),
  async (req, res) => {
    try {
      const session = req.hvSession;
      if (!req.body.csrfToken || req.body.csrfToken !== session.csrfToken) {
        secLog(req, "invalid inquiry CSRF token");
        return res.status(403).json({ error: "Invalid CSRF token" });
      }

      if (!GHL_INQUIRY_WEBHOOK_URL) {
        return res.status(500).json({ error: "Inquiry webhook not configured." });
      }

      const fields = validateInquiry(req.body);
      if (typeof fields === "string") return res.status(400).json({ error: fields });

      const response = await fetch(GHL_INQUIRY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });

      if (!response.ok) {
        throw new Error("GHL responded with status " + response.status);
      }

      session.csrfToken = null; // Destroy token only on success
      res.json({ success: true, message: "Inquiry sent successfully." });
    } catch (err) {
      console.error("[Inquiry Proxy Error]", err.message);
      res.status(500).json({ error: "Could not send inquiry at this time." });
    }
  }
);

// ============================================================
// HELPER: Availability check for a booking request
// ============================================================
// One Smoobu fetch for the whole request. Returns an error message for the
// first room that can't be booked, or null. Fails safe if Smoobu is down.
async function findUnavailableRoom(rooms) {
  const from = rooms.map((r) => r.checkIn).sort()[0];
  const to = rooms.map((r) => r.checkOut).sort().at(-1);
  let bookings;
  try {
    bookings = (await fetchReservations(from, to)).filter((b) => b.type !== "cancellation");
  } catch (err) {
    console.warn("[Availability] Smoobu fetch failed — blocking as precaution:", err.message);
    return "We couldn't confirm availability right now. Please try again in a moment.";
  }

  for (const room of rooms) {
    const overlaps = (b) => b.arrival && b.departure && b.arrival < room.checkOut && b.departure > room.checkIn;
    if (room.name === "Bunk Beds") {
      const booked = new Set(bookings.filter((b) => BUNK_APARTMENT_IDS.includes(b.apartment?.id) && overlaps(b)).map((b) => b.apartment.id));
      const free = BUNK_APARTMENT_IDS.length - booked.size;
      if (free < room.pax) {
        return `Not enough bunk beds available for the selected dates. Only ${free} bed${free !== 1 ? "s" : ""} left — you requested ${room.pax}. Please adjust your dates or number of beds.`;
      }
    } else if (bookings.some((b) => b.apartment?.id === NON_BUNK_ROOM_APT_IDS[room.name] && overlaps(b))) {
      return `${room.name} is not available for the selected dates. Please choose different dates or a different room.`;
    }
  }
  return null;
}

// Free bunk apartment ids for a stay (used to pick beds for Smoobu drafts).
async function findAvailableBunkApartments(checkIn, checkOut) {
  try {
    const booked = new Set((await fetchReservations(checkIn, checkOut))
      .filter((b) => b.type !== "cancellation" && BUNK_APARTMENT_IDS.includes(b.apartment?.id) &&
        b.arrival && b.departure && b.arrival < checkOut && b.departure > checkIn)
      .map((b) => b.apartment.id));
    return BUNK_APARTMENT_IDS.filter((id) => !booked.has(id));
  } catch (err) {
    console.error("[Bunk Picker] Error — failing safe:", err.message);
    return [];
  }
}

// ============================================================
// HELPER: Create Smoobu Draft Booking
// ============================================================
async function createSmoobuDraft(data) {
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
      apartmentIds = [NON_BUNK_ROOM_APT_IDS[room.name]];
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
        // "Ref: <ref>" is parsed back by seedRefsFromSmoobu() — keep the format.
        notice: `[WEBSITE ${data.bookingId}] ${data.payment.channel === "cash" ? "₱0 PAID" : `GUEST SAYS PAID ₱${data.payment.amount} (UNVERIFIED)`} OF ₱${data.payment.grandTotal} |${data.payment.channel.toUpperCase()} | Ref: ${data.payment.referenceNumber} | ${data.payment.channel === "cash" ? "WALK-IN — CASH ON ARRIVAL" : "AWAITING RECEIPT VERIFICATION"}${bedSuffix ? " | " + bedSuffix.trim() : ""}${approvalNote(data.rooms) ? " | " + approvalNote(data.rooms).toUpperCase() : ""} | CHECK ID 18+`,
        language: "en",
      };

      try {
        const response = await smoobuFetch("https://login.smoobu.com/api/reservations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (response.ok) {
          console.log("[Smoobu Draft Created]", data.bookingId, "room:", room.name + bedSuffix, "aptId:", apartmentId, "smoobuId:", result.id);
        } else {
          console.warn("[Smoobu Draft Failed]", "aptId:", apartmentId, response.status);
        }
      } catch (err) {
        console.error("[Smoobu Draft Network Error]", err.message);
      }
    }
  }
}

// ============================================================
// HELPER: Send Email Notification
// ============================================================
async function sendBookingEmail(data) {
  if (!RESEND_API_KEY) return;

  const resend = new Resend(RESEND_API_KEY);
  const channelNames = CHANNEL_NAMES;
  const isCash = data.payment.channel === "cash";
  const approval = approvalNote(data.rooms);
  // Only "attack" is flagged: a "suspicious" score fits a real guest (a typo, a stale page).
  const risky = data.risk && data.risk.level === "attack";
  const riskHtml = risky
    ? `<div style="background:#fef3f2;border-left:4px solid #b42318;padding:12px;margin-bottom:16px;border-radius:4px;color:#7a271a;">
        <strong>⚠️ Check this booking carefully (attack).</strong><br>
        The same connection also triggered: ${Object.entries(data.risk.reasons).map(([k, v]) => `${esc(k)} ×${esc(v)}`).join(", ")}.
        Verify the payment receipt before confirming.
      </div>`
    : "";
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
        ${riskHtml}
        ${approval ? `<div style="background:#fff8e6;border-left:4px solid #f59e0b;padding:12px;margin-bottom:16px;border-radius:4px;"><strong>⚠️ Needs approval:</strong> ${esc(approval)}.</div>` : ""}
        <h3 style="margin-top:0;color:#C9A96E;">👤 Guest Details</h3>
        <p style="margin:4px 0;"><strong>Name:</strong> ${esc(data.guest.name)}</p>
        <p style="margin:4px 0;"><strong>Email:</strong> ${esc(data.guest.email)}</p>
        <p style="margin:4px 0;"><strong>Phone:</strong> ${esc(data.guest.phone)}</p>
        <p style="margin:4px 0;"><strong>Date of Birth:</strong> ${esc(data.guest.birthDate)} (age ${esc(data.guest.age)})</p>
        ${data.guest.nationality ? `<p style="margin:4px 0;"><strong>Nationality:</strong> ${esc(data.guest.nationality)}</p>` : ""}
        ${data.guest.address ? `<p style="margin:4px 0;"><strong>Address:</strong> ${esc(data.guest.address)}</p>` : ""}
        ${data.guest.arrivalTime ? `<p style="margin:4px 0;"><strong>Arrival Time:</strong> ${esc(data.guest.arrivalTime)}</p>` : ""}
        ${data.guest.port ? `<p style="margin:4px 0;"><strong>Port:</strong> ${esc(data.guest.port)}</p>` : ""}
        ${data.guest.specialRequest ? `<p style="margin:4px 0;"><strong>Special Request:</strong> ${esc(data.guest.specialRequest)}</p>` : ""}
        <h3 style="color:#C9A96E;margin-top:20px;">🛏️ Rooms</h3>
        <table style="width:100%;border-collapse:collapse;">${roomsHtml}</table>
        <h3 style="color:#C9A96E;margin-top:20px;">💰 Payment Details (Server Verified)</h3>
        <p style="margin:4px 0;"><strong>Type:</strong> ${PAY_TYPE_NAMES[data.payment.type]}</p>
        <p style="margin:4px 0;"><strong>Channel:</strong> ${channelNames[data.payment.channel]}</p>
        <p style="margin:4px 0;"><strong>Reference #:</strong> <code style="background:#fff;padding:3px 8px;border-radius:4px;">${esc(data.payment.referenceNumber)}</code></p>
        <p style="margin:4px 0;"><strong>Amount guest says paid (not verified):</strong> <span style="color:#C9A96E;font-size:18px;font-weight:bold;">₱${data.payment.amount.toLocaleString()}</span></p>
        <p style="margin:4px 0;"><strong>Grand Total:</strong> ₱${data.payment.grandTotal.toLocaleString()}</p>
        <p style="margin:4px 0;"><strong>Balance:</strong> ₱${data.payment.grandTotal.toLocaleString()} (nothing verified yet)</p>
        <div style="background:#fff;border-left:4px solid #C9A96E;padding:12px;margin-top:20px;border-radius:4px;">
          ${actionNeededHtml}
        </div>
        <div style="background:#fff;border-left:4px solid #C9A96E;padding:12px;margin-top:12px;border-radius:4px;">
          <strong>🪪 Check the booker's valid ID (18+) at check-in.</strong><br>The name and date of birth must match this booking. If they do not match, do not cancel; flag it for review.
        </div>
      </div>
    </div>
  `;

  const safeSubjectName = String(data.guest.name).replace(/[\r\n]/g, " ").slice(0, 80);
  await resend.emails.send({
    from: `HaidoVille Booking <${FROM_EMAIL}>`,
    to: ADMIN_EMAIL,
    replyTo: data.guest.email,
    subject: `${risky ? "[CHECK] " : ""}${approval ? "[NEEDS APPROVAL] " : ""}🏠 New Booking: ${data.bookingId} — ${safeSubjectName}${isCash ? " [WALK-IN/CASH]" : ""}`,
    html,
  });

  console.log("[Email Sent]", data.bookingId);
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
    throw new Error(`GHL webhook failed (${response.status})`);
  }
  console.log("[GHL Webhook Sent]", data.bookingId, "source:", payload.source);
}

function buildGhlPayload(data) {
  const nameParts = (data.guest.name || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";
  const paymentMethod = CHANNEL_NAMES[data.payment.channel] || data.payment.channel;
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
  const dpAmount = data.payment.amount; // claimed by the guest; Thor's verified payments lower the balance in GHL
  // Multi-room stays can have different dates: the email shows the whole stay
  // (earliest check-in to latest check-out), and each room's own dates when they differ.
  const stayIn = data.rooms.map((r) => r.checkIn).sort()[0];
  const stayOut = data.rooms.map((r) => r.checkOut).sort().at(-1);
  const sameDates = data.rooms.every((r) => r.checkIn === stayIn && r.checkOut === stayOut);
  const fmtRange = (ci, co) => {
    const [a, b] = [fmtShortDate(ci), fmtShortDate(co)]; // "Jun 17, 2027"
    const [am, ad] = a.split(/[ ,]+/), [bm, bd] = b.split(/[ ,]+/);
    return am === bm ? `${am} ${ad}–${bd}` : `${am} ${ad} – ${bm} ${bd}`;
  };
  const roomType = sameDates
    ? data.rooms.map((r) => r.name).join(" + ")
    : data.rooms.map((r) => `${r.name} (${fmtRange(r.checkIn, r.checkOut)})`).join(" + ");
  const totalPax = data.rooms.reduce((sum, r) => sum + (parseInt(r.pax) || 0), 0);
  const totalNights = Math.round((new Date(stayOut + "T00:00:00Z") - new Date(stayIn + "T00:00:00Z")) / 86400000);

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
    check_in_date: fmtShortDate(stayIn),
    check_out_date: fmtShortDate(stayOut),
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
    balance: String(grandTotal), // nothing is verified yet
    // Number fields for the GHL Math steps in Mark DP / Payment Received.
    balance_number: grandTotal,
    verified_paid_total: 0,
    payment_type: PAY_TYPE_NAMES[data.payment.type],
    needs_approval: approvalNote(data.rooms),
    special_request: data.guest.specialRequest || "",
    room_count: String(data.rooms.length),
    // Staff buttons in the payment-check email: {{contact.staff_link}}?action=dp&contact_id={{contact.id}}
    staff_link: staffLink(data),
    payment_status: paymentStatus(data.payment),
    birth_date: data.guest.birthDate || "",
    age_confirmed_at: data.guest.ageConfirmedAt ? fmtManilaTime(data.guest.ageConfirmedAt) : "",
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
// JSON error handler (bad JSON, oversized bodies, anything unhandled).
// Without it Express answers with an HTML stack trace.
// ============================================================
app.use((err, req, res, next) => {
  if (err.status === 413) return res.status(413).json({ error: "Payload too large." });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: "Bad request." });
  console.error("[Unhandled]", err.message);
  res.status(500).json({ error: "Server error" });
});

export {
  app, calculateRoomPrice, normalizePhone, isValidDate, getEaster, isHolyWeekDate, buildAvailabilityResult,
  seedRefsFromSmoobu, sendBookingEmail, buildGhlPayload,
};

// Listen only when run directly (`node server.js`), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`🚀 Secure HaidoVille Smoobu Sync running on port ${PORT}`);
    console.log(`   Smoobu HMAC:   ${SMOOBU_API_LABEL && SMOOBU_API_SECRET ? "✅" : "❌"}`);
    console.log(`   Email:         ${RESEND_API_KEY && ADMIN_EMAIL ? "✅" : "⚠️  disabled"}`);
    console.log(`   GHL Webhook:   ${GHL_WEBHOOK_URL ? "✅" : "⚠️  not configured"}`);
    console.log(`   Smoobu Drafts: ${CREATE_SMOOBU_DRAFT ? "✅ ON" : "❌ OFF"}`);
    console.log(`   Receipts:      ${linksEnabled() ? "✅" : "⚠️  RECEIPT_SECRET not set: no staff or receipt links"}`);
    for (const [action, url] of Object.entries(GHL_ACTION_WEBHOOKS)) {
      if (!url) console.warn(`   ⚠️  GHL webhook for "${action}" not set: staff can't confirm that action`);
    }
  });
  seedRefsFromSmoobu()
    .then((n) => console.log(`[Refs] Restored ${n} payment reference(s) from Smoobu.`))
    .catch((err) => console.error("[Refs] Seed from Smoobu failed:", err.message));
}

// ============================================================
// HAIDOVILLE × SMOOBU SYNC - Render.com Server v3.6
// ============================================================
// v3.6 FIXES:
// - ADDED: GET /ping — public no-auth endpoint for keep-alive / UptimeRobot
// - All other endpoints and security measures unchanged from v3.5
// ============================================================

import express from "express";
import rateLimit from "express-rate-limit";
import { Resend } from "resend";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

// ---- Config ----
const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL || "";
const CACHE_DURATION_MS = 5 * 60 * 1000;
const CREATE_SMOOBU_DRAFT = process.env.CREATE_SMOOBU_DRAFT === "true";

// ---- Secure Configuration Keys ----
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const CALENDAR_ACCESS_TOKEN = process.env.CALENDAR_ACCESS_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || "10m";

// ============================================================
// PERSISTENT REFERENCE NUMBER STORE
// ============================================================
const REFS_FILE = path.join(__dirname, "refs.json");

function loadPersistedRefs() {
  try {
    if (fs.existsSync(REFS_FILE)) {
      const raw = fs.readFileSync(REFS_FILE, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (err) {
    console.warn(
      "[Refs] Could not load refs.json, starting fresh:",
      err.message,
    );
  }
  return new Set();
}

function persistRefs(set) {
  try {
    fs.writeFileSync(REFS_FILE, JSON.stringify([...set]), "utf8");
  } catch (err) {
    console.error("[Refs] Failed to persist refs.json:", err.message);
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
  return diffDays >= -1 && diffDays <= 7;
}

const processedReferenceNumbers = loadPersistedRefs();
console.log(
  `[Refs] Loaded ${processedReferenceNumbers.size} persisted reference number(s).`,
);

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
    "https://www.haidoville.com",
  ];
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-API-Key, X-Calendar-Access, Authorization",
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
    return res
      .status(401)
      .json({ error: "Unauthorized infrastructure access denied." });
  }
  next();
};

const requireCalendarAccess = (req, res, next) => {
  const calToken = req.headers["x-calendar-access"];
  if (!calToken || calToken !== CALENDAR_ACCESS_TOKEN) {
    return res.status(403).json({ error: "Direct access is restricted." });
  }
  next();
};

// ============================================================
// ONE-TIME USE JWT VALIDATION
// ============================================================
const usedTokens = new Map();

const requireJwtToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(403)
      .json({
        error:
          "Direct access is restricted. Missing or invalid Authorization header.",
      });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (usedTokens.has(decoded.jti)) {
      return res
        .status(401)
        .json({ error: "Token already used (one-time use only)." });
    }
    usedTokens.set(decoded.jti, decoded.exp * 1000);
    if (usedTokens.size > 1000) {
      const now = Date.now();
      for (const [id, exp] of usedTokens) {
        if (now > exp) usedTokens.delete(id);
      }
    }
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token." });
  }
};

// ============================================================
// RATE LIMITING
// ============================================================
const bookingRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a moment and try again.",
  },
});

const tokenRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a moment and try again.",
  },
});

// ============================================================
// GET /ping  ← NEW v3.6: Public keep-alive endpoint (no auth)
// ============================================================
// Used by the frontend keep-alive and UptimeRobot.
// Returns 200 with a minimal payload — no sensitive data.
// No auth required because it reveals nothing about the system.
// ============================================================
app.get("/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ============================================================
// GET /  — Protected health check (internal use only)
// ============================================================
app.get("/", requireApiKey, (req, res) => {
  res.json({
    service: "HaidoVille Smoobu Sync",
    version: "3.6",
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
// GET /bookings  (protected calendar sync — internal/admin use)
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

    const fromDate =
      typeof req.query.from === "string" ? req.query.from.slice(0, 10) : today;
    const endDate =
      typeof req.query.to === "string" ? req.query.to.slice(0, 10) : toDate;

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
        return res
          .status(smoobuRes.status)
          .json({
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
// GET /availability  (public — no auth, no PII)
// ============================================================
app.get("/availability", async (req, res) => {
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
    let page = 1,
      totalPages = 1;

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
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

// Shared helper — builds the availability result from Smoobu bookings array
function buildAvailabilityResult(allBookings) {
  const result = {
    bookedRanges: [],
    bunkBookings: [],
    familyBookedUnits: [],
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
// GET /booking-token  (public — issues one-time JWT)
// ============================================================
app.get("/booking-token", tokenRateLimiter, (req, res) => {
  const jti = uuidv4();
  const token = jwt.sign({ jti }, JWT_SECRET, { expiresIn: JWT_EXPIRATION });
  res.json({ token });
});

// ============================================================
// POST /bookings/create
// ============================================================
app.post(
  "/bookings/create",
  requireJwtToken,
  bookingRateLimiter,
  async (req, res) => {
    try {
      const rawData = req.body;

      if (
        !rawData ||
        !rawData.bookingId ||
        !rawData.guest ||
        !rawData.rooms ||
        !rawData.payment
      ) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (
        !Array.isArray(rawData.rooms) ||
        rawData.rooms.length === 0 ||
        rawData.rooms.length > 5
      ) {
        return res
          .status(400)
          .json({ error: "Invalid room allocation parameters boundary." });
      }

      const clientRef = String(rawData.payment.referenceNumber || "").trim();
      if (rawData.payment.channel !== "cash") {
        if (!clientRef || clientRef.length < 5) {
          return res
            .status(400)
            .json({ error: "Invalid reference tracking length." });
        }
        if (processedReferenceNumbers.has(clientRef)) {
          return res
            .status(409)
            .json({
              error: "Duplicate transaction reference code tracking conflict.",
            });
        }
      }

      const sanitizedGuest = {
        name: String(rawData.guest.name || "").slice(0, 80),
        email: String(rawData.guest.email || "").slice(0, 80),
        phone: String(rawData.guest.phone || "").slice(0, 30),
        age: String(rawData.guest.age || ""),
        nationality: String(rawData.guest.nationality || "").slice(0, 30),
        address: String(rawData.guest.address || "").slice(0, 200),
        arrivalTime: String(rawData.guest.arrivalTime || ""),
        departureTime: String(rawData.guest.departureTime || ""),
        port: String(rawData.guest.port || "").slice(0, 50),
        specialRequest: String(rawData.guest.specialRequest || "").slice(
          0,
          500,
        ),
      };

      const sanitizedRooms = rawData.rooms.map((room) => ({
        name: String(room.name),
        checkIn: String(room.checkIn).slice(0, 10),
        checkOut: String(room.checkOut).slice(0, 10),
        nights: Math.max(1, Math.min(30, parseInt(room.nights) || 1)),
        pax: Math.max(1, Math.min(9, parseInt(room.pax) || 1)),
        paxLabel: String(room.paxLabel || "Guests"),
      }));

      let calculatedGrandTotal = 0;
      const finalProcessedRooms = sanitizedRooms.map((room) => {
        const calculatedSubtotal = calculateRoomPrice(
          room.name,
          room.pax,
          room.nights,
          room.checkIn,
          room.checkOut,
        );
        calculatedGrandTotal += calculatedSubtotal;
        return { ...room, subtotal: calculatedSubtotal };
      });

      if (SMOOBU_API_KEY) {
        for (const room of sanitizedRooms) {
          if (room.name === "Bunk Beds") continue;
          const aptId = NON_BUNK_ROOM_APT_IDS[room.name];
          if (!aptId) continue;
          const isAvailable = await checkNonBunkAvailability(
            aptId,
            room.checkIn,
            room.checkOut,
          );
          if (!isAvailable) {
            console.warn(
              `[Availability] ${room.name} is already booked for ${room.checkIn} → ${room.checkOut}.`,
            );
            return res.status(409).json({
              error: `${room.name} is not available for the selected dates. Please choose different dates or a different room.`,
            });
          }
        }
      }

      const paymentChannel = String(rawData.payment.channel);
      const paymentType =
        String(rawData.payment.type) === "full" ? "full" : "dp";
      const finalAmountPaid =
        paymentType === "full"
          ? calculatedGrandTotal
          : Math.ceil(calculatedGrandTotal * 0.5);

      const data = {
        bookingId: String(rawData.bookingId).slice(0, 50),
        source: String(rawData.source || "Website (Direct)").slice(0, 50),
        submittedAt: rawData.submittedAt || new Date().toISOString(),
        guest: sanitizedGuest,
        rooms: finalProcessedRooms,
        payment: {
          channel: paymentChannel,
          type: paymentType,
          referenceNumber:
            paymentChannel === "cash" ? `CASH-${Date.now()}` : clientRef,
          amount: finalAmountPaid,
          grandTotal: calculatedGrandTotal,
        },
      };

      if (paymentChannel !== "cash") {
        processedReferenceNumbers.add(clientRef);
        persistRefs(processedReferenceNumbers);
      }

      pendingBookings.push({ ...data, receivedAt: new Date().toISOString() });

      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      while (
        pendingBookings.length > 0 &&
        new Date(pendingBookings[0].receivedAt).getTime() < weekAgo
      ) {
        pendingBookings.shift();
      }

      console.log(
        "[Booking Received]",
        data.bookingId,
        "-",
        data.guest.name,
        "(",
        data.guest.email,
        ") source:",
        data.source,
      );

      if (GHL_WEBHOOK_URL) {
        forwardToGHL(data).catch((err) =>
          console.error("[GHL Webhook Error]", err.message),
        );
      }

      if (RESEND_API_KEY && ADMIN_EMAIL) {
        sendBookingEmail(data).catch((err) =>
          console.error("[Email Error]", err.message),
        );
      }

      if (CREATE_SMOOBU_DRAFT && SMOOBU_API_KEY) {
        createSmoobuDraft(data)
          .then(() => {
            cache = { data: null, timestamp: 0 };
          })
          .catch((err) => console.error("[Smoobu Draft Error]", err.message));
      }

      res.json({
        success: true,
        bookingId: data.bookingId,
        message: "Booking logged securely. Please send receipt via Messenger.",
      });
    } catch (err) {
      console.error("[Booking Create Error]", err);
      res.status(500).json({ error: "Server error", message: err.message });
    }
  },
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
      console.warn(
        `[Availability] Smoobu fetch failed for apt ${apartmentId}. Blocking as precaution. Status:`,
        response.status,
      );
      return false;
    }

    const data = await response.json();
    const bookings = data.bookings || [];

    for (const b of bookings) {
      if (b.type === "cancellation") continue;
      if (b.apartment?.id !== apartmentId) continue;
      if (
        b.arrival &&
        b.departure &&
        b.arrival < checkOut &&
        b.departure > checkIn
      ) {
        return false;
      }
    }

    return true;
  } catch (err) {
    console.error(
      `[Availability] Error checking apt ${apartmentId}:`,
      err.message,
    );
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
      console.warn(
        "[Bunk Picker] Smoobu fetch failed — failing safe. Status:",
        response.status,
      );
      return [];
    }

    const data = await response.json();
    const bookings = data.bookings || [];
    const bookedIds = new Set();

    for (const b of bookings) {
      if (b.type === "cancellation") continue;
      const aptId = b.apartment?.id;
      if (!BUNK_APARTMENT_IDS.includes(aptId)) continue;
      if (
        b.arrival &&
        b.departure &&
        b.arrival < checkOut &&
        b.departure > checkIn
      ) {
        bookedIds.add(aptId);
      }
    }

    const freeIds = BUNK_APARTMENT_IDS.filter((id) => !bookedIds.has(id));
    console.log(
      "[Bunk Picker]",
      checkIn,
      "→",
      checkOut,
      "| booked:",
      bookedIds.size,
      "| free IDs:",
      freeIds,
    );
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
      const freeApts = await findAvailableBunkApartments(
        room.checkIn,
        room.checkOut,
      );
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
      const bedSuffix =
        isBunk && isMulti ? ` (Bed ${i + 1}/${apartmentIds.length})` : "";

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
        const response = await fetch(
          "https://login.smoobu.com/api/reservations",
          {
            method: "POST",
            headers: {
              "Api-Key": SMOOBU_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );
        const result = await response.json();
        if (response.ok) {
          console.log(
            "[Smoobu Draft Created]",
            data.bookingId,
            "room:",
            room.name + bedSuffix,
            "aptId:",
            apartmentId,
            "smoobuId:",
            result.id,
          );
        } else {
          console.warn(
            "[Smoobu Draft Failed]",
            "aptId:",
            apartmentId,
            JSON.stringify(result),
          );
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
    .map(
      (r, i) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;">
        <strong>Room ${i + 1}: ${r.name}</strong><br>
        <small style="color:#666;">${r.checkIn} → ${r.checkOut} (${r.nights} nights)</small><br>
        <small style="color:#666;">${r.pax} ${r.paxLabel} • ₱${r.subtotal.toLocaleString()}</small>
      </td>
    </tr>
  `,
    )
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
      <div style="background:linear-gradient(135deg,#C9A96E 0%,#b8935a 100%);color:#fff;padding:20px;border-radius:12px 12px 0 0;">
        <h2 style="margin:0;font-size:22px;">🏠 Secure HaidoVille Booking</h2>
        <p style="margin:6px 0 0;opacity:0.9;">Reference Code Verified: ${data.bookingId}</p>
        <p style="margin:4px 0 0;opacity:0.8;font-size:13px;">Source: ${data.source || "Website (Direct)"}</p>
      </div>
      <div style="background:#f9f9f9;padding:20px;border-radius:0 0 12px 12px;">
        <h3 style="margin-top:0;color:#C9A96E;">👤 Guest Details</h3>
        <p style="margin:4px 0;"><strong>Name:</strong> ${data.guest.name}</p>
        <p style="margin:4px 0;"><strong>Email:</strong> ${data.guest.email}</p>
        <p style="margin:4px 0;"><strong>Phone:</strong> ${data.guest.phone}</p>
        ${data.guest.nationality ? `<p style="margin:4px 0;"><strong>Nationality:</strong> ${data.guest.nationality}</p>` : ""}
        ${data.guest.address ? `<p style="margin:4px 0;"><strong>Address:</strong> ${data.guest.address}</p>` : ""}
        ${data.guest.arrivalTime ? `<p style="margin:4px 0;"><strong>Arrival Time:</strong> ${data.guest.arrivalTime}</p>` : ""}
        ${data.guest.port ? `<p style="margin:4px 0;"><strong>Port:</strong> ${data.guest.port}</p>` : ""}
        ${data.guest.specialRequest ? `<p style="margin:4px 0;"><strong>Special Request:</strong> ${data.guest.specialRequest}</p>` : ""}
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

  await resend.emails.send({
    from: `HaidoVille Booking <${FROM_EMAIL}>`,
    to: ADMIN_EMAIL,
    replyTo: data.guest.email,
    subject: `🏠 Verified Booking: ${data.bookingId} — ${data.guest.name}${isCash ? " [WALK-IN/CASH]" : ""}`,
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
  const paymentMethod =
    channelLabels[data.payment.channel] || data.payment.channel;
  const firstRoom = data.rooms[0] || {};

  const fmtShortDate = (d) => {
    if (!d) return "";
    try {
      return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (e) {
      return d;
    }
  };

  const confirmationDate = new Date(
    data.submittedAt || new Date(),
  ).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
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
  if (data.rooms.length > 1)
    roomType = data.rooms.map((r) => r.name).join(" + ");
  const totalPax = data.rooms.reduce(
    (sum, r) => sum + (parseInt(r.pax) || 0),
    0,
  );
  const totalNights = firstRoom.nights || 0;

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
    no_of_guests: String(totalPax),
    payment_method: paymentMethod,
    payment_ref: data.payment.referenceNumber || "",
    total_amount: String(grandTotal),
    dp_amount: String(dpAmount),
    balance: String(balance),
    payment_type:
      data.payment.type === "full" ? "Full Payment" : "Downpayment (50%)",
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
  console.log(
    `   Email:         ${RESEND_API_KEY && ADMIN_EMAIL ? "✅" : "⚠️  disabled"}`,
  );
  console.log(
    `   GHL Webhook:   ${GHL_WEBHOOK_URL ? "✅" : "⚠️  not configured"}`,
  );
  console.log(`   Smoobu Drafts: ${CREATE_SMOOBU_DRAFT ? "✅ ON" : "❌ OFF"}`);
});

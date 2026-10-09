// Helpers shared by server.js and appServer.js.
import crypto from "crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";

// ---- Client IP ----
// Render sits behind Cloudflare, which sets CF-Connecting-IP to the real client.
export const clientIp = (req) => req.headers["cf-connecting-ip"] || req.ip;

// Security events, without guest PII. Each one also feeds the attack monitor below.
export const secLog = (req, event) => {
  console.warn(`[SEC] ${event} | ${req.method} ${req.originalUrl.split("?")[0]} | ip=${clientIp(req)}`);
  recordEvent(clientIp(req), event);
};

// ============================================================
// ATTACK MONITOR
// ============================================================
// Every [SEC] event adds weight to its client IP for 15 minutes.
// A real guest trips one or two light events at most (a typo at the guest
// login, a booking page left open until prices changed). An attacker trips
// them over and over, or trips one only a forged request can (a bad key,
// a forged token). An IP at ATTACK_SCORE or more raises an alert.
const EVENT_WEIGHT = {
  "bad internal API key": 10,               // someone guessing the admin key
  "bad calendar access token": 10,
  "invalid booking token": 10,              // forged or tampered JWT
  "booking token reused": 10,               // replay
  "bad session hint signature": 5,
  "invalid inquiry CSRF token": 5,
  "upload rejected: not a JPEG/PNG/WebP image": 5,
  "many bookings from one IP": 5,
  "booking price mismatch": 4,              // tampering, or a stale page
  "session used from a different user-agent": 4,
  "rate limit hit": 3,
  "session hint blocked origin": 3,
  "guest-access blocked origin": 3,
  "per-guest daily booking cap": 3,
  "missing or invalid guest pass": 2,       // also: a pass that just expired
  "guest-access denied": 2,                 // also: a typo; 5 in a row is guessing
  "internal endpoint without key": 1,       // crawlers and scanners hit "/" all day
};
const WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ATTACK_SCORE = 10;
const SITE_ATTACK_SCORE = 60;               // many IPs at once (distributed)
const BOOKINGS_PER_IP_ALERT = 3;            // successful bookings from one IP in 15 min
// ponytail: fixed guess for a small resort; raise it if busy days cause false alarms.
const BOOKINGS_PER_HOUR_ALERT = parseInt(process.env.BOOKINGS_PER_HOUR_ALERT) || 8;
const MAX_TRACKED_IPS = 10000;

const ipEvents = new Map();   // ip -> [{ t, event, w }], last 15 min
const siteEvents = [];        // [{ t, w }], last 15 min, oldest first
let siteScore = 0;
const bookingTimes = [];      // successful bookings, last hour
const lastAlertAt = new Map(); // alert key -> time, one alert per key per hour
const recentAlerts = [];      // last 50, for /internal/security

function pruneMonitor(now = Date.now()) {
  for (const [ip, list] of ipEvents) {
    const kept = list.filter((e) => now - e.t < WINDOW_MS);
    if (kept.length) ipEvents.set(ip, kept); else ipEvents.delete(ip);
  }
  for (const [k, t] of lastAlertAt) if (now - t >= HOUR_MS) lastAlertAt.delete(k);
}
setInterval(pruneMonitor, 60 * 1000).unref();

function ipReport(ip, now = Date.now()) {
  const list = (ipEvents.get(ip) || []).filter((e) => now - e.t < WINDOW_MS);
  const events = {};
  let score = 0, bookings = 0;
  for (const e of list) {
    if (e.event === "booking accepted") { bookings++; continue; }
    score += e.w;
    events[e.event] = (events[e.event] || 0) + 1;
  }
  const level = score >= ATTACK_SCORE ? "attack" : score > 0 ? "suspicious" : "normal";
  return { ip, level, score, events, bookings };
}

function recordEvent(ip, event, now = Date.now()) {
  if (!ipEvents.has(ip) && ipEvents.size >= MAX_TRACKED_IPS) {
    raiseAlert("site:ips", "Traffic from over 10,000 IPs with security events", { ips: ipEvents.size });
    return;
  }
  const w = event === "booking accepted" ? 0 : EVENT_WEIGHT[event] ?? 1;
  const list = ipEvents.get(ip) || [];
  list.push({ t: now, event, w });
  ipEvents.set(ip, list);

  siteEvents.push({ t: now, w });
  siteScore += w;
  while (siteEvents.length && now - siteEvents[0].t >= WINDOW_MS) siteScore -= siteEvents.shift().w;

  const r = ipReport(ip, now);
  if (r.level === "attack") raiseAlert(`ip:${ip}`, `Possible attack from IP ${ip}`, r.events);
  if (siteScore >= SITE_ATTACK_SCORE) {
    raiseAlert("site:score", "Many security events across many IPs (possible distributed attack)",
      { "security score, last 15 min": siteScore, "IPs involved": ipEvents.size });
  }
}

// Called for every accepted booking. Returns how the booking looks:
// "normal" (clean IP), "suspicious" or "attack" (the IP also tripped [SEC] events).
export function recordBooking(req, now = Date.now()) {
  const ip = clientIp(req);
  const before = ipReport(ip, now);
  recordEvent(ip, "booking accepted", now);
  if (before.bookings + 1 >= BOOKINGS_PER_IP_ALERT) secLog(req, "many bookings from one IP");

  bookingTimes.push(now);
  while (bookingTimes.length && now - bookingTimes[0] >= HOUR_MS) bookingTimes.shift();
  if (bookingTimes.length >= BOOKINGS_PER_HOUR_ALERT) {
    raiseAlert("site:bookings", `${bookingTimes.length} bookings in the last hour (check for fake bookings)`,
      { "bookings, last hour": bookingTimes.length, "alert threshold": BOOKINGS_PER_HOUR_ALERT });
  }
  const { level, events } = ipReport(ip, now);
  return { level, reasons: events };
}

export function securityStatus(now = Date.now()) {
  const ips = [...ipEvents.keys()].map((ip) => ipReport(ip, now))
    .filter((r) => r.level !== "normal")
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
  return {
    thresholds: { attackScorePerIp: ATTACK_SCORE, siteAttackScore: SITE_ATTACK_SCORE, bookingsPerHour: BOOKINGS_PER_HOUR_ALERT },
    siteScoreLast15Min: siteScore,
    bookingsLastHour: bookingTimes.filter((t) => now - t < HOUR_MS).length,
    flaggedIps: ips,
    recentAlerts: [...recentAlerts].reverse(),
  };
}

// Alerts go to the Render logs (search "[ALERT]"), once per issue per hour.
function raiseAlert(key, title, details, now = Date.now()) {
  if (now - (lastAlertAt.get(key) || 0) < HOUR_MS) return;
  lastAlertAt.set(key, now);
  recentAlerts.push({ at: new Date(now).toISOString(), title, details });
  if (recentAlerts.length > 50) recentAlerts.shift();
  console.error(`[ALERT] ${title} | ${JSON.stringify(details)}`);
}

export function limiter(windowMs, max, message = { error: "Too many requests. Please wait a moment and try again." }) {
  return rateLimit({
    windowMs, max, message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    handler: (req, res, next, opts) => { secLog(req, "rate limit hit"); res.status(opts.statusCode).json(opts.message); },
  });
}

// Constant-time compare for shared secrets; false when the secret isn't configured.
export function safeEqual(given, secret) {
  if (!given || !secret) return false;
  const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(secret));
}

// ---- Smoobu HMAC-signed fetch ----
export async function smoobuFetch(url, options = {}) {
  const label = process.env.SMOOBU_API_LABEL, secret = process.env.SMOOBU_API_SECRET;
  if (!label || !secret) throw new Error("SMOOBU_API_LABEL or SMOOBU_API_SECRET not configured");

  const method = (options.method || "GET").toUpperCase();
  const parsed = new URL(url);
  const sortedParams = [...parsed.searchParams.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = uuidv4();
  const bodyHash = crypto.createHash("sha256").update(options.body || "").digest("hex");
  const canonical = `${method}\n${parsed.pathname}\n${sortedParams}\n${timestamp}\n${nonce}\n${bodyHash}\n${label}`;
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("base64");

  return fetch(url, {
    ...options,
    method,
    // A hung Smoobu call must not hold the booking lock forever.
    signal: options.signal ?? AbortSignal.timeout(15000),
    headers: { ...options.headers, "X-API-Key": label, "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Signature": signature },
  });
}

// All reservations whose stay overlaps [from, to], across pages.
export async function fetchReservations(from, to, extraParams = {}) {
  const all = [];
  for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
    const url = new URL("https://login.smoobu.com/api/reservations");
    const params = { from, to, pageSize: "100", page: String(page), excludeBlocked: "false", ...extraParams };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await smoobuFetch(url.toString(), { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw Object.assign(new Error(`Smoobu ${res.status}`), { status: res.status });
    const data = await res.json();
    if (data.bookings?.length) all.push(...data.bookings);
    pages = data.page_count || 1;
  }
  return all;
}

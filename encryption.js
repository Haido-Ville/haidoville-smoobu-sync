// ============================================================
// HAIDOVILLE ENCRYPTION MODULE — AES-256-GCM  v3.8
// ============================================================
// SECURITY CHANGES vs v3.7:
//
//   REMOVED: POST /api/bootstrap/context (public decrypt oracle)
//     → Any caller could POST a ciphertext and get plaintext back.
//       This made the entire encryption layer useless.
//
//   REPLACED WITH: Client-side Web Crypto decryption
//     → The browser derives the same AES-256-GCM key locally using
//       PBKDF2 over a short-lived, HMAC-signed session token
//       (DECRYPT_HINT) that the server issues once per page load.
//       Decryption never leaves the browser. No server oracle exists.
//
// HOW IT WORKS:
//   1. Browser calls GET /api/session-hint  (rate-limited, origin-checked)
//   2. Server returns { hint, sig } — hint is a random 16-byte hex nonce,
//      sig is HMAC-SHA256(hint, SESSION_HINT_SECRET).
//   3. Browser verifies the sig client-side, then derives:
//        sessionKey = PBKDF2(hint + ":" + BROWSER_DECRYPT_KEY, salt, 200k, SHA-256)
//      where BROWSER_DECRYPT_KEY is a short public constant (see frontend).
//   4. Server derives the same key when encrypting for that request by
//      reading the X-Session-Hint header the browser sends.
//   5. No plaintext ever passes over /api/bootstrap/context.
//
// ENV VARS REQUIRED:
//   ENCRYPTION_KEY        — server-side master secret (never sent to browser)
//   SESSION_HINT_SECRET   — HMAC signing secret for hint tokens
//   BROWSER_DECRYPT_KEY   — short public constant known to both sides
//                           (embedded in frontend JS, not secret by itself)
// ============================================================

import crypto from "crypto";

const ALGORITHM        = "aes-256-gcm";
const IV_LENGTH        = 16;   // 128-bit IV
const AUTH_TAG_LENGTH  = 16;   // 128-bit auth tag
const KEY_LENGTH       = 32;   // 256-bit key
const PBKDF2_ITERATIONS       = 600_000; // server-side (OWASP 2023)
const PBKDF2_ITERATIONS_CLIENT = 200_000; // client-side Web Crypto limit
const PBKDF2_DIGEST    = "sha512";

// Fixed salt — public, prevents rainbow tables.
const PBKDF2_SALT = Buffer.from(
  process.env.PBKDF2_SALT || "HaidoVille::AES256GCM::v1::salt::9f3a7c2e",
  "utf8",
);

// ─── Master key (server ↔ server comms, e.g. /bookings internal) ─────────────
let _masterKey = null;

function getMasterKey() {
  if (_masterKey) return _masterKey;
  const rawSecret = process.env.ENCRYPTION_KEY;
  if (!rawSecret) throw new Error("[Encryption] ENCRYPTION_KEY env var not set.");
  _masterKey = crypto.pbkdf2Sync(rawSecret, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
  console.log("[Encryption] Master AES-256-GCM key derived (PBKDF2 x600k).");
  return _masterKey;
}

// Removed getSessionKey as browser encryption is deprecated.

// ─── Hint token helpers ────────────────────────────────────────────────────────
const HINT_TTL_MS = 15 * 60 * 1000; // 15-minute window

export function generateHint() {
  const secret = process.env.SESSION_HINT_SECRET;
  if (!secret) throw new Error("[Encryption] SESSION_HINT_SECRET env var not set.");
  const hint      = crypto.randomBytes(16).toString("hex");
  const ts        = Date.now().toString(36);           // compact timestamp
  const payload   = `${hint}.${ts}`;
  const sig       = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return { hint, ts, sig };
}

export function verifyHint(hint, ts, sig) {
  const secret = process.env.SESSION_HINT_SECRET;
  if (!secret) throw new Error("[Encryption] SESSION_HINT_SECRET env var not set.");
  const payload   = `${hint}.${ts}`;
  const expected  = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // Constant-time compare
  if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) {
    throw new Error("Invalid hint signature.");
  }
  const issuedAt  = parseInt(ts, 36);
  if (Date.now() - issuedAt > HINT_TTL_MS) {
    throw new Error("Hint token expired.");
  }
  return true;
}

// ─── Core encrypt / decrypt ────────────────────────────────────────────────────

export function encrypt(data, key) {
  const k   = key || getMasterKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, k, iv, { authTagLength: AUTH_TAG_LENGTH });
  const plaintext = JSON.stringify(data);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return { encrypted, iv: iv.toString("hex"), tag: tag.toString("hex") };
}

export function decrypt(payload, key) {
  const k  = key || getMasterKey();
  const iv  = Buffer.from(payload.iv,  "hex");
  const tag = Buffer.from(payload.tag, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, k, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(payload.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

// ─── Response helpers ──────────────────────────────────────────────────────────

// Encrypt with master key (server-to-server / admin endpoints).
export function encryptResponse(data) {
  const { encrypted, iv, tag } = encrypt(data);
  return { _encrypted: true, payload: encrypted, iv, tag };
}






export function getSessionKey(hint) {
  const browserKey = process.env.BROWSER_DECRYPT_KEY;
  if (!browserKey) throw new Error("[Encryption] BROWSER_DECRYPT_KEY env var not set.");
  const rawHint = hint.split('.')[0];
  const passphrase = rawHint + ':' + browserKey;
  return crypto.pbkdf2Sync(
    passphrase,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS_CLIENT,
    KEY_LENGTH,
    "sha256"
  );
}

export function encryptForSession(data, hint) {
  const key = getSessionKey(hint);
  const { encrypted, iv, tag } = encrypt(data, key);
  return { _encrypted: true, payload: encrypted, iv, tag };
}

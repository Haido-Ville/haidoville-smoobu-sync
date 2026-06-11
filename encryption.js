// ============================================================
// HAIDOVILLE ENCRYPTION MODULE — AES-256-GCM
// ============================================================
// Military-grade symmetric encryption using:
//   • AES-256-GCM (256-bit key, authenticated encryption)
//   • PBKDF2 key derivation (600,000 iterations — bcrypt-level)
//   • Random 16-byte IV per encryption (no IV reuse)
//   • 16-byte authentication tag (tamper detection)
//
// The raw ENCRYPTION_KEY env var is stretched via PBKDF2 with a
// fixed salt into a 256-bit derived key. This means even a weak
// passphrase is hardened to bcrypt-equivalent strength.
// ============================================================

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128-bit IV
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const KEY_LENGTH = 32; // 256-bit key
const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommended minimum
const PBKDF2_DIGEST = "sha512";

// Fixed salt for PBKDF2 key derivation — this can be public.
// It exists to make rainbow-table attacks infeasible.
const PBKDF2_SALT = Buffer.from(
  "HaidoVille::AES256GCM::v1::salt::9f3a7c2e",
  "utf8",
);

// ---- Derive the 256-bit encryption key from the env secret ----
let _derivedKey = null;

function getDerivedKey() {
  if (_derivedKey) return _derivedKey;

  const rawSecret = process.env.ENCRYPTION_KEY;
  if (!rawSecret) {
    throw new Error(
      "[Encryption] ENCRYPTION_KEY environment variable is not set.",
    );
  }

  // PBKDF2 with 600k iterations — equivalent strength to bcrypt cost 12+
  _derivedKey = crypto.pbkdf2Sync(
    rawSecret,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST,
  );

  console.log("[Encryption] AES-256-GCM key derived (PBKDF2 x600k).");
  return _derivedKey;
}

// ============================================================
// encrypt(data) → { encrypted, iv, tag }
// ============================================================
// Takes any JSON-serializable data, returns an object with:
//   • encrypted: hex-encoded ciphertext
//   • iv: hex-encoded initialization vector
//   • tag: hex-encoded authentication tag
// ============================================================
export function encrypt(data) {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const plaintext = JSON.stringify(data);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

// ============================================================
// decrypt({ encrypted, iv, tag }) → original data
// ============================================================
// Takes the encrypted payload and returns the original object.
// Throws if the key is wrong or data has been tampered with.
// ============================================================
export function decrypt(payload) {
  const key = getDerivedKey();
  const iv = Buffer.from(payload.iv, "hex");
  const tag = Buffer.from(payload.tag, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(payload.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted);
}

// ============================================================
// encryptResponse(data) → wrapped encrypted response
// ============================================================
// Convenience wrapper that returns the format sent to clients.
// ============================================================
export function encryptResponse(data) {
  const { encrypted, iv, tag } = encrypt(data);
  return {
    _encrypted: true,
    payload: encrypted,
    iv,
    tag,
  };
}

// ============================================================
// POST /decrypt endpoint handler
// ============================================================
// Decrypts a payload sent by the frontend.
// Body: { payload, iv, tag }
// Returns: the original decrypted JSON data
// ============================================================
export function handleDecrypt(req, res) {
  try {
    const { payload, iv, tag } = req.body;

    if (!payload || !iv || !tag) {
      return res
        .status(400)
        .json({ error: "Missing encrypted payload fields (payload, iv, tag)." });
    }

    const decrypted = decrypt({ encrypted: payload, iv, tag });
    return res.json(decrypted);
  } catch (err) {
    console.error("[Encryption] Decrypt failed:", err.message);
    return res
      .status(403)
      .json({ error: "Decryption failed. Invalid or tampered payload." });
  }
}

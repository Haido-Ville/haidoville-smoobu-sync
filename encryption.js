import crypto from "crypto";
import zlib from "zlib";

// ─── Hint token helpers ────────────────────────────────────────────────────────
export const HINT_TTL_MS = 15 * 60 * 1000; // 15-minute window

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
    throw Object.assign(new Error("Hint token expired."), { expired: true });
  }
  return true;
}

// ─── Guest pass ────────────────────────────────────────────────────────────────
function guestPassSig(exp) {
  const secret = process.env.SESSION_HINT_SECRET;
  if (!secret) throw new Error("[Encryption] SESSION_HINT_SECRET env var not set.");
  return crypto.createHmac("sha256", secret).update(`guest.${exp}`).digest("hex");
}

export function generateGuestPass(exp) {
  return `${exp}.${guestPassSig(exp)}`;
}

export function verifyGuestPass(pass) {
  const [exp, sig] = String(pass || "").split(".");
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig || "")) return false;
  if (Date.now() > Number(exp)) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(guestPassSig(exp), "hex"));
}

// ─── Sealed links (staff confirm page, booking receipt) ────────────────────────
const MAX_LINK_LENGTH = 4096;

function linkKey() {
  const secret = process.env.RECEIPT_SECRET;
  if (!secret) throw new Error("[Encryption] RECEIPT_SECRET env var not set.");
  return crypto.createHash("sha256").update(secret).digest();
}

export function sealLink(kind, data, ttlMs) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", linkKey(), iv);
  const plain = zlib.deflateRawSync(JSON.stringify({ ...data, v: 1, kind, exp: Date.now() + ttlMs }));
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}

// The sealed data, or null when the link is missing, changed, expired or of another kind.
export function openLink(kind, token) {
  try {
    token = String(token || "");
    if (token.length > MAX_LINK_LENGTH) return null;
    const buf = Buffer.from(token, "base64url");
    // Node skips invalid base64 characters; only the exact encoding is accepted.
    if (buf.length < 12 + 16 + 1 || buf.toString("base64url") !== token) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", linkKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(-16));
    // final() checks the tag first, so only authentic data is ever inflated.
    const plain = Buffer.concat([decipher.update(buf.subarray(12, -16)), decipher.final()]);
    const data = JSON.parse(zlib.inflateRawSync(plain));
    return data.v === 1 && data.kind === kind && Date.now() < data.exp ? data : null;
  } catch {
    return null;
  }
}

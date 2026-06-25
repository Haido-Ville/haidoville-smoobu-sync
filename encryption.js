import crypto from "crypto";

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

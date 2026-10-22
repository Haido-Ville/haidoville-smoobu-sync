// ============================================================
// Promo banner feed (spec: reports/haido-feature.md)
// ============================================================
// Env: HAIDO_PROMO_FEED = promo JSON or https webhook URL; HAIDO_PROMO_FEED_KEY = X-Promo-Key header.

const TTL_MS = 3 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 20_000;
const MAX_PROMOS = 3;
const MAX_LEN = { headline: 120, subline: 200, cta_text: 40, cta_url: 500, ends_on: 10 };
// https links, same-site paths and #anchors. Blocks javascript:, data:, http: and //other-host.
const SAFE_URL = /^(https:\/\/[^\s"'<>]+|\/(?!\/)[^\s"'<>]*|#[^\s"'<>]*)$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s) => DATE_REGEX.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const manilaDay = (now) => new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD

let cache = [];          // last good promos from the feed
let fetchedAt = -TTL_MS; // so the first request fetches
let inFlight = null;     // one shared feed call, however many visitors arrive at once
let inline = null;       // parsed HAIDO_PROMO_FEED JSON

// Keeps only the known string fields of valid promos. null = not a promo feed at all.
export function cleanPromos(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.promos)) return null;
  return data.promos.slice(0, MAX_PROMOS).flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const out = {};
    for (const [field, max] of Object.entries(MAX_LEN)) {
      const v = typeof p[field] === "string" ? p[field].trim() : "";
      if (v.length > max) return reject(`${field} longer than ${max}`);
      out[field] = v;
    }
    if (!out.headline) return reject("no headline");
    if (out.cta_url && !SAFE_URL.test(out.cta_url)) return reject("unsafe cta_url");
    if (out.ends_on && !isRealDate(out.ends_on)) return reject("ends_on is not YYYY-MM-DD");
    return [out];
  });
}

function reject(why) {
  console.warn(`[Promo] Promo skipped: ${why}.`);
  return [];
}

async function fetchFeed(url) {
  const headers = { Accept: "application/json" };
  if (process.env.HAIDO_PROMO_FEED_KEY) headers["X-Promo-Key"] = process.env.HAIDO_PROMO_FEED_KEY;
  const r = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`response over ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  const promos = cleanPromos(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!promos) throw new Error('no "promos" array');
  return promos;
}

// Promos to show now. Never throws: on any feed problem it serves the last good cache.
export async function getPromos(now = Date.now()) {
  const source = (process.env.HAIDO_PROMO_FEED || "").trim();
  let promos = [];
  if (source.startsWith("{")) {
    if (!inline) {
      try { inline = cleanPromos(JSON.parse(source)) || []; }
      catch { inline = []; console.warn("[Promo] HAIDO_PROMO_FEED is not valid JSON."); }
    }
    promos = inline;
  } else if (source.startsWith("https://")) {
    // The clock starts before the call, so a failing feed is also retried only every 3 hours.
    if (now - fetchedAt >= TTL_MS) {
      fetchedAt = now;
      inFlight = fetchFeed(source)
        .then((fresh) => { cache = fresh; console.log(`[Promo] Feed called: ${fresh.length} promo(s).`); })
        .catch((err) => console.warn(`[Promo] Feed failed, serving the last cache: ${err.message}`))
        .finally(() => { inFlight = null; });
    }
    if (inFlight) await inFlight;
    promos = cache;
  }
  const today = manilaDay(now);
  return promos.filter((p) => !p.ends_on || p.ends_on >= today); // ends_on is the last day shown
}

export const promoFeedMode = () => {
  const source = (process.env.HAIDO_PROMO_FEED || "").trim();
  return source.startsWith("{") ? "JSON" : source.startsWith("https://") ? "webhook" : "";
};

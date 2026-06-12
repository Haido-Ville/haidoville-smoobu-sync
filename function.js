// ============================================================
// REPLACEMENT FOR hvLoadBooked() FUNCTION
// ============================================================
// Hanapin mo sa existing code mo yung function na ito:
//
//   async function hvLoadBooked() {
//     bookedRanges = [];
//     bunkBookings = [];
//     pendingRanges = [];
//     familyBookedUnits = [];
//     return [];
//   }
//
// Palitan mo ng EXACT NA ETO SA BABA.
// Wala nang ibang mababago sa buong code mo.
// Yung Step 1–4 flow, cart system, Holy Week logic — lahat nanatili.
// ============================================================

// ⚠️ PALITAN MO ITO NG ACTUAL RENDER URL MO AFTER DEPLOY
// Example: 'https://haidoville-smoobu-sync.onrender.com/availability'
const SMOOBU_PROXY_URL = 'https://haidoville-smoobu-sync.onrender.com/availability';

const BROWSER_DECRYPT_KEY = 'TtmULtv+9xsmhC2j5UNfFSCIFAE4PHDW';

// ============================================================
// GLOBAL SESSION HINT SINGLETON
// Only ONE hint is ever fetched, shared across ALL GHL scripts
// via window._hvSessionHintPromise. This prevents race conditions
// where multiple scripts fetch different hints.
// ============================================================
if (!window._hvSessionHintPromise) {
  window._hvSessionHintPromise = (async function() {
    const hintUrl = SMOOBU_PROXY_URL.replace(/\/availability$/, '/api/session-hint');
    const res = await fetch(hintUrl);
    if (!res.ok) throw new Error('Could not get session hint (' + res.status + ').');
    const data = await res.json();
    if (!data.hint) throw new Error('Server did not return a session hint.');
    return data.hint;
  })();
}

async function hvGetSessionHint() {
  return window._hvSessionHintPromise;
}

async function hvDeriveSessionKey(hint) {
  const rawHint    = hint.split('.')[0];
  const passphrase = rawHint + ':' + BROWSER_DECRYPT_KEY;
  const enc        = new TextEncoder();
  const salt       = enc.encode('HaidoVille::AES256GCM::v1::salt::9f3a7c2e');

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: 200000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

async function hvDecrypt(encryptedData) {
  const hint       = await hvGetSessionHint();
  const sessionKey = await hvDeriveSessionKey(hint);

  const iv         = hexToBuffer(encryptedData.iv);
  const tag        = hexToBuffer(encryptedData.tag);
  const ciphertext = hexToBuffer(encryptedData.payload);

  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  combined.set(new Uint8Array(ciphertext), 0);
  combined.set(new Uint8Array(tag), ciphertext.byteLength);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: 128 },
    sessionKey,
    combined
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

async function hvFetchWithHint(url, options) {
  const hint    = await hvGetSessionHint();
  const opts    = options ? Object.assign({}, options) : {};
  opts.headers = Object.assign({}, opts.headers || {}, {
    'X-Session-Hint': hint
  });
  const response = await fetch(url, opts);
  if (response.status === 401) {
    alert("Session expired, reload the page");
    window.location.reload();
    throw new Error("Session expired");
  }
  return response;
}

async function hvLoadBooked() {
  // Reset arrays first
  bookedRanges = [];
  bunkBookings = [];
  pendingRanges = [];
  familyBookedUnits = [];

  try {
    // Timeout after 35 seconds (Render cold start can take ~30 sec sa free tier)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000);

    const response = await hvFetchWithHint(SMOOBU_PROXY_URL, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn('[HaidoVille] Smoobu sync failed, showing all dates as available');
      return [];
    }

    let data = await response.json();

    // Handle encrypted responses from backend v3.7+
    if (data._encrypted) {
      data = await hvDecrypt(data);
    }

    // Populate global arrays used by the calendar
    if (Array.isArray(data.bookedRanges)) {
      bookedRanges = data.bookedRanges.filter(r => !r._unmapped);
    }
    if (Array.isArray(data.bunkBookings)) {
      bunkBookings = data.bunkBookings;
    }
    if (Array.isArray(data.familyBookedUnits)) {
      familyBookedUnits = data.familyBookedUnits;
    }

    console.log('[HaidoVille] Smoobu sync OK:', {
      regularBookings: bookedRanges.length,
      bunkBookings: bunkBookings.length,
      familyBookings: familyBookedUnits.length,
      lastUpdate: data.updatedAt,
    });

    return data;

  } catch (err) {
    console.warn('[HaidoVille] Smoobu sync error:', err.message);
    // Fail silently — calendar uses empty arrays (safe default)
    return [];
  }
}



// ============================================================
// BONUS: KEEP-ALIVE PING (prevents Render cold start)
// ============================================================
// Render free tier nag-"sleep" after 15 mins ng walang traffic.
// Para hindi laging mabagal yung first load, tawagin natin yung
// server pag bukas ng website. Background lang, hindi makakaapekto.
// ============================================================

(function hvKeepAlive() {
  const HEALTH_URL = 'https://haidoville-smoobu-sync.onrender.com/ping';

  // Ping once immediately (so yung server magising kaagad)
  fetch(HEALTH_URL, { method: 'GET', mode: 'no-cors' }).catch(() => {});

  // Ping every 10 minutes para hindi matulog (kung active yung tab)
  setInterval(() => {
    fetch(HEALTH_URL, { method: 'GET', mode: 'no-cors' }).catch(() => {});
  }, 10 * 60 * 1000);
})();


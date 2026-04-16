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
// Example: 'https://haidoville-smoobu-sync.onrender.com/bookings'
const SMOOBU_PROXY_URL = 'https://YOUR-APP-NAME.onrender.com/bookings';

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

    const response = await fetch(SMOOBU_PROXY_URL, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn('[HaidoVille] Smoobu sync failed, showing all dates as available');
      return [];
    }

    const data = await response.json();

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
  // Same URL as above but without /bookings (yung root na health check)
  const HEALTH_URL = SMOOBU_PROXY_URL.replace(/\/bookings$/, '/');

  // Ping once immediately (so yung server magising kaagad)
  fetch(HEALTH_URL, { method: 'GET', mode: 'no-cors' }).catch(() => {});

  // Ping every 10 minutes para hindi matulog (kung active yung tab)
  setInterval(() => {
    fetch(HEALTH_URL, { method: 'GET', mode: 'no-cors' }).catch(() => {});
  }, 10 * 60 * 1000);
})();

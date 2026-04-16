
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes


const APARTMENT_MAP = {
  // BUNK BEDS (6 separate listings, 1 bed each)
  3261752: { roomId: 'bunk', beds: 1 }, // Bed1
  3261757: { roomId: 'bunk', beds: 1 }, // Bed2
  3261762: { roomId: 'bunk', beds: 1 }, // Bed3
  3261767: { roomId: 'bunk', beds: 1 }, // Bed4
  3261772: { roomId: 'bunk', beds: 1 }, // Bed5
  3261777: { roomId: 'bunk', beds: 1 }, // Bed6

  // BARKADA ROOM
  3261782: 'barkada',

  // COUPLE ROOM
  3261742: 'couple',

  // FAMILY ROOMS (2 units)
  3261662: { roomId: 'family', unit: 'Family Room 1' },
  3261737: { roomId: 'family', unit: 'Family Room 2' },
};
// ---- Simple in-memory cache ----
let cache = {
  data: null,
  timestamp: 0,
};

// ---- CORS middleware ----
app.use((req, res, next) => {
  const origin = req.headers.origin || '';

  const allowedOrigins = [
    'https://haidoville.com',
    'https://www.haidoville.com',
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// ---- Root endpoint (health check) ----
app.get('/', (req, res) => {
  res.json({
    service: 'HaidoVille Smoobu Sync',
    status: 'online',
    endpoints: {
      bookings: '/bookings',
      apartments: '/apartments-list',
    },
    timestamp: new Date().toISOString(),
  });
});

// ---- Apartments list endpoint (helper to find apartment IDs) ----
app.get('/apartments-list', async (req, res) => {
  if (!SMOOBU_API_KEY) {
    return res.status(500).json({ error: 'SMOOBU_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://login.smoobu.com/api/apartments', {
      headers: {
        'Api-Key': SMOOBU_API_KEY,
        'Cache-Control': 'no-cache',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    const apartments = data.apartments || [];

    const sampleMapping = {};
    apartments.forEach(apt => {
      sampleMapping[apt.id] = `'${apt.name}' // palitan ng: 'bunk' / 'barkada' / 'couple' / { roomId: 'family', unit: 'Family Room 1' }`;
    });

    res.json({
      instructions: 'Kopyahin yung IDs at gamitin sa APARTMENT_MAP sa server.js',
      totalApartments: apartments.length,
      apartments,
      sampleMapping,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Main bookings endpoint ----
app.get('/bookings', async (req, res) => {
  if (!SMOOBU_API_KEY) {
    return res.status(500).json({ error: 'SMOOBU_API_KEY not configured' });
  }

  // Cache check
  const nocache = req.query.nocache === '1';
  const now = Date.now();
  if (!nocache && cache.data && (now - cache.timestamp) < CACHE_DURATION_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age', Math.floor((now - cache.timestamp) / 1000));
    return res.json(cache.data);
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const oneYearLater = new Date();
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    const toDate = oneYearLater.toISOString().slice(0, 10);

    const fromDate = req.query.from || today;
    const endDate = req.query.to || toDate;

    // Fetch all bookings (paginated)
    const allBookings = [];
    let page = 1;
    let totalPages = 1;
    const maxPages = 20;

    do {
      const url = new URL('https://login.smoobu.com/api/reservations');
      url.searchParams.set('from', fromDate);
      url.searchParams.set('to', endDate);
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('page', page);
      url.searchParams.set('excludeBlocked', 'false');

      const smoobuRes = await fetch(url.toString(), {
        headers: {
          'Api-Key': SMOOBU_API_KEY,
          'Cache-Control': 'no-cache',
        },
      });

      if (!smoobuRes.ok) {
        const errText = await smoobuRes.text();
        return res.status(smoobuRes.status).json({
          error: 'Smoobu API error',
          status: smoobuRes.status,
          detail: errText,
        });
      }

      const data = await smoobuRes.json();
      if (data.bookings && data.bookings.length) {
        allBookings.push(...data.bookings);
      }
      totalPages = data.page_count || 1;
      page++;
    } while (page <= totalPages && page <= maxPages);

    // Transform to HaidoVille format
    const result = {
      bookedRanges: [],
      bunkBookings: [],
      familyBookedUnits: [],
      updatedAt: new Date().toISOString(),
      totalBookings: allBookings.length,
    };

    for (const booking of allBookings) {
      if (booking.type === 'cancellation') continue;

      const apartmentId = booking.apartment?.id;
      const apartmentName = booking.apartment?.name || '';
      const arrival = booking.arrival;
      const departure = booking.departure;
      const guestName = booking['guest-name'] || booking.guest_name || 'Guest';
      const channelName = booking.channel?.name || 'Direct';

      if (!apartmentId || !arrival || !departure) continue;

      const mapping = APARTMENT_MAP[apartmentId];

      if (!mapping) {
        result.bookedRanges.push({
          _unmapped: true,
          apartmentId,
          apartmentName,
          ci: arrival,
          co: departure,
        });
        continue;
      }

      const range = {
        ci: arrival,
        co: departure,
        guest: guestName,
        channel: channelName,
      };

      if (typeof mapping === 'string') {
        if (mapping === 'bunk') {
          result.bunkBookings.push({ ...range, beds: 1 });
        } else {
          result.bookedRanges.push({ ...range, room: mapping });
        }
      } else if (typeof mapping === 'object') {
        if (mapping.roomId === 'bunk') {
          result.bunkBookings.push({ ...range, beds: mapping.beds || 1 });
        } else if (mapping.roomId === 'family') {
          result.familyBookedUnits.push({ ...range, unit: mapping.unit });
        } else {
          result.bookedRanges.push({ ...range, room: mapping.roomId });
        }
      }
    }

    // Update cache
    cache = { data: result, timestamp: now };
    res.setHeader('X-Cache', 'MISS');
    res.json(result);

  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`🚀 HaidoVille Smoobu Sync running on port ${PORT}`);
  console.log(`   API Key configured: ${SMOOBU_API_KEY ? '✅ Yes' : '❌ No — set SMOOBU_API_KEY env var'}`);
});

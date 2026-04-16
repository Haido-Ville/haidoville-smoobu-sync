// ============================================================
// HAIDOVILLE × SMOOBU SYNC — Render.com Server v2
// ============================================================
// v2 UPDATES:
// - Added POST /bookings/create endpoint
// - Added email notification (via Resend)
// - Added optional Smoobu draft booking creation
// - Keeps all existing sync functionality
// ============================================================

import express from 'express';
import { Resend } from 'resend';

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config from environment variables ----
const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;              // OPTIONAL
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';              // where to send notifs
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev'; // default to Resend's test domain
const CACHE_DURATION_MS = 5 * 60 * 1000;
const CREATE_SMOOBU_DRAFT = process.env.CREATE_SMOOBU_DRAFT === 'true'; // off by default

// ---- Apartment Mapping ----
const APARTMENT_MAP = {
  // ─── BARKADA ROOM ───
  3261782: 'barkada',

  // ─── COUPLE ROOM ───
  3261742: 'couple',

  // ─── FAMILY ROOMS ───
  3261662: { roomId: 'family', unit: 'Family Room 1' },
  3261737: { roomId: 'family', unit: 'Family Room 2' },

  // ─── MIXED DORMITORY / BUNK BEDS ───
  3261752: { roomId: 'bunk', beds: 1 },
  3261757: { roomId: 'bunk', beds: 1 },
  3261762: { roomId: 'bunk', beds: 1 },
  3261767: { roomId: 'bunk', beds: 1 },
  3261772: { roomId: 'bunk', beds: 1 },
  3261777: { roomId: 'bunk', beds: 1 },
};

// Reverse map (roomName -> apartmentId) — gagamitin natin sa draft booking creation
const ROOM_NAME_TO_APT_ID = {
  'Barkada Room': 3261782,
  'Couple Room': 3261742,
  'Family Room 1': 3261662,
  'Family Room 2': 3261737,
  'Bunk Beds': [3261752, 3261757, 3261762, 3261767, 3261772, 3261777], // array kasi may 6
};

// ---- In-memory cache & pending bookings ----
let cache = { data: null, timestamp: 0 };
const pendingBookings = []; // para sa soft-block

// ---- Middleware ----
app.use(express.json({ limit: '1mb' }));

// ---- CORS ----
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://haidoville.com',
    'https://www.haidoville.com',
    // Add your GoHighLevel funnel domain here
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    service: 'HaidoVille Smoobu Sync',
    version: '2.0',
    status: 'online',
    endpoints: {
      bookings: 'GET /bookings',
      apartments: 'GET /apartments-list',
      createBooking: 'POST /bookings/create',
    },
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// GET /apartments-list (existing)
// ============================================================
app.get('/apartments-list', async (req, res) => {
  if (!SMOOBU_API_KEY) return res.status(500).json({ error: 'SMOOBU_API_KEY not configured' });
  try {
    const response = await fetch('https://login.smoobu.com/api/apartments', {
      headers: { 'Api-Key': SMOOBU_API_KEY, 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    const data = await response.json();
    const apartments = data.apartments || [];
    const sampleMapping = {};
    apartments.forEach(apt => {
      sampleMapping[apt.id] = `'${apt.name}'`;
    });
    res.json({
      instructions: 'Copy IDs at gamitin sa APARTMENT_MAP',
      totalApartments: apartments.length,
      apartments,
      sampleMapping,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /bookings (existing sync endpoint)
// ============================================================
app.get('/bookings', async (req, res) => {
  if (!SMOOBU_API_KEY) return res.status(500).json({ error: 'SMOOBU_API_KEY not configured' });

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
        headers: { 'Api-Key': SMOOBU_API_KEY, 'Cache-Control': 'no-cache' },
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
      if (data.bookings && data.bookings.length) allBookings.push(...data.bookings);
      totalPages = data.page_count || 1;
      page++;
    } while (page <= totalPages && page <= maxPages);

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
          apartmentId, apartmentName, ci: arrival, co: departure,
        });
        continue;
      }

      const range = { ci: arrival, co: departure, guest: guestName, channel: channelName };
      if (typeof mapping === 'string') {
        if (mapping === 'bunk') result.bunkBookings.push({ ...range, beds: 1 });
        else result.bookedRanges.push({ ...range, room: mapping });
      } else if (typeof mapping === 'object') {
        if (mapping.roomId === 'bunk') result.bunkBookings.push({ ...range, beds: mapping.beds || 1 });
        else if (mapping.roomId === 'family') result.familyBookedUnits.push({ ...range, unit: mapping.unit });
        else result.bookedRanges.push({ ...range, room: mapping.roomId });
      }
    }

    cache = { data: result, timestamp: now };
    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// ============================================================
// POST /bookings/create (NEW — eto yung custom checkout)
// ============================================================
app.post('/bookings/create', async (req, res) => {
  try {
    const data = req.body;

    if (!data || !data.bookingId || !data.guest || !data.rooms || !data.payment) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Log booking in-memory (ephemeral pero good for debugging)
    pendingBookings.push({
      ...data,
      receivedAt: new Date().toISOString(),
    });

    // Prune old pending bookings (> 7 days)
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    while (pendingBookings.length > 0 && new Date(pendingBookings[0].receivedAt).getTime() < weekAgo) {
      pendingBookings.shift();
    }

    // Console log for Render logs (visible sa dashboard)
    console.log('[Booking Received]', data.bookingId, '-', data.guest.name, '(', data.guest.email, ')');

    // ─── Send email notification ───
    if (RESEND_API_KEY && ADMIN_EMAIL) {
      sendBookingEmail(data).catch(err => {
        console.error('[Email Error]', err.message);
      });
    }

    // ─── Optional: Create draft booking sa Smoobu ───
    if (CREATE_SMOOBU_DRAFT && SMOOBU_API_KEY) {
      createSmoobuDraft(data).catch(err => {
        console.error('[Smoobu Draft Error]', err.message);
      });
    }

    res.json({
      success: true,
      bookingId: data.bookingId,
      message: 'Booking logged successfully. Please send receipt via Messenger.',
    });

  } catch (err) {
    console.error('[Booking Create Error]', err);
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// ============================================================
// HELPER: Send email notification via Resend
// ============================================================
async function sendBookingEmail(data) {
  if (!RESEND_API_KEY) return;

  const resend = new Resend(RESEND_API_KEY);
  const channelNames = { gcash: 'GCash', maya: 'Maya', metro: 'Metrobank', land: 'Landbank' };
  const payTypeNames = { full: 'Full Payment', dp: 'Downpayment (50%)' };

  const roomsHtml = data.rooms.map((r, i) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;">
        <strong>Room ${i + 1}: ${r.name}</strong><br>
        <small style="color:#666;">${r.checkIn} → ${r.checkOut} (${r.nights} nights)</small><br>
        <small style="color:#666;">${r.pax} ${r.paxLabel} • ₱${r.subtotal.toLocaleString()}</small>
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
      <div style="background:linear-gradient(135deg,#C9A96E 0%,#b8935a 100%);color:#fff;padding:20px;border-radius:12px 12px 0 0;">
        <h2 style="margin:0;font-size:22px;">🏠 New HaidoVille Booking</h2>
        <p style="margin:6px 0 0;opacity:0.9;">Reference: ${data.bookingId}</p>
      </div>

      <div style="background:#f9f9f9;padding:20px;border-radius:0 0 12px 12px;">
        <h3 style="margin-top:0;color:#C9A96E;">👤 Guest Details</h3>
        <p style="margin:4px 0;"><strong>Name:</strong> ${data.guest.name}</p>
        <p style="margin:4px 0;"><strong>Email:</strong> ${data.guest.email}</p>
        <p style="margin:4px 0;"><strong>Phone:</strong> ${data.guest.phone}</p>
        ${data.guest.nationality ? `<p style="margin:4px 0;"><strong>Nationality:</strong> ${data.guest.nationality}</p>` : ''}
        ${data.guest.address ? `<p style="margin:4px 0;"><strong>Address:</strong> ${data.guest.address}</p>` : ''}
        ${data.guest.arrivalTime ? `<p style="margin:4px 0;"><strong>Arrival Time:</strong> ${data.guest.arrivalTime}</p>` : ''}
        ${data.guest.port ? `<p style="margin:4px 0;"><strong>Port:</strong> ${data.guest.port}</p>` : ''}
        ${data.guest.specialRequest ? `<p style="margin:4px 0;"><strong>Special Request:</strong> ${data.guest.specialRequest}</p>` : ''}

        <h3 style="color:#C9A96E;margin-top:20px;">🛏️ Rooms</h3>
        <table style="width:100%;border-collapse:collapse;">${roomsHtml}</table>

        <h3 style="color:#C9A96E;margin-top:20px;">💰 Payment</h3>
        <p style="margin:4px 0;"><strong>Type:</strong> ${payTypeNames[data.payment.type]}</p>
        <p style="margin:4px 0;"><strong>Channel:</strong> ${channelNames[data.payment.channel]}</p>
        <p style="margin:4px 0;"><strong>Reference #:</strong> <code style="background:#fff;padding:3px 8px;border-radius:4px;">${data.payment.referenceNumber}</code></p>
        <p style="margin:4px 0;"><strong>Amount Paid:</strong> <span style="color:#C9A96E;font-size:18px;font-weight:bold;">₱${data.payment.amount.toLocaleString()}</span></p>
        <p style="margin:4px 0;"><strong>Grand Total:</strong> ₱${data.payment.grandTotal.toLocaleString()}</p>

        <div style="background:#fff;border-left:4px solid #C9A96E;padding:12px;margin-top:20px;border-radius:4px;">
          <strong>⏰ ACTION NEEDED:</strong><br>
          Wait for customer's receipt via Messenger (m.me/haidoville), then manually create booking in Smoobu if verified.
        </div>

        <p style="margin-top:20px;font-size:12px;color:#888;">
          Submitted: ${new Date(data.submittedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}
        </p>
      </div>
    </div>
  `;

  const text = `New HaidoVille Booking\n\nRef: ${data.bookingId}\nName: ${data.guest.name}\nEmail: ${data.guest.email}\nPhone: ${data.guest.phone}\n\nRooms:\n${data.rooms.map((r, i) => `${i + 1}. ${r.name} | ${r.checkIn} → ${r.checkOut} | ${r.pax} ${r.paxLabel} | ₱${r.subtotal.toLocaleString()}`).join('\n')}\n\nPayment:\n- ${payTypeNames[data.payment.type]} via ${channelNames[data.payment.channel]}\n- Amount: ₱${data.payment.amount.toLocaleString()}\n- Grand Total: ₱${data.payment.grandTotal.toLocaleString()}\n- Reference #: ${data.payment.referenceNumber}\n\nAction: Wait for customer's receipt via m.me/haidoville`;

  await resend.emails.send({
    from: `HaidoVille Booking <${FROM_EMAIL}>`,
    to: ADMIN_EMAIL,
    replyTo: data.guest.email,
    subject: `🏠 New Booking: ${data.bookingId} — ${data.guest.name}`,
    html,
    text,
  });

  console.log('[Email Sent]', ADMIN_EMAIL, '-', data.bookingId);
}

// ============================================================
// HELPER: Create draft booking sa Smoobu (OPTIONAL)
// ============================================================
async function createSmoobuDraft(data) {
  if (!CREATE_SMOOBU_DRAFT || !SMOOBU_API_KEY) return;

  for (const room of data.rooms) {
    const apartmentId = resolveApartmentId(room.name);
    if (!apartmentId) {
      console.warn('[Smoobu Draft] Unknown room:', room.name);
      continue;
    }

    const payload = {
      arrivalDate: room.checkIn,
      departureDate: room.checkOut,
      apartmentId: apartmentId,
      channelId: 70,  // Direct booking
      firstName: data.guest.name.split(' ')[0] || data.guest.name,
      lastName: data.guest.name.split(' ').slice(1).join(' ') || '(none)',
      email: data.guest.email,
      phone: data.guest.phone,
      adults: room.pax,
      price: room.subtotal,
      priceStatus: 0, // unpaid
      notice: `[WEBSITE ${data.bookingId}] Ref: ${data.payment.referenceNumber} | ${data.payment.channel.toUpperCase()} | Awaiting receipt verification`,
      language: 'en',
    };

    try {
      const response = await fetch('https://login.smoobu.com/api/reservations', {
        method: 'POST',
        headers: {
          'Api-Key': SMOOBU_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      if (response.ok) {
        console.log('[Smoobu Draft Created]', data.bookingId, '→ Smoobu ID:', result.id);
      } else {
        console.warn('[Smoobu Draft Failed]', JSON.stringify(result));
      }
    } catch (err) {
      console.error('[Smoobu Draft Network Error]', err.message);
    }
  }
}

function resolveApartmentId(roomName) {
  const mapping = ROOM_NAME_TO_APT_ID[roomName];
  if (!mapping) return null;
  if (Array.isArray(mapping)) {
    // Para sa Bunk Beds — pick first one as representative
    return mapping[0];
  }
  return mapping;
}

// ============================================================
// Start server
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 HaidoVille Smoobu Sync v2 running on port ${PORT}`);
  console.log(`   Smoobu API: ${SMOOBU_API_KEY ? '✅' : '❌ SMOOBU_API_KEY missing'}`);
  console.log(`   Resend:     ${RESEND_API_KEY ? '✅' : '⚠️  RESEND_API_KEY not set (email disabled)'}`);
  console.log(`   Admin email: ${ADMIN_EMAIL || '⚠️ not set'}`);
  console.log(`   Smoobu Drafts: ${CREATE_SMOOBU_DRAFT ? '✅ ON' : '❌ OFF (manual mode)'}`);
});
// ============================================================
// HAIDOVILLE × SMOOBU SYNC - Render.com Server v3.2
// ============================================================
// v3.2 UPDATES:
// - FIXED: Bunk Beds now auto-picks FREE apartment units (was always
//   trying Bunkbed 1, causing "reservation already exists" errors)
// - Multi-bed bunk bookings now create one draft per bed across
//   different free apartment units
//
// v3.1 (kept):
// - Added `source` field to GHL payload (for OTA analytics tracking)
//
// v3 FEATURES (kept):
// - Forwards booking to GHL webhook (with exact payload format)
// - Creates Smoobu draft booking (pending, unpaid) to auto-block dates
// - Email notification via Resend
// - Calendar sync via /bookings
// ============================================================

import express from 'express';
import { Resend } from 'resend';

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config ----
const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL || '';
const CACHE_DURATION_MS = 5 * 60 * 1000;
const CREATE_SMOOBU_DRAFT = process.env.CREATE_SMOOBU_DRAFT === 'true';

// ---- Apartment Mapping ----
const APARTMENT_MAP = {
  3261782: 'barkada',
  3261742: 'couple',
  3261662: { roomId: 'family', unit: 'Family Room 1' },
  3261737: { roomId: 'family', unit: 'Family Room 2' },
  3261752: { roomId: 'bunk', beds: 1 },
  3261757: { roomId: 'bunk', beds: 1 },
  3261762: { roomId: 'bunk', beds: 1 },
  3261767: { roomId: 'bunk', beds: 1 },
  3261772: { roomId: 'bunk', beds: 1 },
  3261777: { roomId: 'bunk', beds: 1 },
};

// For creating drafts: map room name to Smoobu apartment ID
const ROOM_NAME_TO_APT_ID = {
  'Barkada Room': 3261782,
  'Couple Room': 3261742,
  'Family Room 1': 3261662,
  'Family Room 2': 3261737,
  'Bunk Beds': [3261752, 3261757, 3261762, 3261767, 3261772, 3261777],
};

// All bunk apartment IDs (extracted for easy reference)
const BUNK_APARTMENT_IDS = ROOM_NAME_TO_APT_ID['Bunk Beds'];

// ---- Cache ----
let cache = { data: null, timestamp: 0 };
const pendingBookings = [];

// ---- Middleware ----
app.use(express.json({ limit: '1mb' }));

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
    version: '3.2',
    status: 'online',
    features: {
      smoobuSync: !!SMOOBU_API_KEY,
      email: !!RESEND_API_KEY && !!ADMIN_EMAIL,
      ghlWebhook: !!GHL_WEBHOOK_URL,
      smoobuDraft: CREATE_SMOOBU_DRAFT && !!SMOOBU_API_KEY
    },
    endpoints: {
      bookings: 'GET /bookings',
      apartments: 'GET /apartments-list',
      createBooking: 'POST /bookings/create'
    },
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// GET /apartments-list
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
    apartments.forEach(apt => { sampleMapping[apt.id] = `'${apt.name}'`; });
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
// GET /bookings (calendar sync)
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
// POST /bookings/create (MAIN CHECKOUT ENDPOINT)
// ============================================================
app.post('/bookings/create', async (req, res) => {
  try {
    const data = req.body;

    if (!data || !data.bookingId || !data.guest || !data.rooms || !data.payment) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Default source to "Website (Direct)" if client didn't send one
    if (!data.source) {
      data.source = 'Website (Direct)';
    }

    pendingBookings.push({
      ...data,
      receivedAt: new Date().toISOString(),
    });

    // Prune old pending bookings (> 7 days)
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    while (pendingBookings.length > 0 && new Date(pendingBookings[0].receivedAt).getTime() < weekAgo) {
      pendingBookings.shift();
    }

    console.log('[Booking Received]', data.bookingId, '-', data.guest.name, '(', data.guest.email, ') source:', data.source);

    // Forward to GHL webhook (non-blocking, runs in parallel)
    if (GHL_WEBHOOK_URL) {
      forwardToGHL(data).catch(err => {
        console.error('[GHL Webhook Error]', err.message);
      });
    }

    // Send admin email (non-blocking)
    if (RESEND_API_KEY && ADMIN_EMAIL) {
      sendBookingEmail(data).catch(err => {
        console.error('[Email Error]', err.message);
      });
    }

    // Create Smoobu draft booking to block dates (non-blocking)
    if (CREATE_SMOOBU_DRAFT && SMOOBU_API_KEY) {
      createSmoobuDraft(data).then(() => {
        cache = { data: null, timestamp: 0 };
      }).catch(err => {
        console.error('[Smoobu Draft Error]', err.message);
      });
    }

    res.json({
      success: true,
      bookingId: data.bookingId,
      message: 'Booking logged. Please send receipt via Messenger.',
    });

  } catch (err) {
    console.error('[Booking Create Error]', err);
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// ============================================================
// HELPER: Forward to GHL Webhook
// ============================================================
async function forwardToGHL(data) {
  if (!GHL_WEBHOOK_URL) return;

  const payload = buildGhlPayload(data);

  const response = await fetch(GHL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GHL webhook failed (${response.status}): ${errText}`);
  }

  console.log('[GHL Webhook Sent]', data.bookingId, 'source:', payload.source);
}

function buildGhlPayload(data) {
  const nameParts = (data.guest.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const channelLabels = {
    gcash: 'GCash/PayMaya',
    maya: 'GCash/PayMaya',
    metro: 'Metrobank',
    land: 'Landbank',
    cash: 'Cash on Arrival (Walk-in)'
  };
  const paymentMethod = channelLabels[data.payment.channel] || data.payment.channel;

  const firstRoom = data.rooms[0] || {};

  const fmtShortDate = (d) => {
    if (!d) return '';
    try {
      return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
    } catch(e) { return d; }
  };

  const confirmationDate = new Date(data.submittedAt || new Date()).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila'
  });

  const fmtTime12 = (t) => {
    if (!t) return '';
    const parts = t.split(':');
    let h = parseInt(parts[0]);
    const m = parts[1];
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m + ' ' + ampm;
  };

  const grandTotal = data.payment.grandTotal || 0;
  const dpAmount = data.payment.type === 'full' ? grandTotal : Math.ceil(grandTotal * 0.5);
  const balance = data.payment.type === 'full' ? 0 : grandTotal - dpAmount;

  let roomType = firstRoom.name || '';
  if (data.rooms.length > 1) {
    roomType = data.rooms.map(r => r.name).join(' + ');
  }

  const totalPax = data.rooms.reduce((sum, r) => sum + (parseInt(r.pax) || 0), 0);
  const totalNights = firstRoom.nights || 0;

  return {
    source: data.source || 'Website (Direct)',
    email: data.guest.email || '',
    phone: data.guest.phone || '',
    first_name: firstName,
    last_name: lastName,
    name: data.guest.name || '',
    booking_id: data.bookingId,
    confirmation_date: confirmationDate,
    guest_name: data.guest.name || '',
    contact_number: data.guest.phone || '',
    email_address: data.guest.email || '',
    age: String(data.guest.age || ''),
    nationality: data.guest.nationality || '',
    complete_address: data.guest.address || '',
    room_type: roomType,
    check_in_date: fmtShortDate(firstRoom.checkIn),
    check_out_date: fmtShortDate(firstRoom.checkOut),
    arrival_time: fmtTime12(data.guest.arrivalTime),
    departure_time: fmtTime12(data.guest.departureTime),
    port_of_arrival: data.guest.port || '',
    no_of_nights: String(totalNights),
    no_of_guests: String(totalPax),
    payment_method: paymentMethod,
    payment_ref: data.payment.referenceNumber || '',
    total_amount: String(grandTotal),
    dp_amount: String(dpAmount),
    balance: String(balance),
    payment_type: data.payment.type === 'full' ? 'Full Payment' : 'Downpayment (50%)',
    special_request: data.guest.specialRequest || '',
    room_count: String(data.rooms.length),
    all_rooms: data.rooms.map(r => ({
      name: r.name,
      check_in: fmtShortDate(r.checkIn),
      check_out: fmtShortDate(r.checkOut),
      nights: String(r.nights),
      pax: String(r.pax),
      subtotal: String(r.subtotal)
    }))
  };
}

// ============================================================
// 🆕 NEW HELPER: Find available Bunk apartments for a date range
// ============================================================
// Queries Smoobu for existing bookings in the requested range and
// returns a list of bunk apartment IDs that are FREE.
async function findAvailableBunkApartments(checkIn, checkOut) {
  if (!SMOOBU_API_KEY) return [];

  try {
    const url = new URL('https://login.smoobu.com/api/reservations');
    url.searchParams.set('from', checkIn);
    url.searchParams.set('to', checkOut);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('excludeBlocked', 'false');

    const response = await fetch(url.toString(), {
      headers: { 'Api-Key': SMOOBU_API_KEY, 'Cache-Control': 'no-cache' },
    });

    if (!response.ok) {
      console.warn('[Bunk Picker] Smoobu fetch failed, returning all bunk apts as fallback');
      return [...BUNK_APARTMENT_IDS];
    }

    const data = await response.json();
    const bookings = data.bookings || [];

    // Find bunk apartment IDs that have a conflicting booking
    const bookedIds = new Set();
    for (const b of bookings) {
      if (b.type === 'cancellation') continue;
      const aptId = b.apartment?.id;
      if (!BUNK_APARTMENT_IDS.includes(aptId)) continue;

      // Standard overlap check: [b.arrival, b.departure) ∩ [checkIn, checkOut)
      if (b.arrival && b.departure
          && b.arrival < checkOut
          && b.departure > checkIn) {
        bookedIds.add(aptId);
      }
    }

    const freeIds = BUNK_APARTMENT_IDS.filter(id => !bookedIds.has(id));

    console.log('[Bunk Picker]', checkIn, '→', checkOut,
                '| booked:', bookedIds.size,
                '| free:', freeIds.length,
                '| free IDs:', freeIds);

    return freeIds;
  } catch (err) {
    console.error('[Bunk Picker] Error:', err.message);
    // Safe fallback: return all bunk IDs (Smoobu will reject duplicates anyway)
    return [...BUNK_APARTMENT_IDS];
  }
}

// ============================================================
// HELPER: Create Smoobu Draft Booking (auto-block dates)
// ============================================================
// 🆕 v3.2: For Bunk Beds, now creates one draft per bed across DIFFERENT
//          free apartment units (was always trying Bunkbed 1 → caused
//          "reservation already exists" errors).
async function createSmoobuDraft(data) {
  if (!CREATE_SMOOBU_DRAFT || !SMOOBU_API_KEY) return;

  for (const room of data.rooms) {
    const isBunk = room.name === 'Bunk Beds';
    const bedsNeeded = parseInt(room.pax) || 1;

    // ── Determine which apartment IDs to book ──
    let apartmentIds = [];

    if (isBunk) {
      const freeApts = await findAvailableBunkApartments(room.checkIn, room.checkOut);

      if (freeApts.length < bedsNeeded) {
        console.warn(
          '[Smoobu Draft] Not enough free bunk apartments.',
          'Requested:', bedsNeeded,
          'Free:', freeApts.length,
          'BookingId:', data.bookingId
        );

        // Still try to book what's available so dates get partially blocked
        if (freeApts.length === 0) {
          console.warn('[Smoobu Draft] Skipping — no free bunk apartments at all.');
          continue;
        }
      }

      apartmentIds = freeApts.slice(0, bedsNeeded);
    } else {
      const aptId = resolveApartmentId(room.name);
      if (!aptId) {
        console.warn('[Smoobu Draft] Unknown room:', room.name);
        continue;
      }
      apartmentIds = [aptId];
    }

    // ── Split name ──
    const nameParts = (data.guest.name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || 'Guest';
    const lastName = nameParts.slice(1).join(' ') || '(Pending)';

    // ── Compute per-unit price/adults ──
    // For bunk: split price evenly per bed (1 adult per bed).
    // For others: full price + full pax.
    const unitsToCreate = apartmentIds.length;
    const isMulti = unitsToCreate > 1;
    const pricePerUnit = isBunk
      ? Math.round((room.subtotal || 0) / Math.max(1, bedsNeeded))
      : (room.subtotal || 0);
    const adultsPerUnit = isBunk ? 1 : (parseInt(room.pax) || 1);

    // ── Create one Smoobu draft per apartment ──
    for (let i = 0; i < apartmentIds.length; i++) {
      const apartmentId = apartmentIds[i];
      const bedSuffix = isBunk && isMulti
        ? ` (Bed ${i + 1}/${unitsToCreate})`
        : '';

      const payload = {
        arrivalDate: room.checkIn,
        departureDate: room.checkOut,
        apartmentId: apartmentId,
        channelId: 70, // Direct booking
        firstName: firstName,
        lastName: lastName + bedSuffix,
        email: data.guest.email,
        phone: data.guest.phone,
        adults: adultsPerUnit,
        price: pricePerUnit,
        priceStatus: 0, // unpaid
        notice: `[WEBSITE ${data.bookingId}] ${data.payment.type.toUpperCase()} | ${data.payment.channel.toUpperCase()} | Ref: ${data.payment.referenceNumber} | ${data.payment.channel === 'cash' ? 'WALK-IN — CASH ON ARRIVAL' : 'AWAITING RECEIPT VERIFICATION'}${bedSuffix ? ' | ' + bedSuffix.trim() : ''}`,        language: 'en',
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
          console.log(
            '[Smoobu Draft Created]',
            data.bookingId,
            'room:', room.name + bedSuffix,
            'aptId:', apartmentId,
            'smoobuId:', result.id
          );
        } else {
          console.warn(
            '[Smoobu Draft Failed]',
            'aptId:', apartmentId,
            'room:', room.name + bedSuffix,
            JSON.stringify(result)
          );
        }
      } catch (err) {
        console.error('[Smoobu Draft Network Error]', err.message);
      }
    }
  }
}

// ── Kept as-is for non-bunk rooms (Barkada/Couple/Family Room 1 & 2) ──
function resolveApartmentId(roomName) {
  const mapping = ROOM_NAME_TO_APT_ID[roomName];
  if (!mapping) return null;
  if (Array.isArray(mapping)) return mapping[0];
  return mapping;
}

// ============================================================
// HELPER: Send Email Notification
// ============================================================
async function sendBookingEmail(data) {
  if (!RESEND_API_KEY) return;

  const resend = new Resend(RESEND_API_KEY);
  const channelNames = { gcash: 'GCash', maya: 'Maya', metro: 'Metrobank', land: 'Landbank', cash: 'Cash on Arrival (Walk-in)' };
  const payTypeNames = { full: 'Full Payment', dp: 'Downpayment (50%)' };
  const isCash = data.payment.channel === 'cash';
  const actionNeededHtml = isCash
    ? `<strong>⏰ ACTION NEEDED (WALK-IN/CASH):</strong><br>The guest will pay in cash upon arrival. Please confirm the room is ready and reach out via Messenger if you need to clarify the arrival time. <strong>No payment receipt to verify.</strong>`
    : `<strong>⏰ ACTION NEEDED:</strong><br>Wait for customer's receipt via Messenger (m.me/haidoville), then verify payment and update Smoobu booking status to paid.`;

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
        <p style="margin:4px 0 0;opacity:0.8;font-size:13px;">Source: ${data.source || 'Website (Direct)'}</p>
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
          ${actionNeededHtml}
        </div>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: `HaidoVille Booking <${FROM_EMAIL}>`,
    to: ADMIN_EMAIL,
    replyTo: data.guest.email,
    ssubject: `🏠 New Booking: ${data.bookingId} — ${data.guest.name}${isCash ? ' [WALK-IN/CASH]' : ''}`,
    html,
  });

  console.log('[Email Sent]', ADMIN_EMAIL, '-', data.bookingId);
}

// ============================================================
// Start server
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 HaidoVille Smoobu Sync v3.2 running on port ${PORT}`);
  console.log(`   Smoobu API:    ${SMOOBU_API_KEY ? '✅' : '❌'}`);
  console.log(`   Email:         ${RESEND_API_KEY && ADMIN_EMAIL ? '✅' : '⚠️  disabled'}`);
  console.log(`   GHL Webhook:   ${GHL_WEBHOOK_URL ? '✅' : '⚠️  not configured'}`);
  console.log(`   Smoobu Drafts: ${CREATE_SMOOBU_DRAFT ? '✅ ON' : '❌ OFF'}`);
});
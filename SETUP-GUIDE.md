# 🏠 HAIDOVILLE × SMOOBU SYNC — RENDER SETUP GUIDE

**Walang babaguhin sa 4-step flow mo.** Magsi-sync lang yung calendar sa Smoobu bookings (Airbnb, Booking.com, Agoda, Direct) gamit ang **Render.com** as backend proxy.

---

## 🎯 ARCHITECTURE

```
Airbnb ───┐
Booking ──┼──► Smoobu ──► Render Proxy ──► GoHighLevel Website
Agoda ────┤     (API)     (API Key hidden)    (hvLoadBooked)
Direct ───┘
```

---

## 📋 REQUIREMENTS

- ✅ Render.com account (libre, walang credit card needed)
- ✅ Smoobu account with API key access
- ✅ GitHub account (for easy deploy) — **libre din**

---

## 🚀 STEP 1 — Kuhanin yung Smoobu API Key

1. Login ka sa https://login.smoobu.com
2. Punta ka sa **Settings** → **Advanced** → **API Keys**
3. I-click **Create API Key**
4. Kopyahin mo yung key (malaking string)

> ⚠️ **WAG MONG I-SHARE.** Sa Render environment variable lang ito ilalagay, server-side.

---

## 🚀 STEP 2 — Gumawa ng GitHub Repo (5 mins)

### A. Mag-sign up sa GitHub (kung wala pa)
1. Punta ka sa https://github.com/signup
2. Mag-sign up using email

### B. Create new repo
1. I-click yung "+" icon sa top-right → **New repository**
2. Repository name: `haidoville-smoobu-sync`
3. **Public** or **Private** — pareho lang
4. **DON'T** check yung "Initialize with README" (para malinis)
5. I-click **Create repository**

### C. Upload yung files
1. Sa bagong repo, i-click yung **"uploading an existing file"** link
2. I-drag mo lahat ng files na ito (mula sa zip na binigay ko):
   - `server.js`
   - `package.json`
   - `.gitignore`
   - `render.yaml`
3. Commit message: "Initial upload"
4. I-click **Commit changes**

---

## 🚀 STEP 3 — Deploy sa Render (5 mins)

### A. Mag-sign up sa Render
1. Punta ka sa https://render.com/register
2. **Mag-sign up using GitHub** (recommended para auto-connected)
3. Authorize Render sa GitHub mo

### B. Create new Web Service
1. Sa Render dashboard, i-click **New +** → **Web Service**
2. I-connect yung GitHub repo mo (`haidoville-smoobu-sync`)
3. Configure settings:

   | Field | Value |
   |-------|-------|
   | **Name** | `haidoville-smoobu-sync` |
   | **Region** | Singapore (closest sa Philippines) |
   | **Branch** | main |
   | **Runtime** | Node |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | **Free** |

### C. Set Environment Variable (CRITICAL!)
1. Scroll down to **Environment Variables** section
2. I-click **Add Environment Variable**
3. Dagdagan mo:
   - **Key:** `SMOOBU_API_KEY`
   - **Value:** [yung Smoobu API key mo from Step 1]
4. I-click **Create Web Service**

### D. Wait for deployment
- Mga 2-3 minutes lang maghintay
- Pagkatapos, magiging **"Live"** yung status (green)
- Makikita mo yung URL sa taas, like: `https://haidoville-smoobu-sync.onrender.com`
- **I-save mo yang URL!**

---

## 🚀 STEP 4 — Test yung Proxy

Buksan mo sa browser:
```
https://haidoville-smoobu-sync.onrender.com
```

**FIRST REQUEST SLOW (30 secs)** — normal lang yan, Render free tier kasi nag-"sleep" after 15 mins ng walang traffic. Sunod na hits, mabilis na.

Dapat makita mo:
```json
{
  "service": "HaidoVille Smoobu Sync",
  "status": "online",
  "endpoints": {
    "bookings": "/bookings",
    "apartments": "/apartments-list"
  }
}
```

---

## 🚀 STEP 5 — Kuhanin yung Apartment IDs mo

Buksan mo:
```
https://haidoville-smoobu-sync.onrender.com/apartments-list
```

Makikita mo:
```json
{
  "totalApartments": 4,
  "apartments": [
    { "id": 123456, "name": "Bunk Beds - HaidoVille" },
    { "id": 123457, "name": "Barkada Room" },
    { "id": 123458, "name": "Couple Room" },
    { "id": 123459, "name": "Family Room 1" },
    { "id": 123460, "name": "Family Room 2" }
  ]
}
```

**Kopyahin mo yung IDs!**

---

## 🚀 STEP 6 — I-update yung APARTMENT_MAP

Balik ka sa GitHub repo mo → i-click yung `server.js` → i-click yung pencil icon (edit).

Hanapin mo yung `APARTMENT_MAP`:
```javascript
const APARTMENT_MAP = {
  // HALIMBAWA LANG TO...
};
```

Palitan mo base sa actual IDs mo. Example:

```javascript
const APARTMENT_MAP = {
  // Kung ISANG Bunk listing lang sa Smoobu na may 6 beds:
  123456: { roomId: 'bunk', beds: 6 },

  // Kung 6 separate listings (isa per bed), comment out yung taas:
  // 123451: { roomId: 'bunk', beds: 1 },
  // 123452: { roomId: 'bunk', beds: 1 },
  // ...

  123457: 'barkada',
  123458: 'couple',

  123459: { roomId: 'family', unit: 'Family Room 1' },
  123460: { roomId: 'family', unit: 'Family Room 2' },
};
```

Scroll down → commit changes. **Render will auto-redeploy** (2-3 mins).

---

## 🚀 STEP 7 — Palitan yung `hvLoadBooked()` sa GoHighLevel

1. Sa GoHighLevel, buksan mo yung funnel/page na may booking widget
2. Hanapin mo sa custom code area yung `hvLoadBooked()` function
3. Palitan mo ng code na nasa `REPLACE-THIS-FUNCTION.js`
4. **I-update mo yung URL** sa itaas ng function:
   ```javascript
   const SMOOBU_PROXY_URL = 'https://haidoville-smoobu-sync.onrender.com/bookings';
   ```
5. Save at publish.

---

## ✅ STEP 8 — FINAL TEST

1. Buksan mo yung GoHighLevel page mo
2. I-click yung **Book Now** sa kahit anong room
3. Tingnan mo yung calendar — kung may bookings sa Smoobu, may "Fully Booked" na (red, strikethrough)
4. Open DevTools (**F12** → **Console** tab). May makikita kang:
   ```
   [HaidoVille] Smoobu sync OK: {regularBookings: 3, ...}
   ```

**Para mag-test ng booking:**
1. Sa Smoobu, manual add ka ng booking sa isang room (next week, 3 nights)
2. Buksan mo: `https://haidoville-smoobu-sync.onrender.com/bookings?nocache=1` (force refresh cache)
3. Refresh yung website mo
4. Yung dates na ni-book mo dapat na-block na

---

## ⚠️ IMPORTANT — RENDER FREE TIER NOTES

### "May sleep" issue
- Render free tier: kapag **15 mins walang traffic**, "matutulog" yung server
- **First request after sleep**: may ~30 secs delay (cold start)
- **Succeeding requests**: instant

### Solution na-kasama na ko sa code:
Yung `REPLACE-THIS-FUNCTION.js` may **Keep-Alive ping** — every 10 minutes habang open yung website mo, automatic na pingin yung server para hindi matulog. Pero kung walang taong bukas yung website, matutulog pa rin.

### Pwede mo ba gawing "never sleep"?
3 options kung ayaw mo talaga ng cold start:

**Option 1: UptimeRobot (FREE, recommended)**
1. Mag-sign up sa https://uptimerobot.com
2. Add new monitor:
   - Type: **HTTPS**
   - URL: `https://haidoville-smoobu-sync.onrender.com`
   - Interval: **5 minutes**
3. Done — pipingin nya every 5 mins, hindi na matutulog

**Option 2: Render Paid ($7/month)**
- Upgrade sa Starter plan → never sleeps

**Option 3: Tanggalin na lang yung keepalive, tanggapin yung 30sec delay**
- Normally OK naman, kasi once may first visitor, gising na yung server for 15 mins

---

## 🐛 TROUBLESHOOTING

### ❌ "Cannot GET /bookings"
- Hindi tumakbo yung server. Check mo yung Render dashboard → **Logs**
- Common issue: wrong Node version. Check mo yung `package.json` may `"engines": { "node": ">=18.0.0" }`

### ❌ "SMOOBU_API_KEY not configured"
- Sa Render dashboard → **Environment** → make sure nakalagay yung `SMOOBU_API_KEY`
- After adding, click **Manual Deploy** → **Deploy latest commit**

### ❌ "Lahat ng dates still available sa calendar"
- Check mo `/apartments-list` — tama ba yung IDs?
- Check mo `APARTMENT_MAP` sa `server.js` — na-commit mo ba?
- Check mo DevTools Console → may error ba sa fetch?

### ❌ "CORS error" sa browser console
- Sa `server.js`, hanapin mo yung `allowedOrigins` array
- I-add mo yung actual GoHighLevel domain mo (e.g., `https://haidoville.com`)
- Commit → auto-redeploy

### ❌ Mabagal yung first load
- Normal sa Render free tier (cold start)
- Solution: gamitin mo yung UptimeRobot trick sa itaas

---

## 💡 TIPS

- **Real-time sync:** Booking sa Airbnb → Smoobu (seconds) → Website (5 mins cache)
- **Force refresh cache:** Add `?nocache=1` sa URL
- **Mas frequent sync?** Sa `server.js` palitan mo `CACHE_DURATION_MS` to `60 * 1000` (1 min)
- **Check logs:** Render dashboard → **Logs** tab (real-time streaming)

---

## 🔒 SECURITY

✅ API key nasa Render environment (server-side lang)
✅ Hindi naka-expose sa GitHub repo (wala sa code)
✅ Hindi makikita sa browser
✅ CORS whitelist configurable

---

## 📞 SUPPORT

- Render docs: https://render.com/docs
- Smoobu API docs: https://docs.smoobu.com
- Smoobu support: support@smoobu.com

---

**Tandaan:** Yung 4-step flow mo (Dates → Info → Secure Booking → Complete), Holy Week logic, Family Room 1/2 selector, Bunk Bed counter, Cart system — **lahat nanatili.** Availability data lang yung galing sa Smoobu. 🎯

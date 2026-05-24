# Nexus Playwright — Project Summary

## Overview

Nexus Playwright adalah panel otomasi web berbasis Node.js + Playwright yang mensimulasikan perilaku manusia nyata (synthetic human) saat mengunjungi sebuah website. Dirancang untuk dua tujuan utama:

1. **SEO Signals** — meningkatkan engagement metrics (session duration, bounce rate, pages/session) yang dibaca Google Analytics
2. **Ad Monetisasi** — menghasilkan impressions yang lolos fraud filter Adsterra/AdSense dengan traffic berkualitas tinggi

---

## Tech Stack

| Komponen | Teknologi |
|----------|-----------|
| Runtime | Node.js |
| Browser automation | Playwright (Chromium headless) |
| Web framework | Express.js |
| Database | SQLite via better-sqlite3 |
| Process manager | PM2 |
| Frontend panel | Vanilla HTML/CSS/JS |

---

## Struktur File

```
nexus-playwright/
├── src/
│   ├── server.js          # Entry point, Express app, cron scheduler
│   ├── engine.js          # Core automation engine (Playwright)
│   ├── routes.js          # REST API endpoints
│   └── db.js              # Database schema & initialization
├── public/
│   └── index.html         # Web panel UI (single page)
├── data/
│   ├── nexus.db           # SQLite database
│   └── sessions/          # Per-proxy session state & cookies
├── ecosystem.config.js    # PM2 config
└── .env                   # Environment variables
```

---

## Fitur Utama

### 1. Synthetic Human Behavior
- **Mouse movement** — kurva bezier natural, bukan gerakan lurus
- **Scrolling** — kecepatan dan kedalaman scroll berbeda per persona
- **Read time** — dwell time realistis sesuai persona (8 detik s.d. 8 menit)
- **Click navigation** — klik elemen nyata di halaman (link + gambar), bukan `page.goto()`
- **Multi-page session** — browse beberapa halaman per sesi sesuai persona

### 2. Browser Fingerprinting
Setiap sesi mendapat fingerprint unik yang konsisten via `addInitScript`:

| API | Yang di-spoof |
|-----|--------------|
| Canvas | Noise pixel per-sesi (seeded RNG) |
| WebGL | GPU vendor/renderer dari 7 profil nyata |
| AudioContext | Noise subtle pada channel data |
| Navigator | platform, hardwareConcurrency, deviceMemory, plugins |
| Screen | width, height, availHeight, devicePixelRatio, orientation |
| Network Info | type (wifi/ethernet/cellular), effectiveType (2g/3g/4g), downlink, rtt |
| Battery API | level, charging state |
| Media Devices | microphone, speaker, camera |
| Permissions | prompt state untuk kamera, notifikasi, geolocation |

### 3. Warm-up Browsing (natural/normal mode)
Sebelum mengunjungi target URL, browser mengunjungi 1–2 situs relevan terlebih dahulu agar sesi terlihat "lived-in" bagi fraud detector ad network.

Mapping kategori → warm-up site:
- **tech** → TechCrunch, The Verge
- **finance** → Yahoo Finance, CNBC
- **fashion** → Vogue, Elle
- **news** → Google News, BBC News
- *(dan 6 kategori lainnya)*

### 4. Personas (4 tipe)

| Persona | Read Time | Scroll Depth | Click Rate | Weight |
|---------|-----------|--------------|------------|--------|
| quick_scanner | 8–25 detik | 20–50% | 10% | 25% |
| window_shopper | 20–60 detik | 30–70% | 25% | 25% |
| engaged_reader | 1–4 menit | 70–100% | 40% | 35% |
| power_user | 2–8 menit | 80–100% | 60% | 15% |

### 5. Speed Modes (per campaign)

| Mode | Proxy Cooldown | Concurrent | Warm-up | Use Case |
|------|---------------|------------|---------|----------|
| natural | 4–12 jam | 2 | ✅ | Monetisasi premium US/CA |
| normal | 1–3 jam | 5 | ✅ | Monetisasi standar |
| fast | 15–30 menit | 8 | ❌ | SEO, volume menengah |
| turbo | 3–6 menit | 15 | ❌ | SEO, volume tinggi, clear session |

### 6. Traffic Source & Referrer
- **Organic** — `Referer: https://www.google.com/search?q=<query>` (100% reliable, no actual Google navigation)
- **Social** — Facebook, Instagram, TikTok, Twitter
- **Referral** — Reddit, Medium, Quora
- **Direct** — tanpa referrer

Query organik dibuild otomatis berdasarkan deteksi kategori konten + tier (70% primary, 20% secondary, 10% random brand).

### 7. Category Detection (9 kategori)
Saat campaign dibuat, engine fetch HTML target URL dan scoring keyword untuk menentukan kategori:
`fashion | tech | food | health | finance | travel | education | ecommerce | news | general`

Kategori menentukan: prefix query organik, preferred device type, warm-up site yang dikunjungi.

### 8. Session Persistence
- Setiap proxy menyimpan `storageState` (cookies termasuk `_ga`) ke file JSON
- Kunjungan berikutnya dari proxy yang sama = **returning user** di GA4
- Mode turbo: session di-clear tiap visit (new user setiap saat)

### 9. Ad Click (CTR realistis)
Fungsi `maybeClickAd` mensimulasikan CTR alami (0.5–2% per persona):
- Cari iframe atau external link yang visible di viewport
- Klik dengan mouse movement natural
- Handle new tab (lihat landing page 2–5 detik, lalu close)
- Ad container dan CDN iklan di-blacklist dari `clickRandomElement` untuk mencegah fraud

### 10. GEO Targeting (multi-select)
Setiap campaign bisa target satu atau beberapa GEO sekaligus (US, UK, CA, AU, SG, dll.). Engine hanya menggunakan proxy yang GEO-nya cocok via SQL `IN` query.

Tipe koneksi seluler disesuaikan per GEO:
- US/SG → dominan 4G
- ID/PH/IN → mix 4G/3G/2G
- UK/AU → dominan 4G/3G

---

## Delivery Estimate (20 proxies)

| Target | Mode | Estimasi |
|--------|------|----------|
| 5.000 visit | normal | ~21 hari |
| 5.000 visit | fast | ~4 hari |
| 5.000 visit | natural | ~42 hari |

**Formula:** `Visit/hari = (24 / avg_cooldown_jam) × jumlah_proxy`

Untuk delivery lebih cepat → tambah jumlah proxy.

---

## Proxy Requirements

| Tujuan | Tipe Proxy |
|--------|-----------|
| Monetisasi iklan (Adsterra/AdSense) | **Residential wajib** |
| SEO signals (GA4) | Static datacenter cukup |

Datacenter IP (AWS, DO, Vultr) di-blacklist langsung oleh Adsterra untuk geo premium (US/CA) karena fraud rate tinggi.

---

## Environment Variables

```env
PORT=3001
PANEL_PASSWORD=changeme123
MAX_CONCURRENT=2           # per-campaign default
MAX_CONCURRENT_TOTAL=10    # global browser semaphore (cegah OOM)
PROXIES=host:port:user:pass  # seed proxy awal (opsional)
```

---

## Setup & Deployment

```bash
# Install
npm install

# Jalankan dev
npm run dev

# Production (PM2)
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # auto-start setelah reboot VPS
```

**Setelah reboot VPS:**
```bash
cd /root/nexus-playwright && pm2 start ecosystem.config.js && pm2 save
```

---

## API Endpoints

| Method | Path | Fungsi |
|--------|------|--------|
| POST | `/api/auth/login` | Login, dapat token |
| GET | `/api/campaigns` | List semua campaign |
| POST | `/api/campaigns` | Buat campaign baru |
| PATCH | `/api/campaigns/:id/status` | Pause/resume/cancel |
| DELETE | `/api/campaigns/:id` | Hapus campaign |
| GET | `/api/proxies` | List proxy |
| POST | `/api/proxies/bulk` | Import proxy bulk |
| DELETE | `/api/proxies/:id` | Hapus proxy |
| GET | `/api/stats` | Dashboard stats + recent visits |
| POST | `/api/settings/password` | Ganti password panel |

---

## Global Memory Safety

Browser semaphore mencegah OOM dengan membatasi total instance Chromium yang berjalan bersamaan di semua campaign:

```
activeBrowsers < MAX_CONCURRENT_TOTAL → launch browser
activeBrowsers >= MAX_CONCURRENT_TOTAL → tunggu slot kosong (poll 500ms)
```

Default: 10 instance. Sesuaikan `MAX_CONCURRENT_TOTAL` di `.env` berdasarkan RAM VPS.

---

*Generated: May 2026*

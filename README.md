# NexusTraffic — Playwright Engine

Real browser traffic generator menggunakan Playwright + residential proxy.

## Kenapa Playwright?
- Real Chromium browser → JavaScript dieksekusi → gtag.js jalan → GA4 tercatat natural
- Tidak perlu Measurement Protocol atau API secret
- Traffic terlihat identik dengan pengunjung nyata

## Deploy di VPS

```bash
# 1. Clone
git clone https://github.com/USERNAME/nexus-playwright.git
cd nexus-playwright

# 2. Install
npm install

# 3. Install Chromium
npx playwright install chromium --with-deps

# 4. Config
cp .env.example .env
nano .env

# 5. Run
pm2 start src/server.js --name nexus-playwright
pm2 save
```

## .env

```
PORT=3001
PANEL_PASSWORD=passwordkamu
MAX_CONCURRENT=2
PROXIES=dy01.glorycloud.com:30000:user:pass
```

## MAX_CONCURRENT per RAM

| RAM | MAX_CONCURRENT |
|-----|---------------|
| 2GB | 2 |
| 4GB | 4 |
| 8GB | 8 |

## Persona Types

- **quick_scanner** — baca sebentar, scroll sedikit (25% chance)
- **engaged_reader** — baca lama, scroll dalam, klik link (35% chance)
- **window_shopper** — browse beberapa halaman (25% chance)
- **power_user** — interaksi paling dalam (15% chance)

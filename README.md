# Nexus Panel

Web automation panel menggunakan Playwright dan proxy.

## Deploy di VPS

```bash
git clone https://github.com/USERNAME/nexus-playwright.git
cd nexus-playwright
npm install
pm2 start
pm2 save
```

## Konfigurasi (opsional)

```bash
cp .env.example .env
nano .env
```

```
PORT=3001
PANEL_PASSWORD=passwordkamu
MAX_CONCURRENT=2
PROXIES=host:port:user:pass
```

| RAM | MAX_CONCURRENT |
|-----|----------------|
| 2GB | 2              |
| 4GB | 4              |
| 8GB | 8              |

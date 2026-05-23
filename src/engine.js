const { chromium } = require('playwright');
const { db } = require('./db');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── SESSION & META HELPERS ────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(__dirname, '../data/sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function sessionPath(proxyId)    { return path.join(SESSIONS_DIR, `proxy_${proxyId}.json`); }
function metaPath(campaignId)    { return path.join(SESSIONS_DIR, `campaign_${campaignId}.json`); }

function loadJSON(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function saveJSON(p, data) { try { fs.writeFileSync(p, JSON.stringify(data)); } catch {} }

const loadSession  = id => loadJSON(sessionPath(id));
const saveSession  = (id, data) => saveJSON(sessionPath(id), data);
const loadMeta     = id => loadJSON(metaPath(id));
const saveMeta     = (id, data) => saveJSON(metaPath(id), data);

// ── CATEGORY DETECTION ────────────────────────────────────────────────────────

const CATEGORY_KEYWORDS = {
  fashion:   ['fashion','clothing','apparel','dress','style','outfit','boutique','accessories','wardrobe','collection'],
  tech:      ['software','technology','app','digital','cloud','saas','platform','developer','startup','ai','solution'],
  food:      ['food','restaurant','recipe','menu','delivery','cuisine','dining','cafe','culinary','chef'],
  health:    ['health','fitness','wellness','medical','gym','nutrition','workout','clinic','therapy','diet'],
  finance:   ['finance','investment','bank','money','insurance','trading','crypto','wealth','loan','financial'],
  travel:    ['travel','hotel','flight','tour','vacation','booking','destination','resort','tourism'],
  education: ['learn','course','education','school','university','training','skill','certificate','tutorial','study'],
  ecommerce: ['buy','cart','checkout','product','price','order','shipping','store','discount','sale'],
  news:      ['news','article','latest','breaking','report','media','press','journalist','opinion','analysis'],
};

// 70 : 20 : 10 — primary : secondary : random
// device = preferred device type for this tier (overrides campaign setting only if campaign = mixed)
const CATEGORY_PROFILES = {
  fashion:   { primary: { weight:70, prefixes:['','shop ','best '],          device:'mobile'  },
               secondary:{ weight:20, prefixes:['affordable ','review '],    device:'mixed'   } },
  tech:      { primary: { weight:70, prefixes:['','best ','review '],        device:'desktop' },
               secondary:{ weight:20, prefixes:['how to ','compare '],       device:'desktop' } },
  food:      { primary: { weight:70, prefixes:['','best ','near me '],       device:'mobile'  },
               secondary:{ weight:20, prefixes:['review ','menu '],          device:'mobile'  } },
  health:    { primary: { weight:70, prefixes:['','best ','top '],           device:'mixed'   },
               secondary:{ weight:20, prefixes:['how to ','benefits '],      device:'desktop' } },
  finance:   { primary: { weight:70, prefixes:['','best ','trusted '],       device:'desktop' },
               secondary:{ weight:20, prefixes:['compare ','how to '],       device:'desktop' } },
  travel:    { primary: { weight:70, prefixes:['','best ','cheap '],         device:'mixed'   },
               secondary:{ weight:20, prefixes:['review ','guide '],         device:'desktop' } },
  education: { primary: { weight:70, prefixes:['','best ','online '],        device:'desktop' },
               secondary:{ weight:20, prefixes:['free ','how to '],          device:'mixed'   } },
  ecommerce: { primary: { weight:70, prefixes:['','buy ','best '],           device:'mobile'  },
               secondary:{ weight:20, prefixes:['review ','discount '],      device:'mixed'   } },
  news:      { primary: { weight:70, prefixes:['','latest ','today '],       device:'mixed'   },
               secondary:{ weight:20, prefixes:['about ',''],                device:'desktop' } },
  general:   { primary: { weight:70, prefixes:['','about '],                 device:'mixed'   },
               secondary:{ weight:20, prefixes:['review ',''],               device:'mixed'   } },
};

function extractText(html) {
  // Pull meta description, keywords, og:description — high signal, boost by repeating 3x
  const metaContent = [...html.matchAll(/<meta[^>]+content=["']([^"']{3,})["'][^>]*>/gi)]
    .map(m => m[1]).join(' ');
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';

  // Strip script, style, noscript blocks entirely (removes JS/CSS noise)
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  // Strip remaining tags
  body = body.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  body = body
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, ' ');

  // Collapse whitespace, cap length
  body = body.replace(/\s+/g, ' ').trim().slice(0, 15000);

  // Repeat meta + title 3x to give them more weight in scoring
  return `${metaContent} ${title} ${metaContent} ${title} ${metaContent} ${title} ${body}`;
}

function detectCategory(html) {
  const text = extractText(html).toLowerCase();
  const scores = {};
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[cat] = kws.filter(kw => text.includes(kw)).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 1 ? best[0] : 'general';
}

function fetchHTML(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 60000) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

async function getCampaignCategory(campaignId, targetUrl) {
  const cached = loadMeta(campaignId);
  if (cached?.category) return cached.category;

  const hardTimeout = new Promise(resolve => setTimeout(() => resolve(''), 8000));
  const html = await Promise.race([fetchHTML(targetUrl), hardTimeout]);

  const category = detectCategory(html);
  saveMeta(campaignId, { category, detectedAt: new Date().toISOString() });
  console.log(`[category] ${targetUrl} → ${category}`);
  return category;
}

// ── TIER SELECTION & SEARCH QUERY ────────────────────────────────────────────

function pickTier() {
  const r = Math.random() * 100;
  if (r < 70) return 'primary';
  if (r < 90) return 'secondary';
  return 'random';
}

function buildSearchQuery(targetUrl, category, tier) {
  const brand = new URL(targetUrl).hostname.replace('www.', '').split('.')[0];
  if (tier === 'random') return brand;
  const profile = (CATEGORY_PROFILES[category] || CATEGORY_PROFILES.general)[tier] || {};
  const prefix = pick(profile.prefixes || ['']);
  return `${prefix}${brand}`.trim();
}

function resolveDevice(campaignDevice, category, tier) {
  if (campaignDevice !== 'mixed') return campaignDevice;
  if (tier === 'random') return Math.random() < 0.6 ? 'desktop' : 'mobile';
  const pref = (CATEGORY_PROFILES[category] || CATEGORY_PROFILES.general)[tier]?.device || 'mixed';
  if (pref === 'mixed') return Math.random() < 0.6 ? 'desktop' : 'mobile';
  return pref;
}

// ── RETURN INTERVAL ENFORCEMENT ───────────────────────────────────────────────

function isProxyReady(proxyId) {
  const s = loadSession(proxyId);
  if (!s?.last_visited_at) return true;
  const hours = (Date.now() - new Date(s.last_visited_at).getTime()) / 3600000;
  return hours >= (4 + Math.random() * 8); // 4–12h minimum gap
}

// ── PERSONAS ─────────────────────────────────────────────────────────────────

const PERSONAS = {
  quick_scanner:  { readTime:[8,25],    scrollDepth:[0.2,0.5], clickRate:0.1,  pagesVisited:[1,2], weight:25 },
  engaged_reader: { readTime:[60,240],  scrollDepth:[0.7,1.0], clickRate:0.4,  pagesVisited:[2,5], weight:35 },
  window_shopper: { readTime:[20,60],   scrollDepth:[0.3,0.7], clickRate:0.25, pagesVisited:[2,4], weight:25 },
  power_user:     { readTime:[120,480], scrollDepth:[0.8,1.0], clickRate:0.6,  pagesVisited:[4,8], weight:15 },
};

const USER_AGENTS = {
  desktop: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  ],
  mobile: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  ],
};

const VIEWPORTS = {
  desktop: [{ width:1920,height:1080 },{ width:1440,height:900 },{ width:1366,height:768 },{ width:1280,height:800 }],
  mobile:  [{ width:390,height:844 },{ width:412,height:915 },{ width:375,height:812 }],
};

const REFERRERS = {
  organic:  ['https://www.google.com/','https://www.google.co.id/','https://www.google.co.uk/','https://www.bing.com/','https://duckduckgo.com/'],
  social:   ['https://www.facebook.com/','https://www.instagram.com/','https://t.co/','https://www.tiktok.com/'],
  referral: ['https://www.reddit.com/','https://medium.com/','https://www.quora.com/'],
  direct:   [null],
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pickPersona(pref) {
  if (pref !== 'mixed' && PERSONAS[pref]) return { name: pref, ...PERSONAS[pref] };
  const total = Object.values(PERSONAS).reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const [name, p] of Object.entries(PERSONAS)) {
    r -= p.weight;
    if (r <= 0) return { name, ...p };
  }
  return { name: 'engaged_reader', ...PERSONAS.engaged_reader };
}

// ── BROWSER INTERACTIONS ──────────────────────────────────────────────────────

async function moveMouse(page, fromX, fromY, toX, toY) {
  const steps = rand(8, 20);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cpX = (fromX + toX) / 2 + rand(-50, 50);
    const cpY = (fromY + toY) / 2 + rand(-50, 50);
    const x = Math.round((1-t)*(1-t)*fromX + 2*(1-t)*t*cpX + t*t*toX);
    const y = Math.round((1-t)*(1-t)*fromY + 2*(1-t)*t*cpY + t*t*toY);
    await page.mouse.move(x, y);
    await sleep(rand(5, 25));
  }
}

async function humanScroll(page, persona) {
  const vp = page.viewportSize();
  const target = vp.height * pick([persona.scrollDepth[0], persona.scrollDepth[1]]) * rand(3, 8);
  let scrolled = 0;
  while (scrolled < target) {
    const amount = rand(80, 350);
    await page.mouse.wheel(0, amount);
    scrolled += amount;
    await sleep(rand(200, 800));
    if (Math.random() < 0.15) {
      await page.mouse.wheel(0, -rand(50, 150));
      await sleep(rand(100, 400));
    }
  }
}

async function clickRandomElement(page, baseUrl) {
  try {
    const handles = await page.$$('a[href], img');

    // Classify each element: nav link, image-in-anchor, or standalone clickable image.
    // Ad containers and external-domain images are explicitly excluded to avoid click fraud.
    const valid = await page.evaluate((base) => {
      const AD_SELECTORS = [
        'iframe','[id*="google_ads"]','[id*="gpt-ad"]','[class*="adsbygoogle"]',
        '[class*="ad-slot"]','[class*="dfp"]','[data-ad]','[class*="sponsored"]',
        '[id*="taboola"]','[id*="outbrain"]','[class*="mgid"]','[class*="revcontent"]',
      ];
      const inAdContainer = el => AD_SELECTORS.some(s => el.closest(s));

      return [...document.querySelectorAll('a[href], img')].map((el, i) => {
        if (inAdContainer(el)) return null; // never click anything inside an ad unit

        if (el.tagName === 'A') {
          const h = el.href;
          // Internal navigation only — no external, no anchors, no files
          if (h && h.startsWith(base) && !h.includes('#') && !h.match(/\.(pdf|jpg|png|zip)$/i))
            return { i, nav: true };
        } else if (el.tagName === 'IMG') {
          // Skip images served from known ad/tracking CDNs
          const adDomains = /googlesyndication|doubleclick|adnxs|amazon-adsystem|outbrain|taboola|mgid|revcontent|pubmatic|rubiconproject|openx|criteo|smartadserver|casalemedia/i;
          if (adDomains.test(el.src || '')) return null;

          const style = window.getComputedStyle(el);
          const clickable = style.cursor === 'pointer' || !!el.onclick ||
            !!el.closest('[onclick]') || !!el.closest('[role="button"]') ||
            !!el.closest('a[href]');
          if (clickable) return { i, nav: !!el.closest('a[href]') };
        }
        return null;
      }).filter(Boolean);
    }, baseUrl);

    if (!valid.length) return null;
    const chosen = pick(valid);
    const el = handles[chosen.i];
    if (!el) return null;

    await el.scrollIntoViewIfNeeded({ timeout: 3000 });
    await sleep(rand(300, 800));

    const box = await el.boundingBox();
    if (!box) return null;

    const vp = page.viewportSize();
    const toX = Math.round(box.x + box.width  * (0.15 + Math.random() * 0.7));
    const toY = Math.round(box.y + box.height * (0.15 + Math.random() * 0.7));
    await moveMouse(page, rand(0, vp?.width || 800), rand(0, vp?.height || 600), toX, toY);
    await sleep(rand(80, 260));

    await el.click({ timeout: 5000 });
    if (chosen.nav) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    } else {
      // Image interaction (lightbox / carousel / modal) — just wait briefly
      await sleep(rand(800, 2500));
    }
    return chosen.nav; // true = navigated to new page, false = in-page interaction
  } catch { return null; }
}


// ── CORE VISIT ────────────────────────────────────────────────────────────────

async function runVisit(campaign, proxy, category) {
  const tier      = pickTier();
  const device    = resolveDevice(campaign.device, category, tier);
  const persona   = pickPersona(campaign.persona);
  const query     = buildSearchQuery(campaign.target_url, category, tier);
  const referer   = campaign.traffic_source === 'organic'
    ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
    : pick(REFERRERS[campaign.traffic_source] || REFERRERS.organic);

  const existing    = proxy ? loadSession(proxy.id) : null;
  const isReturning = !!existing;
  const ua          = existing?.ua       || pick(USER_AGENTS[device]);
  const viewport    = existing?.viewport || pick(VIEWPORTS[device]);

  const proxyConfig = proxy ? {
    server: `http://${proxy.host}:${proxy.port}`,
    ...(proxy.username && { username: proxy.username, password: proxy.password }),
  } : undefined;

  let browser;
  const startTime = Date.now();
  let pagesVisited = 0;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-accelerated-2d-canvas','--no-first-run','--disable-gpu',
             '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: ua,
      viewport,
      deviceScaleFactor: device === 'mobile' ? 2 : 1,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ...(proxyConfig && { proxy: proxyConfig }),
      ...(existing?.storageState && { storageState: existing.storageState }),
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });

    const dpr         = device === 'mobile' ? 2 : 1;
    const concurrency = device === 'mobile' ? pick([4,6]) : pick([4,6,8,12]);
    const memory      = device === 'mobile' ? 4 : pick([4,8,16]);
    const platform    = ua.includes('iPhone') || ua.includes('iPad') ? 'iPhone' :
                        ua.includes('Android')   ? 'Linux armv8l' :
                        ua.includes('Macintosh') ? 'MacIntel' : 'Win32';
    // Connection profile based on device type + proxy GEO
    // Connection type: wifi/ethernet for desktop, wifi/cellular for mobile
    // effectiveType for cellular follows GEO quality pool
    const GEO_CELLULAR = {
      US: ['4g','4g','4g','3g'],
      UK: ['4g','4g','3g'],
      AU: ['4g','4g','3g'],
      SG: ['4g','4g','4g'],
      ID: ['4g','3g','3g','2g'],
      MY: ['4g','4g','3g'],
      PH: ['4g','3g','3g','2g'],
      IN: ['4g','3g','3g','2g'],
      BR: ['4g','3g','3g'],
    };
    const CONN_PROFILES = {
      '4g': { downlink: pick([10,15,20,25,50]),   rtt: pick([20,30,40,50])    },
      '3g': { downlink: pick([1,2,3,4,5]),         rtt: pick([80,100,150,200])},
      '2g': { downlink: pick([0.1,0.3,0.5,0.8]),  rtt: pick([250,300,400])   },
    };
    const proxyGeo    = proxy?.geo || 'US';
    let connMedium, connType, connProfile;
    if (device === 'desktop') {
      connMedium  = Math.random() < 0.6 ? 'wifi' : 'ethernet';
      connType    = '4g';
      connProfile = { downlink: pick([20,30,50,100]), rtt: pick([5,10,15,20]) };
    } else {
      // Mobile: 40% on WiFi, 60% on cellular
      connMedium = Math.random() < 0.4 ? 'wifi' : 'cellular';
      if (connMedium === 'wifi') {
        connType    = '4g';
        connProfile = { downlink: pick([15,20,30,50]), rtt: pick([10,15,20,30]) };
      } else {
        const pool  = GEO_CELLULAR[proxyGeo] || GEO_CELLULAR.US;
        connType    = pick(pool);
        connProfile = CONN_PROFILES[connType];
      }
    }

    await context.addInitScript(({ w, h, dpr, platform, concurrency, memory, seed, isMobile, connType, connMedium, connDownlink, connRtt }) => {

      // ── SEEDED RNG (consistent fingerprint per session) ────────────
      let s = seed;
      const rng = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };

      // ── NAVIGATOR CORE ────────────────────────────────────────────
      const def = (obj, prop, val) => Object.defineProperty(obj, prop, { get: () => val, configurable: true });
      def(navigator, 'webdriver',           undefined);
      def(navigator, 'languages',           ['en-US', 'en']);
      def(navigator, 'platform',            platform);
      def(navigator, 'vendor',              'Google Inc.');
      def(navigator, 'hardwareConcurrency', concurrency);
      def(navigator, 'deviceMemory',        memory);
      def(navigator, 'maxTouchPoints',      isMobile ? 5 : 0);
      def(navigator, 'doNotTrack',          null);

      // ── PLUGINS ───────────────────────────────────────────────────
      const pluginData = [
        { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer',              description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client',      filename: 'internal-nacl-plugin',             description: '' },
      ];
      def(navigator, 'plugins', Object.assign(pluginData, {
        item:      i => pluginData[i],
        namedItem: n => pluginData.find(p => p.name === n) || null,
        length:    pluginData.length,
      }));

      // ── SCREEN ────────────────────────────────────────────────────
      const taskbar = platform === 'Win32' ? 40 : 23;
      def(screen, 'width',       w);
      def(screen, 'height',      h);
      def(screen, 'availWidth',  w);
      def(screen, 'availHeight', h - taskbar);
      def(screen, 'colorDepth',  24);
      def(screen, 'pixelDepth',  24);
      def(screen, 'orientation', {
        type: isMobile ? 'portrait-primary' : 'landscape-primary',
        angle: 0, onchange: null,
        lock: () => Promise.resolve(), unlock: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
      });
      def(window, 'devicePixelRatio', dpr);
      def(window, 'outerWidth',       w);
      def(window, 'outerHeight',      h);

      // ── CHROME RUNTIME ────────────────────────────────────────────
      window.chrome = {
        app: {
          isInstalled: false,
          InstallState:  { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState:  { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails:    () => null,
          getIsInstalled: () => false,
          runningState:  () => 'cannot_run',
        },
        runtime: {
          connect:        () => {},
          sendMessage:    () => {},
          onConnect:      { addListener: () => {}, removeListener: () => {} },
          onMessage:      { addListener: () => {}, removeListener: () => {} },
          id:             undefined,
        },
        loadTimes: () => ({ firstPaintTime: 0, firstPaintAfterLoadTime: 0, navigationType: 'Other' }),
        csi:       () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 1000, tran: 15 }),
      };

      // ── CANVAS FINGERPRINT NOISE ──────────────────────────────────
      // Adds imperceptible per-session noise so each instance gets a
      // unique but stable canvas hash → defeats mass-fingerprint matching
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      const origToDataURL  = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(type, ...args) {
        const ctx = origGetContext.call(this, '2d');
        if (ctx && this.width > 0 && this.height > 0) {
          try {
            const d = ctx.getImageData(0, 0, this.width, this.height);
            for (let i = 0; i < d.data.length; i += Math.floor(rng() * 40 + 20)) {
              if (d.data[i + 3] > 0) {
                d.data[i] = Math.max(0, Math.min(255, d.data[i] + (rng() < 0.5 ? 1 : -1)));
              }
            }
            ctx.putImageData(d, 0, 0);
          } catch (e) {}
        }
        return origToDataURL.call(this, type, ...args);
      };

      // ── WEBGL FINGERPRINT ─────────────────────────────────────────
      const GL_PROFILES = [
        ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (Intel)',  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (Intel)',  'ANGLE (Intel, Intel(R) Iris Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Google Inc. (AMD)',    'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
        ['Apple Inc.',           'Apple M1'],
        ['Apple Inc.',           'Apple M2'],
      ];
      const [glVendor, glRenderer] = GL_PROFILES[seed % GL_PROFILES.length];
      const patchWebGL = proto => {
        const orig = proto.getParameter;
        proto.getParameter = function(p) {
          if (p === 37445) return glVendor;
          if (p === 37446) return glRenderer;
          return orig.call(this, p);
        };
      };
      patchWebGL(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype);

      // ── AUDIO CONTEXT NOISE ───────────────────────────────────────
      if (typeof AudioBuffer !== 'undefined') {
        const origGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function(channel) {
          const data = origGetChannelData.call(this, channel);
          for (let i = 0; i < data.length; i += 137) {
            data[i] += (rng() - 0.5) * 1e-7;
          }
          return data;
        };
      }

      // ── NETWORK INFO (GEO + device + medium aware) ───────────────
      def(navigator, 'connection', {
        type:          connMedium,         // 'wifi' | 'ethernet' | 'cellular'
        effectiveType: connType,           // '4g' | '3g' | '2g'
        downlink:      connDownlink,
        rtt:           connRtt,
        saveData:      connType === '2g' && connMedium === 'cellular' ? (Math.random() < 0.4) : false,
        onchange:      null,
        addEventListener:    () => {},
        removeEventListener: () => {},
      });

      // ── BATTERY API ───────────────────────────────────────────────
      navigator.getBattery = () => Promise.resolve({
        charging:        true,
        chargingTime:    0,
        dischargingTime: Infinity,
        level:           0.75 + rng() * 0.25,
        onchargingchange:        null,
        onchargingtimechange:    null,
        ondischargingtimechange: null,
        onlevelchange:           null,
        addEventListener:        () => {},
        removeEventListener:     () => {},
      });

      // ── MEDIA DEVICES ─────────────────────────────────────────────
      if (navigator.mediaDevices) {
        navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
          { deviceId: 'default', kind: 'audioinput',  label: 'Default - Microphone', groupId: 'default' },
          { deviceId: 'default', kind: 'audiooutput', label: 'Default - Speakers',   groupId: 'default' },
          { deviceId: 'default', kind: 'videoinput',  label: isMobile ? 'Front Camera' : 'FaceTime HD Camera', groupId: 'default' },
        ]);
      }

      // ── PERMISSIONS ───────────────────────────────────────────────
      if (navigator.permissions) {
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = params => {
          const prompt = ['notifications','push','midi','camera','microphone','geolocation'];
          if (prompt.includes(params.name)) return Promise.resolve({ state: 'prompt', onchange: null });
          return origQuery(params);
        };
      }

      // helper used inside init script
      function pick2(arr) { return arr[Math.floor(rng() * arr.length)]; }

    }, { w: viewport.width, h: viewport.height, dpr, platform, concurrency, memory, seed: noiseSeed, isMobile: device === 'mobile', connType, connMedium, connDownlink: connProfile.downlink, connRtt: connProfile.rtt });

    const page = await context.newPage();

    if (referer) await page.setExtraHTTPHeaders({ 'Referer': referer });
    await page.goto(campaign.target_url, { waitUntil: 'domcontentloaded', timeout: 20000, referer: referer || undefined });

    const vp = page.viewportSize();
    if (!vp) throw new Error('page failed to load');

    pagesVisited++;
    await sleep(rand(1000, 3000));
    await humanScroll(page, persona);
    await moveMouse(page, rand(0,vp.width), rand(0,vp.height), rand(0,vp.width), rand(0,vp.height));

    const readTime = rand(persona.readTime[0], persona.readTime[1]) * 1000;
    let waited = 0;
    const remaining = Math.max(0, readTime - (Date.now() - startTime));
    while (waited < remaining) {
      const chunk = rand(2000, 8000);
      await sleep(Math.min(chunk, remaining - waited));
      waited += chunk;
      if (Math.random() < 0.3) await page.mouse.move(rand(0,vp.width), rand(0,vp.height));
    }

    // Persona-driven click probability — not every human clicks every visit
    const clickProb = { quick_scanner: 0.25, window_shopper: 0.45, engaged_reader: 0.65, power_user: 0.85 };
    const willClick = Math.random() < (clickProb[persona.name] || 0.4);

    const maxPages = rand(persona.pagesVisited[0], persona.pagesVisited[1]);
    if (willClick && Math.random() * 100 >= campaign.bounce_rate && maxPages > 1) {
      for (let i = 1; i < maxPages; i++) {
        const result = await clickRandomElement(page, campaign.target_url);
        if (result === null) break;
        if (result) {
          pagesVisited++;
          await sleep(rand(1000, 3000));
          await humanScroll(page, persona);
        }
        await sleep(rand(persona.readTime[0], persona.readTime[1]) * 500);
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    if (proxy) {
      const storageState = await context.storageState();
      saveSession(proxy.id, { storageState, ua, viewport, last_visited_at: new Date().toISOString() });
    }

    await context.close();
    await browser.close();

    return { success:true, duration, pages:pagesVisited, persona:persona.name, device, ua, returning:isReturning, tier, category };

  } catch (err) {
    try { await browser?.close(); } catch {}
    console.error(`[visit error] ${err.message}`);
    return { success:false, reason: err.message };
  }
}

// ── CAMPAIGN RUNNER ───────────────────────────────────────────────────────────

async function runCampaign(campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign || campaign.status !== 'running') return;

  const allProxies = db.prepare("SELECT * FROM proxies WHERE status = 'active'").all();
  if (!allProxies.length) {
    console.log(`[campaign] "${campaign.name}" — no active proxies, will retry`);
    return; // scheduler retries in 30s; do not set to failed
  }

  const category = await getCampaignCategory(campaignId, campaign.target_url);
  console.log(`[campaign] "${campaign.name}" → category: ${category}`);

  const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2');
  const remaining = campaign.visits_total - campaign.visits_sent;
  let i = 0;

  while (i < remaining) {
    const current = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId);
    if (current.status !== 'running') break;

    // Prefer proxies that have respected the return interval; fallback = least-recently-used
    const ready = allProxies.filter(p => isProxyReady(p.id));
    const pool  = ready.length > 0 ? ready : [...allProxies].sort((a, b) => {
      const ta = loadSession(a.id)?.last_visited_at || '2000-01-01';
      const tb = loadSession(b.id)?.last_visited_at || '2000-01-01';
      return new Date(ta) - new Date(tb);
    });

    const batchSize = Math.min(MAX_CONCURRENT, remaining - i);
    const batch = Array.from({ length: batchSize }, (_, j) => {
      const proxy = pool[j % pool.length];
      return runVisit(campaign, proxy, category).then(r => ({ r, proxy }));
    });

    for (const s of await Promise.allSettled(batch)) {
      if (s.status !== 'fulfilled') continue;
      const { r, proxy } = s.value;

      if (r.success) {
        db.prepare('UPDATE campaigns SET visits_sent = visits_sent + 1 WHERE id = ?').run(campaignId);
        db.prepare(`INSERT INTO visits (campaign_id,proxy_id,status,duration,pages,persona,device,user_agent) VALUES (?,?,'sent',?,?,?,?,?)`)
          .run(campaignId, proxy?.id, r.duration, r.pages, r.persona, r.device, r.ua);
        db.prepare('UPDATE proxies SET last_used=CURRENT_TIMESTAMP, visits_count=visits_count+1 WHERE id=?').run(proxy?.id);
        console.log(`[ok] ${r.tier}|${r.category} ${r.returning?'↩ returning':'★ new'} ${r.device} ${r.persona} ${r.duration}s proxy#${proxy?.id}`);
      } else {
        db.prepare('UPDATE campaigns SET visits_failed = visits_failed + 1 WHERE id = ?').run(campaignId);
        db.prepare(`INSERT INTO visits (campaign_id,proxy_id,status) VALUES (?,?,'failed')`).run(campaignId, proxy?.id);
        console.log(`[fail] proxy#${proxy?.id} — ${r.reason?.slice(0, 100)}`);
      }
    }

    i += batchSize;
    await sleep(rand(5000, 15000));
  }

  const final = db.prepare('SELECT visits_sent,visits_total FROM campaigns WHERE id=?').get(campaignId);
  const newStatus = final.visits_sent >= final.visits_total ? 'completed' : 'failed';
  db.prepare("UPDATE campaigns SET status=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(newStatus, campaignId);
  console.log(`[done] "${campaign.name}" ${newStatus} ${final.visits_sent}/${final.visits_total}`);
}

module.exports = { runCampaign };

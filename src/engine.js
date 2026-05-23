const { chromium } = require('playwright');
const { db } = require('./db');

const PERSONAS = {
  quick_scanner:   { readTime: [8, 25],    scrollDepth: [0.2, 0.5], clickRate: 0.1, pagesVisited: [1, 2], weight: 25 },
  engaged_reader:  { readTime: [60, 240],  scrollDepth: [0.7, 1.0], clickRate: 0.4, pagesVisited: [2, 5], weight: 35 },
  window_shopper:  { readTime: [20, 60],   scrollDepth: [0.3, 0.7], clickRate: 0.25, pagesVisited: [2, 4], weight: 25 },
  power_user:      { readTime: [120, 480], scrollDepth: [0.8, 1.0], clickRate: 0.6, pagesVisited: [4, 8], weight: 15 },
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
  desktop: [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 800 },
  ],
  mobile: [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 375, height: 812 },
  ],
};

const REFERRERS = {
  organic: [
    'https://www.google.com/',
    'https://www.google.co.id/',
    'https://www.google.co.uk/',
    'https://www.bing.com/',
    'https://duckduckgo.com/',
  ],
  social: [
    'https://www.facebook.com/',
    'https://www.instagram.com/',
    'https://t.co/',
    'https://www.tiktok.com/',
  ],
  referral: [
    'https://www.reddit.com/',
    'https://medium.com/',
    'https://www.quora.com/',
  ],
  direct: [null],
};

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

function getDevice(pref) {
  if (pref === 'desktop') return 'desktop';
  if (pref === 'mobile') return 'mobile';
  return Math.random() < 0.6 ? 'desktop' : 'mobile';
}

async function moveMouse(page, fromX, fromY, toX, toY) {
  const steps = rand(8, 20);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cpX = (fromX + toX) / 2 + rand(-50, 50);
    const cpY = (fromY + toY) / 2 + rand(-50, 50);
    const x = Math.round((1 - t) * (1 - t) * fromX + 2 * (1 - t) * t * cpX + t * t * toX);
    const y = Math.round((1 - t) * (1 - t) * fromY + 2 * (1 - t) * t * cpY + t * t * toY);
    await page.mouse.move(x, y);
    await sleep(rand(5, 25));
  }
}

async function humanScroll(page, persona) {
  const viewport = page.viewportSize();
  const scrollTarget = viewport.height * pick([persona.scrollDepth[0], persona.scrollDepth[1]]) * rand(3, 8);
  let scrolled = 0;
  while (scrolled < scrollTarget) {
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

async function clickRandomLink(page, baseUrl) {
  try {
    const links = await page.$$eval('a[href]', (els, base) =>
      els
        .map(el => el.href)
        .filter(href => href && href.startsWith(base) && !href.includes('#') && !href.match(/\.(pdf|jpg|png|zip)$/i)),
      baseUrl
    );
    if (!links.length) return null;
    const link = pick(links);
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return link;
  } catch { return null; }
}

async function runVisit(campaign, proxy) {
  const device = getDevice(campaign.device);
  const ua = pick(USER_AGENTS[device]);
  const viewport = pick(VIEWPORTS[device]);
  const persona = pickPersona(campaign.persona);
  const sources = REFERRERS[campaign.traffic_source] || REFERRERS.organic;
  const referer = pick(sources);

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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent: ua,
      viewport,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ...(proxyConfig && { proxy: proxyConfig }),
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    if (referer) {
      await page.setExtraHTTPHeaders({ 'Referer': referer });
    }

    const pages = JSON.parse(campaign.pages || `["${campaign.target_url}"]`);
    const entryUrl = Math.random() < 0.8 ? campaign.target_url : pick(pages);

    await page.goto(entryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
      referer: referer || undefined,
    });

    pagesVisited++;
    await sleep(rand(1000, 3000));

    await humanScroll(page, persona);

    const vp = page.viewportSize();
    await moveMouse(page, rand(0, vp.width), rand(0, vp.height), rand(0, vp.width), rand(0, vp.height));

    const readTime = rand(persona.readTime[0], persona.readTime[1]) * 1000;
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, readTime - elapsed);

    let waited = 0;
    while (waited < remaining) {
      const chunk = rand(2000, 8000);
      await sleep(Math.min(chunk, remaining - waited));
      waited += chunk;
      if (Math.random() < 0.3) {
        await page.mouse.move(rand(0, vp.width), rand(0, vp.height));
      }
    }

    const maxPages = rand(persona.pagesVisited[0], persona.pagesVisited[1]);
    const bounce = Math.random() * 100 < campaign.bounce_rate;

    if (!bounce && maxPages > 1) {
      for (let i = 1; i < maxPages; i++) {
        const nextUrl = await clickRandomLink(page, campaign.target_url);
        if (!nextUrl) break;
        pagesVisited++;
        await sleep(rand(1000, 3000));
        await humanScroll(page, persona);
        await sleep(rand(persona.readTime[0], persona.readTime[1]) * 500);
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    await context.close();
    await browser.close();

    return { success: true, duration, pages: pagesVisited, persona: persona.name, device, ua };

  } catch (err) {
    try { await browser?.close(); } catch {}
    console.error(`[visit error] ${err.message}`);
    return { success: false, reason: err.message };
  }
}

async function runCampaign(campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign || campaign.status !== 'running') return;

  const proxies = db.prepare("SELECT * FROM proxies WHERE status = 'active'").all();
  if (!proxies.length) {
    db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaignId);
    return;
  }

  const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2');
  const remaining = campaign.visits_total - campaign.visits_sent;
  let i = 0;

  while (i < remaining) {
    const current = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId);
    if (current.status !== 'running') break;

    const batchSize = Math.min(MAX_CONCURRENT, remaining - i);
    const batch = [];

    for (let j = 0; j < batchSize; j++) {
      const proxy = proxies[(i + j) % proxies.length];
      batch.push(runVisit(campaign, proxy).then(r => ({ r, proxy })));
    }

    const settled = await Promise.allSettled(batch);

    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      const { r, proxy } = s.value;

      if (r.success) {
        db.prepare('UPDATE campaigns SET visits_sent = visits_sent + 1 WHERE id = ?').run(campaignId);
        db.prepare(`
          INSERT INTO visits (campaign_id, proxy_id, status, duration, pages, persona, device, user_agent)
          VALUES (?, ?, 'sent', ?, ?, ?, ?, ?)
        `).run(campaignId, proxy?.id, r.duration, r.pages, r.persona, r.device, r.ua);
        db.prepare('UPDATE proxies SET last_used = CURRENT_TIMESTAMP, visits_count = visits_count + 1 WHERE id = ?').run(proxy?.id);
        console.log(`[ok] ${r.device} ${r.persona} ${r.duration}s proxy#${proxy?.id}`);
      } else {
        db.prepare('UPDATE campaigns SET visits_failed = visits_failed + 1 WHERE id = ?').run(campaignId);
        db.prepare(`INSERT INTO visits (campaign_id, proxy_id, status) VALUES (?, ?, 'failed')`).run(campaignId, proxy?.id);
        console.log(`[fail] proxy#${proxy?.id} — ${r.reason?.slice(0, 100)}`);
      }
    }

    i += batchSize;
    await sleep(rand(5000, 15000));
  }

  const final = db.prepare('SELECT visits_sent, visits_total FROM campaigns WHERE id = ?').get(campaignId);
  const newStatus = final.visits_sent >= final.visits_total ? 'completed' : 'failed';
  db.prepare("UPDATE campaigns SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(newStatus, campaignId);
}

module.exports = { runCampaign };

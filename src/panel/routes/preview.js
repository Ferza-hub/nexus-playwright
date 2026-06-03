'use strict';

const https  = require('https');
const http   = require('http');
const { Router } = require('express');

const router = Router();

// In-memory cache — avoid re-fetching the same URL within 10 min
const _cache  = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// Block SSRF to private/loopback addresses
function _isPrivate(host) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|0\.0\.0\.0)/i.test(host);
}

function _fetchHtml(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 3) { reject(new Error('too many redirects')); return; }
    let parsed;
    try { parsed = new URL(url); } catch { reject(new Error('invalid url')); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { reject(new Error('bad protocol')); return; }
    if (_isPrivate(parsed.hostname)) { reject(new Error('private address')); return; }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
        res.destroy();
        _fetchHtml(next, hops + 1).then(resolve).catch(reject);
        return;
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        html += chunk;
        // 12 KB is more than enough to capture all <meta> tags in the <head>
        if (html.length > 12288) { res.destroy(); resolve(html); }
      });
      res.on('end', () => resolve(html));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function _extract(html) {
  // Match both attribute orders: property="og:X" content="..." and vice-versa
  const og = (prop) => {
    const re1 = new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : null;
  };
  const titleTag = () => { const m = html.match(/<title[^>]*>([^<]+)<\/title>/i); return m ? m[1].trim() : null; };

  return {
    image:       og('image'),
    title:       og('title') || titleTag(),
    description: og('description'),
  };
}

// GET /api/preview?url=...
router.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  // Basic URL validation
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    if (_isPrivate(u.hostname)) return res.status(400).json({ error: 'private address' });
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  const hit = _cache.get(url);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json(hit.data);

  try {
    const html = await _fetchHtml(url);
    const data = _extract(html);
    _cache.set(url, { data, ts: Date.now() });
    // Evict oldest if cache grows large
    if (_cache.size > 500) {
      const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      _cache.delete(oldest[0]);
    }
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;

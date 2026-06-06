#!/usr/bin/env node
'use strict';

// Check all active proxies: type (datacenter/residential), ISP, country, latency.
// Usage: node tools/check-proxies.js
// Reads proxies from the DB. Requires the app's .env to be present.

require('dotenv').config();
const http  = require('http');
const https = require('https');
const { getDb } = require('../src/database/db');

const CONCURRENCY = 5;
const TIMEOUT_MS  = 15_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ip-api.com — free, no key needed, returns hosting:true for datacenter IPs
function checkIp(proxyHost, proxyPort, proxyUser, proxyPass) {
  return new Promise((resolve) => {
    const auth    = proxyUser ? `${proxyUser}:${proxyPass}@` : '';
    const headers = { 'User-Agent': 'curl/7.88.1' };
    if (proxyUser) headers['Proxy-Authorization'] =
      'Basic ' + Buffer.from(`${proxyUser}:${proxyPass}`).toString('base64');

    const req = http.request({
      host:    proxyHost,
      port:    parseInt(proxyPort, 10),
      method:  'GET',
      path:    'http://ip-api.com/json?fields=query,isp,org,country,regionName,hosting,proxy,mobile',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: true, ...JSON.parse(data) }); }
        catch { resolve({ ok: false, err: 'parse_error' }); }
      });
    });

    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, err: e.message.slice(0, 60) }));
    req.end();
  });
}

function label(info) {
  if (!info.ok) return `FAIL  ${info.err}`;
  const type = info.hosting ? '\x1b[31mDATACENTER\x1b[0m' : '\x1b[32mRESIDENTIAL\x1b[0m';
  const flag  = info.proxy  ? ' [proxy-flagged]' : '';
  return `${type}${flag}  ${info.country}/${info.regionName}  ${(info.isp || info.org || '').slice(0, 40)}  → ${info.query}`;
}

async function run() {
  const db      = getDb();
  const proxies = db.prepare("SELECT * FROM proxies WHERE status='active' ORDER BY id").all();

  if (!proxies.length) {
    console.log('No active proxies in DB.');
    process.exit(0);
  }

  console.log(`\nChecking ${proxies.length} proxies (concurrency ${CONCURRENCY})...\n`);
  console.log(`${'ID'.padEnd(5)} ${'HOST:PORT'.padEnd(28)} RESULT`);
  console.log('─'.repeat(90));

  // Process in batches
  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const start = Date.now();

    const results = await Promise.all(
      batch.map(p => checkIp(p.host, p.port, p.username, p.password))
    );

    for (let j = 0; j < batch.length; j++) {
      const p    = batch[j];
      const info = results[j];
      const ms   = info.ok ? `${Date.now() - start}ms` : '';
      const addr = `${p.host}:${p.port}`.padEnd(28);
      console.log(`#${String(p.id).padEnd(4)} ${addr} ${label(info)}  ${ms}`);
    }
  }

  console.log('\nDone.\n');
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });

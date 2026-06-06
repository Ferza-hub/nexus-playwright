#!/usr/bin/env node
'use strict';

// Usage: node tools/gen-accounts.js <firstname> <lastname> <number> <base_password> [count] [--csv]
// Example: node tools/gen-accounts.js alex dempsey 08 MyPass99 20
// Add --csv to save to file (delete it after use — contains credentials)

const args     = process.argv.slice(2).filter(a => a !== '--csv');
const saveCSV  = process.argv.includes('--csv');
const [first='alex', last='dempsey', num='08', basePass='Pass123', countArg='20'] = args;
const COUNT = parseInt(countArg, 10);

const f  = first.toLowerCase();
const l  = last.toLowerCase();
const F  = first[0].toUpperCase() + first.slice(1).toLowerCase();
const L  = last[0].toUpperCase() + last.slice(1).toLowerCase();
const n  = num;
const n2 = String(parseInt(n, 10) + 1).padStart(n.length, '0');
const n3 = String(parseInt(n, 10) + 2).padStart(n.length, '0');

// ── Username templates ──────────────────────────────────────────────────────
const userTemplates = [
  `${f}${l}${n}`,
  `${f}.${l}${n}`,
  `${f}${l}.${n}`,
  `${l}.${f}`,
  `${l}.${f}${n}`,
  `${l}${f}${n}`,
  `${f}.${l}`,
  `${f}${n}`,
  `${f}${n2}`,
  `${f}${n3}`,
  `${l}${n}`,
  `${l}${n2}`,
  `${f[0]}${l}${n}`,
  `${f[0]}.${l}${n}`,
  `${f[0]}${l}`,
  `${f[0]}.${l}`,
  `${f}${l[0]}${n}`,
  `${f}.${l[0]}${n}`,
  `${f}${l}`,
  `${l}${f}`,
  `${f}.${l}.${n}`,
  `${l}.${f}.${n}`,
  `${f[0]}${f.slice(1)}${l[0]}${n}`,
  `${f}${l.slice(0,4)}${n}`,
  `${l.slice(0,4)}${f}${n}`,
  `${f}${l}${n}${n2}`,
  `real.${f}.${l}`,
  `the.${f}.${l}`,
  `${f}_${l}${n}`,
  `${l}_${f}${n}`,
];

// ── Password templates ──────────────────────────────────────────────────────
function passvariants(base) {
  const b  = base;
  const B  = base[0].toUpperCase() + base.slice(1);
  const b_ = base.toLowerCase();
  const B_ = base.toUpperCase();
  return [
    `${b}!`,
    `${B}!`,
    `${b}@${n}`,
    `${B}@${n}`,
    `${b}#${n}`,
    `${b}${n}!`,
    `${B}${n}!`,
    `${b_}${n}@`,
    `${B_}${n}`,
    `${b}${n}${n2}`,
    `${b}.${n}`,
    `${B}.${n}`,
    `${f}${B}${n}!`,
    `${F}${b}${n}`,
    `${b}${F}${n}`,
    `${b}${L}${n}`,
    `${F}${L}${n}!`,
    `${b}${n}#${n2}`,
    `${B}${n}#`,
    `${b}!${n}`,
  ];
}

const usernames = [...new Set(userTemplates)];
const passwords = [...new Set(passvariants(basePass))];

// ── Pair & output ───────────────────────────────────────────────────────────
const rows = [];
for (let i = 0; i < COUNT; i++) {
  const user = usernames[i % usernames.length];
  const pass = passwords[i % passwords.length];
  rows.push({ email: `${user}@gmail.com`, username: user, password: pass });
}

// Print table
console.log('\n' + '─'.repeat(72));
console.log(`${'EMAIL'.padEnd(38)} ${'PASSWORD'.padEnd(22)}`);
console.log('─'.repeat(72));
rows.forEach(r => {
  console.log(`${r.email.padEnd(38)} ${r.password.padEnd(22)}`);
});
console.log('─'.repeat(72));
console.log(`\nTotal: ${rows.length} accounts\n`);

// CSV only if --csv flag passed — delete the file after use
if (saveCSV) {
  const fs  = require('fs');
  const csv = 'email,username,password\n' +
    rows.map(r => `${r.email},${r.username},${r.password}`).join('\n');
  const out = `tools/accounts-${f}${l}-${Date.now()}.csv`;
  fs.writeFileSync(out, csv);
  console.log(`CSV saved → ${out}`);
  console.log('⚠  Delete this file after use — it contains credentials.\n');
}

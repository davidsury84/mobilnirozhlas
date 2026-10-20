#!/usr/bin/env node
'use strict';
/* Přegenerování doprava/seed-ekonomika.json z xlsx snímku sešitu „Auta-doprava2026" (list auta-2026).
   Použití:  node tools-doprava-seed-ekonomika.js <cesta.xlsx | ID souboru na Disku>
   Z Disku se stahuje service accountem (GOOGLE_SA_CLIENT_EMAIL/PRIVATE_KEY v prostředí) —
   spouštět přes `railway run --service mobilnirozhlas node tools-doprava-seed-ekonomika.js <ID>`.
   Proč snímek a ne živá tabulka: nativní Google verze sešitu má ve vzorcích #REF! (externí odkazy),
   hodnoty drží jen xlsx export. Bez závislostí — xlsx čte čtečka z doprava/lib/nafta.js. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { xlsxRows } = require('./doprava/lib/nafta');
const { parseEkonomika } = require('./doprava/index');
const OUT = path.join(__dirname, 'doprava', 'seed-ekonomika.json');

async function tokenSA() {
  const email = process.env.GOOGLE_SA_CLIENT_EMAIL, key = String(process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('chybí GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY (spusť přes railway run)');
  const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cl = b64u(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(hdr + '.' + cl).sign(key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + hdr + '.' + cl + '.' + sig });
  const j = await r.json(); if (!j.access_token) throw new Error('token SA: ' + JSON.stringify(j).slice(0, 160)); return j.access_token;
}
async function nactiXlsx(arg) {
  if (fs.existsSync(arg)) return { buf: fs.readFileSync(arg), nazev: path.basename(arg) };
  const t = await tokenSA();
  const meta = await (await fetch('https://www.googleapis.com/drive/v3/files/' + arg + '?fields=name,modifiedTime&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + t } })).json();
  const r = await fetch('https://www.googleapis.com/drive/v3/files/' + arg + '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + t } });
  if (!r.ok) throw new Error('Drive HTTP ' + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), nazev: (meta.name || arg) + (meta.modifiedTime ? ' (' + meta.modifiedTime.slice(0, 10) + ')' : '') };
}
// List auta-2026 poznáme podle obsahu: řádky „SPZ | 501100 PHM | …" (názvy listů minimální čtečka nevrací).
function najdiAuta(sheets) {
  let best = null, max = 0;
  for (const rows of sheets) {
    const n = rows.filter((r) => /^[0-9][A-Z][A-Z0-9]\s?\d{4}$/i.test(String(r[0] || '').trim()) && /^501100/.test(String(r[1] || ''))).length;
    if (n > max) { max = n; best = rows; }
  }
  if (!best) throw new Error('v xlsx není list auta-2026 (řádky SPZ | 501100 PHM)');
  return best.map((r) => r.map((c) => (c == null ? '' : c)));
}
(async () => {
  const arg = process.argv[2]; if (!arg) { console.error('zadej cestu k xlsx nebo ID souboru na Disku'); process.exit(1); }
  const { buf, nazev } = await nactiXlsx(arg);
  const rows = najdiAuta(xlsxRows(buf));
  const ek = parseEkonomika(rows);
  if (!ek.vozy || !ek.vozy.length) throw new Error('parser nenašel žádný vůz');
  // poměrové řádky sešitu (Tržby na Km, Opravy / Tržby) nejsou náklady — do položek nepatří
  ek.vozy.forEach((v) => { v.polozky = v.polozky.filter((p) => !/tržby na km|opravy \/ tržby/i.test(p.nazev)); });
  const datum = (nazev.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || new Date().toISOString().slice(0, 10);
  const seed = { zdroj: 'snapshot Auta-doprava2026 (' + datum + ')', rok: ek.rok || 2026, mesiceSdaty: ek.mesiceSdaty, vozy: ek.vozy };
  const sum = (k) => seed.vozy.reduce((a, v) => a + ((v.souhrny[k] && v.souhrny[k].celkem) || 0), 0);
  fs.writeFileSync(OUT, JSON.stringify(seed));
  console.log('seed zapsán:', OUT, '| zdroj:', seed.zdroj, '| měsíce', JSON.stringify(seed.mesiceSdaty), '| vozů', seed.vozy.length, '| tržby', Math.round(sum('trzby')).toLocaleString('cs-CZ'), '| HV', Math.round(sum('hv')).toLocaleString('cs-CZ'));
})().catch((e) => { console.error('CHYBA:', e.message); process.exit(1); });

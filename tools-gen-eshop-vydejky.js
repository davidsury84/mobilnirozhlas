#!/usr/bin/env node
/**
 * Seed výdejek e-shopu z exportu „Expediční příkazy" (řada 441 = celý e-shop, prodejní ceny).
 * Výstup eshop-vydejky.json v kořeni = commitnutý základ; nahrání v appce (volume) má
 * u shodného dne přednost. Stejná logika jako vydParseWorkbook() v SMI_aplikace.html.
 *
 * Použití: node tools-gen-eshop-vydejky.js "~/Downloads/objednávky eshop 2026.xlsx"
 */
const fs = require('fs'), path = require('path');
const X = require('./nakup-report/xlsx-mini');
const src = process.argv[2] || path.join(process.env.HOME, 'Downloads', 'objednávky eshop 2026.xlsx');
const s = X.parse(fs.readFileSync(src));
const H = s[0].map(x => String(x == null ? '' : x).trim());
const c = n => { const i = H.indexOf(n); if (i < 0) throw new Error('chybí sloupec ' + n); return i; };
const I = { zak: c('Číslo zakázky'), dr: H.indexOf('Druh pohybu'), sk: c('SK'), reg: c('Reg. č.'), n: c('Název 1'), q: c('Množství'), kc: c('CC bez daní'), dat: c('Datum případu'), nm: H.indexOf('Název'), ico: H.indexOf('IČO') };
const den = v => { if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const m = String(v || '').match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/); return m ? (m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0')) : ''; };
const dny = {}; let radku = 0, jine = 0;
for (let i = 1; i < s.length; i++) { const r = s[i];
  if (I.dr >= 0) { const dr = String(r[I.dr] || '').trim(); if (dr && !/exped/i.test(dr)) { jine++; continue; } }
  const d = den(r[I.dat]); if (!d) continue;
  const sk = String(r[I.sk] || '').trim(), id = sk + '-' + String(r[I.reg] || '').trim(); if (id === '-') continue;
  const ks = +r[I.q] || 0, kc = +r[I.kc] || 0, zak = String(r[I.zak] || ''), nm = I.nm >= 0 ? String(r[I.nm] || '').trim() : '', ico = I.ico >= 0 ? String(r[I.ico] || '').trim() : '';
  const D = dny[d] || (dny[d] = { zak: new Set(), radku: 0, ks: 0, kc: 0, dopravaKc: 0, b2bKc: 0, b2cKc: 0, polozky: {}, zakaznici: {} });
  D.zak.add(zak); D.radku++; D.ks += ks; D.kc += kc; if (sk === '900') D.dopravaKc += kc; if (ico) D.b2bKc += kc; else D.b2cKc += kc;
  const q = D.polozky[id] || (D.polozky[id] = { ks: 0, kc: 0, n: String(r[I.n] || '').trim() }); q.ks += ks; q.kc += kc;
  if (nm) { const z = D.zakaznici[nm] || (D.zakaznici[nm] = { kc: 0, zak: new Set(), ico }); z.kc += kc; z.zak.add(zak); }
  radku++; }
const out = {};
Object.keys(dny).sort().forEach(d => { const D = dny[d]; const zk = {};
  Object.keys(D.zakaznici).forEach(n => { const z = D.zakaznici[n]; zk[n] = { kc: Math.round(z.kc), zak: z.zak.size, ico: z.ico }; });
  const pol = {}; Object.keys(D.polozky).forEach(k => { pol[k] = { ks: +D.polozky[k].ks.toFixed(3), kc: Math.round(D.polozky[k].kc), n: D.polozky[k].n.slice(0, 120) }; });
  out[d] = { zakazek: D.zak.size, radku: D.radku, ks: +D.ks.toFixed(3), kc: Math.round(D.kc), dopravaKc: Math.round(D.dopravaKc), b2bKc: Math.round(D.b2bKc), b2cKc: Math.round(D.b2cKc), polozky: pol, zakaznici: zk }; });
const ds = Object.keys(out).sort();
const rec = { seed: true, nahrano: { kdy: new Date().toISOString(), kdo: 'seed z repa', source: path.basename(src), od: ds[0], do: ds[ds.length - 1], dnu: ds.length, radku }, dny: out };
fs.writeFileSync(path.join(__dirname, 'eshop-vydejky.json'), JSON.stringify(rec));
console.log('eshop-vydejky.json: ' + ds.length + ' dnů (' + ds[0] + '…' + ds[ds.length - 1] + '), ' + radku + ' řádků' + (jine ? ', přeskočeno ' + jine + ' jiných pohybů' : ''));

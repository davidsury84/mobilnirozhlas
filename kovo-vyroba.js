'use strict';
// Přehled výroby KOVO — čte knihy zakázek 4 závodů z Google Sheets (service account,
// vzor modul Doprava). Každý závod má vlastní list a rozložení sloupců.
// Normalizace zakázky: { zavod, cvz, vyrobek, ks, zeDne, termin, expedice, zakaznik, storno, rok }
//   termin   = potvrzený/požadovaný termín expedice (plán)
//   expedice = skutečné datum expedice, pokud ho závod eviduje (jinak null)
// „Expedováno" (hotové) se počítá až v UI podle dneška — viz SLEDUJE_EXPEDICI.

const sheets = require('./doprava/lib/sheets');
const fs = require('node:fs');
const path = require('node:path');
const SNAPSHOT_FILE = path.join(__dirname, 'kovo-vyroba-snapshot.json');

// Závody, které v knize evidují SKUTEČNÉ datum expedice (jinak se „hotové" bere podle potvrzeného termínu).
const SLEDUJE_EXPEDICI = { brpopelnice: true, supikovice: true };

const ZAVODY = [
  { klic: 'chomutov',    nazev: 'Chomutov',            id: '1mh8Fhi39uClg0xXvKuWvEDqmFvF5-mWv_8IA1cStBQM', listy: [/^zakázky CV \d{4}$/i] },
  { klic: 'polsko',      nazev: 'Polsko',              id: '1d9GEieuF9P3vlJXgIfuFFHJkmNZwUldB9NNfnVGlV0E', listy: [/^Order book active$/i] },
  { klic: 'bruntal',     nazev: 'Bruntál',             id: '1CWoHIcbSR7Z5V1PjKE2QslOZ60JrZUPUD_Hhuexizaw', listy: [/^Zak\.Bruntál$/i, /^Exp\. zakázky 2024-2026$/i] },
  { klic: 'brpopelnice', nazev: 'Bruntál — popelnice', id: '1620BTnSV5qlN25CcSg60CuTOgqiey6ck2eC_JKFOIbE', listy: [/^Boxy contract \d{4}$/i] },
  { klic: 'supikovice',  nazev: 'Supíkovice',          id: '19ZskN-LJssZvGwRuEJ7rjfn19dsQqzZs-2z_sbXi-yY', listy: [/^zakázky Supíkovice$/i] },
];

function datum(s) {
  const str = String(s || '').trim();
  if (/^\d{4,5}(\.\d+)?$/.test(str)) {                 // Excel serial (dny od 1899-12-30, vč. leap-bug)
    const n = parseFloat(str);
    if (n >= 20000 && n <= 60000) return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
  }
  const m = str.match(/(\d{1,2})\s*\.\s*(\d{1,2})\s*\.+\s*(20\d{2})/);
  if (!m) return null;
  return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
}
function cislo(s) { const m = String(s || '').replace(',', '.').match(/\d+(?:\.\d+)?/); if (!m) return 0; const n = Math.round(parseFloat(m[0])); return n > 0 && n < 100000 ? n : 0; }
function rokZPrefixu(s) { const m = String(s || '').match(/(2\d)[A-Z]\s?\d/); return m ? 2000 + Number(m[1]) : null; }
const STORNO_RE = /storno/i;
function jeZakazka(vyrobek, ks, zeDne) {
  const v = String(vyrobek || '').trim();
  if (!v || /^výrobek$/i.test(v) || /^předmět/i.test(v) || /^product/i.test(v) || /^20\d{2}$/.test(v)) return false;
  return !!(ks || zeDne);
}

/* Mapy sloupců ověřené na reálných knihách zakázek (2026-07). expedice=null → skutečnou expedici
   kniha neeviduje, „hotové" se pozná podle potvrzeného termínu (viz SLEDUJE_EXPEDICI). */
const MAPY = {
  // ČVZ = prefix(0)+pořadí(1), rok z prefixu (26C…)
  chomutov: { prefix: 0, poradi: 1, vyrobek: 2, ks: 7, zeDne: 10, termin: 12, expedice: null, zakaznik: 16 },
  bruntal:  { prefix: 0, poradi: 1, vyrobek: 2, ks: 7, zeDne: 10, termin: 12, expedice: null, zakaznik: 16 },
  // Boxy CPR: Zadáno(2)=datum přijetí, Výrobek(3), Ks(6), plán(15), skutečná Expedice(17), Místo dodání(14)
  brpopelnice: { prefix: 0, poradi: 1, vyrobek: 3, ks: 6, zeDne: 2, termin: 15, expedice: 17, zakaznik: 14 },
};

function parseRows(klic, rows) {
  const out = [];
  if (klic === 'polsko') {
    for (const r of rows) {
      const vyrobek = r[1], ks = cislo(r[6]), zeDne = datum(r[9]);
      if (!jeZakazka(vyrobek, ks, zeDne)) continue;
      out.push({
        cvz: String(r[0] || '').trim() || null, vyrobek: String(vyrobek).trim(), ks,
        zeDne, termin: datum(r[11]), expedice: null,
        zakaznik: String(r[4] || '').trim() || null,
        storno: STORNO_RE.test(r.join(' ')),
        rok: rokZPrefixu(r[8]) || (zeDne ? Number(zeDne.slice(0, 4)) : null),
      });
    }
    return out;
  }
  if (klic === 'supikovice') {
    for (const r of rows) {
      const vyrobek = r[2], ks = cislo(r[10]), zeDne = datum(r[14]);
      if (!jeZakazka(vyrobek, ks, zeDne)) continue;
      const cvz = String(r[1] || '').trim();
      let rok = null; let m = cvz.match(/\b(2\d)S/); if (m) rok = 2000 + Number(m[1]);
      if (!rok) { m = cvz.match(/SU\s?(\d\d)/i); if (m) rok = 2000 + Number(m[1]); }
      if (!rok) { m = cvz.match(/^(20\d{2})\//); if (m) rok = Number(m[1]); }
      if (!rok && zeDne) rok = Number(zeDne.slice(0, 4));
      out.push({
        cvz: cvz || null, vyrobek: String(vyrobek).trim(), ks,
        zeDne, termin: datum(r[16]), expedice: datum(r[17]),
        zakaznik: String(r[18] || '').trim() || null,
        storno: STORNO_RE.test(r.join(' ')), rok,
      });
    }
    return out;
  }
  const map = MAPY[klic]; if (!map) return out;
  for (const r of rows) {
    const vyrobek = r[map.vyrobek], ks = cislo(r[map.ks]), zeDne = datum(r[map.zeDne]);
    if (!jeZakazka(vyrobek, ks, zeDne)) continue;
    const prefix = String(r[map.prefix] || '').trim();
    const rokM = prefix.match(/^(2\d)[A-Z]$/);
    out.push({
      cvz: prefix && r[map.poradi] ? prefix + String(r[map.poradi]).trim() : null,
      vyrobek: String(vyrobek).trim(), ks,
      zeDne, termin: datum(r[map.termin]),
      expedice: map.expedice != null ? datum(r[map.expedice]) : null,
      zakaznik: String(r[map.zakaznik] || '').trim() || null,
      storno: STORNO_RE.test([r[6], r[16], r[24], vyrobek].join(' ')),
      rok: rokM ? 2000 + Number(rokM[1]) : (zeDne ? Number(zeDne.slice(0, 4)) : null),
    });
  }
  return out;
}

// Načte jen relevantní list(y) knihy zakázek a vybere řádky aktuálního roku.
async function nactiZavod(z, rok) {
  const listy = (await sheets.listSheets(z.id)).filter((s) => !s.hidden);
  const vybrane = listy.filter((l) => z.listy.some((re) => re.test(l.title)));
  let vsechny = [];
  for (const l of vybrane) {
    try {
      const rows = await sheets.readValues(z.id, `'${l.title.replace(/'/g, "''")}'!A1:AH6000`);
      vsechny = vsechny.concat(parseRows(z.klic, rows || []));
    } catch (_) {}
  }
  const seen = new Set(); const out = [];
  for (const x of vsechny) {
    const k = [x.cvz, x.vyrobek, x.zeDne, x.ks].join('|');
    if (seen.has(k)) continue; seen.add(k);
    if (x.rok === rok) out.push({ ...x, zavod: z.klic });
  }
  return out;
}

let _cache = { at: 0, data: null };
const TTL = 30 * 60 * 1000;

function meta(extra) {
  return Object.assign({
    zavody: ZAVODY.map((z) => ({ klic: z.klic, nazev: z.nazev, url: 'https://docs.google.com/spreadsheets/d/' + z.id })),
    sledujeExpedici: SLEDUJE_EXPEDICI,
    saEmail: sheets.saEmail(),
  }, extra);
}

async function fetchVyroba({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache.data && now - _cache.at < TTL) return _cache.data;
  const rok = new Date().getFullYear();
  const chyby = {}; let zakazky = []; let zivych = 0;
  for (const z of ZAVODY) {
    try { const r = await nactiZavod(z, rok); zakazky = zakazky.concat(r); zivych++; }
    catch (e) { chyby[z.klic] = String(e.message || e).slice(0, 120); }
  }
  const data = meta({ rok, zakazky, chyby, zivaData: zivych > 0, aktualizovano: new Date().toISOString() });
  if (zivych > 0) { _cache = { at: now, data }; return data; }
  if (fs.existsSync(SNAPSHOT_FILE)) {
    try { return fromSnapshot(JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'))); } catch (_) {}
  }
  return data;
}

function fromSnapshot(snap) {
  const rok = new Date().getFullYear();
  return meta({
    rok, zakazky: (snap.zakazky || []).filter((z) => z.rok === rok), chyby: {},
    zivaData: false, snapshot: snap.porizeno || null, aktualizovano: snap.porizeno || new Date().toISOString(),
  });
}

module.exports = { fetchVyroba, fromSnapshot, parseRows, ZAVODY, MAPY, SLEDUJE_EXPEDICI };

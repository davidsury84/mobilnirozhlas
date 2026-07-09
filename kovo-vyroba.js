'use strict';
// Přehled výroby KOVO — čte knihy zakázek 4 závodů z Google Sheets (service account,
// stejný vzor jako modul Doprava). Tabulky musí být nasdílené SA jako Čtenář.
// Normalizace: { zavod, cvz, vyrobek, ks, zeDne, termin, hotovo, zakaznik, storno }

const sheets = require('./doprava/lib/sheets');
const fs = require('node:fs');
const path = require('node:path');
const SNAPSHOT_FILE = path.join(__dirname, 'kovo-vyroba-snapshot.json');

const ZAVODY = [
  { klic: 'chomutov',    nazev: 'Chomutov',            id: '1mh8Fhi39uClg0xXvKuWvEDqmFvF5-mWv_8IA1cStBQM' },
  { klic: 'polsko',      nazev: 'Polsko',              id: '1d9GEieuF9P3vlJXgIfuFFHJkmNZwUldB9NNfnVGlV0E' },
  { klic: 'bruntal',     nazev: 'Bruntál',             id: '1CWoHIcbSR7Z5V1PjKE2QslOZ60JrZUPUD_Hhuexizaw' },
  { klic: 'brpopelnice', nazev: 'Bruntál — popelnice', id: '1620BTnSV5qlN25CcSg60CuTOgqiey6ck2eC_JKFOIbE' },
  { klic: 'supikovice',  nazev: 'Supíkovice',          id: '19ZskN-LJssZvGwRuEJ7rjfn19dsQqzZs-2z_sbXi-yY' },
];

// Tolerantní datum: "5.1.2026", "05. 01. 2026" i Excel sériové číslo (46119) — vrací YYYY-MM-DD nebo null.
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
// Počet kusů: první číslo (i „6.0", „48.0", „2+2" → 6/48/2). Ne prostý strip číslic (ten z „6.0" udělá 60).
function cislo(s) { const m = String(s || '').replace(',', '.').match(/\d+(?:\.\d+)?/); if (!m) return 0; const n = Math.round(parseFloat(m[0])); return n > 0 && n < 100000 ? n : 0; }
const STORNO_RE = /storno/i;

// Řádek je zakázka, pokud má výrobek a (ks nebo datum) — přeskočí hlavičky, mezisoučty, roční předěly.
function jeZakazka(vyrobek, ks, zeDne) {
  const v = String(vyrobek || '').trim();
  if (!v || /^výrobek$/i.test(v) || /^předmět/i.test(v) || /^20\d{2}$/.test(v)) return false;
  return !!(ks || zeDne);
}

/* Mapování sloupců podle závodu (index od 0). „hotovo" = skutečný termín expedice
   (vyplněný ⇒ vyrobeno/expedováno; „x" bez data ⇒ hotovo bez známého data). */
const PARSERY = {
  chomutov(rows) { return knihaZakazek(rows, { prefix: 0, poradi: 1, vyrobek: 2, ks: 7, zeDne: 10, termin: 12, hotovo: 13, zakaznik: 16, stornoV: [6, 19, 20] }); },
  bruntal(rows)  { return knihaZakazek(rows, { prefix: 0, poradi: 1, vyrobek: 2, ks: 7, zeDne: 10, termin: 12, hotovo: 13, zakaznik: 16, stornoV: [6, 24] }); },
  // paletové boxy CPR: datum přijetí je ve sl. 2, výrobek sl. 3, „Místo dodání" = zákazník sl. 14
  brpopelnice(rows) { return knihaZakazek(rows, { prefix: 0, poradi: 1, vyrobek: 3, ks: 6, zeDne: 2, termin: 15, hotovo: 17, zakaznik: 14, stornoV: [16] }); },
  // Supíkovice: ČVZ v jednom sloupci („19S001", „SU18/009"), ks sl. 10, datumy 14/16/17, zákazník 18
  supikovice(rows) {
    const out = [];
    for (const r of rows) {
      const vyrobek = r[2], ks = cislo(r[10]), zeDne = datum(r[14]);
      if (!jeZakazka(vyrobek, ks, zeDne)) continue;
      const cvz = String(r[1] || '').trim();
      let rok = null;
      let m = cvz.match(/\b(2\d)S/); if (m) rok = 2000 + Number(m[1]);
      if (!rok) { m = cvz.match(/SU\s?(\d\d)/i); if (m) rok = 2000 + Number(m[1]); }
      if (!rok && zeDne) rok = Number(zeDne.slice(0, 4));
      out.push({
        cvz: cvz || null, vyrobek: String(vyrobek).trim(), ks,
        zeDne, termin: datum(r[16]), hotovo: datum(r[17]),
        zakaznik: String(r[18] || '').trim() || null,
        storno: STORNO_RE.test(r.join(' ')), rok,
      });
    }
    return out;
  },
  polsko(rows) {
    const out = [];
    for (const r of rows) {
      const vyrobek = r[1], ks = cislo(r[6]), zeDne = datum(r[9]);
      if (!jeZakazka(vyrobek, ks, zeDne)) continue;
      const hotovoRaw = String(r[12] || '').trim();
      out.push({
        cvz: String(r[0] || '').trim() || null,
        vyrobek: String(vyrobek).trim(), ks,
        zeDne, termin: datum(r[11]),
        hotovo: datum(r[12]) || (hotovoRaw ? 'ano' : null),
        zakaznik: String(r[4] || r[8] || '').trim() || null,   // odběratelský závod / objednávka
        storno: STORNO_RE.test(r.join(' ')),
        rok: rokZPrefixu(r[8]) || (zeDne ? Number(zeDne.slice(0, 4)) : null),
      });
    }
    return out;
  },
};
function rokZPrefixu(s) { const m = String(s || '').match(/(2\d)[A-Z]\s?\d/); return m ? 2000 + Number(m[1]) : null; }

function knihaZakazek(rows, map) {
  const out = [];
  for (const r of rows) {
    const vyrobek = r[map.vyrobek], ks = cislo(r[map.ks]), zeDne = datum(r[map.zeDne]);
    if (!jeZakazka(vyrobek, ks, zeDne)) continue;
    const prefix = String(r[map.prefix] || '').trim();
    const rokM = prefix.match(/^(2\d)[A-Z]$/);
    const hotovoRaw = String(r[map.hotovo] || '').trim();
    const stornoTxt = (map.stornoV || []).map((i) => r[i] || '').join(' ') + ' ' + String(vyrobek);
    out.push({
      cvz: prefix && r[map.poradi] ? prefix + String(r[map.poradi]).trim() : null,
      vyrobek: String(vyrobek).trim(), ks,
      zeDne, termin: datum(r[map.termin]),
      hotovo: datum(r[map.hotovo]) || (/^x+$/i.test(hotovoRaw) ? 'ano' : null),
      zakaznik: String(r[map.zakaznik] || '').trim() || null,
      storno: STORNO_RE.test(stornoTxt),
      rok: rokM ? 2000 + Number(rokM[1]) : (zeDne ? Number(zeDne.slice(0, 4)) : null),
    });
  }
  return out;
}

// Načte všechny listy tabulky a vybere řádky aktuálního roku (list může být jeden souvislý,
// nebo po letech — bereme všechny listy a filtrujeme podle roku záznamu).
async function nactiZavod(z, rok) {
  const listy = (await sheets.listSheets(z.id)).filter((s) => !s.hidden);
  let vsechny = [];
  for (const l of listy.slice(0, 6)) {
    try {
      const rows = await sheets.readValues(z.id, `'${l.title}'!A1:Z3000`);
      vsechny = vsechny.concat((PARSERY[z.klic] || (() => []))(rows || []));
    } catch (_) {}
  }
  // dedup (stejný list vícekrát / duplicitní řádky) dle cvz+vyrobek+zeDne
  const seen = new Set();
  const out = [];
  for (const x of vsechny) {
    const k = [x.cvz, x.vyrobek, x.zeDne, x.ks].join('|');
    if (seen.has(k)) continue; seen.add(k);
    if (x.rok === rok) out.push({ ...x, zavod: z.klic });
  }
  return out;
}

let _cache = { at: 0, data: null };
const TTL = 30 * 60 * 1000; // 30 min

async function fetchVyroba({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache.data && now - _cache.at < TTL) return _cache.data;
  const rok = new Date().getFullYear();
  const chyby = {};
  let zakazky = [];
  let zivych = 0;
  for (const z of ZAVODY) {
    try { const r = await nactiZavod(z, rok); zakazky = zakazky.concat(r); zivych++; }
    catch (e) { chyby[z.klic] = String(e.message || e).slice(0, 120); }
  }
  const data = {
    rok, zakazky, chyby,
    zivaData: zivych > 0,
    zavody: ZAVODY.map((z) => ({ klic: z.klic, nazev: z.nazev, url: 'https://docs.google.com/spreadsheets/d/' + z.id })),
    saEmail: sheets.saEmail(),
    aktualizovano: new Date().toISOString(),
  };
  if (zivych > 0) _cache = { at: now, data };
  // žádný závod nešel načíst (SA zatím nemá přístup) → jednorázový snímek, pokud existuje
  if (zivych === 0 && fs.existsSync(SNAPSHOT_FILE)) {
    try { const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); return fromSnapshot(snap); } catch (_) {}
  }
  return data;
}

// Sestaví data z předpřipravených zakázek (jednorázový snímek, když SA ještě nevidí do Sheets).
function fromSnapshot(snap) {
  const rok = new Date().getFullYear();
  const zakazky = (snap.zakazky || []).filter((z) => z.rok === rok);
  return {
    rok, zakazky, chyby: {},
    zivaData: false,
    snapshot: snap.porizeno || null,
    zavody: ZAVODY.map((z) => ({ klic: z.klic, nazev: z.nazev, url: 'https://docs.google.com/spreadsheets/d/' + z.id })),
    saEmail: sheets.saEmail(),
    aktualizovano: snap.porizeno || new Date().toISOString(),
  };
}

module.exports = { fetchVyroba, fromSnapshot, ZAVODY, PARSERY };

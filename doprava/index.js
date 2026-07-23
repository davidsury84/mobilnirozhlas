'use strict';
// Modul „Doprava" — výkony a náklady vozového parku, data živě z Google Sheets.
// Zapojení v server.js:
//   const doprava = require('./doprava').mount({ send, readBody, empSession, isAdmin, employeeModules, dataDir });
//   ...v handleru: if (await doprava.handle(req, res)) return;
//   ...ve startu:  doprava.tick(); setInterval(doprava.tick, 6*3600*1000);
// Env:
//   DOPRAVA_SHEET_VYKONY_ID   tabulka výkonů (km/tržby po měsících; výchozí = ostrá tabulka)
//   DOPRAVA_SHEET_NAKLADY_ID  tabulka nákladové kalkulace (výchozí = ostrá tabulka)
// Obě tabulky je nutné nasdílet service accountu (GOOGLE_SA_CLIENT_EMAIL) jako Prohlížející.

const path = require('path');
const fs = require('fs');
const urlLib = require('url');
const sheets = require('./lib/sheets');

const HTML_FILE = path.join(__dirname, 'doprava.html');
// Výkony můžou být ve více souborech (ročníky „Daily report ECZ"); čte se ze všech
// nasdílených a použije se ten s nejnovějšími měsíci. Víc ID odděl čárkou.
// Historické ročníky (2021…) sem NEPATŘÍ — ty jsou jen pro srovnávací analytiku.
const VYKONY_IDS = () => (process.env.DOPRAVA_SHEET_VYKONY_ID || '1Na7nDmIdSkbpviGfVDRHWsC6kcQacFIFLVx7vaBGVy4')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Účetní skutečnost po vozech (list „auta-2026"). Výchozí data jsou přibalený snapshot
// (doprava/seed-ekonomika.json); živé čtení se zapne nastavením DOPRAVA_SHEET_EKONOMIKA_ID
// na ID nativní Google tabulky se stejnou strukturou (nasdílené robotovi).
const EKONOMIKA_ID = () => (process.env.DOPRAVA_SHEET_EKONOMIKA_ID || '').trim();
// Historické ročníky pro záložku Historie (meziroční srovnání, sezónnost, vývoj vozů).
// Načte se, co je robotovi nasdílené; nenasdílené ročníky se tiše přeskočí.
const HISTORIE_IDS = () => (process.env.DOPRAVA_SHEET_HISTORIE_IDS
  || '1ZTPTuRdZvbOWOiHuVwdoMOhs_r3rS6OmBCabKJ8dmio,1TBPZVRkjzbKjqiDi5YvxxfMoFVmRi8tCzXiejLYpFl0,1CHrbCwh7txbw9RPdZbOFYM89vxuIeoEyhTxqrLnQXok')
  .split(',').map((s) => s.trim()).filter(Boolean);
const NAKLADY_ID = () => process.env.DOPRAVA_SHEET_NAKLADY_ID || '1sVQBx0Weo2Ds9Gfgqwd-LyTVvQ_cBQBtUh7QzDSmnOE';
const VOZY_ID = () => process.env.DOPRAVA_SHEET_VOZY_ID || '1nWnbtWffoyeaSyy4pEqiHEIIcw0L1dhnLunIyzZLJhg';

/* ---------- parsování čísel z formátovaných buněk ---------- */
// Zvládá český i americký zápis: "197 800 Kč" → 197800; "13,45 Kč" → 13.45;
// "48,000.00 Kč" → 48000; "10,000" → 10000; "29,3" i "29.3" → 29.3; jiné → null
function parseNum(v) {
  if (v == null) return null;
  let s = String(v).replace(/\u00a0/g, ' ').replace(/K\u010d/gi, '').trim();
  if (!s || /^#/.test(s)) return null;              // #DIV/0! apod.
  s = s.replace(/ /g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');            // 129,430.76 -> 129430.76
  else if (/,\d{3}(,\d{3})*$/.test(s)) s = s.replace(/,/g, '');               // 10,000 -> 10000 (oddelovac tisicu)
  else s = s.replace(',', '.');                                               // 29,3 -> 29.3 (desetinna carka)
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
// normalizace textu pro hledání štítků: malá písmena, bez diakritiky, jedna mezera
function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

/* ---------- tabulka výkonů: bloky měsíců (Vozidlo | SPZ | km | tržby | průměr …) ---------- */
function parseVykony(rows) {
  const veh = new Map();
  let colMap = null;   // [{col, mesic:'2026-01'}] — platí do dalšího řádku s hlavičkou měsíců
  for (const r of rows) {
    const hdr = [];
    (r || []).forEach((c, i) => {
      const m = String(c || '').trim().match(/^(\d{1,2})\/(\d{4})$/);
      if (m) hdr.push({ col: i, mesic: m[2] + '-' + String(m[1]).padStart(2, '0') });
    });
    if (hdr.length >= 2) { colMap = hdr; continue; }
    if (!colMap) continue;
    const cislo = String((r || [])[0] || '').trim();
    if (!/^\d+$/.test(cislo)) continue;               // datové řádky mají v A čísle vozidla
    const spz = String((r || [])[1] || '').trim();
    let v = veh.get(cislo);
    if (!v) { v = { cislo, spz: spz || '', mesice: {} }; veh.set(cislo, v); }
    if (spz && !v.spz) v.spz = spz;
    for (const h of colMap) {
      const km = parseNum(r[h.col]);
      const trzby = parseNum(r[h.col + 1]);
      if (km == null && trzby == null) continue;
      const cur = v.mesice[h.mesic] || { km: 0, trzby: 0 };
      cur.km += km || 0; cur.trzby += trzby || 0;
      v.mesice[h.mesic] = cur;
    }
  }
  return Array.from(veh.values()).sort((a, b) => Number(a.cislo) - Number(b.cislo));
}

/* ---------- tabulka nákladů: hodnoty podle štítků (první číslo vpravo od štítku) ---------- */
const NAKLADY_STITKY = [
  ['kurz', 'kurz'],
  ['pocetVozidel', 'pocet vozidel'],
  ['spotreba', 'prumerna spotreba'],
  ['cenaPhm', 'kc na 1l phm'],
  ['phmNaKm', 'phm kc na 1 km'],
  ['leasingTahac', 'leasing tahac'],
  ['leasingNaves', 'leasing/odpis naves'],
  ['servisFee', 'servis fee tahac'],
  ['pojisteniTahac', 'pojisteni tahac'],
  ['pojisteniNaves', 'pojisteni naves'],
  ['silDanTahac', 'silnicni dan tahac'],
  ['silDanNaves', 'silnicni dan naves'],
  ['mzdyThp', 'mzdy thp'],
  ['ostatniRezie', 'ostatni rezie'],
  ['odpisyOst', 'odpisy ost majetku'],
  ['fixNaKm', 'celkem fix/auto/km'],       // specifičtější štítky před obecnějšími
  ['celkemFix', 'celkem fix/auto'],
  ['nafta', 'nafta'],
  ['pneu', 'pneu 0'],
  ['adblue', 'adblue'],
  ['myto', 'myto'],
  ['mzdyRidicu', 'mzdy ridicu'],
  ['opravy', 'opravy na km'],
  ['celkemVar', 'celkem var/auto/km'],
  ['nakladNaKm', 'celkove naklady na km'],
];
function parseNaklady(rows) {
  const out = {};
  for (const r of rows) {
    for (let i = 0; i < (r || []).length; i++) {
      const label = norm(r[i]);
      if (!label) continue;
      for (const [key, stitek] of NAKLADY_STITKY) {
        if (out[key] != null || !label.startsWith(stitek)) continue;
        for (let j = i + 1; j < r.length; j++) {          // první číselná buňka za štítkem
          const n = parseNum(r[j]);
          if (n != null) { out[key] = n; break; }
        }
        break;   // jedna buňka = max jeden štítek (nejspecifičtější je v seznamu dřív)
      }
    }
  }
  // dopočty, kdyby v tabulce něco chybělo / přejmenovali řádek
  if (out.nafta == null && out.spotreba != null && out.cenaPhm != null) out.nafta = Math.round(out.spotreba * out.cenaPhm) / 100;
  if (out.celkemVar == null) {
    const parts = [out.nafta, out.pneu, out.adblue, out.myto, out.mzdyRidicu, out.opravy];
    if (parts.every((x) => x != null)) out.celkemVar = Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;
  }
  if (out.celkemFix == null) {
    const parts = [out.leasingTahac, out.leasingNaves, out.servisFee, out.pojisteniTahac, out.pojisteniNaves, out.silDanTahac, out.silDanNaves, out.mzdyThp, out.ostatniRezie, out.odpisyOst];
    if (parts.some((x) => x != null)) out.celkemFix = Math.round(parts.reduce((a, b) => a + (b || 0), 0) * 100) / 100;
  }
  return out;
}

/* ---------- účetní skutečnost po vozech (layout listu „auta-2026") ---------- */
// Bloky: [číslo, 'Text 1', Leden…Prosinec, Celkem] a pod tím řádky [SPZ, položka, měsíce…, celkem, pozn].
const EKON_SOUHRNY = {
  'prime naklady': 'primeNaklady', 'prime mzdy - ridici': 'primeMzdy', 'ostatni prime naklady': 'ostatniPrime',
  'prime naklady celkem': 'primeCelkem', 'rezijni naklady celkem': 'rezijni', 'naklady celkem': 'naklady',
  'trzby celkem': 'trzby', 'hv celkem': 'hv',
};
const EKON_KPI_SKIP = ['kc na 1 km', 'spotreba l na 100 km', 'opravy / trzby', 'trzby na km', 'naklady na km'];
function parseEkonomika(rows) {
  const vozy = []; let voz = null;
  const mesicu = (r) => r.slice(2, 14).map(parseNum).map((x) => x == null ? 0 : x);
  for (const r0 of rows) {
    const r = r0 || [];
    if (String(r[1] || '').trim() === 'Text 1') {
      if (voz && (voz.souhrny.trzby || voz.souhrny.naklady)) vozy.push(voz);
      voz = { cislo: String(r[0] || '').trim().split('.')[0], spz: '', polozky: [], souhrny: {}, km: [], kmCelkem: 0, spotrebaL: [] };
      continue;
    }
    if (!voz) continue;
    const nazev = String(r[1] || '').trim();
    if (!nazev) continue;
    const klic = norm(nazev);
    const mes = mesicu(r); const cel = parseNum(r[14]) || 0;
    if (!voz.spz && /^[0-9][A-Z]/.test(String(r[0] || '').trim())) voz.spz = String(r[0] || '').trim();
    if (EKON_SOUHRNY[klic]) voz.souhrny[EKON_SOUHRNY[klic]] = { mesice: mes, celkem: cel };
    else if (klic === 'najeto celkem km') { voz.km = mes; voz.kmCelkem = cel; }
    else if (klic === 'spotreba l') voz.spotrebaL = mes;
    else if (!EKON_KPI_SKIP.includes(klic)) {
      const p = { nazev, celkem: cel };
      if (cel !== 0 || mes.some(Boolean)) p.mesice = mes;
      const pozn = String(r[15] || '').trim(); if (pozn) p.pozn = pozn;
      voz.polozky.push(p);
    }
  }
  if (voz && (voz.souhrny.trzby || voz.souhrny.naklady)) vozy.push(voz);
  const mesiceSdaty = [];
  for (let m = 0; m < 12; m++) if (vozy.some((v) => (v.souhrny.naklady && v.souhrny.naklady.mesice[m]) || 0)) mesiceSdaty.push(m + 1);
  // ořez měsíčních polí na poslední měsíc s daty (stejně jako v seed souboru)
  const n = mesiceSdaty.length ? mesiceSdaty[mesiceSdaty.length - 1] : 12;
  vozy.forEach((v) => {
    Object.values(v.souhrny).forEach((s) => { s.mesice = s.mesice.slice(0, n); });
    v.km = v.km.slice(0, n); v.spotrebaL = v.spotrebaL.slice(0, n);
    v.polozky.forEach((p) => { if (p.mesice) p.mesice = p.mesice.slice(0, n); });
  });
  return { rok: null, mesiceSdaty, vozy };
}

/* ---------- evidence vozů: SPZ, řidič, značka, Scania paušál, smlouva do ---------- */
// Normalizovaná SPZ pro párování s výkazem: "2TL 20-80" i "2TL 2080" → "2TL2080".
function normSpz(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function parseVozy(rows) {
  let col = null;   // mapování sloupců podle hlavičky
  const out = [];
  for (const r of rows) {
    const labels = (r || []).map(norm);
    if (!col) {
      const iSpz = labels.findIndex((l) => l.startsWith('spz vozidla'));
      if (iSpz >= 0) {
        col = { spz: iSpz,
          znacka: labels.findIndex((l) => l.startsWith('znacka vozidlo')),
          ridic: labels.findIndex((l) => l === 'ridic'),
          pozn: labels.findIndex((l) => l.startsWith('pozn')),
          pausal: labels.findIndex((l) => l.includes('pausal')),
          smlouva: labels.findIndex((l) => l.startsWith('smlouva do')) };
      }
      continue;
    }
    const spz = normSpz((r || [])[col.spz]);
    if (!/^[0-9][A-Z][A-Z0-9]\d{4}$/.test(spz)) continue;          // řádky bez SPZ vozidla (vleky, prázdné) přeskočit
    const cely = (r || []).map((c) => norm(c)).join(' | ');
    const znacka = col.znacka >= 0 ? String(r[col.znacka] || '').trim() : '';
    const nastavba = col.znacka >= 0 ? String(r[col.znacka + 1] || '').trim() : '';
    const smlText = col.smlouva >= 0 ? String(r[col.smlouva] || '').trim() : '';
    const smlM = smlText.match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
    out.push({
      spz,
      znacka: (znacka + (nastavba ? ' · ' + nastavba : '')).trim(),
      ridic: (() => { const j = col.ridic >= 0 ? String(r[col.ridic] || '').trim() : ''; return /\d{3}|km/i.test(j) ? '' : j; })(),   // do sloupce občas zatéká poznámka („najeto 535.000km")
      pozn: col.pozn >= 0 ? String(r[col.pozn] || '').trim() : '',
      pausal: col.pausal >= 0 ? parseNum(String(r[col.pausal] || '').replace(/\./g, ' ').replace(/,?\s*-\s*$/, '')) : null,
      smlouvaDo: smlM ? { m: Number(smlM[1]), y: Number(smlM[2]) + (Number(smlM[2]) < 100 ? 2000 : 0) } : null,
      prodano: /prodan/.test(cely),
    });
  }
  return out;
}

/* ---------- jednotlivé zakázky (jízdy) z listů jednotlivých vozů ----------
   Každý vůz má vlastní list „<číslo> - <řidič>" s denními jízdami:
   datum | Trasa | přejezd | vzdálenost s nákladem | EUR | fakturace | převod |
   Celkem tržby v CZK | tržba/km | Obchodník | váha | puťovka | konstrukce | Poznámka
   „Klient" (dle zadání) = cíl trasy — poslední (u okružní Br-…-Br prostřední) úsek. */
const ZAK_NEJIZDA = /^(svatek|dovolena|skoleni|nemoc|volno|servis|stk|sanitka|lekar|porucha|oprava|paragraf|neplacene|nahradni|home ?office|preprava neproběhla|osetrovani|oc\b|p\.?n\.?)/;
function cilZTrasy(trasa) {
  const s = String(trasa || '').trim();
  if (!s) return '';
  const segs = s.split(/\s*(?:->|[-–—>])\s*/).map((x) => x.trim()).filter(Boolean);
  if (segs.length <= 1) return s;
  const home = (x) => /^br(untal)?\.?$/i.test(x);
  if (segs.length >= 3 && norm(segs[0]) === norm(segs[segs.length - 1])) return segs.slice(1, -1).join(' / ');
  const last = segs[segs.length - 1];
  return (home(last) && !home(segs[0])) ? segs[0] : last;
}
function parseZakazky(rows, voz) {
  // Najdi hlavičku (řádek se štítkem „trasa") a zmapuj sloupce dle názvů; fallback = pevné indexy.
  let idx = { datum: 0, trasa: 1, prejezd: 2, km: 3, trzby: 7, trzbaKm: 8, obchodnik: 9, vaha: 10, putovka: 11, pozn: 13 };
  let hdrRow = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const labels = (rows[i] || []).map((c) => norm(c));
    if (labels.some((l) => l === 'trasa')) {
      hdrRow = i;
      const find = (fn) => { const j = labels.findIndex(fn); return j; };
      const m = {
        trasa: find((l) => l === 'trasa'),
        prejezd: find((l) => l.startsWith('prejezd')),
        km: find((l) => l.startsWith('vzdalenost')),
        trzby: find((l) => l.includes('celkem trzby')),
        trzbaKm: find((l) => l.includes('trzba/km') || l.includes('trzba / km')),
        obchodnik: find((l) => l.startsWith('obchodnik')),
        vaha: find((l) => l.startsWith('vaha')),
        putovka: find((l) => l.startsWith('putovka')),
        pozn: find((l) => l.startsWith('pozn')),
      };
      Object.keys(m).forEach((k) => { if (m[k] >= 0) idx[k] = m[k]; });
      idx.datum = 0;
      break;
    }
  }
  const out = [];
  for (let i = (hdrRow >= 0 ? hdrRow + 1 : 0); i < rows.length; i++) {
    const r = rows[i] || [];
    const dm = String(r[idx.datum] || '').trim().match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/);
    if (!dm) continue;
    const trasa = String(r[idx.trasa] || '').trim();
    if (!trasa || ZAK_NEJIZDA.test(norm(trasa))) continue;
    const trzby = parseNum(r[idx.trzby]);
    const km = parseNum(r[idx.km]);
    if ((trzby == null || trzby === 0) && (km == null || km === 0)) continue;   // řádek bez najetých km i tržby = nejde o reálnou jízdu
    out.push({
      datum: dm[3] + '-' + String(dm[2]).padStart(2, '0') + '-' + String(dm[1]).padStart(2, '0'),
      mesic: dm[3] + '-' + String(dm[2]).padStart(2, '0'),
      voz: voz.voz, ridic: voz.ridic || '',
      trasa, cil: cilZTrasy(trasa),
      km: km || 0, trzby: trzby || 0,
      obchodnik: String(r[idx.obchodnik] || '').trim().replace(/\.$/, ''),
      putovka: String(r[idx.putovka] || '').trim(),
    });
  }
  return out;
}

function mount(host) {
  const CACHE_F = path.join(host.dataDir || __dirname, 'doprava-cache.json');
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(CACHE_F, 'utf8')); } catch (_) {}
  // Bez cache (čerstvé nasazení) se použije přibalený snapshot dat — modul tak má
  // co zobrazit i předtím, než dostane service account práva k tabulkám.
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
      try { fs.writeFileSync(CACHE_F, JSON.stringify(cache)); } catch (_) {}
      console.log('[doprava] cache založena z přibaleného snapshotu (' + (cache.zdroj || '') + ')');
    } catch (_) {}
  }
  let lastFail = 0;   // neúspěšná obnova → další automatický pokus nejdřív za 10 minut
  // Účetní skutečnost: přibalený snapshot jako výchozí zdroj (živý zdroj přes env viz výše).
  let seedEkonomika = null;
  try { seedEkonomika = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-ekonomika.json'), 'utf8')); } catch (_) {}
  // Evidence řidičů a typů vozidel (v tabulkách není; plní správce přímo v modulu).
  const INFO_F = path.join(host.dataDir || __dirname, 'doprava-vozidla.json');
  function readInfo() { try { const i = JSON.parse(fs.readFileSync(INFO_F, 'utf8')); return (i && typeof i === 'object') ? i : {}; } catch { return {}; } }

  const json = (res, code, obj) => host.send(res, code, obj);
  const html = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  function maModul(req) {
    if (host.isAdmin(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    try { return (host.employeeModules(e.email) || []).includes('doprava'); } catch { return false; }
  }

  // Načte tabulku a najde list s daty: zkusí první list, pak postupně všechny pojmenované.
  async function readParsed(id, range, parseFn, maSmysl) {
    let prvniChyba = null;
    try { const d = parseFn(await sheets.readValues(id, range)); if (maSmysl(d)) return d; }
    catch (e) { prvniChyba = e; }
    const listy = await sheets.listSheets(id).catch(() => []);
    for (const t of listy.slice(0, 8)) {
      try { const d = parseFn(await sheets.readValues(id, "'" + t.replace(/'/g, "''") + "'!" + range)); if (maSmysl(d)) return d; }
      catch (_) {}
    }
    throw prvniChyba || new Error('data se nepodařilo najít na žádném listu — zkontrolujte strukturu tabulky');
  }

  // Výkony: projde všechny soubory (ročníky) i jejich listy a vybere data s NEJNOVĚJŠÍM měsícem.
  const posledniMesic = (voz) => voz.reduce((m, v) => Object.keys(v.mesice).reduce((x, k) => (k > x ? k : x), m), '');
  async function readVykonyBest() {
    let best = null; const chyby = [];
    for (const id of VYKONY_IDS()) {
      const kandidati = [null, ...(await sheets.listSheets(id).catch(() => []))].slice(0, 9);
      let chybaSouboru = null;
      for (const list of kandidati) {
        try {
          const range = list == null ? 'A1:Z300' : ("'" + list.replace(/'/g, "''") + "'!A1:Z300");
          const d = parseVykony(await sheets.readValues(id, range));
          if (!d.length) continue;
          const mes = posledniMesic(d);
          if (!best || mes > best.mesic) best = { vozidla: d, mesic: mes, id, list: list || '(první list)' };
        } catch (e) { if (!chybaSouboru) chybaSouboru = e.message; }
      }
      if (chybaSouboru) chyby.push(chybaSouboru);
    }
    if (!best) throw new Error(chyby[0] || 'výkaz se nepodařilo najít v žádném z nasdílených souborů');
    return best;
  }

  // Jednotlivé zakázky: z výkonového souboru projde listy jednotlivých vozů („<číslo> - <řidič>").
  async function readZakazky(id) {
    const listy = await sheets.listSheets(id).catch(() => []);
    const vozListy = listy.filter((t) => /^\s*\d+\s*[-–]/.test(t) && !/depozit|rekapitul/i.test(t));
    const out = [];
    for (const t of vozListy) {
      try {
        const m = t.match(/^\s*(\d+)\s*[-–]\s*(.*)$/);
        const rows = await sheets.readValues(id, "'" + t.replace(/'/g, "''") + "'!A1:P400");
        out.push(...parseZakazky(rows, { voz: m ? m[1] : t.trim(), ridic: m ? m[2].trim() : '' }));
      } catch (_) {}
    }
    return out.sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : Number(a.voz) - Number(b.voz)));
  }

  // Historické ročníky: z každého souboru list s nejvíce měsíci; rok = převažující rok v datech.
  async function readHistorie() {
    const roky = [];
    for (const id of HISTORIE_IDS()) {
      try {
        const kandidati = [null, ...(await sheets.listSheets(id).catch(() => []))].slice(0, 9);
        let best = null;
        for (const list of kandidati) {
          try {
            const range = list == null ? 'A1:Z300' : ("'" + list.replace(/'/g, "''") + "'!A1:Z300");
            const d = parseVykony(await sheets.readValues(id, range));
            if (!d.length) continue;
            const mes = new Set(); d.forEach((v) => Object.keys(v.mesice).forEach((k) => mes.add(k)));
            if (!best || mes.size > best.n) best = { vozidla: d, n: mes.size, list: list || '(první list)' };
          } catch (_) {}
        }
        if (!best) continue;
        const cnt = {}; best.vozidla.forEach((v) => Object.keys(v.mesice).forEach((k) => { const y = k.slice(0, 4); cnt[y] = (cnt[y] || 0) + 1; }));
        const rok = Number(Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0]);
        roky.push({ rok, id, list: best.list, vozidla: best.vozidla });
      } catch (e) { console.error('[doprava] historický ročník ' + id.slice(0, 10) + '… se nenačetl:', e.message); }
    }
    return roky.sort((a, b) => a.rok - b.rok);
  }

  // Stáhne a naparsuje tabulky; při úspěchu uloží cache na disk.
  let _refreshing = null;
  async function refresh() {
    if (_refreshing) return _refreshing;   // souběžné požadavky sdílí jedno stažení
    _refreshing = (async () => {
      // Tabulky se čtou a ukládají nezávisle: co se povede, použije se hned;
      // co selže, zůstane z poslední úspěšné verze (cache) a nahlásí se ve varování.
      const [vyk, nak, evi] = await Promise.allSettled([
        readVykonyBest(),
        readParsed(NAKLADY_ID(), 'A1:Z120', parseNaklady, (d) => d.celkemVar != null || d.celkemFix != null),
        readParsed(VOZY_ID(), 'A1:Z120', parseVozy, (d) => d.length > 0),
      ]);
      const data = { ts: Date.now(), vozidla: null, naklady: null, evidence: null, vykonyZdroj: null, vykonyChyba: null, nakladyChyba: null, evidenceChyba: null };
      if (evi.status === 'fulfilled') data.evidence = evi.value;
      else {
        data.evidenceChyba = evi.reason.message;
        data.evidence = (cache && cache.evidence) || null;
        console.error('[doprava] evidence vozů se nenačetla:', data.evidenceChyba);
      }
      if (vyk.status === 'fulfilled') {
        data.vozidla = vyk.value.vozidla; data.vykonyZdroj = { id: vyk.value.id, list: vyk.value.list, mesic: vyk.value.mesic };
        // Jednotlivé zakázky se čtou z téhož (nejnovějšího) výkonového souboru; selhání nezhatí zbytek.
        try { data.zakazky = await readZakazky(vyk.value.id); }
        catch (e) { data.zakazky = (cache && cache.zakazky) || null; console.error('[doprava] zakázky se nenačetly:', e.message); }
      } else { data.vykonyChyba = vyk.reason.message; data.zakazky = (cache && cache.zakazky) || null; }
      if (nak.status === 'fulfilled') data.naklady = nak.value;
      else data.nakladyChyba = nak.reason.message;
      if (data.vykonyChyba) { data.vozidla = (cache && cache.vozidla) || null; console.error('[doprava] tabulka výkonů se nenačetla:', data.vykonyChyba); }
      if (data.nakladyChyba) { data.naklady = (cache && cache.naklady) || null; console.error('[doprava] nákladová tabulka se nenačetla:', data.nakladyChyba); }
      // Účetní skutečnost (jen když je nastavený živý zdroj) — obnova max 1× denně.
      const staraEkon = cache && cache.ekonomika;
      if (EKONOMIKA_ID() && (!staraEkon || (Date.now() - (staraEkon.ts || 0)) > 24 * 3600 * 1000)) {
        try {
          const ek = await readParsed(EKONOMIKA_ID(), 'A1:R1200', parseEkonomika, (d) => d.vozy && d.vozy.length > 0);
          data.ekonomika = { ts: Date.now(), zdroj: 'živě z Google Sheets', ...ek };
        } catch (e) { data.ekonomika = staraEkon || null; console.error('[doprava] účetní ekonomika se nenačetla:', e.message); }
      } else data.ekonomika = staraEkon || null;
      // Historické ročníky se mění zřídka — obnova max 1× denně, jinak z cache.
      const staraHist = cache && cache.historie;
      if (!staraHist || (Date.now() - (staraHist.ts || 0)) > 24 * 3600 * 1000) {
        try {
          const roky = await readHistorie();
          data.historie = (roky.length || !staraHist) ? { ts: Date.now(), roky } : staraHist;
        } catch (e) { data.historie = staraHist || null; }
      } else data.historie = staraHist;
      if (!data.vozidla) throw new Error('tabulka výkonů: ' + data.vykonyChyba);
      cache = data;
      try { fs.writeFileSync(CACHE_F, JSON.stringify(data)); } catch (_) {}
      // Výkony určují čerstvost dat — když selžou, hlásíme chybu (a retry za 10 minut),
      // čerstvě stažené náklady už ale zůstávají uložené a zobrazí se.
      if (data.vykonyChyba) throw new Error('tabulka výkonů: ' + data.vykonyChyba);
      return data;
    })();
    try { return await _refreshing; } finally { _refreshing = null; }
  }

  async function handle(req, res) {
    const u = urlLib.parse(req.url, true); const p = u.pathname;
    if (!p.startsWith('/doprava') && !p.startsWith('/api/doprava')) return false;

    if (!maModul(req)) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'Nemáte přístup k modulu Doprava.' });
      else html(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K modulu Doprava nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }

    if ((p === '/doprava' || p === '/doprava/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { html(res, 404, '<h1>Chybí doprava.html</h1>'); return true; }
      html(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }

    if (p === '/api/doprava/data' && req.method === 'GET') {
      // Odpověď z cache + případná upozornění (nedostupná nákladová tabulka, stará data…)
      const zCache = (varovani) => {
        // Výkaz starší než ~2 měsíce = nejspíš je nasdílený jen starý ročník souboru.
        let zastarale = null;
        if (cache.vykonyZdroj && cache.vykonyZdroj.mesic) {
          const [ry, rm] = cache.vykonyZdroj.mesic.split('-').map(Number);
          const ted = new Date();
          if ((ted.getFullYear() - ry) * 12 + (ted.getMonth() + 1 - rm) > 2)
            zastarale = 'Pozor: nejnovější dostupný výkaz je za ' + rm + '/' + ry + ' — robot nejspíš nemá nasdílený aktuální ročník „Daily report ECZ".';
        }
        const upozorneni = [varovani, zastarale,
          cache.nakladyChyba ? ('Nákladová kalkulace se nenačetla (' + cache.nakladyChyba + ') — dashboard běží jen nad výkony.') : null,
          cache.evidenceChyba ? ('Evidence vozů se nenačetla (' + cache.evidenceChyba + ') — fixní náklady se počítají plné u všech vozů.') : null,
        ].filter(Boolean).join(' ');
        json(res, 200, { konfigurace: true, saEmail: sheets.saEmail(), aktualizovano: cache.ts, vozidla: cache.vozidla, naklady: cache.naklady, evidence: cache.evidence || null, vykonyZdroj: cache.vykonyZdroj || null, historie: (cache.historie && cache.historie.roky) || [], zakazky: cache.zakazky || null, ekonomika: cache.ekonomika || seedEkonomika || null, info: readInfo(), admin: host.isAdmin(req), varovani: upozorneni || undefined });
      };
      if (!sheets.configured()) {
        if (cache) zCache('Service account není nastaven — zobrazuji poslední stažená data (bez obnovy z Google Sheets).');
        else json(res, 200, { konfigurace: false, saEmail: '', hint: 'Nastavte GOOGLE_SA_CLIENT_EMAIL a GOOGLE_SA_PRIVATE_KEY a nasdílejte obě tabulky service accountu (Prohlížející).' });
        return true;
      }
      const force = u.query.refresh === '1';
      const stale = !cache || (Date.now() - cache.ts) > 6 * 3600 * 1000;
      try {
        if (force || (stale && Date.now() - lastFail > 10 * 60 * 1000)) await refresh();
        zCache('');
      } catch (e) {
        lastFail = Date.now();
        if (cache) zCache('Obnovení z Google Sheets selhalo (' + e.message + ') — zobrazuji poslední stažená data.');
        else json(res, 200, { konfigurace: true, saEmail: sheets.saEmail(), chyba: 'Nepodařilo se načíst data z Google Sheets: ' + e.message + ' Nasdíleli jste tabulky účtu ' + sheets.saEmail() + '?' });
      }
      return true;
    }

    // Uložení řidiče / typu vozidla k číslu vozu (jen správce).
    if (p === '/api/doprava/vozidlo' && req.method === 'POST') {
      if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Upravovat řidiče a vozidla smí jen správce.' }); return true; }
      let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
      const cislo = String(b.cislo || '').trim();
      if (!cislo) { json(res, 400, { chyba: 'Chybí číslo vozu.' }); return true; }
      const info = readInfo();
      const fixMes = parseNum(String(b.fixMes == null ? '' : b.fixMes));
      info[cislo] = { ridic: String(b.ridic || '').trim().slice(0, 60), typ: String(b.typ || '').trim().slice(0, 60), fixMes: fixMes != null && fixMes >= 0 ? fixMes : null };
      if (!info[cislo].ridic && !info[cislo].typ && info[cislo].fixMes == null) delete info[cislo];
      try { fs.writeFileSync(INFO_F, JSON.stringify(info, null, 2)); } catch (e) { json(res, 500, { chyba: e.message }); return true; }
      json(res, 200, { ok: true, info }); return true;
    }

    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  // Tick (co 6 h): předehřátí cache, ať první otevření stránky nečeká na Google.
  async function tick() {
    if (!sheets.configured()) return;
    try { await refresh(); console.log('[doprava] data obnovena, vozidel: ' + cache.vozidla.length); }
    catch (e) { console.error('[doprava] obnova dat selhala:', e.message); }
  }

  return { handle, tick };
}

module.exports = { mount, parseZakazky, cilZTrasy };

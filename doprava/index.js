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
const VYKONY_ID = () => process.env.DOPRAVA_SHEET_VYKONY_ID || '1Na7nDmIdSkbpviGfVDRHWsC6kcQacFIFLVx7vaBGVy4';
const NAKLADY_ID = () => process.env.DOPRAVA_SHEET_NAKLADY_ID || '1sVQBx0Weo2Ds9Gfgqwd-LyTVvQ_cBQBtUh7QzDSmnOE';

/* ---------- parsování čísel z formátovaných buněk ---------- */
// "197 800 Kč" → 197800; "13,45 Kč" → 13.45; "29,3" → 29.3; prázdné/nečíselné → null
function parseNum(v) {
  if (v == null) return null;
  let s = String(v).replace(/ /g, ' ').replace(/Kč/gi, '').replace(/%/g, '').trim();
  if (!s || /^#/.test(s)) return null;              // #DIV/0! apod.
  s = s.replace(/ /g, '').replace(',', '.');
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

  const json = (res, code, obj) => host.send(res, code, obj);
  const html = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  function maModul(req) {
    if (host.isAdmin(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    try { return (host.employeeModules(e.email) || []).includes('doprava'); } catch { return false; }
  }

  // Stáhne a naparsuje obě tabulky; při úspěchu uloží cache na disk.
  let _refreshing = null;
  async function refresh() {
    if (_refreshing) return _refreshing;   // souběžné požadavky sdílí jedno stažení
    _refreshing = (async () => {
      // Tabulky se čtou nezávisle: výkony jsou povinné, náklady volitelné (bez nich
      // dashboard běží v omezeném režimu a stránka na chybějící kalkulaci upozorní).
      const [vyk, nak] = await Promise.allSettled([
        sheets.readValues(VYKONY_ID(), 'A1:Z300'),
        sheets.readValues(NAKLADY_ID(), 'A1:Z120'),
      ]);
      if (vyk.status === 'rejected') throw new Error('tabulka výkonů: ' + vyk.reason.message);
      const data = { ts: Date.now(), vozidla: parseVykony(vyk.value), naklady: null, nakladyChyba: null };
      if (!data.vozidla.length) throw new Error('V tabulce výkonů se nepodařilo najít žádné vozidlo — zkontrolujte strukturu listu.');
      if (nak.status === 'fulfilled') data.naklady = parseNaklady(nak.value);
      else { data.nakladyChyba = nak.reason.message; console.error('[doprava] nákladová tabulka se nenačetla:', nak.reason.message); }
      cache = data;
      try { fs.writeFileSync(CACHE_F, JSON.stringify(data)); } catch (_) {}
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
        const upozorneni = [varovani, cache.nakladyChyba ? ('Nákladová kalkulace se nenačetla (' + cache.nakladyChyba + ') — dashboard běží jen nad výkony.') : null].filter(Boolean).join(' ');
        json(res, 200, { konfigurace: true, saEmail: sheets.saEmail(), aktualizovano: cache.ts, vozidla: cache.vozidla, naklady: cache.naklady, varovani: upozorneni || undefined });
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

module.exports = { mount };

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
const VYKONY_IDS = () => (process.env.DOPRAVA_SHEET_VYKONY_ID || '1Na7nDmIdSkbpviGfVDRHWsC6kcQacFIFLVx7vaBGVy4,1ZTPTuRdZvbOWOiHuVwdoMOhs_r3rS6OmBCabKJ8dmio')
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
      if (vyk.status === 'fulfilled') { data.vozidla = vyk.value.vozidla; data.vykonyZdroj = { id: vyk.value.id, list: vyk.value.list, mesic: vyk.value.mesic }; }
      else data.vykonyChyba = vyk.reason.message;
      if (nak.status === 'fulfilled') data.naklady = nak.value;
      else data.nakladyChyba = nak.reason.message;
      if (data.vykonyChyba) { data.vozidla = (cache && cache.vozidla) || null; console.error('[doprava] tabulka výkonů se nenačetla:', data.vykonyChyba); }
      if (data.nakladyChyba) { data.naklady = (cache && cache.naklady) || null; console.error('[doprava] nákladová tabulka se nenačetla:', data.nakladyChyba); }
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
        json(res, 200, { konfigurace: true, saEmail: sheets.saEmail(), aktualizovano: cache.ts, vozidla: cache.vozidla, naklady: cache.naklady, evidence: cache.evidence || null, vykonyZdroj: cache.vykonyZdroj || null, info: readInfo(), admin: host.isAdmin(req), varovani: upozorneni || undefined });
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

module.exports = { mount };

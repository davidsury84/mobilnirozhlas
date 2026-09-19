'use strict';
// ============================================================================
//  Modul „Výroba Popelnice" — zakázky kovových boxů, muld a abrollů (závod Bruntál)
// ============================================================================
//  Co modul dělá (fáze 1, bez napojení na Helios):
//   1) obchodník zadá objednávku JEDNOU (hlavička + položky z katalogu) → položky
//      dostanou výrobní číslo ČVZ (26B-nnn) a objeví se ve frontě výroby
//   2) ředitel výroby (Ladislav Mathé) mění stavy položek přímo v dílně
//      (zadáno → svařovna → lakovna / zinkovna → hotovo → naplánováno → expedováno)
//   3) hotové položky se jedním tlačítkem odešlou do aplikace „Ložný plán"
//      (/api/shared na Railway, stejná data, nic se nepřepisuje podruhé)
//   4) živý přehled: stav každé položky, termíny, skluz, kooperace
//   5) jednorázový import stávajícího Google Sheetu PLÁN VÝROBY (list Boxy contract 2026)
//
//  Mount v server.js:
//    const vyroba = require('./vyroba').mount({
//      send, readBody, empSession, isAdmin, employeeModules, getState, logActivity, dataDir,
//      sheets: { available, read(spreadsheetId, range) },     // Google Sheets (service account)
//      drive:  { available, list(folderId) },                  // Google Drive (read-only)
//      loznyplan: { url, ssoSign },                            // aplikace Ložný plán + podpis SSO
//      baseUrl,
//    });
//    if (vyroba && await vyroba.handle(req, res)) return;
//    vyroba.notifikace(email) — dlaždice na nástěnku intranetu
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const urlLib = require('url');

const HTML_FILE = path.join(__dirname, 'vyroba.html');
const KATALOG_SEED = path.join(__dirname, 'katalog-seed.json');
const { pdfToText } = require('./pdftext');
const { parseXlsx } = require('./xlsx');
const parsers = require('./parsers');
const sheetsync = require('./sheetsync');

// Stavy položky (= jeden řádek ČVZ). Pořadí = průběh zakázky; „pozastaveno" a „storno" jsou mimo řadu.
const STAVY = [
  ['prijata',      'Objednávka přijata',  'Order received',        'Bestellung eingegangen'],
  ['zadano',       'Zadáno do výroby',    'Released to production','In Produktion freigegeben'],
  ['svarovna',     'Svařovna',            'In production',         'In Produktion'],
  ['lakovna',      'Lakovna',             'Painting',              'Lackierung'],
  ['zinkovna',     'Zinkovna',            'Galvanising',           'Verzinkung'],
  ['hotovo',       'Hotovo na skladě',    'Ready for dispatch',    'Fertig, versandbereit'],
  ['naplanovano',  'Naplánováno na LKW',  'Loading scheduled',     'Verladung geplant'],
  ['expedovano',   'Expedováno',          'Dispatched',            'Verladen'],
  ['doruceno',     'Doručeno',            'Delivered',             'Geliefert'],
  ['pozastaveno',  'Pozastaveno',         'On hold',               'Zurückgestellt'],
  ['storno',       'Storno',              'Cancelled',             'Storniert'],
];
const STAV_KEYS = STAVY.map(s => s[0]);
const STAV_PORADI = {}; STAVY.forEach((s, i) => { STAV_PORADI[s[0]] = i; });
const VYKRES = { neni: 'není třeba', poslan: 'poslán ke schválení', schvalen: 'schválen', vydan: 'vydán do výroby' };
const POVRCH = { lak: 'lakování', zinek: 'žárový zinek', zaklad: 'základní nátěr', bez: 'bez úpravy' };

// Nejčastější RAL na boxech (pro barvu v ložném plánu a přehledu). Ostatní se zobrazí neutrálně.
const RAL_HEX = {
  '1003': '#F7BA0B', '1023': '#F7B500', '2002': '#C63927', '2004': '#E25303', '2008': '#ED6B21', '3000': '#A72920', '3001': '#9B2423', '3002': '#9B2321', '3003': '#861A22',
  '3004': '#6B1C23', '3009': '#642424', '3011': '#781F19', '3020': '#BB1E10', '5002': '#00387B', '5003': '#1F3855', '5005': '#004F7C', '5010': '#004F7C', '5012': '#0089B6',
  '5013': '#193153', '5015': '#007CB0', '5017': '#005B8C', '5021': '#007577', '6001': '#28713E', '6002': '#276235', '6005': '#0F4336', '6018': '#61993B', '6029': '#006F3D',
  '7011': '#434B4D', '7016': '#293133', '7021': '#23282B', '7024': '#474A50', '7031': '#5B686D', '7034': '#8F8B66', '7035': '#C5C7C4', '7037': '#7A7B7A', '7040': '#9DA3A6',
  '7042': '#8D9295', '8004': '#8F4E35', '9002': '#E7EBDA', '9005': '#0A0A0D', '9006': '#A1A1A0', '9010': '#F1ECE1', '9016': '#F1F0EA',
};

const DEN = 86400000;

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'vyroba-popelnice.json');

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  const low = s => String(s || '').trim().toLowerCase();
  const str = (s, max) => String(s == null ? '' : s).trim().slice(0, max || 400);
  const num = (v, def) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : (def == null ? 0 : def); };
  const dnesISO = () => new Date().toISOString().slice(0, 10);
  const newId = (p) => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---- perzistence ---------------------------------------------------------
  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); } catch (_) {}
    if (!d || typeof d !== 'object') d = {};
    for (const k of ['objednavky', 'polozky', 'zakaznici', 'katalog']) if (!Array.isArray(d[k])) d[k] = [];
    if (!d.seq || typeof d.seq !== 'object') d.seq = {};
    if (!d.seq.cvz || typeof d.seq.cvz !== 'object') d.seq.cvz = {};
    if (!d.nastaveni || typeof d.nastaveni !== 'object') d.nastaveni = {};
    const n = d.nastaveni;
    if (!Array.isArray(n.reditelVyroby)) n.reditelVyroby = [];      // e-maily lidí z výroby (mění stavy, nezakládají)
    if (!Array.isArray(n.obchod)) n.obchod = [];                    // e-maily obchodu (zakládají objednávky)
    if (typeof n.sheetId !== 'string') n.sheetId = '1620BTnSV5qlN25CcSg60CuTOgqiey6ck2eC_JKFOIbE';   // PLÁN VÝROBY BRUNTÁL POPELNICE
    if (typeof n.sheetList !== 'string') n.sheetList = 'Boxy contract 2026';
    if (typeof n.sheetListOstatni !== 'string') n.sheetListOstatni = 'Ostatní výrobky';
    if (typeof n.driveRoot !== 'string') n.driveRoot = '1VVre4yFfde8sKx36QtXuO7kbKMHwv41h';        // složka Contract (BE26xxxx …)
    if (typeof n.prubeznaDobaDny !== 'number') n.prubeznaDobaDny = 7;   // termín výroby = KW dodání − X dní
    if (typeof n.upozorneniDny !== 'number') n.upozorneniDny = 7;       // „hotovo bez kamionu déle než"
    if (typeof n.syncSheetId !== 'string') n.syncSheetId = '17pgM2HKTyiVT4fOTF0g7o7mBFWHmkGQIN-CcsIelGjA';   // ZAKÁZKY POPELNICE (intranet) – obousměrně synchronizovaná tabulka
    if (typeof n.syncMinuty !== 'number') n.syncMinuty = 5;
    if (!d.sheetSync || typeof d.sheetSync !== 'object') d.sheetSync = {};
    if (!d.import || typeof d.import !== 'object') d.import = {};
    if (!d.katalog.length) { seedKatalog(d); }
    if (!d.migrace || typeof d.migrace !== 'object') d.migrace = {};
    if (!d.migrace.objem10 || !d.migrace.objem10b) {   // objem z kódu se dřív bral doslova (08.00 → 8 m³) místo /10 (→ 0,8 m³)
      const oprav = (x) => { const m = String(x.kod || '').replace(/\s+/g, '').match(/^[A-ZÖ]+(\d{1,2}[.,]\d{2})/i); if (!m) return; const stary = Math.round(num(m[1]) * 100) / 100; if (x.objem === stary) x.objem = Math.round(num(m[1]) * 10) / 100; };
      d.katalog.forEach(oprav); d.polozky.forEach(oprav);
      // hmotnosti ze seedu (ceník Metallboxy) k produktům, které je v katalogu nemají
      try { const seed = JSON.parse(fs.readFileSync(KATALOG_SEED, 'utf8')); const kk = k => low(k).replace(/\s+/g, ''); d.katalog.forEach(k => { if (k.kg == null) { const sd = seed.find(x => kk(x.kod) === kk(k.kod)); if (sd && sd.kg != null) k.kg = sd.kg; } }); } catch (_) {}
      d.migrace.objem10 = d.migrace.objem10 || new Date().toISOString(); d.migrace.objem10b = new Date().toISOString(); try { save(d); } catch (_) {}
    }
    return d;
  }
  function saveRaw(d) { fs.writeFileSync(DATA_F, JSON.stringify(d, null, 2)); }
  function save(d) { saveRaw(d); try { if (sheet) sheet.naplanuj(); } catch (_) {} }

  function seedKatalog(d) {
    try {
      const seed = JSON.parse(fs.readFileSync(KATALOG_SEED, 'utf8'));
      if (Array.isArray(seed)) d.katalog = seed.map(normKatalog).filter(k => k.kod);
    } catch (_) {}
  }

  // ---- katalog produktů ----------------------------------------------------
  // Kód provedení: CPRÖ 08.00 LacNamÖla → řada CPRÖ, objem 0.8 m³, Lac = lak, Nam = ražení, Öla = výpustný kohout.
  function parseKod(kod) {
    const k = String(kod || '').trim();
    const m = k.match(/^([A-ZÖ]+)\s*(\d{1,2}[.,]\d{2})\s*(.*)$/i);
    if (!m) return { rada: '', objem: null, provedeni: k };
    // Číslo v kódu je objem × 10: 08.00 → 0,8 m³, 16.00 → 1,6 m³, 30.70 → 3,07 m³ (viz ceník Metallboxy)
    return { rada: m[1].toUpperCase(), objem: Math.round(num(m[2]) * 10) / 100, provedeni: m[3] || '' };
  }
  function povrchZKodu(kod) {
    const p = String(kod || '');
    if (/Zin/i.test(p) || /pozink|zinek/i.test(p)) return 'zinek';
    if (/Gru/i.test(p)) return 'zaklad';
    if (/Lac/i.test(p)) return 'lak';
    return '';
  }
  // „1200x800x800/920" → vnější rozměry pro ložný plán (délka, šířka, výška celkem, výška vnitřní)
  function parseRozmer(s) {
    const m = String(s || '').replace(/\s/g, '').replace(/\./g, '').match(/(\d{3,4})[x×](\d{3,4})[x×](\d{3,4})(?:\/(\d{3,4}))?/i);
    if (!m) return null;
    return { l: +m[1], w: +m[2], hi: +m[3], h: +(m[4] || m[3]) };
  }
  function normKatalog(k) {
    const kod = str(k.kod, 80);
    const pk = parseKod(kod);
    const roz = parseRozmer(k.rozmer);
    return {
      id: k.id || newId('k'),
      kod,
      nazev: str(k.nazev, 160),
      rada: str(k.rada, 20) || pk.rada,
      objem: k.objem != null && k.objem !== '' ? num(k.objem) : pk.objem,
      rozmer: str(k.rozmer, 40),
      tloustka: k.tloustka != null && k.tloustka !== '' ? num(k.tloustka) : null,
      kg: k.kg != null && k.kg !== '' ? num(k.kg) : null,
      povrch: str(k.povrch, 10) || povrchZKodu(kod),
      l: roz ? roz.l : (k.l || null), w: roz ? roz.w : (k.w || null), h: roz ? roz.h : (k.h || null), hi: roz ? roz.hi : (k.hi || null),
      stoh: k.stoh != null ? num(k.stoh) : null,        // kolik ks na sebe v kamionu (null = dle ložného plánu)
      aktivni: k.aktivni !== false,
    };
  }
  function najdiKatalog(d, kod) {
    const n = low(kod).replace(/\s+/g, '');
    if (!n) return null;
    return d.katalog.find(k => low(k.kod).replace(/\s+/g, '') === n) || null;
  }
  // Produkt mimo katalog (nové provedení stejné bedny, např. CPRDÖ 08.00 …): rozměr a hmotnost
  // se odvodí od sourozence stejné řady CP* a stejného objemu, aby ložný plán měl s čím počítat.
  function odvozenyProdukt(d, kod) {
    const pk = parseKod(kod);
    if (!pk.objem || !/^CP/.test(pk.rada)) return null;
    const me = low(kod).replace(/\s+/g, '');
    const sour = d.katalog.filter(k => /^CP/.test(k.rada || '') && k.objem === pk.objem && low(k.kod).replace(/\s+/g, '') !== me);
    if (!sour.length) return null;
    const zin = /Zin/i.test(kod);
    const pref = arr => arr.slice().sort((a, b) => Number((/Zin/i.test(b.kod)) === zin) - Number((/Zin/i.test(a.kod)) === zin));
    const sKg = pref(sour.filter(k => k.kg != null)), sRoz = pref(sour.filter(k => k.rozmer));
    if (!sKg.length && !sRoz.length) return null;
    const zdroj = sRoz[0] || sKg[0];
    return { rozmer: sRoz.length ? sRoz[0].rozmer : '', kg: sKg.length ? sKg[0].kg : null, tloustka: zdroj.tloustka != null ? zdroj.tloustka : null, objem: pk.objem };
  }

  // ---- lidé a role ---------------------------------------------------------
  function zamestnanci() {
    let s = null; try { s = host.getState ? host.getState() : null; } catch (_) {}
    const emps = (s && Array.isArray(s.employees)) ? s.employees : [];
    return emps.filter(e => e && e.email).map(e => ({ email: low(e.email), name: e.name || e.email, stredisko: e.stredisko || '' }));
  }
  function moduly(email) { try { return host.employeeModules(email) || []; } catch (_) { return []; } }
  function role(req) {
    const d = load(), e = host.empSession(req);
    const email = e ? low(e.email) : '';
    const admin = host.isAdmin(req);
    const mods = email ? moduly(email) : [];
    const obchod = admin || mods.includes('vyroba') || d.nastaveni.obchod.map(low).includes(email);
    const vyroba = obchod || mods.includes('vyrobadilna') || d.nastaveni.reditelVyroby.map(low).includes(email);
    return { email, name: e ? (e.name || '') : '', admin, obchod, vyroba, pristup: !!(obchod || vyroba) };
  }
  function hasAccess(email) {
    email = low(email); if (!email) return false;
    const d = load(); const mods = moduly(email);
    return mods.includes('vyroba') || mods.includes('vyrobadilna')
      || d.nastaveni.obchod.map(low).includes(email) || d.nastaveni.reditelVyroby.map(low).includes(email);
  }

  // ---- ČVZ, termíny --------------------------------------------------------
  function dalsiCvz(d, rok) {
    rok = rok || new Date().getFullYear();
    const cur = num(d.seq.cvz[rok], 0);
    const next = cur + 1; d.seq.cvz[rok] = next;
    return { cvz: String(rok).slice(2) + 'B-' + String(next).padStart(3, '0'), rok, poradi: next };
  }
  function posunSeq(d, rok, poradi) { if (num(d.seq.cvz[rok], 0) < poradi) d.seq.cvz[rok] = poradi; }
  // ISO týden → pondělí toho týdne
  function pondeliKW(kw, rok) {
    kw = num(kw, 0); rok = num(rok, new Date().getFullYear());
    if (!kw) return null;
    const jan4 = new Date(Date.UTC(rok, 0, 4));
    const den = jan4.getUTCDay() || 7;
    const mon1 = new Date(jan4.getTime() - (den - 1) * DEN);
    return new Date(mon1.getTime() + (kw - 1) * 7 * DEN).toISOString().slice(0, 10);
  }
  function kwZData(iso) {
    if (!iso) return null;
    const dt = new Date(iso + 'T00:00:00Z'); if (isNaN(dt)) return null;
    const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    const den = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - den);
    const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return { kw: Math.ceil((((d - y0) / DEN) + 1) / 7), rok: d.getUTCFullYear() };
  }
  function terminVyrobyZ(o, nast) {
    if (o.terminDodani) { const t = new Date(o.terminDodani + 'T00:00:00Z'); if (!isNaN(t)) return new Date(t.getTime() - nast.prubeznaDobaDny * DEN).toISOString().slice(0, 10); }
    const p = pondeliKW(o.kwDodani, o.kwRok || (o.datum ? Number(o.datum.slice(0, 4)) : null));
    if (!p) return null;
    return new Date(new Date(p + 'T00:00:00Z').getTime() - nast.prubeznaDobaDny * DEN).toISOString().slice(0, 10);
  }

  // ---- odvozené údaje ------------------------------------------------------
  function stavObjednavky(polozky) {
    const ziv = polozky.filter(p => p.stav !== 'storno');
    if (!ziv.length) return polozky.length ? 'storno' : 'prijata';
    if (ziv.some(p => p.stav === 'pozastaveno')) return 'pozastaveno';
    // stav objednávky = nejméně pokročilá živá položka
    return ziv.reduce((a, p) => (STAV_PORADI[p.stav] < STAV_PORADI[a] ? p.stav : a), 'doruceno');
  }
  function skluz(p, dnes) {
    if (!p.terminVyroby) return 0;
    if (STAV_PORADI[p.stav] >= STAV_PORADI.hotovo || p.stav === 'storno') return 0;
    const dni = Math.floor((new Date(dnes + 'T00:00:00Z') - new Date(p.terminVyroby + 'T00:00:00Z')) / DEN);
    return dni > 0 ? dni : 0;
  }
  function obohatPolozku(d, p, dnes, nast) {
    const k = p.katalogId ? d.katalog.find(x => x.id === p.katalogId) : najdiKatalog(d, p.kod);
    // provedení mimo katalog (nebo v katalogu bez hmotnosti) → hmotnost/rozměr od sourozence stejné řady a objemu
    const od = (!k || k.kg == null || !k.rozmer) ? odvozenyProdukt(d, p.kod) : null;
    const kg = p.kgKs != null ? p.kgKs : (k && k.kg != null ? k.kg : (od && od.kg != null ? od.kg : null));
    const posledni = (p.udalosti || []).slice(-1)[0] || null;
    const dnuVeStavu = posledni ? Math.floor((Date.now() - posledni.ts) / DEN) : null;
    return Object.assign({}, p, {
      kgKs: kg, kgCelkem: kg != null ? Math.round(kg * num(p.ks)) : null, kgOdvozene: kg != null && p.kgKs == null && !(k && k.kg != null),
      rozmer: p.rozmer || (k ? k.rozmer : (od ? od.rozmer : '')), objem: p.objem != null ? p.objem : (k ? k.objem : (od ? od.objem : null)),
      skluzDni: skluz(p, dnes), dnuVeStavu,
      cekaBezKamionu: p.stav === 'hotovo' && dnuVeStavu != null && dnuVeStavu >= nast.upozorneniDny,
    });
  }
  function obohatObjednavku(d, o, dnes, nast) {
    const pol = d.polozky.filter(p => p.objId === o.id).sort((a, b) => (a.pozice || 0) - (b.pozice || 0)).map(p => obohatPolozku(d, p, dnes, nast));
    const z = d.zakaznici.find(x => x.id === o.zakaznikId) || null;
    const pr = d.zakaznici.find(x => x.id === o.prijemceId) || z;
    return Object.assign({}, o, {
      polozky: pol,
      stav: stavObjednavky(pol),
      zakaznik: z ? z.nazev : (o.zakaznikNazev || ''),
      prijemce: pr ? pr.nazev : (o.prijemceNazev || ''),
      prijemceAdresa: pr ? adresa(pr) : (o.prijemceAdresa || ''),
      ks: pol.filter(p => p.stav !== 'storno').reduce((s, p) => s + num(p.ks), 0),
      kg: pol.filter(p => p.stav !== 'storno').reduce((s, p) => s + (p.kgCelkem || 0), 0),
      skluzDni: Math.max(0, ...pol.map(p => p.skluzDni)),
    });
  }
  function adresa(z) { return [z.ulice, [z.psc, z.mesto].filter(Boolean).join(' '), z.zeme].filter(Boolean).join(', '); }

  // ---- Google tabulka ZAKÁZKY POPELNICE (obousměrná synchronizace) ---------------------
  const stavLabel = k => (STAVY.find(s => s[0] === k) || [k, k])[1];
  const stavKey = lbl => { const l = low(lbl); const s = STAVY.find(s => low(s[1]) === l || s[0] === l); return s ? s[0] : null; };
  const SYS = { email: 'tabulka@elkoplast.cz', name: 'Google tabulka' };
  const norm = x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  const zmen = (obj, k, v) => { if (norm(obj[k]) === norm(v)) return false; obj[k] = v; return true; };
  // Převzetí upraveného řádku z tabulky do dat. Vrací true, když se něco změnilo.
  function aplikujZTabulky(d, key, obj) {
    if (key === 'objednavky') {
      const o = d.objednavky.find(x => x.id === obj.id); if (!o) return false; let z = false;
      if (zmen(o, 'cislo', cisloKey(obj.cislo))) z = true; if (zmen(o, 'cisloAU', str(obj.cisloAU, 30))) z = true; if (zmen(o, 'helios', str(obj.helios, 20))) z = true;
      if (obj.datum && zmen(o, 'datum', obj.datum)) z = true;
      if (zmen(o, 'kwDodani', obj.kwDodani == null || obj.kwDodani === '' ? null : Math.round(obj.kwDodani))) { z = true; if (o.kwDodani && !o.kwRok) o.kwRok = Number(String(o.datum || dnesISO()).slice(0, 4)); }
      if (zmen(o, 'terminDodani', obj.terminDodani || '')) z = true;
      if (!!o.potvrzena !== !!obj.potvrzena) { o.potvrzena = !!obj.potvrzena; o.potvrzenaDatum = o.potvrzena ? (o.potvrzenaDatum || dnesISO()) : ''; z = true; }
      if (zmen(o, 'doprava', str(obj.doprava, 80))) z = true; if (zmen(o, 'poznamka', str(obj.poznamka, 1000))) z = true; if (zmen(o, 'driveUrl', str(obj.driveUrl, 300))) z = true;
      if (z) { o.updatedAt = Date.now(); o.updatedBy = SYS.email; d.polozky.filter(p => p.objId === o.id && !p.cvz).forEach(p => { p.terminVyroby = terminVyrobyZ(o, d.nastaveni) || p.terminVyroby; }); }
      return z;
    }
    if (key === 'polozky') {
      const p = d.polozky.find(x => x.id === obj.id); if (!p) return false; let z = false; const zm = [];
      const S = (k, v, max) => { if (zmen(p, k, str(v, max))) { z = true; zm.push(k); } };
      const N = (k, v) => { const nv = v == null || v === '' ? null : v; if ((p[k] == null ? '' : String(p[k])) !== (nv == null ? '' : String(nv))) { p[k] = nv; z = true; zm.push(k); } };
      if (obj.kod && zmen(p, 'kod', str(obj.kod, 80))) { z = true; zm.push('kod'); const k = najdiKatalog(d, p.kod); p.katalogId = k ? k.id : null; }
      S('nazev', obj.nazev, 200); if (obj.ks != null && obj.ks !== '' && Math.round(obj.ks) !== num(p.ks)) { p.ks = Math.max(0, Math.round(obj.ks)); z = true; zm.push('ks'); }
      S('rozmer', obj.rozmer, 40); N('tloustka', obj.tloustka); N('kgKs', obj.kgKs); if (POVRCH[obj.povrch]) S('povrch', obj.povrch, 10);
      S('ral', obj.ral, 40); S('lem', obj.lem, 40); S('razeni', obj.razeni, 200); S('polepy', obj.polepy, 200); S('heliosPolozka', obj.heliosPolozka, 20); N('cena', obj.cena);
      if (obj.vykresStav && VYKRES[obj.vykresStav] && (!p.vykres || p.vykres.stav !== obj.vykresStav)) { p.vykres = { stav: obj.vykresStav, datum: dnesISO() }; z = true; zm.push('výkres'); }
      if (obj.terminVyroby !== undefined && zmen(p, 'terminVyroby', obj.terminVyroby || '')) { z = true; zm.push('termín'); }
      const ns = obj.stav ? stavKey(obj.stav) : null;
      if (ns && ns !== p.stav) { p.stav = ns; z = true; zm.push('stav'); if (ns === 'hotovo') { p.hotovoDne = p.hotovoDne || dnesISO(); p.hotovoKs = num(p.ks); } if (ns === 'expedovano') p.expedovanoDne = p.expedovanoDne || obj.expedovanoDne || dnesISO(); }
      if (obj.hotovoKs != null && obj.hotovoKs !== '' && Math.round(obj.hotovoKs) !== num(p.hotovoKs)) { p.hotovoKs = Math.max(0, Math.round(obj.hotovoKs)); z = true; zm.push('hotovo ks'); }
      S('kamion', obj.kamion, 30); if (zmen(p, 'expedovanoDne', obj.expedovanoDne || '')) { z = true; zm.push('expedováno'); } if (zmen(p, 'dorucenoDne', obj.dorucenoDne || '')) { z = true; zm.push('doručeno'); }
      S('poznamka', obj.poznamka, 400);
      if (z) { p.udalosti = p.udalosti || []; p.udalosti.push({ ts: Date.now(), kdo: SYS.email, jmeno: SYS.name, stav: p.stav, ks: null, pozn: 'úprava z tabulky: ' + zm.join(', ') }); }
      return z;
    }
    if (key === 'katalog') {
      const k = d.katalog.find(x => x.id === obj.id); if (!k) return false;
      const nk = normKatalog(Object.assign({}, k, { kod: obj.kod || k.kod, nazev: obj.nazev, objem: obj.objem, rozmer: obj.rozmer, tloustka: obj.tloustka, kg: obj.kg, povrch: obj.povrch || k.povrch, stoh: obj.stoh, aktivni: !!obj.aktivni, id: k.id }));
      const before = JSON.stringify(k); Object.assign(k, nk); return JSON.stringify(k) !== before;
    }
    if (key === 'zakaznici') {
      const z = d.zakaznici.find(x => x.id === obj.id); if (!z) return false;
      const nz = normZakaznik(Object.assign({}, z, obj, { nazev: obj.nazev || z.nazev }), z);
      const before = JSON.stringify(z); Object.assign(z, nz); return JSON.stringify(z) !== before;
    }
    return false;
  }
  // Nový řádek v listu Položky (bez ID): založí položku k objednávce podle Bestellung / Helios čísla, případně i objednávku.
  function novaZTabulky(d, obj) {
    let o = najdiObjednavku(d, obj.cislo, obj.helios);
    if (!o) {
      if (!obj.cislo && !obj.helios) return false;
      o = { id: newId('o'), createdAt: Date.now(), createdBy: SYS.email, loznyplan: null, cislo: cisloKey(obj.cislo), cisloAU: '', helios: str(obj.helios, 20), datum: dnesISO(), zakaznikId: null, zakaznikNazev: '', prijemceId: null, prijemceNazev: '', kwDodani: obj.kwDodani || null, kwRok: obj.kwDodani ? new Date().getFullYear() : null, terminDodani: '', doprava: '', mena: 'EUR', potvrzena: false, potvrzenaDatum: '', poznamka: '', driveUrl: '', zdroj: 'tabulka' };
      if (obj.prijemce) { const z = zajistiZakaznika(d, null, obj.prijemce, { partner: 'contract' }); o.zakaznikId = z.id; o.zakaznikNazev = z.nazev; o.prijemceId = z.id; }
      d.objednavky.push(o);
    }
    const np = normPolozka(d, { kod: obj.kod, nazev: obj.nazev, ks: obj.ks, rozmer: obj.rozmer, tloustka: obj.tloustka, kgKs: obj.kgKs, povrch: obj.povrch, ral: obj.ral, lem: obj.lem, razeni: obj.razeni, polepy: obj.polepy, heliosPolozka: obj.heliosPolozka, cena: obj.cena, poznamka: obj.poznamka, vykres: { stav: obj.vykresStav || 'neni', datum: '' } }, o.id);
    np.pozice = d.polozky.filter(p => p.objId === o.id).length + 1;
    Object.assign(np, { cvz: null, rok: null, poradi: null, stav: 'prijata', hotovoKs: 0, kamion: str(obj.kamion, 30), terminVyroby: obj.terminVyroby || terminVyrobyZ(o, d.nastaveni), udalosti: [{ ts: Date.now(), kdo: SYS.email, jmeno: SYS.name, stav: 'prijata', ks: null, pozn: 'založeno z tabulky' }], zdroj: 'tabulka' });
    d.polozky.push(np); return true;
  }
  const sheet = sheetsync.mount(host, {
    load, save: saveRaw, STAVY, stavLabel, stavKey, aplikujZTabulky, novaZTabulky,
    obohat: (d) => { const dnes = dnesISO(); return d.objednavky.map(o => obohatObjednavku(d, o, dnes, d.nastaveni)).sort((a, b) => String(b.datum || '').localeCompare(String(a.datum || ''))); },
  });

  // ---- HTTP ----------------------------------------------------------------
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (p !== '/vyroba' && p !== '/vyroba/' && !p.startsWith('/api/vyroba')) return false;

    // Server-to-server (Bearer = SSO tajemství intranetu): spuštění importů bez přihlášeného uživatele
    // (nástroj tools-vyroba-import.js přes `railway run`). Stejný vzor jako ingest u lodních kontejnerů.
    if (p === '/api/vyroba/ingest' && req.method === 'POST') {
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      let ok = false; try { ok = !!auth && !!host.ssoSecret && require('crypto').timingSafeEqual(Buffer.from(auth), Buffer.from(String(host.ssoSecret))); } catch (_) { ok = false; }
      if (!ok) { json(res, 401, { chyba: 'Neplatné tajemství.' }); return true; }
      const rs = { email: 'intranet@elkoplast.cz', name: 'Import (server)', admin: true, obchod: true, vyroba: true, pristup: true };
      try {
        const b = JSON.parse(await host.readBody(req) || '{}');
        if (b.akce === 'sheet') return await apiImportSheet(req, res, rs, b);
        if (b.akce === 'drive') return await apiImportDrive(req, res, rs, b);
        if (b.akce === 'xlsx') return apiImportXlsx(req, res, rs, b);
        if (b.akce === 'pdf') return apiImportPdf(req, res, rs, b);
        if (b.akce === 'text') return apiImportText(req, res, rs, b);
        if (b.akce === 'sync') { const st = await sheet.sync('ručně (server)'); json(res, 200, Object.assign({ ok: !st.chyba }, st)); return true; }
        if (b.akce === 'stav') { const d = load(); json(res, 200, { objednavek: d.objednavky.length, polozek: d.polozky.length, zakazniku: d.zakaznici.length, katalog: d.katalog.length, seq: d.seq, import: d.import }); return true; }
        json(res, 400, { chyba: 'Neznámá akce (sheet | drive | xlsx | pdf | stav).' }); return true;
      } catch (e) { console.error('[vyroba] ingest:', e); json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true; }
    }

    const r = role(req);
    if (!r.pristup) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'K modulu Výroba Popelnice nemáte přístup.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">'
        + 'K modulu Výroba Popelnice nemáte přístup. Přiděluje ho správce intranetu (Přístupy → Výroba Popelnice).</p>');
      return true;
    }
    if ((p === '/vyroba' || p === '/vyroba/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí vyroba.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }
    try {
      if (p === '/api/vyroba/data' && req.method === 'GET') return apiData(req, res, r);
      if (p === '/api/vyroba/export' && req.method === 'GET') return apiExport(req, res);
      if (p === '/api/vyroba/drive' && req.method === 'GET') return await apiDrive(req, res, u.query);
      if (req.method !== 'POST') { json(res, 404, { chyba: 'Neznámý požadavek.' }); return true; }
      const b = JSON.parse(await host.readBody(req) || '{}');
      if (p === '/api/vyroba/import/pdf') { if (!r.obchod) { json(res, 403, { chyba: 'Jen obchod.' }); return true; } return apiImportPdf(req, res, r, b); }
      if (p === '/api/vyroba/import/xlsx') { if (!r.obchod) { json(res, 403, { chyba: 'Jen obchod.' }); return true; } return apiImportXlsx(req, res, r, b); }
      if (p === '/api/vyroba/import/drive') { if (!r.obchod) { json(res, 403, { chyba: 'Jen obchod.' }); return true; } return await apiImportDrive(req, res, r, b); }
      const jenObchod = () => { if (!r.obchod) { json(res, 403, { chyba: 'Tuto akci může provést jen obchod nebo správce.' }); return false; } return true; };
      switch (p) {
        case '/api/vyroba/objednavka':          return jenObchod() && apiObjednavka(req, res, r, b);
        case '/api/vyroba/objednavka/zadat':    return jenObchod() && apiZadat(req, res, r, b);
        case '/api/vyroba/objednavka/stav':     return jenObchod() && apiObjStav(req, res, r, b);
        case '/api/vyroba/objednavka/smazat':   return jenObchod() && apiObjSmazat(req, res, r, b);
        case '/api/vyroba/polozka':             return jenObchod() && apiPolozka(req, res, r, b);
        case '/api/vyroba/polozka/stav':        return apiPolozkaStav(req, res, r, b);
        case '/api/vyroba/polozka/vykres':      return apiPolozkaVykres(req, res, r, b);
        case '/api/vyroba/zakaznik':            return jenObchod() && apiZakaznik(req, res, r, b);
        case '/api/vyroba/katalog':             return jenObchod() && apiKatalog(req, res, r, b);
        case '/api/vyroba/katalog/smazat':      return jenObchod() && apiKatalogSmazat(req, res, r, b);
        case '/api/vyroba/import/sheet':        return jenObchod() && await apiImportSheet(req, res, r, b);
        case '/api/vyroba/import/rows':         return jenObchod() && apiImportRows(req, res, r, b);
        case '/api/vyroba/loznyplan/odeslat':   return jenObchod() && await apiLoznyPlanOdeslat(req, res, r, b);
        case '/api/vyroba/nastaveni':           return jenObchod() && apiNastaveni(req, res, r, b);
        case '/api/vyroba/sheet/sync':          { if (!jenObchod()) return true; const st = await sheet.sync('ručně'); json(res, 200, Object.assign({ ok: !st.chyba }, st)); return true; }
      }
    } catch (e) {
      console.error('[vyroba] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }
    json(res, 404, { chyba: 'Neznámý požadavek.' }); return true;
  }

  // ---- čtení ---------------------------------------------------------------
  function apiData(req, res, r) {
    const d = load(), dnes = dnesISO(), nast = d.nastaveni;
    const objednavky = d.objednavky.map(o => obohatObjednavku(d, o, dnes, nast))
      .sort((a, b) => String(b.datum || '').localeCompare(String(a.datum || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    json(res, 200, {
      me: r,
      objednavky,
      katalog: d.katalog.slice().sort((a, b) => a.kod.localeCompare(b.kod, 'cs')),
      zakaznici: d.zakaznici.slice().sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs')),
      nastaveni: nast,
      stavy: STAVY, vykres: VYKRES, povrch: POVRCH, ralHex: RAL_HEX,
      seq: d.seq, import: d.import,
      sheetDostupny: !!(host.sheets && host.sheets.available),
      driveDostupny: !!(host.drive && host.drive.available),
      loznyplanUrl: host.loznyplan && host.loznyplan.url || '',
      sheetSync: Object.assign({}, d.sheetSync || {}, sheet.stav(), { url: nast.syncSheetId ? 'https://docs.google.com/spreadsheets/d/' + nast.syncSheetId + '/edit' : '' }),
      zamestnanci: zamestnanci(),
      dnes,
    });
    return true;
  }

  // ---- objednávka ----------------------------------------------------------
  function normPolozka(d, p, objId) {
    const k = p.katalogId ? d.katalog.find(x => x.id === p.katalogId) : najdiKatalog(d, p.kod);
    const kod = str(p.kod || (k && k.kod), 80);
    const od = (!k || k.kg == null || !k.rozmer) ? odvozenyProdukt(d, kod) : null;
    return {
      id: p.id || newId('p'), objId,
      pozice: num(p.pozice, 0) || null,
      katalogId: k ? k.id : null,
      kod, nazev: str(p.nazev, 200),
      ks: Math.max(0, Math.round(num(p.ks))),
      rozmer: str(p.rozmer || (k && k.rozmer) || (od && od.rozmer), 40),
      tloustka: p.tloustka != null && p.tloustka !== '' ? num(p.tloustka) : (k && k.tloustka != null ? k.tloustka : (od && od.tloustka != null ? od.tloustka : null)),
      objem: p.objem != null && p.objem !== '' ? num(p.objem) : (k ? k.objem : (od ? od.objem : null)),
      kgKs: p.kgKs != null && p.kgKs !== '' ? num(p.kgKs) : (od && od.kg != null ? od.kg : null),
      povrch: str(p.povrch, 10) || (k ? k.povrch : povrchZKodu(kod)),
      ral: str(p.ral, 40), lem: str(p.lem, 40),
      razeni: str(p.razeni, 200), polepy: str(p.polepy, 200),
      heliosPolozka: str(p.heliosPolozka, 20), cena: p.cena != null && p.cena !== '' ? num(p.cena) : null,
      vykres: { stav: (p.vykres && VYKRES[p.vykres.stav]) ? p.vykres.stav : 'neni', datum: str(p.vykres && p.vykres.datum, 10) },
      poznamka: str(p.poznamka, 400),
    };
  }
  function apiObjednavka(req, res, r, b) {
    const d = load();
    const je = b.id ? d.objednavky.find(o => o.id === b.id) : null;
    if (b.id && !je) { json(res, 404, { chyba: 'Objednávka nenalezena.' }); return true; }
    const o = je || { id: newId('o'), createdAt: Date.now(), createdBy: r.email, loznyplan: null };
    // zákazník / příjemce: buď existující id, nebo nový záznam podle názvu
    const zak = zajistiZakaznika(d, b.zakaznikId, b.zakaznikNazev, b.zakaznik);
    const pri = zajistiZakaznika(d, b.prijemceId, b.prijemceNazev, b.prijemce);
    Object.assign(o, {
      cislo: str(b.cislo, 30), cisloAU: str(b.cisloAU, 30), helios: str(b.helios, 20),
      datum: str(b.datum, 10) || dnesISO(),
      zakaznikId: zak ? zak.id : null, zakaznikNazev: zak ? zak.nazev : str(b.zakaznikNazev, 160),
      prijemceId: pri ? pri.id : (zak ? zak.id : null), prijemceNazev: pri ? pri.nazev : '',
      kwDodani: num(b.kwDodani, 0) || null, kwRok: num(b.kwRok, 0) || null,
      terminDodani: str(b.terminDodani, 10),
      doprava: str(b.doprava, 80), mena: str(b.mena, 3) || 'EUR',
      potvrzena: !!b.potvrzena, potvrzenaDatum: b.potvrzena ? (o.potvrzenaDatum || dnesISO()) : '',
      poznamka: str(b.poznamka, 1000), driveUrl: str(b.driveUrl, 300),
      updatedAt: Date.now(), updatedBy: r.email,
    });
    if (!o.kwRok && o.kwDodani) o.kwRok = Number(o.datum.slice(0, 4));
    if (!je) d.objednavky.push(o);
    // položky: přijaté pole je kompletní stav položek (upravit, přidat, odebrat ty bez ČVZ)
    if (Array.isArray(b.polozky)) {
      const stavajici = d.polozky.filter(p => p.objId === o.id);
      const ids = new Set();
      b.polozky.forEach((bp, i) => {
        const ex = bp.id ? stavajici.find(p => p.id === bp.id) : null;
        const np = normPolozka(d, bp, o.id); np.pozice = np.pozice || (i + 1);
        if (ex) { Object.assign(ex, np, { id: ex.id, cvz: ex.cvz, rok: ex.rok, poradi: ex.poradi, stav: ex.stav, udalosti: ex.udalosti, terminVyroby: ex.terminVyroby, hotovoKs: ex.hotovoKs, kamion: ex.kamion }); ids.add(ex.id); }
        else { Object.assign(np, { cvz: null, rok: null, poradi: null, stav: 'prijata', hotovoKs: 0, kamion: '', terminVyroby: terminVyrobyZ(o, d.nastaveni), udalosti: [udalost(r, 'prijata', null, 'založeno')] }); d.polozky.push(np); ids.add(np.id); }
      });
      // odebrané položky: bez ČVZ smazat, s ČVZ stornovat (řada čísel musí zůstat souvislá)
      stavajici.filter(p => !ids.has(p.id)).forEach(p => {
        if (!p.cvz) d.polozky = d.polozky.filter(x => x.id !== p.id);
        else if (p.stav !== 'storno') { p.stav = 'storno'; p.udalosti.push(udalost(r, 'storno', null, 'položka odebrána z objednávky')); }
      });
    }
    // termín výroby položek, které ho nemají (nebo se změnila KW)
    d.polozky.filter(p => p.objId === o.id && !p.cvz).forEach(p => { p.terminVyroby = terminVyrobyZ(o, d.nastaveni); });
    save(d);
    logAct('vyroba', req, (je ? 'Upravena' : 'Založena') + ' objednávka ' + (o.cislo || o.helios || o.id));
    json(res, 200, { ok: true, id: o.id, objednavka: obohatObjednavku(d, o, dnesISO(), d.nastaveni) });
    return true;
  }
  function zajistiZakaznika(d, id, nazev, obj) {
    if (id) { const z = d.zakaznici.find(x => x.id === id); if (z) { if (obj && typeof obj === 'object') Object.assign(z, normZakaznik(obj, z)); return z; } }
    const n = str(nazev || (obj && obj.nazev), 160); if (!n) return null;
    let z = d.zakaznici.find(x => low(x.nazev) === low(n));
    if (!z) { z = normZakaznik(Object.assign({ nazev: n }, obj || {}), null); d.zakaznici.push(z); }
    else if (obj && typeof obj === 'object') Object.assign(z, normZakaznik(Object.assign({}, obj, { nazev: z.nazev }), z));
    return z;
  }
  function normZakaznik(b, ex) {
    return {
      id: (ex && ex.id) || b.id || newId('z'),
      nazev: str(b.nazev, 160), ulice: str(b.ulice, 120), mesto: str(b.mesto, 80), psc: str(b.psc, 12), zeme: str(b.zeme, 4) || (ex ? ex.zeme : 'CH'),
      partner: str(b.partner, 20) || (ex ? ex.partner : 'contract'),   // contract | primy
      kontakt: str(b.kontakt, 120), email: str(b.email, 120), telefon: str(b.telefon, 40),
      jazyk: str(b.jazyk, 2) || (ex ? ex.jazyk : 'de'),
      poznamka: str(b.poznamka, 400),
    };
  }
  function udalost(r, stav, ks, pozn) { return { ts: Date.now(), kdo: r.email, jmeno: r.name, stav, ks: ks == null ? null : num(ks), pozn: str(pozn, 300) }; }

  // Zadání do výroby: přidělí ČVZ všem položkám bez čísla a posune je na „zadáno".
  function apiZadat(req, res, r, b) {
    const d = load();
    const o = d.objednavky.find(x => x.id === b.id); if (!o) { json(res, 404, { chyba: 'Objednávka nenalezena.' }); return true; }
    const rok = new Date().getFullYear();
    let n = 0;
    d.polozky.filter(p => p.objId === o.id && p.stav !== 'storno').forEach(p => {
      if (!p.cvz) { const c = dalsiCvz(d, rok); p.cvz = c.cvz; p.rok = c.rok; p.poradi = c.poradi; }
      if (p.stav === 'prijata') { p.stav = 'zadano'; p.zadanoDne = dnesISO(); p.udalosti.push(udalost(r, 'zadano', null, b.pozn || '')); n++; }
      if (!p.terminVyroby) p.terminVyroby = terminVyrobyZ(o, d.nastaveni);
    });
    o.zadanoDne = o.zadanoDne || dnesISO();
    save(d);
    logAct('vyroba', req, 'Zadáno do výroby: ' + (o.cislo || o.helios || o.id) + ' (' + n + ' položek)');
    json(res, 200, { ok: true, objednavka: obohatObjednavku(d, o, dnesISO(), d.nastaveni) });
    return true;
  }
  function apiObjStav(req, res, r, b) {
    const d = load();
    const o = d.objednavky.find(x => x.id === b.id); if (!o) { json(res, 404, { chyba: 'Objednávka nenalezena.' }); return true; }
    const akce = str(b.akce, 20);
    const pol = d.polozky.filter(p => p.objId === o.id);
    if (akce === 'potvrdit') { o.potvrzena = true; o.potvrzenaDatum = str(b.datum, 10) || dnesISO(); }
    else if (akce === 'storno') pol.forEach(p => { if (STAV_PORADI[p.stav] < STAV_PORADI.expedovano) { p.stav = 'storno'; p.udalosti.push(udalost(r, 'storno', null, b.pozn || '')); } });
    else if (akce === 'pozastavit') pol.forEach(p => { if (STAV_PORADI[p.stav] < STAV_PORADI.hotovo) { p.stavPred = p.stav; p.stav = 'pozastaveno'; p.udalosti.push(udalost(r, 'pozastaveno', null, b.pozn || '')); } });
    else if (akce === 'obnovit') pol.forEach(p => { if (p.stav === 'pozastaveno') { p.stav = p.stavPred || 'zadano'; delete p.stavPred; p.udalosti.push(udalost(r, p.stav, null, 'obnoveno')); } });
    else { json(res, 400, { chyba: 'Neznámá akce.' }); return true; }
    save(d);
    logAct('vyroba', req, 'Objednávka ' + (o.cislo || o.helios) + ': ' + akce);
    json(res, 200, { ok: true, objednavka: obohatObjednavku(d, o, dnesISO(), d.nastaveni) });
    return true;
  }
  function apiObjSmazat(req, res, r, b) {
    const d = load();
    const o = d.objednavky.find(x => x.id === b.id); if (!o) { json(res, 404, { chyba: 'Objednávka nenalezena.' }); return true; }
    if (d.polozky.some(p => p.objId === o.id && p.cvz)) { json(res, 400, { chyba: 'Objednávka už má výrobní čísla — místo smazání ji stornujte.' }); return true; }
    d.objednavky = d.objednavky.filter(x => x.id !== o.id);
    d.polozky = d.polozky.filter(p => p.objId !== o.id);
    save(d); json(res, 200, { ok: true }); return true;
  }
  function apiPolozka(req, res, r, b) {
    const d = load();
    const p = d.polozky.find(x => x.id === b.id); if (!p) { json(res, 404, { chyba: 'Položka nenalezena.' }); return true; }
    const np = normPolozka(d, Object.assign({}, p, b), p.objId);
    Object.assign(p, np, { id: p.id, cvz: p.cvz, rok: p.rok, poradi: p.poradi, stav: p.stav, udalosti: p.udalosti, hotovoKs: p.hotovoKs, kamion: p.kamion });
    if (b.terminVyroby !== undefined) p.terminVyroby = str(b.terminVyroby, 10) || p.terminVyroby;
    save(d); json(res, 200, { ok: true, polozka: obohatPolozku(d, p, dnesISO(), d.nastaveni) }); return true;
  }

  // Změna stavu položky (dílna i obchod). Částečné množství = zapíše se ks k události a hotovoKs.
  function apiPolozkaStav(req, res, r, b) {
    const d = load();
    const ids = Array.isArray(b.ids) ? b.ids : [b.id];
    const stav = str(b.stav, 20);
    if (!STAV_KEYS.includes(stav)) { json(res, 400, { chyba: 'Neznámý stav.' }); return true; }
    if (!r.obchod && ['prijata', 'storno', 'doruceno'].includes(stav)) { json(res, 403, { chyba: 'Tento stav mění jen obchod.' }); return true; }
    const out = [];
    ids.forEach(id => {
      const p = d.polozky.find(x => x.id === id); if (!p) return;
      const ks = b.ks != null && b.ks !== '' ? Math.max(0, Math.round(num(b.ks))) : null;
      if (stav === 'hotovo') p.hotovoKs = ks != null ? Math.min(num(p.ks), num(p.hotovoKs) + ks) : num(p.ks);
      if (stav === 'hotovo' && ks != null && p.hotovoKs < num(p.ks)) {
        // část hotová: položka zůstává ve stavu, jen se zapíše událost s počtem
        p.udalosti.push(udalost(r, p.stav, ks, 'hotovo ' + p.hotovoKs + ' z ' + p.ks + ' ks' + (b.pozn ? ' · ' + b.pozn : '')));
      } else {
        p.stav = stav;
        if (stav === 'zinkovna' || stav === 'lakovna') p.kooperace = { druh: stav, odvoz: str(b.datum, 10) || dnesISO(), ks: ks != null ? ks : num(p.ks) };
        if (stav === 'naplanovano') p.kamion = str(b.kamion, 30) || p.kamion;
        if (stav === 'expedovano') { p.expedovanoDne = str(b.datum, 10) || dnesISO(); p.kamion = str(b.kamion, 30) || p.kamion; }
        if (stav === 'doruceno') p.dorucenoDne = str(b.datum, 10) || dnesISO();
        if (stav === 'hotovo') p.hotovoDne = str(b.datum, 10) || dnesISO();
        p.udalosti.push(udalost(r, stav, ks, b.pozn || ''));
      }
      out.push(obohatPolozku(d, p, dnesISO(), d.nastaveni));
    });
    save(d);
    logAct('vyroba', req, 'Stav ' + stav + ': ' + out.map(p => p.cvz || p.kod).join(', '));
    json(res, 200, { ok: true, polozky: out }); return true;
  }
  function apiPolozkaVykres(req, res, r, b) {
    const d = load();
    const p = d.polozky.find(x => x.id === b.id); if (!p) { json(res, 404, { chyba: 'Položka nenalezena.' }); return true; }
    const stav = str(b.stav, 12); if (!VYKRES[stav]) { json(res, 400, { chyba: 'Neznámý stav výkresu.' }); return true; }
    p.vykres = { stav, datum: str(b.datum, 10) || dnesISO() };
    p.udalosti.push(udalost(r, p.stav, null, 'výkres: ' + VYKRES[stav]));
    save(d); json(res, 200, { ok: true, polozka: obohatPolozku(d, p, dnesISO(), d.nastaveni) }); return true;
  }

  // ---- zákazníci, katalog, nastavení -------------------------------------------
  function apiZakaznik(req, res, r, b) {
    const d = load();
    if (b.smazat && b.id) {
      if (d.objednavky.some(o => o.zakaznikId === b.id || o.prijemceId === b.id)) { json(res, 400, { chyba: 'Zákazník má objednávky, nelze smazat.' }); return true; }
      d.zakaznici = d.zakaznici.filter(z => z.id !== b.id); save(d); json(res, 200, { ok: true }); return true;
    }
    const ex = b.id ? d.zakaznici.find(z => z.id === b.id) : null;
    if (!str(b.nazev, 160)) { json(res, 400, { chyba: 'Chybí název zákazníka.' }); return true; }
    const z = normZakaznik(b, ex);
    if (ex) Object.assign(ex, z); else d.zakaznici.push(z);
    save(d); json(res, 200, { ok: true, zakaznik: ex || z }); return true;
  }
  function apiKatalog(req, res, r, b) {
    const d = load();
    if (!str(b.kod, 80)) { json(res, 400, { chyba: 'Chybí kód produktu.' }); return true; }
    const ex = b.id ? d.katalog.find(k => k.id === b.id) : null;
    const dup = najdiKatalog(d, b.kod);
    if (dup && (!ex || dup.id !== ex.id)) { json(res, 400, { chyba: 'Produkt ' + dup.kod + ' už v katalogu je.' }); return true; }
    const k = normKatalog(Object.assign({}, ex || {}, b, { id: ex ? ex.id : undefined }));
    if (ex) Object.assign(ex, k); else d.katalog.push(k);
    save(d); json(res, 200, { ok: true, produkt: ex || k }); return true;
  }
  function apiKatalogSmazat(req, res, r, b) {
    const d = load();
    const k = d.katalog.find(x => x.id === b.id); if (!k) { json(res, 404, { chyba: 'Produkt nenalezen.' }); return true; }
    if (d.polozky.some(p => p.katalogId === k.id)) { k.aktivni = false; } else d.katalog = d.katalog.filter(x => x.id !== k.id);
    save(d); json(res, 200, { ok: true }); return true;
  }
  function apiNastaveni(req, res, r, b) {
    const d = load(), n = d.nastaveni;
    const emaily = v => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(low).filter(x => /@/.test(x));
    if (b.reditelVyroby !== undefined) n.reditelVyroby = emaily(b.reditelVyroby);
    if (b.obchod !== undefined) n.obchod = emaily(b.obchod);
    if (b.sheetId !== undefined) n.sheetId = str(b.sheetId, 120);
    if (b.sheetList !== undefined) n.sheetList = str(b.sheetList, 80);
    if (b.sheetListOstatni !== undefined) n.sheetListOstatni = str(b.sheetListOstatni, 80);
    if (b.driveRoot !== undefined) n.driveRoot = str(b.driveRoot, 120);
    if (b.prubeznaDobaDny !== undefined) n.prubeznaDobaDny = Math.max(0, Math.round(num(b.prubeznaDobaDny, 7)));
    if (b.upozorneniDny !== undefined) n.upozorneniDny = Math.max(1, Math.round(num(b.upozorneniDny, 7)));
    if (b.syncSheetId !== undefined) { const v = str(b.syncSheetId, 200); const m = v.match(/\/d\/([A-Za-z0-9_-]{20,})/); n.syncSheetId = m ? m[1] : v; if (d.sheetSync) { d.sheetSync.otisky = {}; d.sheetSync.formatovano = ''; } }
    if (b.syncMinuty !== undefined) n.syncMinuty = Math.max(1, Math.round(num(b.syncMinuty, 5)));
    save(d); json(res, 200, { ok: true, nastaveni: n }); return true;
  }

  // ---- import z Google Sheetu PLÁN VÝROBY ------------------------------------
  // Sloupce listu „Boxy contract 2026": 0 prefix (26B) · 1 pořadí · 2 zadáno · 3 výrobek · 4 rozměr · 5 tloušťka ·
  // 6 ks · 7 RAL · 8 objem · 9 číslo položky Helios · 10 název (ražení, polepy) · 11 stav · 12 číslo objednávky Helios ·
  // 13 (variantní název zákazníka) · 14 místo dodání · 15 požadovaný termín · 16 poznámka · 17 expedice
  function datumZ(s) {
    const t = String(s || '').trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = t.match(/(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{2,4})/);
    if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); }
    return null;
  }
  function importRows(d, rows, r, list) {
    const stat = { objednavek: 0, polozek: 0, aktualizovano: 0, preskoceno: 0 };
    const rokTab = new Date().getFullYear();
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const prefix = str(row[0], 6).replace(/\s/g, ''); const poradi = Math.round(num(row[1], 0));
      const vyrobek = str(row[3], 120);
      const m = prefix.match(/^(\d{2})B$/i);
      if (!m || !poradi || !vyrobek) { stat.preskoceno++; continue; }
      const rok = 2000 + Number(m[1]);
      const cvz = m[1] + 'B-' + String(poradi).padStart(3, '0');
      const heliosObj = str(row[12], 20).replace(/\.0$/, '');
      const zakaznikNazev = str(row[14], 160) || str(row[13], 160) || 'Neznámý zákazník';
      // objednávka = Helios číslo (+ zákazník), jinak jedna „sběrná" na zákazníka
      const klic = heliosObj || ('bez-helios:' + low(zakaznikNazev));
      let o = d.objednavky.find(x => (x.helios && x.helios === heliosObj) || (!heliosObj && x.importKlic === klic));
      if (!o) {
        const z = zajistiZakaznika(d, null, zakaznikNazev, { partner: list === 'ostatni' ? 'primy' : 'contract' });
        o = { id: newId('o'), cislo: '', cisloAU: '', helios: heliosObj, importKlic: klic, datum: datumZ(row[2]) || dnesISO(),
          zakaznikId: z.id, zakaznikNazev: z.nazev, prijemceId: z.id, prijemceNazev: '',
          kwDodani: null, kwRok: null, terminDodani: datumZ(row[15]) || '', doprava: '', mena: 'EUR', potvrzena: true, potvrzenaDatum: '',
          poznamka: '', driveUrl: '', createdAt: Date.now(), createdBy: r.email, zdroj: 'sheet', loznyplan: null };
        const kw = kwZData(o.terminDodani); if (kw) { o.kwDodani = kw.kw; o.kwRok = kw.rok; }
        d.objednavky.push(o); stat.objednavek++;
      }
      const ralText = str(row[7], 80);
      const ralM = ralText.match(/RAL\s?(\d{4})/i); const lemM = ralText.match(/lem\s*(?:RAL\s?)?(\d{4})/i);
      const povrch = /pozink|zin/i.test(ralText) ? 'zinek' : (/zákl/i.test(ralText) ? 'zaklad' : (ralM ? 'lak' : povrchZKodu(vyrobek)));
      const nazev = str(row[10], 200);
      const razM = nazev.match(/ražení\s*názvu\s*[:\-]?\s*([^\n]*)/i);
      const polepM = nazev.match(/polepy?\s*([^\n]*)/i);
      const pozn = str(row[16], 300); const exped = datumZ(row[17]); const stavTxt = low(row[11]) + ' ' + low(pozn) + ' ' + low(row[17]);
      let stav = 'zadano';
      if (/storno/.test(stavTxt)) stav = 'storno';
      else if (exped || /^\s*\d{1,2}\.\s*\d{1,2}\./.test(String(row[17] || ''))) stav = 'expedovano';
      else if (/zinkovn|zink\b|zin\.|zink /.test(low(pozn))) stav = 'zinkovna';
      else if (/hotovo|hot\./.test(stavTxt)) stav = 'hotovo';
      const tl = num(row[5], 0); const objem = num(row[8], 0);
      let p = d.polozky.find(x => x.cvz === cvz);
      const kat = najdiKatalog(d, vyrobek); const od = (!kat || kat.kg == null || !kat.rozmer) ? odvozenyProdukt(d, vyrobek) : null;
      const data = {
        objId: o.id, pozice: null, katalogId: kat ? kat.id : null, kod: vyrobek, nazev: '',
        ks: Math.round(num(row[6], 0)), rozmer: str(row[4], 40) || (od ? od.rozmer : ''),
        tloustka: tl > 0 && tl < 20 ? tl : (od && od.tloustka != null ? od.tloustka : null), objem: objem > 0 && objem < 100 ? objem : (od ? od.objem : null), kgKs: od && od.kg != null ? od.kg : null,
        // v RAL sloupci bývá u vík a náhradních dílů popis („komplet-hrazda, zámek…") → jde do názvu, ne do RAL
        povrch, ral: ralM ? 'RAL ' + ralM[1] : (povrch === 'zinek' || !/RAL|lak/i.test(ralText) ? '' : ralText), lem: lemM ? 'RAL ' + lemM[1] : '',
        nazev: !ralM && !/pozink|zin|RAL|lak/i.test(ralText) ? ralText : '',
        razeni: razM ? str(razM[1].replace(/\s{2,}/g, ' '), 200) : (nazev && !/polep/i.test(nazev) ? nazev.replace(/\s{2,}/g, ' ') : ''),
        polepy: polepM ? str(polepM[0].replace(/\s{2,}/g, ' '), 200) : '',
        heliosPolozka: str(row[9], 20).replace(/\.0$/, ''), cena: null,
        poznamka: pozn, terminVyroby: datumZ(row[15]), zadanoDne: datumZ(row[2]),
      };
      if (!p) {
        p = Object.assign({ id: newId('p'), cvz, rok, poradi, stav, hotovoKs: stav === 'hotovo' || STAV_PORADI[stav] >= STAV_PORADI.expedovano ? data.ks : 0, kamion: '',
          expedovanoDne: exped || '', vykres: { stav: 'neni', datum: '' },
          udalosti: [{ ts: Date.now(), kdo: r.email, jmeno: r.name, stav, ks: null, pozn: 'import ze Sheetu' }], zdroj: 'sheet' }, data);
        d.polozky.push(p); stat.polozek++;
        posunSeq(d, rok, poradi);
      } else if (p.zdroj === 'sheet' && !(p.udalosti || []).some(u => u.pozn !== 'import ze Sheetu')) {
        // položku ještě nikdo ručně neměnil → přepíšeme ze Sheetu (Renata ho zatím vede dál)
        Object.assign(p, data, { stav, expedovanoDne: exped || p.expedovanoDne || '' }); stat.aktualizovano++;
      } else stat.preskoceno++;
      if (!p.ks) stat.preskoceno++;
    }
    return stat;
  }
  async function apiImportSheet(req, res, r, b) {
    if (!(host.sheets && host.sheets.available)) { json(res, 400, { chyba: 'Google service account není nastaven (GOOGLE_SA_*).' }); return true; }
    const d = load(); const n = d.nastaveni;
    const listy = [];
    if (b.list !== 'ostatni') listy.push({ nazev: n.sheetList, typ: 'boxy' });
    if (b.list === 'ostatni' || b.list === 'vse') listy.push({ nazev: n.sheetListOstatni, typ: 'ostatni' });
    let celkem = { objednavek: 0, polozek: 0, aktualizovano: 0, preskoceno: 0 };
    for (const l of listy) {
      const rows = await host.sheets.read(n.sheetId, "'" + l.nazev.replace(/'/g, "''") + "'!A2:R2000");
      const s = importRows(d, (rows && rows.values) || rows || [], r, l.typ);
      for (const k in celkem) celkem[k] += s[k];
    }
    d.import.sheet = { at: new Date().toISOString(), kdo: r.email, stat: celkem };
    save(d);
    logAct('vyroba', req, 'Import ze Sheetu: ' + JSON.stringify(celkem));
    json(res, 200, Object.assign({ ok: true }, celkem)); return true;
  }
  // Import z pole řádků (např. vyexportovaný list) — stejná logika bez Google účtu.
  function apiImportRows(req, res, r, b) {
    if (!Array.isArray(b.rows)) { json(res, 400, { chyba: 'Chybí rows.' }); return true; }
    const d = load();
    const s = importRows(d, b.rows, r, b.list === 'ostatni' ? 'ostatni' : 'boxy');
    d.import.rows = { at: new Date().toISOString(), kdo: r.email, stat: s };
    save(d); json(res, 200, Object.assign({ ok: true }, s)); return true;
  }

  // ---- import z dokumentů (PDF Bestellung / VydObj, kniha CONTRACT Bestellung.xlsx, Disk) -------
  const cisloKey = c => String(c || '').replace(/\s/g, '').toUpperCase().replace(/^B(?=\d{6}$)/, 'BE');
  // „Rodina" kódu: stejný výrobek pojmenovaný různě v Bestellung (DE), Heliosu (CZ) a knize Renaty
  //   CPRETKunststoff-Deckel ~ Plastové víko k boxu 1,6 m3 ~ Víko na bednu 1.6 → VIKO1.6 ; DMC-CH-6,3-543 ~ DMC-CHN-6.3 → DMCCH6.3
  function kodFam(k) {
    let s = String(k || '').toUpperCase().replace(/\s+/g, '').replace(/,/g, '.');
    if (/DECKEL|VÍKO|VIKO/.test(s)) {
      const m = s.match(/(08[.]00|04[.]00|16[.]00|22[.]00|0[.]8|0[.]4|1[.]6|2[.]2|12M3|6[.]3|(?<![\d.])8(?![\d.])|(?<![\d.])4(?![\d.]))/);
      let v = m ? m[1] : '';
      v = ({ '08.00': '0.8', '04.00': '0.4', '16.00': '1.6', '22.00': '1.6', '2.2': '1.6', '8': '0.8', '4': '0.4' })[v] || v;
      return 'VIKO' + v;
    }
    if (/ABLASSHAHN|KOHOUT|VENTIL/.test(s)) return 'KOHOUT';
    return s.replace(/^CPRET/, '').replace(/-?(543|534|644|533|43|53|54)$/, '').replace(/CHN/, 'CH').replace(/-/g, '').replace(/\/.*$/, '');
  }
  // Pozice v Bestellung, které nejsou výrobek (doprava, popisky, ostatní) – nezakládat jako položku
  const jeSluzba = k => /^(Transportkosten|Transport|Fracht|ET|Beschriftung|Verpackung|Montage|Sonstiges|Rabatt)$/i.test(String(k || '').trim());
  function najdiObjednavku(d, cislo, helios) {
    const ck = cisloKey(cislo);
    let o = ck ? d.objednavky.find(x => cisloKey(x.cislo) === ck) : null;
    if (!o && helios) o = d.objednavky.find(x => x.helios && x.helios === String(helios)) || null;
    return o;
  }
  function doplnPrijemce(d, o, pr) {
    if (!pr || !pr.nazev) return;
    const z = zajistiZakaznika(d, null, pr.nazev, { ulice: pr.ulice, psc: pr.psc, mesto: pr.mesto, zeme: pr.zeme, partner: 'contract' });
    if (!z) return;
    if (!o.prijemceId || o.prijemceId === o.zakaznikId) { o.prijemceId = z.id; o.prijemceNazev = z.nazev; }
    if (!o.zakaznikId) { const c = zajistiZakaznika(d, null, 'ConTracT Container Vertriebsgesellschaft mbH', { ulice: 'Neuer Weg 37', psc: '38302', mesto: 'Wolfenbüttel', zeme: 'DE', partner: 'contract', jazyk: 'de' }); o.zakaznikId = c.id; o.zakaznikNazev = c.nazev; }
  }
  // Sloučí naparsovaný dokument do dat. Vrací {objednavka, nove, aktualizovano}.
  function applyParsed(d, parsed, r, zdroj) {
    const po = parsed.objednavka || {}; const stat = { nove: 0, aktualizovano: 0, novaObjednavka: false };
    let o = najdiObjednavku(d, po.cislo, po.helios);
    if (!o) {
      o = { id: newId('o'), createdAt: Date.now(), createdBy: r.email, loznyplan: null, cislo: cisloKey(po.cislo), cisloAU: '', helios: '', datum: po.datum || dnesISO(), zakaznikId: null, zakaznikNazev: '', prijemceId: null, prijemceNazev: '',
        kwDodani: null, kwRok: null, terminDodani: '', doprava: '', mena: 'EUR', potvrzena: false, potvrzenaDatum: '', poznamka: '', driveUrl: '', zdroj };
      d.objednavky.push(o); stat.novaObjednavka = true;
    }
    if (!o.cislo && po.cislo) o.cislo = cisloKey(po.cislo);
    if (!o.cisloAU && po.cisloAU) o.cisloAU = po.cisloAU;
    if (!o.helios && po.helios) o.helios = String(po.helios);
    if (!o.kwDodani && po.kwDodani) { o.kwDodani = po.kwDodani; o.kwRok = po.kwRok || Number(String(o.datum || dnesISO()).slice(0, 4)); }
    if (!o.terminDodani && po.terminDodani) { o.terminDodani = po.terminDodani; if (!o.kwDodani) { const k = kwZData(po.terminDodani); if (k) { o.kwDodani = k.kw; o.kwRok = k.rok; } } }
    if (po.datum && (!o.datum || parsed.typ === 'bestellung')) o.datum = po.datum;
    if (po.doprava && !o.doprava) o.doprava = po.doprava;
    if (parsed.typ === 'bestellung') { o.potvrzena = o.potvrzena || false; if (po.celkem != null) o.celkem = po.celkem; }
    doplnPrijemce(d, o, po.prijemce);
    if (po.zakaznikNazev && !o.zakaznikId) { const z = zajistiZakaznika(d, null, po.zakaznikNazev, { partner: 'contract', zeme: 'DE', jazyk: 'de' }); o.zakaznikId = z.id; o.zakaznikNazev = z.nazev; }
    const stavajici = d.polozky.filter(p => p.objId === o.id);
    const kodKey = k => low(k).replace(/\s+/g, '');
    (parsed.polozky || []).forEach((pp, i) => {
      if (jeSluzba(pp.kod)) { if (pp.kod && !(o.poznamka || '').includes(pp.kod)) o.poznamka = str((o.poznamka ? o.poznamka + ' · ' : '') + pp.kod + (pp.cena ? ' ' + pp.cena + ' €' : ''), 1000); return; }
      let p = null;
      if (pp.heliosPolozka) p = stavajici.find(x => x.heliosPolozka === pp.heliosPolozka && (!x.kod || kodKey(x.kod) === kodKey(pp.kod) || kodFam(x.kod) === kodFam(pp.kod))) || null;
      if (!p) p = stavajici.find(x => kodKey(x.kod) === kodKey(pp.kod) && num(x.ks) === num(pp.ks) && !x._matched) || null;
      if (!p) p = stavajici.find(x => kodKey(x.kod) === kodKey(pp.kod) && !x._matched) || null;
      if (!p) p = stavajici.find(x => kodFam(x.kod) === kodFam(pp.kod) && num(x.ks) === num(pp.ks) && !x._matched) || null;
      if (!p) p = stavajici.find(x => kodFam(x.kod) === kodFam(pp.kod) && !x._matched) || null;
      if (!p && kodFam(pp.kod).startsWith('VIKO')) p = stavajici.find(x => kodFam(x.kod).startsWith('VIKO') && num(x.ks) === num(pp.ks) && !x._matched) || null;
      if (p) {
        p._matched = true;
        const before = JSON.stringify([p.heliosPolozka, p.cena, p.ral, p.lem, p.razeni, p.polepy, p.rozmer, p.tloustka]);
        if (!p.heliosPolozka && pp.heliosPolozka) p.heliosPolozka = pp.heliosPolozka;
        if (p.cena == null && pp.cena != null && parsed.typ === 'bestellung') p.cena = pp.cena;
        if (!p.ral && pp.ral) p.ral = pp.ral; if (!p.lem && pp.lem) p.lem = pp.lem;
        if (!p.razeni && pp.razeni) p.razeni = pp.razeni; if (!p.polepy && pp.polepy) p.polepy = pp.polepy;
        if (!p.rozmer && pp.rozmer) p.rozmer = pp.rozmer; if (p.tloustka == null && pp.tloustka != null) p.tloustka = pp.tloustka;
        if (!p.povrch && pp.povrch) p.povrch = pp.povrch; if (!p.nazev && pp.nazev) p.nazev = pp.nazev;
        if (pp.tho && !/Thommen/i.test(p.poznamka || '')) p.poznamka = str((p.poznamka ? p.poznamka + ' · ' : '') + 'provedení Thommen', 400);
        if (JSON.stringify([p.heliosPolozka, p.cena, p.ral, p.lem, p.razeni, p.polepy, p.rozmer, p.tloustka]) !== before) stat.aktualizovano++;
      } else {
        const np = normPolozka(d, { kod: pp.kod, nazev: pp.nazev, ks: pp.ks, rozmer: pp.rozmer, tloustka: pp.tloustka, povrch: pp.povrch, ral: pp.ral, lem: pp.lem, razeni: pp.razeni, polepy: pp.polepy, heliosPolozka: pp.heliosPolozka, cena: parsed.typ === 'bestellung' ? pp.cena : null, poznamka: pp.tho ? 'provedení Thommen' : '' }, o.id);
        np.pozice = pp.pozice || (stavajici.length + i + 1);
        Object.assign(np, { cvz: null, rok: null, poradi: null, stav: 'prijata', hotovoKs: 0, kamion: '', terminVyroby: terminVyrobyZ(o, d.nastaveni), udalosti: [udalost(r, 'prijata', null, 'import ' + zdroj)], zdroj });
        d.polozky.push(np); stavajici.push(np); np._matched = true; stat.nove++;
      }
    });
    stavajici.forEach(p => { delete p._matched; });
    o.updatedAt = Date.now(); o.updatedBy = r.email;
    return Object.assign({ objednavka: o }, stat);
  }
  // Řádky z knihy CONTRACT Bestellung.xlsx: doplní BE čísla, KW, adresy, kg, kamiony k existujícím položkám (párování přes ČVZ nebo Helios).
  function applyContractRows(d, rows, r) {
    const stat = { objednavek: 0, polozek: 0, aktualizovano: 0, preskoceno: 0 };
    const kodKey = k => low(k).replace(/\s+/g, '');
    for (const row of rows) {
      if (!row.cislo) { stat.preskoceno++; continue; }
      const rok = 2000 + Number(row.cislo.slice(2, 4));
      if (rok < 2025) { stat.preskoceno++; continue; }
      const cvz = row.cvzPoradi ? String(rok).slice(2) + 'B-' + String(row.cvzPoradi).padStart(3, '0') : (row.cvzText || '');
      const mimoBruntal = !row.cvzPoradi && !!row.cvzText;   // S-nnn / C-nnn = Supíkovice / Chomutov (v knize jsou kvůli společné dopravě)
      let p = cvz ? d.polozky.find(x => x.cvz === cvz) : null;
      let o = p ? d.objednavky.find(x => x.id === p.objId) : najdiObjednavku(d, row.cislo, row.helios);
      if (!o && rok < new Date().getFullYear()) { stat.preskoceno++; continue; }   // loňské zakázky, které v systému nejsou, nezakládat
      if (!o) {
        o = { id: newId('o'), createdAt: Date.now(), createdBy: r.email, loznyplan: null, cislo: row.cislo, cisloAU: '', helios: row.helios || '', datum: dnesISO(), zakaznikId: null, zakaznikNazev: '', prijemceId: null, prijemceNazev: '',
          kwDodani: row.kwDodani || null, kwRok: row.kwDodani ? rok : null, terminDodani: '', doprava: '', mena: 'EUR', potvrzena: true, potvrzenaDatum: '', poznamka: row.poznamka || '', driveUrl: '', zdroj: 'contract-xlsx' };
        d.objednavky.push(o); stat.objednavek++;
      }
      let zm = false;
      if (!o.cislo) { o.cislo = row.cislo; zm = true; }
      if (!o.helios && row.helios) { o.helios = row.helios; zm = true; }
      if (!o.kwDodani && row.kwDodani) { o.kwDodani = row.kwDodani; o.kwRok = rok; zm = true; }
      if (row.poznamka && !(o.poznamka || '').includes(row.poznamka)) { o.poznamka = str((o.poznamka ? o.poznamka + ' · ' : '') + row.poznamka, 1000); zm = true; }
      doplnPrijemce(d, o, row.prijemce);
      const ve = d.polozky.filter(x => x.objId === o.id);
      if (!p) p = ve.find(x => kodKey(x.kod) === kodKey(row.kod) && (!x.cvz || !cvz) && num(x.ks) === num(row.ks)) || ve.find(x => kodKey(x.kod) === kodKey(row.kod) && !x.cvz)
        || ve.find(x => kodFam(x.kod) === kodFam(row.kod) && num(x.ks) === num(row.ks) && (!x.cvz || !cvz)) || null;
      if (!p) {
        p = normPolozka(d, { kod: row.kod, ks: row.ks, rozmer: row.rozmer, kgKs: row.kgKs, povrch: row.povrch, ral: row.ral, lem: row.lem, poznamka: row.tho ? 'provedení Thommen' : '' }, o.id);
        p.pozice = ve.length + 1;
        Object.assign(p, { cvz: cvz || null, rok: cvz ? rok : null, poradi: row.cvzPoradi || null, stav: cvz ? 'zadano' : 'prijata', hotovoKs: 0, kamion: row.kamion || '', terminVyroby: terminVyrobyZ(o, d.nastaveni), udalosti: [udalost(r, cvz ? 'zadano' : 'prijata', null, 'import z knihy CONTRACT Bestellung')], zdroj: 'contract-xlsx', mimoBruntal });
        if (mimoBruntal) p.poznamka = str('výroba mimo Bruntál (' + row.cvzText + ')' + (p.poznamka ? ' · ' + p.poznamka : ''), 400);
        if (row.cvzPoradi) posunSeq(d, rok, row.cvzPoradi);
        d.polozky.push(p); stat.polozek++;
      } else {
        let pz = false;
        if (p.kgKs == null && row.kgKs) { p.kgKs = row.kgKs; pz = true; }
        if (!p.rozmer && row.rozmer) { p.rozmer = row.rozmer; pz = true; }
        if (!p.ral && row.ral) { p.ral = row.ral; pz = true; } if (!p.lem && row.lem) { p.lem = row.lem; pz = true; }
        if (!p.kamion && row.kamion) { p.kamion = row.kamion; pz = true; }
        if (row.vykresOk && (!p.vykres || p.vykres.stav === 'neni' || p.vykres.stav === 'poslan')) { p.vykres = { stav: 'schvalen', datum: p.vykres && p.vykres.datum || '' }; pz = true; }
        else if (row.vykresPoslan && (!p.vykres || p.vykres.stav === 'neni')) { p.vykres = { stav: 'poslan', datum: '' }; pz = true; }
        if (pz) stat.aktualizovano++;
      }
      if (zm) stat.aktualizovano++;
    }
    return stat;
  }
  function parsePdfBuffer(buf, name) {
    const text = pdfToText(buf);
    if (/Bestellung/i.test(name || '') || /Unser Auftrag|Lieferanten-Nr/.test(text)) return parsers.parseBestellung(text);
    if (/VydObj/i.test(name || '') || /VYDANÁ OBJEDNÁVKA|Helios Inuvio/.test(text)) return parsers.parseHelios(text);
    return null;
  }
  // Nahrané PDF z prohlížeče: náhled (nahled:true) nebo rovnou sloučit do dat.
  function apiImportPdf(req, res, r, b) {
    const files = Array.isArray(b.soubory) ? b.soubory : (b.base64 ? [{ nazev: b.nazev, base64: b.base64 }] : []);
    if (!files.length) { json(res, 400, { chyba: 'Chybí PDF.' }); return true; }
    const d = load(); const out = []; const stat = { nove: 0, aktualizovano: 0 };
    let objId = null;
    for (const f of files.slice(0, 20)) {
      let parsed = null;
      try { parsed = parsePdfBuffer(Buffer.from(String(f.base64 || '').replace(/^data:[^,]*,/, ''), 'base64'), f.nazev); } catch (e) { out.push({ nazev: f.nazev, chyba: e.message }); continue; }
      if (!parsed) { out.push({ nazev: f.nazev, chyba: 'Nepoznaný typ dokumentu (čekám Bestellung od Contractu nebo vydanou objednávku z Heliosu).' }); continue; }
      if (b.nahled) { out.push({ nazev: f.nazev, parsed }); continue; }
      const a = applyParsed(d, parsed, r, 'pdf:' + (f.nazev || parsed.typ));
      objId = a.objednavka.id; stat.nove += a.nove; stat.aktualizovano += a.aktualizovano;
      out.push({ nazev: f.nazev, typ: parsed.typ, objednavka: a.objednavka.cislo || a.objednavka.helios, nove: a.nove, aktualizovano: a.aktualizovano, novaObjednavka: a.novaObjednavka });
    }
    if (!b.nahled) { save(d); logAct('vyroba', req, 'Import PDF: ' + out.map(x => x.nazev).join(', ')); }
    json(res, 200, { ok: true, vysledky: out, objId, stat }); return true;
  }
  // Už vytěžený text dokumentů (např. z Disku přes jiný kanál): { dokumenty: [{ nazev, text, slozka, link }] }
  function apiImportText(req, res, r, b) {
    const docs = Array.isArray(b.dokumenty) ? b.dokumenty : [];
    if (!docs.length) { json(res, 400, { chyba: 'Chybí dokumenty.' }); return true; }
    const d = load(); const stat = { zpracovano: 0, nepoznano: 0, nove: 0, aktualizovano: 0, novychObjednavek: 0, chyby: [] };
    for (const doc of docs.slice(0, 500)) {
      try {
        const text = String(doc.text || ''); const name = String(doc.nazev || '');
        let parsed = null;
        if (/Bestellung/i.test(name) || /Unser Auftrag|Lieferanten-Nr/.test(text)) parsed = parsers.parseBestellung(text);
        else if (/VydObj/i.test(name) || /VYDANÁ OBJEDNÁVKA|Helios Inuvio/.test(text)) parsed = parsers.parseHelios(text);
        if (!parsed) { stat.nepoznano++; continue; }
        const zeSlozky = (String(doc.slozka || '').match(/^(BE?\d{6})/i) || [])[1] || (name.match(/_?(BE?\d{6})/i) || [])[1] || '';
        if (!parsed.objednavka.cislo && zeSlozky) parsed.objednavka.cislo = cisloKey(zeSlozky);
        if (!parsed.objednavka.cislo && !parsed.objednavka.helios) { stat.nepoznano++; continue; }
        const a = applyParsed(d, parsed, r, 'drive:' + name);
        if (doc.link && !a.objednavka.driveUrl) a.objednavka.driveUrl = String(doc.link).slice(0, 300);
        stat.zpracovano++; stat.nove += a.nove; stat.aktualizovano += a.aktualizovano; if (a.novaObjednavka) stat.novychObjednavek++;
      } catch (e) { stat.chyby.push((doc.nazev || '?') + ': ' + e.message); }
    }
    d.import.text = { at: new Date().toISOString(), kdo: r.email, stat: Object.assign({}, stat, { chyby: stat.chyby.slice(0, 20) }) };
    save(d); logAct('vyroba', req, 'Import textů dokumentů: ' + JSON.stringify(Object.assign({}, stat, { chyby: stat.chyby.length })));
    json(res, 200, Object.assign({ ok: true }, stat)); return true;
  }
  function apiImportXlsx(req, res, r, b) {
    if (!b.base64) { json(res, 400, { chyba: 'Chybí soubor.' }); return true; }
    const d = load();
    const x = parseXlsx(Buffer.from(String(b.base64).replace(/^data:[^,]*,/, ''), 'base64'), [/^Metalboxy$/i, /^MULDY$/i, /^ABROLY$/i, /MBT|Hammerer|Andere/i]);
    let rows = [];
    for (const name of Object.keys(x.data)) rows = rows.concat(parsers.parseContractRows(x.data[name], name));
    const stat = applyContractRows(d, rows, r);
    d.import.contract = { at: new Date().toISOString(), kdo: r.email, stat, listy: Object.keys(x.data) };
    save(d); logAct('vyroba', req, 'Import knihy CONTRACT Bestellung: ' + JSON.stringify(stat));
    json(res, 200, Object.assign({ ok: true, radku: rows.length, listy: Object.keys(x.data) }, stat)); return true;
  }
  // Stažení souboru z Disku přes service account (host.drive.token).
  function driveDownload(id) {
    return new Promise(async (resolve, reject) => {
      let tok; try { tok = await host.drive.token(); } catch (e) { return reject(e); }
      const req = https.request({ method: 'GET', hostname: 'www.googleapis.com', path: '/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', headers: { Authorization: 'Bearer ' + tok } }, resp => {
        const chunks = []; resp.on('data', c => chunks.push(c)); resp.on('end', () => { const buf = Buffer.concat(chunks); if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(buf); else reject(new Error('Drive ' + resp.statusCode + ': ' + buf.toString('utf8').slice(0, 160))); });
      });
      req.on('error', reject); req.setTimeout(30000, () => { try { req.destroy(new Error('Drive: časový limit.')); } catch (_) {} }); req.end();
    });
  }
  // Projde složku Contract na Disku: podsložky BE26xxxx (i v ročních složkách „2026") → PDF Bestellung + VydObj; kniha CONTRACT Bestellung*.xlsx.
  let driveJob = null;   // { start, stat, hotovo, chyba }
  async function apiImportDrive(req, res, r, b) {
    if (!(host.drive && host.drive.available && host.drive.token)) { json(res, 400, { chyba: 'Google service account (GOOGLE_SA_*) není nastaven — nahrajte PDF/xlsx ručně.' }); return true; }
    if (b.stav) { json(res, 200, { ok: true, bezi: !!(driveJob && !driveJob.hotovo), job: driveJob }); return true; }
    if (driveJob && !driveJob.hotovo) { json(res, 200, { ok: true, bezi: true, job: driveJob, zprava: 'Načítání z Disku už běží.' }); return true; }
    driveJob = { start: new Date().toISOString(), stat: { slozek: 0, pdf: 0, xlsx: 0, preskoceno: 0, nove: 0, aktualizovano: 0, novychObjednavek: 0, chyby: [] }, hotovo: false, faze: 'start' };
    const job = driveJob;
    runDriveImport(r, b, job).then(() => { job.hotovo = true; job.konec = new Date().toISOString(); }).catch(e => { job.hotovo = true; job.chyba = e.message; job.konec = new Date().toISOString(); console.error('[vyroba] import z Disku:', e); });
    if (b.cekat) { await new Promise(res2 => { const t = setInterval(() => { if (job.hotovo) { clearInterval(t); res2(); } }, 500); }); json(res, 200, Object.assign({ ok: !job.chyba, chyba: job.chyba }, job.stat)); return true; }
    json(res, 202, { ok: true, bezi: true, job, zprava: 'Načítání z Disku běží na pozadí — průběh v Nastavení a import.' }); return true;
  }
  async function runDriveImport(r, b, job) {
    const req = null, res = null; void req; void res;
    const d = load(); const nast = d.nastaveni;
    d.import.driveSoubory = d.import.driveSoubory || {};
    const hotovo = d.import.driveSoubory; const force = !!b.force;
    const stat = job.stat;
    const rokMin = Number(b.rokOd) || (new Date().getFullYear() - 1);
    job.faze = 'seznam složek';
    const root = await host.drive.list(nast.driveRoot);
    const slozky = root.filter(f => f.isFolder && /^BE?\d{6}/i.test(f.name));
    for (const y of root.filter(f => f.isFolder && /^20\d{2}$/.test(f.name) && Number(f.name) >= rokMin)) { try { (await host.drive.list(y.id)).filter(f => f.isFolder && /^BE?\d{6}/i.test(f.name)).forEach(f => slozky.push(f)); } catch (e) { stat.chyby.push(y.name + ': ' + e.message); } }
    const jeAktualni = f => { const m = f.name.match(/^BE?(\d{2})\d{4}/i); return m && (2000 + Number(m[1])) >= rokMin; };
    const vybrane = slozky.filter(jeAktualni); job.celkemSlozek = vybrane.length;
    for (const s of vybrane) {
      stat.slozek++; job.faze = s.name.slice(0, 40);
      let files; try { files = await host.drive.list(s.id); } catch (e) { stat.chyby.push(s.name + ': ' + e.message); continue; }
      const o0 = najdiObjednavku(d, (s.name.match(/^(BE?\d{6})/i) || [])[1], null);
      if (o0 && !o0.driveUrl) o0.driveUrl = s.link || '';
      for (const f of files.filter(f => /\.pdf$/i.test(f.name))) {
        if (!force && hotovo[f.id]) { stat.preskoceno++; continue; }
        try {
          const buf = await driveDownload(f.id);
          const parsed = parsePdfBuffer(buf, f.name);
          if (!parsed) { hotovo[f.id] = 'nepoznano'; stat.preskoceno++; continue; }
          if (!parsed.objednavka.cislo) parsed.objednavka.cislo = (s.name.match(/^(BE?\d{6})/i) || [])[1] || '';
          const a = applyParsed(d, parsed, r, 'drive:' + f.name);
          if (!a.objednavka.driveUrl) a.objednavka.driveUrl = s.link || '';
          stat.pdf++; stat.nove += a.nove; stat.aktualizovano += a.aktualizovano; if (a.novaObjednavka) stat.novychObjednavek++;
          hotovo[f.id] = new Date().toISOString();
        } catch (e) { stat.chyby.push(f.name + ': ' + e.message); }
      }
      if (stat.slozek % 20 === 0) { try { save(d); } catch (_) {} }
    }
    job.faze = 'kniha CONTRACT Bestellung.xlsx';
    for (const f of root.filter(f => !f.isFolder && /CONTRACT Bestellung.*\.xlsx$/i.test(f.name) && !/ARCHIVE/i.test(f.name))) {
      try {
        const buf = await driveDownload(f.id);
        const x = parseXlsx(buf, [/^Metalboxy$/i, /^MULDY$/i, /^ABROLY$/i]);
        let rows = []; for (const name of Object.keys(x.data)) rows = rows.concat(parsers.parseContractRows(x.data[name], name));
        const st = applyContractRows(d, rows, r); stat.xlsx++; stat.nove += st.polozek; stat.aktualizovano += st.aktualizovano; stat.novychObjednavek += st.objednavek;
        d.import.contract = { at: new Date().toISOString(), kdo: r.email, stat: st, soubor: f.name };
      } catch (e) { stat.chyby.push(f.name + ': ' + e.message); }
    }
    job.faze = 'ukládám';
    d.import.drive = { at: new Date().toISOString(), kdo: r.email, stat: Object.assign({}, stat, { chyby: stat.chyby.slice(0, 20) }) };
    save(d); try { if (host.logActivity) host.logActivity('vyroba', { email: r.email, name: r.name }, 'Import z Disku: ' + JSON.stringify(Object.assign({}, stat, { chyby: stat.chyby.length }))); } catch (_) {}
  }

  // ---- Google Drive: složka BE26xxxx k objednávce ---------------------------------
  let _driveCache = { at: 0, files: null };
  async function apiDrive(req, res, q) {
    if (!(host.drive && host.drive.available)) { json(res, 200, { dostupny: false, soubory: [] }); return true; }
    const d = load(); const o = d.objednavky.find(x => x.id === q.objId);
    if (!o) { json(res, 404, { chyba: 'Objednávka nenalezena.' }); return true; }
    if (!_driveCache.files || Date.now() - _driveCache.at > 10 * 60 * 1000) { _driveCache = { at: Date.now(), files: await host.drive.list(d.nastaveni.driveRoot) }; }
    const hled = [o.cislo, o.helios].map(low).filter(Boolean);
    const slozky = _driveCache.files.filter(f => f.isFolder && hled.some(h => low(f.name).includes(h.replace(/^b(?=\d)/, 'be'))));
    let soubory = [];
    for (const s of slozky.slice(0, 3)) { try { soubory = soubory.concat((await host.drive.list(s.id)).map(f => Object.assign({ slozka: s.name }, f))); } catch (_) {} }
    json(res, 200, { dostupny: true, slozky, soubory }); return true;
  }

  // ---- Ložný plán: odeslání objednávky do sdíleného úložiště aplikace -----------------
  function httpJson(method, url, body) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(url); } catch (e) { return reject(e); }
      const lib = u.protocol === 'http:' ? http : https;
      const data = body ? JSON.stringify(body) : null;
      const req = lib.request({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        headers: Object.assign({ 'Accept': 'application/json' }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, resp => {
        resp.setEncoding('utf8'); let s = ''; resp.on('data', c => s += c); resp.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(j || {}); else reject(new Error('Ložný plán ' + resp.statusCode + ': ' + s.slice(0, 160))); });
      });
      req.on('error', e => reject(new Error('Spojení s Ložným plánem: ' + e.message)));
      req.setTimeout(20000, () => { try { req.destroy(new Error('Ložný plán: časový limit spojení.')); } catch (_) {} });
      if (data) req.write(data); req.end();
    });
  }
  function loznyplanUrl(cesta) {
    const base = (host.loznyplan && host.loznyplan.url || '').replace(/\/$/, '');
    if (!base) throw new Error('Adresa aplikace Ložný plán není nastavena (LOZNYPLAN_APP_URL).');
    let tok = '';
    try { if (host.loznyplan.ssoSign) tok = host.loznyplan.ssoSign({ email: 'intranet@elkoplast.cz', name: 'Intranet – Výroba Popelnice', exp: Date.now() + 5 * 60 * 1000 }); } catch (_) {}
    return base + cesta + (tok ? (cesta.includes('?') ? '&' : '?') + 'sso=' + encodeURIComponent(tok) : '');
  }
  const PALETA = ['#4d9fff', '#ff6b6b', '#ffd93d', '#6bcb77', '#c77dff', '#ff9f43', '#00d4ff', '#f368e0', '#48dbfb', '#1dd1a1'];
  function mapaBoxType(shared, p, k) {
    const nazev = String(p.kod || '').replace(/\s+/g, '');
    const n = low(nazev);
    let bt = (shared.boxTypes || []).find(t => low(String(t.name || '')).replace(/\s+/g, '') === n);
    if (bt) return { bt, novy: false };
    const roz = parseRozmer(p.rozmer) || (k && k.l ? { l: k.l, w: k.w, h: k.h, hi: k.hi } : null);
    if (!roz) return { bt: null, novy: false };
    const maxId = Math.max(0, ...(shared.boxTypes || []).map(t => +t.id || 0));
    bt = { id: maxId + 1, name: nazev, l: roz.l, w: roz.w, h: roz.h, hi: roz.hi, kg: p.kgKs != null ? p.kgKs : (k && k.kg != null ? k.kg : 100),
      color: PALETA[(maxId + 1) % PALETA.length], li: Math.round(roz.l * 0.92), wi: Math.round(roz.w * 0.92) };
    shared.boxTypes.push(bt);
    return { bt, novy: true };
  }
  async function apiLoznyPlanOdeslat(req, res, r, b) {
    const d = load();
    const o = d.objednavky.find(x => x.id === b.id); if (!o) { json(res, 404, { chyba: 'Objednávka nenalezena.' }); return true; }
    const ob = obohatObjednavku(d, o, dnesISO(), d.nastaveni);
    // do ložného plánu jde to, co se bude vozit: hotové + naplánované položky, nebo vše živé (b.vse)
    const pol = ob.polozky.filter(p => p.stav !== 'storno' && (b.vse || ['hotovo', 'naplanovano'].includes(p.stav)));
    if (!pol.length) { json(res, 400, { chyba: 'Objednávka nemá žádné hotové položky. Zaškrtněte „včetně nehotových", pokud chcete plánovat dopředu.' }); return true; }
    const shared = await httpJson('GET', loznyplanUrl('/api/shared'));
    shared.boxTypes = shared.boxTypes || []; shared.orders = shared.orders || [];
    const orderNo = o.cislo || o.helios || ob.zakaznik;
    const ex = shared.orders.find(x => String(x.orderNo || '') === orderNo && orderNo);
    const boxes = {}, rals = {}, serials = {}; let nove = 0, bezRozmeru = [];
    pol.forEach(p => {
      const k = p.katalogId ? d.katalog.find(x => x.id === p.katalogId) : najdiKatalog(d, p.kod);
      const m = mapaBoxType(shared, p, k);
      if (!m.bt) { bezRozmeru.push(p.kod); return; }
      if (m.novy) nove++;
      const tid = String(m.bt.id);
      boxes[tid] = (boxes[tid] || 0) + num(p.ks);
      const ralM = String(p.ral || '').match(/(\d{4})/);
      if (ralM) rals[tid] = { ral: 'RAL ' + ralM[1], hex: RAL_HEX[ralM[1]] || '#9da3a6' };
      serials[tid] = [serials[tid], p.cvz].filter(Boolean).join(', ');
    });
    if (!Object.keys(boxes).length) { json(res, 400, { chyba: 'U položek chybí rozměry (' + bezRozmeru.join(', ') + ') — doplňte je v katalogu.' }); return true; }
    const maxOid = Math.max(1000, ...shared.orders.flatMap(x => [+x.id || 0].concat((x.addresses || []).map(a => +a.id || 0))));
    const addr = { id: (ex && ex.addresses && ex.addresses[0] && ex.addresses[0].id) || maxOid + 1, address: ob.prijemceAdresa || ob.prijemce, boxes, serials, rals };
    const order = Object.assign(ex || { id: maxOid + 2, color: PALETA[shared.orders.length % PALETA.length], includeInCalc: true, priority: 0 }, {
      orderNo, customer: ob.prijemce || ob.zakaznik, name: [orderNo, ob.prijemce || ob.zakaznik].filter(Boolean).join(' · '),
      addresses: [addr], intranetId: o.id, intranetAt: new Date().toISOString(),
    });
    if (!ex) shared.orders.push(order);
    const out = await httpJson('PUT', loznyplanUrl('/api/shared'), {
      boxTypes: shared.boxTypes, fleet: shared.fleet || [], orders: shared.orders, team: shared.team || [], activity: shared.activity || [], history: shared.history || [],
      modifiedBy: 'Intranet – Výroba Popelnice (' + (r.name || r.email) + ')',
    });
    o.loznyplan = { orderId: order.id, orderNo, sentAt: new Date().toISOString(), kdo: r.email, polozek: pol.length, verze: out.version || null };
    pol.forEach(p => { const lp = d.polozky.find(x => x.id === p.id); if (lp && lp.stav === 'hotovo') { lp.stav = 'naplanovano'; lp.udalosti.push(udalost(r, 'naplanovano', null, 'odesláno do Ložného plánu')); } });
    save(d);
    logAct('vyroba', req, 'Do Ložného plánu: ' + orderNo + ' (' + pol.length + ' položek)');
    json(res, 200, { ok: true, verze: out.version, novychTypu: nove, polozek: pol.length, bezRozmeru, objednavka: obohatObjednavku(d, o, dnesISO(), d.nastaveni) }); return true;
  }

  // ---- export --------------------------------------------------------------
  function apiExport(req, res) {
    const d = load(), dnes = dnesISO();
    const hl = ['ČVZ', 'Objednávka', 'Helios', 'Zákazník', 'Příjemce', 'Produkt', 'Ks', 'Rozměr', 'Tloušťka', 'RAL', 'Lem', 'Ražení', 'Polepy', 'Helios položka', 'Zadáno', 'Termín výroby', 'KW dodání', 'Stav', 'Hotovo ks', 'Kamion', 'Expedováno', 'Skluz dní', 'Poznámka'];
    const radky = [hl];
    d.objednavky.map(o => obohatObjednavku(d, o, dnes, d.nastaveni)).forEach(o => o.polozky.forEach(p => radky.push([
      p.cvz || '', o.cislo, o.helios, o.zakaznik, o.prijemce, p.kod, p.ks, p.rozmer, p.tloustka == null ? '' : p.tloustka, p.ral, p.lem, p.razeni, p.polepy, p.heliosPolozka,
      p.zadanoDne || '', p.terminVyroby || '', o.kwDodani ? 'KW ' + o.kwDodani : '', (STAVY.find(s => s[0] === p.stav) || [])[1] || p.stav, p.hotovoKs || 0, p.kamion || '', p.expedovanoDne || '', p.skluzDni || 0, p.poznamka,
    ])));
    const csv = '﻿' + radky.map(rw => rw.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(';')).join('\r\n');
    host.send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vyroba-popelnice-' + dnes + '.csv"' });
    return true;
  }

  function logAct(typ, req, detail) {
    try { const e = host.empSession(req) || {}; if (host.logActivity) host.logActivity(typ, { email: e.email || '', name: e.name || '' }, detail); } catch (_) {}
  }

  // ---- nástěnka intranetu -------------------------------------------------------
  function notifikace(email) {
    email = low(email); if (!email || !hasAccess(email)) return [];
    const d = load(), dnes = dnesISO(), nast = d.nastaveni; const out = [];
    const mods = moduly(email);
    const obchod = mods.includes('vyroba') || nast.obchod.map(low).includes(email);
    const pol = d.polozky.map(p => obohatPolozku(d, p, dnes, nast));
    const skl = pol.filter(p => p.skluzDni > 0);
    if (skl.length) out.push({ modul: 'vyroba', modulNazev: 'Výroba Popelnice', ikona: 'gear', urgent: skl.some(p => p.skluzDni > 7),
      text: skl.length + (skl.length === 1 ? ' položka je ve skluzu proti termínu výroby' : skl.length < 5 ? ' položky jsou ve skluzu proti termínu výroby' : ' položek je ve skluzu proti termínu výroby'),
      sub: skl.slice(0, 3).map(p => p.cvz || p.kod).join(', ') });
    const kZadani = pol.filter(p => p.stav === 'prijata');
    if (obchod && kZadani.length) out.push({ modul: 'vyroba', modulNazev: 'Výroba Popelnice', ikona: 'gear', urgent: false,
      text: kZadani.length + (kZadani.length === 1 ? ' položka čeká na zadání do výroby' : ' položek čeká na zadání do výroby'), sub: '' });
    const bezKam = pol.filter(p => p.cekaBezKamionu);
    if (obchod && bezKam.length) out.push({ modul: 'vyroba', modulNazev: 'Výroba Popelnice', ikona: 'truck', urgent: false,
      text: bezKam.length + ' hotových položek čeká na kamion déle než ' + nast.upozorneniDny + ' dní', sub: bezKam.slice(0, 3).map(p => p.cvz || p.kod).join(', ') });
    return out;
  }

  function tick() { try { sheet.tick(); } catch (_) {} }
  function syncMinuty() { try { return load().nastaveni.syncMinuty || 5; } catch (_) { return 5; } }
  return { handle, notifikace, hasAccess, importRows, STAVY, tick, syncMinuty };
}

module.exports = { mount, STAVY, RAL_HEX };

'use strict';
// ============================================================================
//  Modul „Konstrukce" — workflow zadání a schválení standardního výkresu
//  Od požadavku obchodníka přes zkreslení na konstrukci až po schválení
//  klientem přes zabezpečený veřejný náhled. Vzorový výrobek: ABROLL kontejner.
//
//  Montuje se ze server.js:
//    const konstrukce = require('./konstrukce').mount({
//      send, readBody, deliver, empSession, isAdmin, baseUrl,
//      employeeModules, getState, dataDir, mailFrom
//    });
//  a v routingu: if (konstrukceMod && await konstrukceMod.handle(req, res)) return;
//  Veřejné cesty (/konstrukce/nahled/*, /api/konstrukce/nahled/*) musí být
//  propuštěny mimo SSO závoru v server.js.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');
const https = require('https');

const HTML_FILE = path.join(__dirname, 'konstrukce.html');

// Katalog standardních výrobků (ART NO.) z ceníku PRICE LIST ABR-XXX — 6 řad ABROLL.
let KATALOG_ABR = [];
try { KATALOG_ABR = (JSON.parse(fs.readFileSync(path.join(__dirname, 'katalog-abr.json'), 'utf8')).polozky) || []; } catch (_) {}

// ---- Dotazník provedení kontejneru ABROLL (ABR-DSD) ------------------------
// Zdroj: sdílený Google Sheet „Dotazník provedení kontejneru Abroll".
// Pole typu 'volba' mají standard/opci; obchodník volí standard, opci, nebo
// zapíše vlastní „požadavek zákazníka". Jeden informační tok Obchod → Konstrukce.
const DOTAZNIK_ABROLL = [
  { title: 'Základní údaje', fields: [
    { k: 'rozmery', label: 'Vnitřní rozměry (délka × šířka × výška)', type: 'text' },
    { k: 'pocet', label: 'Počet ks', type: 'number' },
    { k: 'adresaDodani', label: 'Adresa dodání / určení', type: 'adresa' },
  ] },
  { title: 'Provedení', fields: [
    { k: 'provedeni', label: 'Provedení', std: '5/3', opce: '4/3 nebo jiné' },
    { k: 'natahovani', label: 'Natahování', std: 'typ A', opce: 'typ H / sklopné / tunelové' },
    { k: 'prumerHaku', label: 'Průměr háku h 1570 (mm)', std: '50', opce: '60' },
    { k: 'napojeniPodlaha', label: 'Napojení podlaha × bočnice', std: '45/45, vytažená podlaha (VP 250)', opce: 'R200/0° (K90)' },
    { k: 'vrchniLem', label: 'Vrchní lem', std: 'jekl 100×80×4 S355', opce: 'tr 89×6 / tr 114×6 S355' },
    { k: 'roztecVyztuhBocnice', label: 'Rozteč výztuh bočnice', std: '750 mm', opce: '500 mm' },
    { k: 'profilVyztuhBocnice', label: 'Profil výztuh bočnice', std: 'U 100×60×3', opce: 'U 100×60×4' },
    { k: 'roztecVyztuhPodlahy', label: 'Rozteč výztuh podlahy', std: '750 mm', opce: '500 mm' },
    { k: 'profilVyztuhPodlahy', label: 'Profil výztuh podlahy', std: 'U 100×60×4', opce: '' },
    { k: 'mezivyztuhaIPN', label: 'Mezivýztuha IPN × podlaha', std: 'ne', opce: 'ano' },
    { k: 'jisteniC', label: 'Jištění C v lyžině', std: 'ano', opce: 'ne' },
    { k: 'zadniTramec', label: 'Zadní trámec', std: 'UPN 180', opce: '' },
    { k: 'rolny', label: 'Rolny 2 ks délka 300 mm', std: 'tr 159×6', opce: '' },
    { k: 'cepRolen', label: 'Čep rolen mazaný / průměr', std: '40 mm (CR 300/40)', opce: '50 mm (CR 300/50)' },
    { k: 'provedeniVrat', label: 'Provedení vrat', std: '2křídlá', opce: '1křídlá / klapka / jiné' },
    { k: 'zaviraniVrat', label: 'Zavírání vrat', std: 'S hák (typ VSH)', opce: 'holandské (VNL)' },
    { k: 'strecha', label: 'Střecha', std: 'ne', opce: 'mechanická / hydraulická / rolovací plachta aj.' },
    { k: 'umisteniOvladaniStrechy', label: 'Umístění ovládání střechy ve směru jízdy', std: 'vlevo', opce: 'vpravo' },
    { k: 'hackyNaPlachtu', label: 'Háčky na plachtu', std: 'ano / 500 mm / 10 mm', opce: 'ne' },
    { k: 'zebrik', label: 'Žebřík (výška kont. min 1500 mm)', std: 'ano / vlevo ve směru jízdy', opce: 'ne' },
    { k: 'centralniJisteni', label: 'Centrální jištění', std: 'ano / 2křídla (typ CE)', opce: 'ne' },
  ] },
  { title: 'Doplňky', fields: [
    { k: 'dvojiteZavirani', label: 'Dvojité zavírání', std: 'ne', opce: 'ano' },
    { k: 'zhustkeNosniky', label: 'Zhuštěné nosníky podlahy', std: 'ne', opce: 'ano 60×60×4' },
    { k: 'horizontalniVyztuha', label: 'Horizontální výztuha', std: 'ne', opce: 'ano', opceVstup: { placeholder: 'počet výztuh', unit: 'ks', num: true } },
    { k: 'poznamky', label: 'Jiné poznámky vč. barevného odstínu (RAL)', type: 'text', ral: true },
  ] },
];

// ---- Stavy zakázky (kap. 4 dokumentu) --------------------------------------
const STAV = {
  novy:      { label: 'Nový',              onTurn: 'sef',        terminal: false },
  prace:     { label: 'Zkreslení',         onTurn: 'konstrukter', terminal: false },
  kontrola:  { label: 'Interní kontrola',  onTurn: 'sef',        terminal: false },
  obchodnik: { label: 'U obchodníka',      onTurn: 'obchodnik',  terminal: false },
  klient:    { label: 'U klienta',         onTurn: 'obchodnik',  terminal: false }, // hlídá obchodník
  revize:    { label: 'Revize',            onTurn: 'konstrukter', terminal: false },
  podklady:  { label: 'Čeká na podklady',  onTurn: 'obchodnik',  terminal: false, hold: true },
  schvaleno: { label: 'Schváleno klientem', onTurn: 'obchodnik', terminal: false },
  vyroba:    { label: 'Předáno do výroby',  onTurn: 'sef-vyroby', terminal: false }, // u šéfa výroby
  stredisko: { label: 'Ve výrobním středisku', onTurn: 'sef-vyroby', terminal: false },
  dokonceno: { label: 'Vyrobeno / Dokončeno', onTurn: null,      terminal: true },
  zamitnuto: { label: 'Zamítnuto / Storno', onTurn: null,        terminal: true },
};

// ---- Výrobní oblasti / střediska (seed — editovatelné v adminu) -------------
// Každá oblast má svého výrobního ředitele (reditelEmail = konkrétní člověk z databáze).
const SEED_STREDISKA = [
  { key: 'supikovice', label: 'Supíkovice', reditelEmail: '' },
  { key: 'bruntal', label: 'Bruntál', reditelEmail: '' },
  { key: 'bruntal-popelnice', label: 'Bruntál popelnice', reditelEmail: '' },
  { key: 'chomutov', label: 'Chomutov', reditelEmail: '' },
  { key: 'polsko', label: 'Polsko', reditelEmail: '' },
];

// ---- Výchozí číselník typů výrobku (seed) — řady ABROLL kontejnerů ---------
// 6 řad z ceníku ABR-XXX; všechny sdílí dotazník provedení (ABR-DSD) a výchozí lhůty.
const RADY_ABR = [
  ['dsd', 'DSD — klasický (s mezivýztuhami)'],
  ['afs', 'AFS — bez mezivýztuh pod podlahou'],
  ['hbs', 'HBS — vyztužené dno (HB)'],
  ['sth', 'STH — silnostěnný'],
  ['hbi', 'HBI — Hardox'],
  ['lwc', 'LWC — odlehčený'],
];
const SEED_TYPES = RADY_ABR.map(([key, name]) => ({
  key, name, standard: true,
  normohodiny: 8, revizeNh: 2,
  lhutaZkresleniDays: 3, lhutaRevizeDays: 2, lhutaPrideleniDays: 1, lhutaKontrolaDays: 1,
  lhutaObchodnikDays: 1, lhutaKlientDays: 5, lhutaVyrobaDays: 1,
  internalCheck: true, linkValidDays: 30,
  dotaznik: DOTAZNIK_ABROLL, params: [],
}));

// ---- Číselník druhů práce pro evidenci (seed z reálného deníku konstrukce) --
// kind: 'zakazka' = produktivní práce na konkrétní zakázce · 'rezie' = režie mimo zakázku
const SEED_ACTIVITIES = [
  { key: 'vyt-model', label: 'Vytvoření/modifikace modelu a OB-výkresu', kind: 'zakazka' },
  { key: 'chystani-sady', label: 'Chystání sady výkresů, Kusovník, DXF', kind: 'zakazka' },
  { key: 'nula-aktualizace', label: 'Model Nula. Aktualizace', kind: 'zakazka' },
  { key: 'nula-vytvoreni', label: 'Model Nula. Vytvoření/úprava', kind: 'zakazka' },
  { key: 'nula-kontrola', label: 'Model Nula. Kontrola sady podkladů', kind: 'zakazka' },
  { key: 'zmeny-prani', label: 'Změny podle přání', kind: 'zakazka' },
  { key: 'zmeny-vyroba', label: 'Změny/optimalizace podle otázek výroby', kind: 'zakazka' },
  { key: 'navrh-prototyp', label: 'Návrh prototypů', kind: 'zakazka' },
  { key: 'navrh-reseni', label: 'Vytvoření návrhu řešení. Posílání obchodníkům', kind: 'zakazka' },
  { key: 'dily-sdsp', label: 'Díly SD/SP. Vytváření/modifikace dílů', kind: 'zakazka' },
  { key: 'pridani-nula', label: 'Přidání zakázek podle NULA modelů', kind: 'zakazka' },
  { key: 'dokumentace', label: 'Vytvoření dodatečné dokumentace na vyžádání', kind: 'zakazka' },
  { key: 'tendr', label: 'TENDR — modely/prototyp, OB-výkres', kind: 'zakazka' },
  { key: 'konzultace-konstr', label: 'Spolupráce / konzultace konstruktéra', kind: 'rezie' },
  { key: 'konzultace-obch', label: 'Spolupráce / konzultace obchodníka', kind: 'rezie' },
  { key: 'rizeni-prace', label: 'Řízení práce – konstruktéři', kind: 'rezie' },
  { key: 'porada-stredisko', label: 'Porada výrobního střediska', kind: 'rezie' },
  { key: 'porada-ukoly', label: 'Porada podle skutečných úkolů', kind: 'rezie' },
  { key: 'administrativa', label: 'Vyřizování objednávek, e-mailů, dotazů z dílny a telefonátů', kind: 'rezie' },
  { key: 'jina', label: 'Jiná / dodatečná práce', kind: 'rezie' },
];

// ---- České státní svátky (pevné + pohyblivé velikonoční) --------------------
function easterSunday(year) {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher) — vrací {m, d}.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}
const _holCache = {};
function holidaySet(year) {
  if (_holCache[year]) return _holCache[year];
  const set = new Set([
    '01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26',
  ]);
  const es = easterSunday(year);
  const easter = new Date(Date.UTC(year, es.m - 1, es.d));
  const goodFri = new Date(easter); goodFri.setUTCDate(easter.getUTCDate() - 2);
  const easterMon = new Date(easter); easterMon.setUTCDate(easter.getUTCDate() + 1);
  const fmt = (dt) => String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  set.add(fmt(goodFri)); set.add(fmt(easterMon));
  _holCache[year] = set; return set;
}
function isWorkday(dt) {
  const dow = dt.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const key = String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  return !holidaySet(dt.getUTCFullYear()).has(key);
}
// Přičte N pracovních dnů k času a vrátí timestamp konce toho dne (23:59 UTC).
function addBusinessDays(fromTs, days) {
  const dt = new Date(fromTs);
  dt.setUTCHours(0, 0, 0, 0);
  let added = 0;
  while (added < days) { dt.setUTCDate(dt.getUTCDate() + 1); if (isWorkday(dt)) added++; }
  dt.setUTCHours(23, 59, 59, 0);
  return dt.getTime();
}
// Počet celých pracovních dnů mezi dvěma časy (může být záporný).
function businessDaysBetween(aTs, bTs) {
  let sign = 1, a = aTs, b = bTs;
  if (a > b) { sign = -1; a = bTs; b = aTs; }
  const dt = new Date(a); dt.setUTCHours(0, 0, 0, 0);
  const end = new Date(b); end.setUTCHours(0, 0, 0, 0);
  let n = 0;
  while (dt.getTime() < end.getTime()) { dt.setUTCDate(dt.getUTCDate() + 1); if (isWorkday(dt)) n++; }
  return sign * n;
}

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'konstrukce.json');
  const FILES_DIR = path.join(host.dataDir || __dirname, 'konstrukce-files');
  try { if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- perzistence ---------------------------------------------------------
  // Práh (podíl lhůty) pro upozornění „blíží se termín" — drží se v synchronu s d.settings.notif.warnPct.
  let WARN_FRAC = 0.8;
  // Výchozí konfigurace notifikací a eskalací (editovatelné v SET-UP).
  const DEFAULT_NOTIF = { warnPct: 80, clientRemind1: 5, clientRemind2: 10, overdueEmail: true, directorDigest: true };
  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); } catch (_) {}
    if (!d || typeof d !== 'object') d = {};
    if (typeof d.seq !== 'number') d.seq = 0;
    if (!d.roles || typeof d.roles !== 'object') d.roles = {};
    if (!d.fond || typeof d.fond !== 'object') d.fond = {};      // email -> hodin/týden
    if (!Array.isArray(d.types) || !d.types.length) d.types = JSON.parse(JSON.stringify(SEED_TYPES));
    // migrace na 6 řad ABROLL: starý jediný typ 'abroll' nahradíme řadami DSD/AFS/…
    if (!d.types.some(t => t.key === 'dsd')) d.types = JSON.parse(JSON.stringify(SEED_TYPES));
    // dotazník řad držíme v synchronu s kódem
    d.types.forEach(t => { if (SEED_TYPES.some(s => s.key === t.key)) t.dotaznik = JSON.parse(JSON.stringify(DOTAZNIK_ABROLL)); });
    if (!Array.isArray(d.zakazky)) d.zakazky = [];
    if (!Array.isArray(d.notif)) d.notif = [];
    if (!Array.isArray(d.activities) || !d.activities.length) d.activities = JSON.parse(JSON.stringify(SEED_ACTIVITIES));
    if (!Array.isArray(d.timesheet)) d.timesheet = [];
    if (!Array.isArray(d.strediska) || !d.strediska.length) d.strediska = JSON.parse(JSON.stringify(SEED_STREDISKA));
    if (!Array.isArray(d.adresy)) d.adresy = [];   // globální číselník adres dodání (roste automaticky)
    if (!d.settings || typeof d.settings !== 'object') d.settings = {};
    if (typeof d.settings.reportEnabled !== 'boolean') d.settings.reportEnabled = true;
    if (!Array.isArray(d.settings.reportRecipients)) d.settings.reportRecipients = ['tomas.krajca@elkoplast.cz', 'david.sury@elkoplast.cz', 'lukas.pospisil@elkoplast.cz'];
    if (!d.settings.phaseDays || typeof d.settings.phaseDays !== 'object') d.settings.phaseDays = { obchod: 2, konstrukce: 5, schvaleni: 5, vyroba: 10 };
    if (!d.settings.notif || typeof d.settings.notif !== 'object') d.settings.notif = {};
    for (const k in DEFAULT_NOTIF) { if (d.settings.notif[k] == null) d.settings.notif[k] = DEFAULT_NOTIF[k]; }
    if (d.settings.reportFreq !== 'daily' && d.settings.reportFreq !== 'weekly') d.settings.reportFreq = 'weekly';
    if (typeof d.settings.reportDow !== 'number' || d.settings.reportDow < 0 || d.settings.reportDow > 6) d.settings.reportDow = 1; // 1 = pondělí
    WARN_FRAC = Math.min(1, Math.max(0, (Number(d.settings.notif.warnPct) || 80) / 100));
    return d;
  }
  function save(d) { fs.writeFileSync(DATA_F, JSON.stringify(d, null, 2)); }

  // ---- Fáze procesu: Obchod -> Konstrukce -> Schvaleni -> Zadani do vyroby ----
  const PHASE_LABEL = { obchod: 'Obchod', konstrukce: 'Konstrukce', schvaleni: 'Schvaleni', vyroba: 'Zadani do vyroby' };
  const PHASE_OF = { novy: 'obchod', obchodnik: 'schvaleni', klient: 'schvaleni', schvaleno: 'schvaleni', prace: 'konstrukce', kontrola: 'konstrukce', revize: 'konstrukce', podklady: 'konstrukce', vyroba: 'vyroba', stredisko: 'vyroba', dokonceno: 'vyroba' };
  function auditAt(z, needle, last) { let t = null; (z.audit || []).forEach(a => { if ((a.action || '').indexOf(needle) >= 0) { if (last) t = a.at; else if (t == null) t = a.at; } }); return t; }
  function computePhaseStats(d) {
    const acc = { obchod: [], konstrukce: [], schvaleni: [], vyroba: [] }, total = [];
    for (const z of (d.zakazky || [])) {
      const created = z.createdAt || null;
      const assigned = auditAt(z, 'Přidělení', false);
      const drawn = auditAt(z, 'Zkreslení hotovo', true);
      const approved = auditAt(z, 'Klient schválil', false);
      const toProd = auditAt(z, 'Předáno do výroby', false) || approved;
      const done = z.closedAt || null;
      if (created && assigned) acc.obchod.push(businessDaysBetween(created, assigned));
      if (assigned && drawn) acc.konstrukce.push(businessDaysBetween(assigned, drawn));
      if (drawn && approved) acc.schvaleni.push(businessDaysBetween(drawn, approved));
      if (toProd && done) acc.vyroba.push(businessDaysBetween(toProd, done));
      const end = done || approved;
      if (created && end) total.push(businessDaysBetween(created, end));
    }
    const avg = a => a.length ? Math.round(a.reduce((x, v) => x + v, 0) / a.length * 10) / 10 : null;
    return { obchod: avg(acc.obchod), konstrukce: avg(acc.konstrukce), schvaleni: avg(acc.schvaleni), vyroba: avg(acc.vyroba), total: avg(total),
      n: { obchod: acc.obchod.length, konstrukce: acc.konstrukce.length, schvaleni: acc.schvaleni.length, vyroba: acc.vyroba.length, total: total.length } };
  }
  function isoWeekKey(ts) { const dt = new Date(ts); const day = (dt.getUTCDay() + 6) % 7; const th = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - day + 3)); const wk = 1 + Math.round((th - new Date(Date.UTC(th.getUTCFullYear(), 0, 4))) / 604800000); return th.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  function buildWeeklyReport(d) {
    const now = Date.now();
    const open = (d.zakazky || []).filter(z => STAV[z.stav] && !STAV[z.stav].terminal);
    const overdue = open.filter(z => semafor(z) === 'red');
    const byPhase = { obchod: 0, konstrukce: 0, schvaleni: 0, vyroba: 0 };
    open.forEach(z => { const ph = PHASE_OF[z.stav]; if (ph) byPhase[ph]++; });
    const ps = computePhaseStats(d), pd = (d.settings && d.settings.phaseDays) || {};
    const pa = (v, tgt) => (v == null ? '\u2014' : v + ' d') + (tgt ? ' (cíl ' + tgt + ' d)' : '');
    let t = 'Týdenní přehled \u2014 Konstrukce (' + fmtDate(now) + ')\n\n';
    t += 'Otevřených zakázek: ' + open.length + '\nPo termínu: ' + overdue.length + '\n\n';
    t += 'Rozpracováno dle fáze:\n\u2022 Obchod: ' + byPhase.obchod + '\n\u2022 Konstrukce: ' + byPhase.konstrukce + '\n\u2022 Schválení: ' + byPhase.schvaleni + '\n\u2022 Zadání do výroby: ' + byPhase.vyroba + '\n\n';
    if (overdue.length) t += 'Zpožděné zakázky:\n' + overdue.map(z => '\u2022 ' + z.cislo + ' (' + z.zakaznik + ') \u2014 ' + STAV[z.stav].label + ', termín ' + fmtDate(z.deadline) + ', odpovídá ' + (empName(responsibleEmail(z)) || '\u2014')).join('\n') + '\n\n';
    t += 'Průměrná skutečná doba fází (prac. dny):\n\u2022 Obchod: ' + pa(ps.obchod, pd.obchod) + '\n\u2022 Konstrukce: ' + pa(ps.konstrukce, pd.konstrukce) + '\n\u2022 Schválení: ' + pa(ps.schvaleni, pd.schvaleni) + '\n\u2022 Zadání do výroby: ' + pa(ps.vyroba, pd.vyroba) + '\n\u2022 Celý proces: ' + pa(ps.total, null) + '\n';
    return t;
  }

  // ---- role a přístup ------------------------------------------------------
  // Je uživatel výrobním ředitelem některé oblasti? (role odvozená z číselníku oblastí)
  function isVyrobniReditel(d, email) {
    if (!email) return false;
    return (d.strediska || []).some(s => (s.reditelEmail || '').toLowerCase() === email.toLowerCase());
  }
  function oblastReditel(d, key) {
    const s = (d.strediska || []).find(x => x.key === key);
    return s ? (s.reditelEmail || '') : '';
  }
  function maModul(req) {
    if (host.isAdmin(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    try {
      if ((host.employeeModules(e.email) || []).includes('konstrukce')) return true;
    } catch (_) {}
    const d = load();
    const email = (e.email || '').toLowerCase();
    return !!d.roles[email] || isVyrobniReditel(d, email);
  }
  // Efektivní role uživatele: admin vidí vše; jinak z číselníku rolí, případně
  // odvozeně „vyrobni-reditel", je-li ředitelem některé výrobní oblasti.
  function roleOf(req) {
    const e = host.empSession(req);
    const isAdm = host.isAdmin(req);
    const email = e ? (e.email || '').toLowerCase() : '';
    const d = load();
    let r = email ? (d.roles[email] || '') : '';
    if (!r && email && isVyrobniReditel(d, email)) r = 'vyrobni-reditel';
    return { email, name: e ? e.name : '', isAdmin: isAdm, role: r };
  }
  // Seznam zaměstnanců intranetu pro výběr osob k rolím (jen pro admina).
  function adminEmployees() {
    try { return (host.getState().employees || []).map(x => ({ email: (x.email || '').toLowerCase(), name: x.name || x.email })).filter(x => x.email).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs')); }
    catch (_) { return []; }
  }
  function empName(email) {
    if (!email) return '';
    try {
      const s = host.getState ? host.getState() : { employees: [] };
      const m = (s.employees || []).find(x => (x.email || '').toLowerCase() === email.toLowerCase());
      return (m && m.name) || email;
    } catch (_) { return email; }
  }
  function employeesWithRole(role) {
    const d = load();
    return Object.keys(d.roles).filter(em => d.roles[em] === role);
  }

  // ---- notifikace a e-maily ------------------------------------------------
  function notify(d, email, text, zakId) {
    if (!email) return;
    d.notif.unshift({ id: 'n' + crypto.randomBytes(5).toString('hex'), email: email.toLowerCase(), text, zakId: zakId || null, at: Date.now(), read: false });
    if (d.notif.length > 500) d.notif.length = 500;
  }
  async function mail(to, subject, text) {
    if (!to || !host.deliver || !host.mailFrom || !host.mailFrom.user) return;
    try {
      await host.deliver({ to, fromAddr: host.mailFrom.user, fromName: host.mailFrom.name || 'Intranet – konstrukce', subject, text, html: mailHtml(text) });
    } catch (e) { console.warn('[konstrukce] e-mail se nepodařilo odeslat (' + to + '): ' + e.message); }
  }
  function mailHtml(text) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#233;line-height:1.55">' +
      esc(text).replace(/\n/g, '<br>') + '</div>';
  }

  // ---- odvozené hodnoty (semafor, na tahu) ---------------------------------
  function responsibleEmail(z) {
    const st = STAV[z.stav]; if (!st || !st.onTurn) return '';
    if (st.onTurn === 'konstrukter') return z.assignedTo || '';
    if (st.onTurn === 'obchodnik') return z.obchodnikEmail || '';
    if (st.onTurn === 'sef') { const s = employeesWithRole('sef'); return s[0] || ''; }
    if (st.onTurn === 'sef-vyroby') { const d = load(); return z.strediskoKey ? oblastReditel(d, z.strediskoKey) : ''; }
    return '';
  }
  function semafor(z) {
    const st = STAV[z.stav];
    if (!st || st.terminal || st.hold || z.stav === 'schvaleno') return 'none';
    if (!z.deadline || !z.stepStartedAt) return 'green';
    const now = Date.now();
    if (now > z.deadline) return 'red';
    // Okno pro „blíží se" počítáme od bodu 0 (zadání), u revize od začátku kroku.
    const base = z.stav === 'revize' ? z.stepStartedAt : (z.createdAt || z.stepStartedAt);
    const total = z.deadline - base;
    const elapsed = now - base;
    if (total > 0 && elapsed >= WARN_FRAC * total) return 'amber';
    // zbývá poslední pracovní den → oranžová
    if (businessDaysBetween(now, z.deadline) <= 1) return 'amber';
    return 'green';
  }
  function typeOf(d, key) { return d.types.find(t => t.key === key) || d.types[0]; }
  // Zbytkové normohodiny úkolu pro kapacitní přehled.
  function remainingNh(d, z) {
    const t = typeOf(d, z.typKey);
    if (z.stav === 'revize') return t.revizeNh || 2;
    if (z.stav === 'prace' || z.stav === 'kontrola') return t.normohodiny || 8;
    return 0;
  }

  // ---- audit ---------------------------------------------------------------
  function audit(z, by, action, note, from, to) {
    if (!Array.isArray(z.audit)) z.audit = [];
    z.audit.push({ at: Date.now(), by: by || '', action, note: note || '', from: from || '', to: to || '' });
  }
  // Nastaví nový stav + termín + začátek kroku (výchozí lhůta z číselníku).
  function enterState(d, z, stav) {
    z.stav = stav;
    z.stepStartedAt = Date.now();
    const t = typeOf(d, z.typKey);
    // Lhůty kroků jsou OFFSETY od bodu 0 (zadání = z.createdAt) — dny se NESČÍTAJÍ.
    // Termín kroku = zadání + N prac. dní; stejné N u dvou kroků = stejné datum.
    const bod0 = z.createdAt || z.stepStartedAt;
    const offsetMap = {
      novy: t.lhutaPrideleniDays, prace: t.lhutaZkresleniDays, kontrola: t.lhutaKontrolaDays,
      obchodnik: t.lhutaObchodnikDays, klient: t.lhutaKlientDays,
      vyroba: t.lhutaVyrobaDays, stredisko: t.lhutaStrediskoDays,
    };
    if (stav === 'revize') {
      // Revize = iterační přepracování (v2, v3…) bez pevného ukotvení k bodu 0 → lhůta běží od začátku kroku.
      const rd = t.lhutaRevizeDays;
      z.deadline = rd ? addBusinessDays(z.stepStartedAt, rd) : null;
    } else {
      const off = offsetMap[stav];
      z.deadline = off ? addBusinessDays(bod0, off) : null;
    }
    // vyčistíme eskalační příznaky pro nový krok
    z.esc = { key: stav + ':' + (z.versions.length || 0) };
  }

  const CURRENT_V = (z) => z.versions[z.versions.length - 1] || null;

  // ======================================================================
  //  HTTP handler
  // ======================================================================
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (!p.startsWith('/konstrukce') && !p.startsWith('/api/konstrukce')) return false;

    // ---------- VEŘEJNÉ cesty klientského náhledu (bez SSO) ----------------
    if (p.startsWith('/konstrukce/nahled/') || p.startsWith('/api/konstrukce/nahled/')) {
      return await handlePublic(req, res, u, p);
    }

    // ---------- interní část: vyžaduje přístup k modulu --------------------
    if (!maModul(req)) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'Nemáte přístup k modulu Konstrukce.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K modulu Konstrukce nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }

    // stránka modulu
    if ((p === '/konstrukce' || p === '/konstrukce/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí konstrukce.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }

    // interní stažení souboru (PDF/CAD) — jen pro role s přístupem
    if (p === '/api/konstrukce/soubor' && req.method === 'GET') {
      return serveInternalFile(res, u.query);
    }

    try {
      if (p === '/api/konstrukce/katalog' && req.method === 'GET') { json(res, 200, { polozky: KATALOG_ABR }); return true; }
      if (p === '/api/konstrukce/me' && req.method === 'GET') return apiMe(req, res);
      if (p === '/api/konstrukce/data' && req.method === 'GET') return apiData(req, res);
      if (p === '/api/konstrukce/zakazka' && req.method === 'POST') return apiCreate(req, res);
      if (p === '/api/konstrukce/prideli' && req.method === 'POST') return apiAssign(req, res);
      if (p === '/api/konstrukce/upload' && req.method === 'POST') return apiUpload(req, res);
      if (p === '/api/konstrukce/stav' && req.method === 'POST') return apiTransition(req, res);
      if (p === '/api/konstrukce/timer' && req.method === 'POST') return apiTimer(req, res);
      if (p === '/api/konstrukce/komentar' && req.method === 'POST') return apiComment(req, res);
      if (p === '/api/konstrukce/termin' && req.method === 'POST') return apiDeadline(req, res);
      if (p === '/api/konstrukce/notif-read' && req.method === 'POST') return apiNotifRead(req, res);
      if (p === '/api/konstrukce/admin/role' && req.method === 'POST') return apiAdminRole(req, res);
      if (p === '/api/konstrukce/admin/fond' && req.method === 'POST') return apiAdminFond(req, res);
      if (p === '/api/konstrukce/admin/typ' && req.method === 'POST') return apiAdminTyp(req, res);
      if (p === '/api/konstrukce/admin/seed' && req.method === 'POST') return apiAdminSeed(req, res);
      if (p === '/api/konstrukce/admin/settings' && req.method === 'POST') return apiAdminSettings(req, res);
      if (p === '/api/konstrukce/admin/report' && req.method === 'GET') return apiReport(req, res, false);
      if (p === '/api/konstrukce/admin/report' && req.method === 'POST') return apiReport(req, res, true);
      if (p === '/api/konstrukce/geocode' && req.method === 'GET') return apiGeocode(req, res, u.query);
      if (p === '/api/konstrukce/timesheet' && req.method === 'GET') return apiTimesheetGet(req, res, u.query);
      if (p === '/api/konstrukce/timesheet' && req.method === 'POST') return apiTimesheetSave(req, res);
      if (p === '/api/konstrukce/timesheet/delete' && req.method === 'POST') return apiTimesheetDelete(req, res);
      if (p === '/api/konstrukce/admin/activity' && req.method === 'POST') return apiAdminActivity(req, res);
      if (p === '/api/konstrukce/admin/stredisko' && req.method === 'POST') return apiAdminStredisko(req, res);
      if (p === '/api/konstrukce/admin/import' && req.method === 'POST') return apiAdminImport(req, res);
    } catch (e) {
      console.error('[konstrukce] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }

    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  // ---- /me: kdo jsem a jaká je moje role -----------------------------------
  function apiMe(req, res) {
    const me = roleOf(req);
    json(res, 200, { email: me.email, name: me.name, isAdmin: me.isAdmin, role: me.role || (me.isAdmin ? 'admin' : '') });
    return true;
  }

  // ---- /data: role-filtrovaný přehled --------------------------------------
  function apiData(req, res) {
    const me = roleOf(req);
    const d = load();
    // který stav „vidím"? admin/šéf/ředitel = vše; obchodník = své zakázky; konstruktér = přiřazené.
    const canSeeAll = me.isAdmin || me.role === 'sef' || me.role === 'reditel';
    let list = d.zakazky.slice();
    if (!canSeeAll) {
      if (me.role === 'obchodnik') list = list.filter(z => (z.obchodnikEmail || '').toLowerCase() === me.email);
      else if (me.role === 'konstrukter') list = list.filter(z => (z.assignedTo || '').toLowerCase() === me.email);
      else if (me.role === 'vyrobni-reditel') {
        const myObl = (d.strediska || []).filter(s => (s.reditelEmail || '').toLowerCase() === me.email).map(s => s.key);
        list = list.filter(z => z.stav === 'vyroba' || ((z.stav === 'stredisko' || z.stav === 'dokonceno') && myObl.includes(z.strediskoKey)));
      } else list = [];
    }
    // sečti hodiny z evidence práce podle zakázky (přičtou se k odpracováno)
    d._tsMap = {}; d.timesheet.forEach(t => { if (t.zakId) d._tsMap[t.zakId] = (d._tsMap[t.zakId] || 0) + (t.hours || 0); });
    const view = list.map(z => publicShape(d, z, me)).sort((a, b) => b.createdAt - a.createdAt);

    // kapacitní přehled konstruktérů (pro šéfa/admin)
    let kapacita = null;
    if (me.isAdmin || me.role === 'sef') kapacita = capacityOverview(d);

    const myNotif = d.notif.filter(n => n.email === me.email);
    json(res, 200, {
      me: { email: me.email, name: me.name || empName(me.email), isAdmin: me.isAdmin, role: me.role || (me.isAdmin ? 'admin' : '') },
      zakazky: view,
      types: d.types,
      kapacita,
      konstrukteri: employeesWithRole('konstrukter').map(em => ({ email: em, name: empName(em) })),
      strediska: (d.strediska || []).map(s => ({ key: s.key, label: s.label, reditelEmail: s.reditelEmail || '', reditelName: s.reditelEmail ? empName(s.reditelEmail) : '' })),
      adresy: (d.adresy || []).slice().sort((a, b) => a.localeCompare(b, 'cs')),
      roles: (me.isAdmin) ? roleAssignments(d) : undefined,
      employees: (me.isAdmin) ? adminEmployees() : undefined,
      notif: myNotif.slice(0, 40),
      notifUnread: myNotif.filter(n => !n.read).length,
      now: Date.now(),
      settings: me.isAdmin ? d.settings : undefined,
      phaseDays: (d.settings && d.settings.phaseDays) || {},
      phaseAvg: computePhaseStats(d),
      phaseLabel: PHASE_LABEL,
    });
    return true;
  }

  function capacityOverview(d) {
    const rows = employeesWithRole('konstrukter').map(em => {
      const fondTyden = d.fond[em] || 40;
      const tasks = d.zakazky.filter(z => (z.assignedTo || '').toLowerCase() === em && (z.stav === 'prace' || z.stav === 'kontrola' || z.stav === 'revize'));
      const nh = tasks.reduce((s, z) => s + remainingNh(d, z), 0);
      // dostupné hodiny do nejbližšího termínu (aprox: fond/den = fond/5)
      const denH = fondTyden / 5;
      const dostupne = Math.max(denH, denH * 5); // horizont ~týden
      const vytizeni = dostupne > 0 ? Math.round((nh / dostupne) * 100) : 0;
      return { email: em, name: empName(em), fondTyden, tasks: tasks.length, nh, vytizeni };
    });
    return rows.sort((a, b) => a.vytizeni - b.vytizeni);
  }
  // Přiřazení osob k rolím pro roli-centrickou administraci (role → seznam lidí).
  function roleAssignments(d) {
    const by = (role) => Object.keys(d.roles).filter(em => d.roles[em] === role)
      .map(em => ({ email: em, name: empName(em), fond: d.fond[em] || null }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
    return { sef: by('sef'), konstrukter: by('konstrukter'), obchodnik: by('obchodnik'), reditel: by('reditel') };
  }

  // Tvar zakázky pro frontend (bez interních tajností klienta se řeší v public části).
  function publicShape(d, z, me) {
    const t = typeOf(d, z.typKey);
    const cur = CURRENT_V(z);
    const tsSec = ((d._tsMap && d._tsMap[z.id]) || 0) * 3600;
    const totalSec = (z.timeEntries || []).reduce((s, e) => s + (e.seconds || 0), 0) + tsSec;
    const myTimer = z.activeTimer && me && z.activeTimer.user === me.email ? z.activeTimer : null;
    return {
      id: z.id, cislo: z.cislo, createdAt: z.createdAt,
      typKey: z.typKey, typName: t.name,
      zakaznik: z.zakaznik, kontakt: z.kontakt, kontaktEmail: z.kontaktEmail,
      cisloPoptavky: z.cisloPoptavky, pozadovanyTermin: z.pozadovanyTermin || null,
      params: z.params || {}, dotaznik: z.dotaznik || null, artNo: z.artNo || '',
      stav: z.stav, stavLabel: STAV[z.stav].label, onTurn: STAV[z.stav].onTurn,
      obchodnikEmail: z.obchodnikEmail, obchodnikName: empName(z.obchodnikEmail),
      assignedTo: z.assignedTo || '', assignedName: z.assignedTo ? empName(z.assignedTo) : '',
      deadline: z.deadline || null, stepStartedAt: z.stepStartedAt || null,
      semafor: semafor(z),
      responsible: responsibleEmail(z), responsibleName: empName(responsibleEmail(z)),
      versionCount: z.versions.length,
      currentVersion: cur ? { v: cur.v, hasPdf: !!cur.pdf, hasCad: !!cur.cad, pdfName: cur.pdf && cur.pdf.name, cadName: cur.cad && cur.cad.name, author: empName(cur.author), createdAt: cur.createdAt } : null,
      versions: z.versions.map(v => ({ v: v.v, hasPdf: !!v.pdf, hasCad: !!v.cad, pdfName: v.pdf && v.pdf.name, cadName: v.cad && v.cad.name, author: empName(v.author), createdAt: v.createdAt })),
      comments: (z.comments || []).map(c => ({ id: c.id, author: c.authorName || empName(c.author), role: c.role, text: c.text, at: c.at, versionRef: c.versionRef })),
      totalSec, myTimer, timerRunning: !!(z.activeTimer),
      link: z.link ? { active: z.link.active, expiresAt: z.link.expiresAt, url: '/konstrukce/nahled/' + z.link.token, hasPin: !!z.link.pin, accesses: (z.link.accesses || []).length } : null,
      revisionCount: z.revisionCount || 0,
      strediskoKey: z.strediskoKey || '', strediskoName: z.strediskoName || '',
      holdReason: z.holdReason || '', prevStav: z.prevStav || '',
      clientDecision: z.clientDecision || null,
      audit: z.audit || [],
    };
  }

  // Očistí odpovědi dotazníku podle definice typu (jen známá pole, omezené délky).
  function sanitizeDotaznik(t, raw) {
    if (!t || !Array.isArray(t.dotaznik) || !raw || typeof raw !== 'object') return null;
    const out = {};
    t.dotaznik.forEach(sec => (sec.fields || []).forEach(f => {
      const a = raw[f.k]; if (a == null) return;
      if (f.std !== undefined) {
        // pole typu volba: { volba: standard|opce|pozadavek, hodnota }
        const volba = ['standard', 'opce', 'pozadavek'].includes(a.volba) ? a.volba : 'standard';
        const hodnota = String(a.hodnota == null ? '' : a.hodnota).slice(0, 300);
        if (hodnota) out[f.k] = { volba, hodnota };
      } else {
        const v = String(a).slice(0, 500).trim(); if (v) out[f.k] = v;
      }
    }));
    return Object.keys(out).length ? out : null;
  }

  // ---- vytvoření zakázky (obchodník) ---------------------------------------
  async function apiCreate(req, res) {
    const me = roleOf(req);
    if (!(me.isAdmin || me.role === 'obchodnik')) { json(res, 403, { chyba: 'Zadávat požadavky smí jen obchodník.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const zakaznik = String(b.zakaznik || '').trim();
    if (!zakaznik) { json(res, 400, { chyba: 'Vyplňte zákazníka.' }); return true; }
    const d = load();
    const t = typeOf(d, b.typKey);
    d.seq += 1;
    const now = Date.now();
    const cislo = 'VYK-' + new Date(now).getUTCFullYear() + '-' + String(d.seq).padStart(4, '0');
    const z = {
      id: 'z' + crypto.randomBytes(7).toString('hex'), cislo, createdAt: now,
      createdBy: me.email, obchodnikEmail: me.email,
      typKey: t.key, params: b.params && typeof b.params === 'object' ? b.params : {},
      dotaznik: sanitizeDotaznik(t, b.dotaznik), artNo: String(b.artNo || '').slice(0, 60),
      zakaznik, kontakt: String(b.kontakt || '').trim(), kontaktEmail: String(b.kontaktEmail || '').trim(),
      cisloPoptavky: String(b.cisloPoptavky || '').trim(),
      pozadovanyTermin: b.pozadovanyTermin ? String(b.pozadovanyTermin).slice(0, 10) : null,
      stav: 'novy', versions: [], comments: [], timeEntries: [], activeTimer: null,
      assignedTo: '', link: null, revisionCount: 0, audit: [],
    };
    enterState(d, z, 'novy');
    audit(z, me.email, 'Založení požadavku', 'typ: ' + t.name);
    d.zakazky.push(z);
    // globální číselník adres: nová adresa dodání se automaticky přidá
    const adr = z.dotaznik && typeof z.dotaznik.adresaDodani === 'string' ? z.dotaznik.adresaDodani.trim() : '';
    if (adr && !d.adresy.some(x => x.toLowerCase() === adr.toLowerCase())) { d.adresy.push(adr); if (d.adresy.length > 800) d.adresy.shift(); }
    // kontrola realizovatelnosti požadovaného termínu (aprox z výchozích lhůt)
    let warn = null;
    if (z.pozadovanyTermin) {
      // Lhůty jsou offsety od zadání → interně hotovo = nejzazší z interních kroků (ne součet).
      const internalDays = Math.max(t.lhutaPrideleniDays || 0, t.lhutaZkresleniDays || 0, (t.internalCheck ? (t.lhutaKontrolaDays || 0) : 0), t.lhutaObchodnikDays || 0);
      const earliest = addBusinessDays(now, internalDays);
      if (new Date(z.pozadovanyTermin + 'T23:59:59Z').getTime() < earliest) warn = 'Pozor: požadovaný termín je při výchozích lhůtách (interně ~' + internalDays + ' prac. dnů) nereálný ještě před reakcí klienta.';
    }
    employeesWithRole('sef').forEach(em => { notify(d, em, 'Nový požadavek ' + cislo + ' (' + zakaznik + ') čeká na přidělení.', z.id); });
    save(d);
    // e-mail šéfovi konstrukce (notifikační matice: založení → šéf e-mail)
    for (const em of employeesWithRole('sef')) mail(em, 'Nový požadavek na výkres · ' + cislo, 'Obchodník ' + me.name + ' založil nový požadavek na výkres.\n\nČíslo: ' + cislo + '\nZákazník: ' + zakaznik + '\nTyp: ' + t.name + '\n\nPřidělte prosím konstruktéra v intranetu → Konstrukce.');
    json(res, 200, { ok: true, id: z.id, cislo, warn });
    return true;
  }

  // ---- přidělení konstruktéra (šéf) ----------------------------------------
  async function apiAssign(req, res) {
    const me = roleOf(req);
    if (!(me.isAdmin || me.role === 'sef')) { json(res, 403, { chyba: 'Přidělovat smí jen šéf konstrukce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    const konstrukter = String(b.konstrukter || '').toLowerCase().trim();
    if (!konstrukter) { json(res, 400, { chyba: 'Vyberte konstruktéra.' }); return true; }
    const prev = z.assignedTo;
    z.assignedTo = konstrukter;
    if (z.stav === 'novy') enterState(d, z, 'prace');
    audit(z, me.email, prev ? 'Přeřazení' : 'Přidělení', 'konstruktér: ' + empName(konstrukter) + (b.duvod ? ' — ' + b.duvod : ''));
    notify(d, konstrukter, 'Byl vám přidělen výkres ' + z.cislo + ' (' + z.zakaznik + '). Termín zkreslení: ' + fmtDate(z.deadline) + '.', z.id);
    save(d);
    mail(konstrukter, 'Přidělen výkres · ' + z.cislo, 'Byl vám přidělen požadavek na výkres.\n\nČíslo: ' + z.cislo + '\nZákazník: ' + z.zakaznik + '\nTermín zkreslení: ' + fmtDate(z.deadline) + '\n\nOtevřete intranet → Konstrukce.');
    json(res, 200, { ok: true });
    return true;
  }

  // ---- upload PDF / CAD (konstruktér) --------------------------------------
  async function apiUpload(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    if (!(me.isAdmin || (me.role === 'konstrukter' && (z.assignedTo || '').toLowerCase() === me.email))) { json(res, 403, { chyba: 'Nahrávat smí jen přiřazený konstruktér.' }); return true; }
    const kind = b.kind === 'cad' ? 'cad' : 'pdf';
    const saved = saveFile(z.id, b.name, b.dataUrl, kind);
    if (saved.chyba) { json(res, 400, { chyba: saved.chyba }); return true; }
    // pracujeme s „rozpracovanou" verzí = poslední verze bez uzamčení, nebo nová draft
    let draft = z.versions.find(v => !v.locked);
    if (!draft) { draft = { v: (z.versions.length ? z.versions[z.versions.length - 1].v : 0) + 1, author: me.email, createdAt: Date.now(), locked: false }; z.versions.push(draft); }
    if (draft[kind] && draft[kind].path) deleteFile(draft[kind].path);
    draft[kind] = { name: saved.name, path: saved.path, at: Date.now() };
    draft.author = me.email;
    save(d);
    json(res, 200, { ok: true, versionCount: z.versions.length });
    return true;
  }

  // ---- přechody stavů ------------------------------------------------------
  async function apiTransition(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    const action = String(b.action || '');
    const note = String(b.note || '').slice(0, 1000);
    const isSef = me.isAdmin || me.role === 'sef';
    const isObch = me.isAdmin || (me.role === 'obchodnik' && (z.obchodnikEmail || '').toLowerCase() === me.email) || (me.role === 'obchodnik' && isSef);
    const isKon = me.isAdmin || (me.role === 'konstrukter' && (z.assignedTo || '').toLowerCase() === me.email);
    const isVyr = me.isAdmin || me.role === 'vyrobni-reditel';           // libovolný výrobní ředitel
    const isMujOblast = me.isAdmin || (z.strediskoKey && oblastReditel(d, z.strediskoKey) === me.email); // ředitel oblasti této zakázky
    let err = null;

    switch (action) {
      case 'zkresleno': { // konstruktér → interní kontrola
        if (!isKon) { err = 'Označit jako zkreslené smí jen přiřazený konstruktér.'; break; }
        if (z.stav !== 'prace' && z.stav !== 'revize') { err = 'Zakázka není ve stavu, kdy lze zkreslit.'; break; }
        const draft = z.versions.find(v => !v.locked);
        if (!draft || !draft.pdf) { err = 'Nejdřív nahrajte PDF výkresu pro klienta.'; break; }
        stopTimer(z, me.email);
        const t = typeOf(d, z.typKey);
        audit(z, me.email, 'Zkreslení hotovo', 'verze v' + draft.v);
        enterState(d, z, t.internalCheck ? 'kontrola' : 'obchodnik');
        if (t.internalCheck) employeesWithRole('sef').forEach(em => notify(d, em, 'Výkres ' + z.cislo + ' je zkreslený a čeká na interní kontrolu.', z.id));
        else { notify(d, z.obchodnikEmail, 'Výkres ' + z.cislo + ' je připraven k potvrzení.', z.id); mail(z.obchodnikEmail, 'Výkres zkreslen · ' + z.cislo, 'Výkres ' + z.cislo + ' (' + z.zakaznik + ') je zkreslený a čeká na vaše potvrzení.'); }
        break;
      }
      case 'kontrola-ok': { // šéf → u obchodníka
        if (!isSef) { err = 'Interní kontrolu provádí šéf konstrukce.'; break; }
        if (z.stav !== 'kontrola') { err = 'Zakázka není v interní kontrole.'; break; }
        audit(z, me.email, 'Interní kontrola OK', note);
        enterState(d, z, 'obchodnik');
        notify(d, z.obchodnikEmail, 'Výkres ' + z.cislo + ' prošel kontrolou a čeká na vaše potvrzení.', z.id);
        mail(z.obchodnikEmail, 'Výkres zkreslen a zkontrolován · ' + z.cislo, 'Výkres ' + z.cislo + ' (' + z.zakaznik + ') prošel interní kontrolou a čeká na vaše potvrzení v intranetu → Konstrukce.');
        break;
      }
      case 'kontrola-vrat': { // šéf → zpět konstruktérovi
        if (!isSef) { err = 'Vracet z kontroly smí šéf konstrukce.'; break; }
        if (z.stav !== 'kontrola') { err = 'Zakázka není v interní kontrole.'; break; }
        if (!note) { err = 'U vrácení uveďte komentář s výhradami.'; break; }
        addComment(z, me, 'internal', 'Vráceno z interní kontroly: ' + note);
        audit(z, me.email, 'Vráceno z kontroly', note);
        unlockDraft(z);
        enterState(d, z, 'prace');
        notify(d, z.assignedTo, 'Výkres ' + z.cislo + ' vrácen z kontroly k přepracování.', z.id);
        break;
      }
      case 'obchodnik-ok': { // obchodník potvrdí → připraveno k odeslání klientovi (zůstává u obchodníka, čeká na odeslání)
        if (!isObch) { err = 'Potvrdit výkres smí obchodník zakázky.'; break; }
        if (z.stav !== 'obchodnik') { err = 'Zakázka není u obchodníka.'; break; }
        // uzamkneme draft jako oficiální verzi
        lockDraft(z);
        z.obchodnikConfirmed = true;
        audit(z, me.email, 'Obchodník potvrdil výkres', note);
        save(d); json(res, 200, { ok: true, readyToSend: true }); return true;
      }
      case 'obchodnik-vrat': { // obchodník má připomínky → zpět konstruktérovi
        if (!isObch) { err = 'Vracet smí obchodník zakázky.'; break; }
        if (z.stav !== 'obchodnik') { err = 'Zakázka není u obchodníka.'; break; }
        if (!note) { err = 'Uveďte připomínky pro konstruktéra.'; break; }
        addComment(z, me, 'internal', 'Připomínky obchodníka: ' + note);
        audit(z, me.email, 'Vráceno obchodníkem', note);
        unlockDraft(z);
        enterState(d, z, 'prace');
        notify(d, z.assignedTo, 'Výkres ' + z.cislo + ' vrácen obchodníkem k úpravě.', z.id);
        break;
      }
      case 'odeslat-klientovi': { // obchodník odešle veřejný náhled (ručně, s možností upravit text)
        if (!isObch) { err = 'Odeslat klientovi smí obchodník zakázky.'; break; }
        if (z.stav !== 'obchodnik') { err = 'Zakázka není připravena k odeslání.'; break; }
        if (!CURRENT_V(z) || !CURRENT_V(z).pdf) { err = 'Chybí PDF výkresu.'; break; }
        if (!z.kontaktEmail) { err = 'U zakázky chybí e-mail kontaktní osoby klienta.'; break; }
        lockDraft(z);
        const t = typeOf(d, z.typKey);
        const token = crypto.randomBytes(24).toString('hex');
        z.link = { token, active: true, createdAt: Date.now(), expiresAt: addDaysCal(Date.now(), t.linkValidDays || 30), pin: b.pin ? String(b.pin).slice(0, 12) : '', accesses: [] };
        enterState(d, z, 'klient');
        audit(z, me.email, 'Odesláno klientovi', 'odkaz platí do ' + fmtDate(z.link.expiresAt));
        const base = host.baseUrl ? host.baseUrl(req) : '';
        const url = base + '/konstrukce/nahled/' + token;
        const defaultText = 'Dobrý den,\n\nzasíláme Vám ke schválení výkres k zakázce ' + z.cislo + ' (' + z.zakaznik + ').\nProhlédnout a schválit jej můžete zde:\n' + url + '\n' + (z.link.pin ? '\nPřístupový PIN: ' + z.link.pin + '\n' : '') + '\nS pozdravem,\n' + me.name;
        const text = (b.text ? String(b.text) : defaultText).replace('{ODKAZ}', url);
        const subject = b.subject ? String(b.subject) : ('Výkres ke schválení · ' + z.cislo);
        save(d);
        await mail(z.kontaktEmail, subject, text);
        notify(d, z.obchodnikEmail, 'Náhled výkresu ' + z.cislo + ' odeslán klientovi (' + z.kontaktEmail + ').', z.id);
        save(d);
        json(res, 200, { ok: true, url });
        return true;
      }
      case 'hold': { // pozastavení lhůt — čeká na podklady
        if (!isObch && !isSef) { err = 'Pozastavit smí obchodník nebo šéf konstrukce.'; break; }
        if (!note) { err = 'Uveďte důvod čekání na podklady.'; break; }
        if (STAV[z.stav].terminal || z.stav === 'podklady') { err = 'Nelze pozastavit.'; break; }
        z.prevStav = z.stav; z.holdReason = note; z.holdSince = Date.now();
        stopTimer(z, me.email);
        z.stav = 'podklady'; z.deadline = null;
        audit(z, me.email, 'Čeká na podklady', note);
        break;
      }
      case 'unhold': { // doplněny podklady → návrat do původního stavu
        if (!isObch && !isSef) { err = 'Obnovit smí obchodník nebo šéf konstrukce.'; break; }
        if (z.stav !== 'podklady') { err = 'Zakázka nečeká na podklady.'; break; }
        const back = z.prevStav || 'prace';
        audit(z, me.email, 'Podklady doplněny', 'návrat do: ' + STAV[back].label);
        enterState(d, z, back);
        z.holdReason = ''; z.prevStav = '';
        notify(d, responsibleEmail(z), 'Podklady k ' + z.cislo + ' doplněny, pokračujte.', z.id);
        break;
      }
      case 'storno': { // zamítnutí/storno interně (obchodník/ředitel)
        if (!(me.isAdmin || me.role === 'obchodnik' || me.role === 'reditel')) { err = 'Stornovat smí obchodník nebo ředitel.'; break; }
        if (!note) { err = 'Uveďte důvod storna.'; break; }
        stopTimer(z, me.email);
        if (z.link) z.link.active = false;
        z.stav = 'zamitnuto'; z.deadline = null; z.closedAt = Date.now();
        audit(z, me.email, 'Storno', note);
        break;
      }
      case 'predat-vyrobe': { // schválený výkres → předání do výroby (do vybrané oblasti)
        if (!(isSef || isObch)) { err = 'Předat do výroby smí obchodník nebo šéf konstrukce.'; break; }
        if (z.stav !== 'schvaleno') { err = 'Do výroby lze předat jen schválenou zakázku.'; break; }
        if (z.link) z.link.active = false;
        const skey0 = String(b.stredisko || '').trim();
        const s0 = skey0 ? d.strediska.find(x => x.key === skey0) : null;
        if (s0) {
          z.strediskoKey = s0.key; z.strediskoName = s0.label;
          enterState(d, z, 'stredisko');
          audit(z, me.email, 'Předáno do výroby', 'oblast ' + s0.label + (note ? ' — ' + note : ''));
          const dir = oblastReditel(d, s0.key);
          if (dir) { notify(d, dir, 'Do výroby (' + s0.label + ') přišel schválený výkres ' + z.cislo + ' (' + z.zakaznik + ').', z.id); mail(dir, 'Do výroby · ' + z.cislo + ' · ' + s0.label, 'Schválený výkres ' + z.cislo + ' (' + z.zakaznik + ') byl předán do výroby ve vaší oblasti ' + s0.label + '.'); }
        } else {
          enterState(d, z, 'vyroba');
          audit(z, me.email, 'Předáno do výroby', note || 'bez přidělené oblasti');
          (d.strediska || []).forEach(s => { if (s.reditelEmail) notify(d, s.reditelEmail, 'Schválený výkres ' + z.cislo + ' čeká na přidělení výrobní oblasti.', z.id); });
        }
        break;
      }
      case 'prideli-stredisko': { // přidělení / přeřazení výrobní oblasti
        if (!(isVyr || isSef)) { err = 'Přidělit výrobní oblast smí výrobní ředitel nebo šéf konstrukce.'; break; }
        if (z.stav !== 'vyroba' && z.stav !== 'stredisko') { err = 'Zakázka není ve fázi výroby.'; break; }
        const skey = String(b.stredisko || '').trim();
        const s = d.strediska.find(x => x.key === skey);
        if (!s) { err = 'Vyberte výrobní oblast.'; break; }
        z.strediskoKey = s.key; z.strediskoName = s.label;
        const wasNew = z.stav !== 'stredisko';
        enterState(d, z, 'stredisko');
        audit(z, me.email, wasNew ? 'Přidělena výrobní oblast' : 'Přeřazena výrobní oblast', s.label + (note ? ' — ' + note : ''));
        const dir = oblastReditel(d, s.key);
        if (dir) notify(d, dir, 'Zakázka ' + z.cislo + ' je přidělena do výroby (' + s.label + ').', z.id);
        notify(d, z.obchodnikEmail, 'Zakázka ' + z.cislo + ' je ve výrobě — oblast ' + s.label + '.', z.id);
        break;
      }
      case 'vyrobeno': { // výroba dokončena → dokončeno/archiv
        if (!(isMujOblast || isSef || (isVyr && z.stav === 'vyroba'))) { err = 'Označit jako vyrobeno smí výrobní ředitel dané oblasti.'; break; }
        if (z.stav !== 'stredisko' && z.stav !== 'vyroba') { err = 'Zakázka není ve výrobě.'; break; }
        z.stav = 'dokonceno'; z.deadline = null; z.closedAt = Date.now();
        audit(z, me.email, 'Vyrobeno / dokončeno', (z.strediskoName ? 'oblast ' + z.strediskoName : '') + (note ? ' — ' + note : ''));
        notify(d, z.obchodnikEmail, 'Zakázka ' + z.cislo + ' je vyrobena a dokončena.', z.id);
        break;
      }
      default: err = 'Neznámá akce „' + action + '".';
    }
    if (err) { json(res, 400, { chyba: err }); return true; }
    save(d);
    json(res, 200, { ok: true });
    return true;
  }

  // ---- geokódování adres z OpenStreetMap (Photon) — našeptávač adresy ------
  // Proxy přes server (kvůli CORS a fair-use); při chybě vrací prázdno a UI
  // spadne zpět na interní číselník adres. Krátká paměťová cache dotazů.
  const _geoCache = {}; let _geoCacheKeys = [];
  function apiGeocode(req, res, q) {
    const query = String(q.q || '').trim();
    if (query.length < 3) { json(res, 200, { items: [] }); return true; }
    const lang = ['en', 'de', 'fr', 'it'].includes(q.lang) ? q.lang : 'default';
    const key = lang + '|' + query.toLowerCase();
    if (_geoCache[key]) { json(res, 200, { items: _geoCache[key] }); return true; }
    const url = 'https://photon.komoot.io/api/?limit=6' + (lang !== 'default' ? '&lang=' + lang : '') + '&q=' + encodeURIComponent(query);
    let done = false;
    const finish = (items) => { if (done) return; done = true; if (items && items.length) { _geoCache[key] = items; _geoCacheKeys.push(key); if (_geoCacheKeys.length > 300) delete _geoCache[_geoCacheKeys.shift()]; } json(res, 200, { items: items || [] }); };
    try {
      const r = https.get(url, { headers: { 'User-Agent': 'ElkoplastIntranet/1.0 (konstrukce; david.sury@elkoplast.cz)' }, timeout: 4000 }, (resp) => {
        let data = ''; resp.on('data', c => { data += c; if (data.length > 500000) resp.destroy(); });
        resp.on('end', () => { try { const j = JSON.parse(data); finish((j.features || []).map(f => formatPhoton(f.properties)).filter(Boolean)); } catch (_) { finish([]); } });
      });
      r.on('timeout', () => { r.destroy(); finish([]); });
      r.on('error', () => finish([]));
    } catch (_) { finish([]); }
    return true;
  }
  function formatPhoton(p) {
    if (!p) return '';
    const nm = (p.name && p.name !== p.city && p.name !== p.street) ? p.name : '';
    const line1 = [p.street || nm, p.housenumber].filter(Boolean).join(' ').trim() || nm;
    const city = [p.postcode, p.city || p.town || p.village || p.district || p.county].filter(Boolean).join(' ').trim();
    const out = [line1, city, p.country].filter(Boolean).join(', ');
    return out.length > 4 ? out : '';
  }

  // ---- timer (konstruktér) -------------------------------------------------
  async function apiTimer(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    if (!(me.isAdmin || (me.role === 'konstrukter' && (z.assignedTo || '').toLowerCase() === me.email))) { json(res, 403, { chyba: 'Timer ovládá přiřazený konstruktér.' }); return true; }
    if (b.action === 'start') {
      // zastav případný běžící timer téhož uživatele na jiné zakázce
      d.zakazky.forEach(x => { if (x.activeTimer && x.activeTimer.user === me.email) stopTimer(x, me.email); });
      z.activeTimer = { user: me.email, startedAt: Date.now() };
    } else if (b.action === 'stop') {
      stopTimer(z, me.email);
    } else if (b.action === 'manual') {
      const min = Math.max(0, Math.min(24 * 60, parseInt(b.minutes, 10) || 0));
      if (min > 0) { z.timeEntries.push({ user: me.email, seconds: min * 60, at: Date.now(), note: String(b.note || 'ruční zápis').slice(0, 200) }); }
    }
    save(d);
    json(res, 200, { ok: true, totalSec: (z.timeEntries || []).reduce((s, e) => s + (e.seconds || 0), 0), running: !!z.activeTimer });
    return true;
  }
  function stopTimer(z, user) {
    if (z.activeTimer && (!user || z.activeTimer.user === user)) {
      const sec = Math.round((Date.now() - z.activeTimer.startedAt) / 1000);
      if (sec > 0) z.timeEntries.push({ user: z.activeTimer.user, seconds: sec, at: Date.now(), note: 'timer' });
      z.activeTimer = null;
    }
  }

  // ---- komentář ------------------------------------------------------------
  async function apiComment(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!text) { json(res, 400, { chyba: 'Prázdný komentář.' }); return true; }
    addComment(z, me, 'internal', text);
    save(d);
    json(res, 200, { ok: true });
    return true;
  }
  function addComment(z, me, role, text) {
    if (!Array.isArray(z.comments)) z.comments = [];
    z.comments.push({ id: 'c' + crypto.randomBytes(5).toString('hex'), author: me.email || '', authorName: me.name || (role === 'client' ? 'Klient' : ''), role, text, at: Date.now(), versionRef: CURRENT_V(z) ? CURRENT_V(z).v : null });
  }

  // ---- změna termínu (obchodník; konstruktér se souhlasem — zjednodušeno na žádost) ----
  async function apiDeadline(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    const reason = String(b.duvod || '').trim();
    if (!reason) { json(res, 400, { chyba: 'Změnu termínu je nutné zdůvodnit.' }); return true; }
    const newTs = b.deadline ? new Date(String(b.deadline).slice(0, 10) + 'T23:59:59Z').getTime() : null;
    if (!newTs || isNaN(newTs)) { json(res, 400, { chyba: 'Neplatný termín.' }); return true; }
    const canObch = me.isAdmin || (me.role === 'obchodnik' && (z.obchodnikEmail || '').toLowerCase() === me.email) || me.role === 'sef';
    if (!canObch) { json(res, 403, { chyba: 'Termín běžící zakázky mění obchodník (konstruktér jen se souhlasem obchodníka).' }); return true; }
    const old = z.deadline;
    z.deadline = newTs;
    z.esc = { key: z.stav + ':' + z.versions.length }; // reset eskalace pro nový termín
    audit(z, me.email, 'Změna termínu', 'z ' + fmtDate(old) + ' na ' + fmtDate(newTs) + ' — ' + reason);
    notify(d, responsibleEmail(z), 'Termín zakázky ' + z.cislo + ' změněn na ' + fmtDate(newTs) + '.', z.id);
    save(d);
    json(res, 200, { ok: true });
    return true;
  }

  async function apiNotifRead(req, res) {
    const me = roleOf(req);
    const d = load();
    d.notif.forEach(n => { if (n.email === me.email) n.read = true; });
    save(d);
    json(res, 200, { ok: true });
    return true;
  }

  // ---- admin: role / fond / číselník ---------------------------------------
  async function apiAdminRole(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const email = String(b.email || '').toLowerCase().trim();
    const role = String(b.role || '').trim();
    if (!email) { json(res, 400, { chyba: 'Chybí e-mail.' }); return true; }
    const d = load();
    if (!role) delete d.roles[email];
    else if (['obchodnik', 'sef', 'konstrukter', 'reditel', 'sef-vyroby'].includes(role)) d.roles[email] = role;
    else { json(res, 400, { chyba: 'Neplatná role.' }); return true; }
    save(d);
    json(res, 200, { ok: true, roles: roleAssignments(d) });
    return true;
  }
  async function apiAdminFond(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const email = String(b.email || '').toLowerCase().trim();
    const h = parseInt(b.fond, 10);
    const d = load();
    if (!isNaN(h) && h > 0) d.fond[email] = h; else delete d.fond[email];
    save(d);
    json(res, 200, { ok: true });
    return true;
  }
  async function apiAdminTyp(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const key = String(b.key || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (!key) { json(res, 400, { chyba: 'Chybí klíč typu.' }); return true; }
    let t = d.types.find(x => x.key === key);
    if (b.delete) { d.types = d.types.filter(x => x.key !== key); save(d); json(res, 200, { ok: true, types: d.types }); return true; }
    if (!t) { t = { key, params: [] }; d.types.push(t); }
    const numFields = ['normohodiny', 'revizeNh', 'lhutaZkresleniDays', 'lhutaRevizeDays', 'lhutaPrideleniDays', 'lhutaKontrolaDays', 'lhutaObchodnikDays', 'lhutaKlientDays', 'lhutaVyrobaDays', 'lhutaStrediskoDays', 'linkValidDays'];
    t.name = String(b.name || t.name || key).slice(0, 120);
    t.standard = !!b.standard;
    t.internalCheck = b.internalCheck !== false;
    numFields.forEach(f => { if (b[f] != null && !isNaN(parseInt(b[f], 10))) t[f] = parseInt(b[f], 10); });
    ['lhutaPrideleniDays', 'lhutaKontrolaDays', 'lhutaObchodnikDays', 'lhutaKlientDays'].forEach(f => { if (t[f] == null) t[f] = SEED_TYPES[0][f]; });
    if (Array.isArray(b.params)) t.params = b.params.slice(0, 40).map(pp => ({ label: String(pp.label || '').slice(0, 80), examples: String(pp.examples || '').slice(0, 200) })).filter(pp => pp.label);
    // dotazník: pole sekcí {title, fields:[{k,label,type|std,opce}]} (pro budoucí typy)
    if (Array.isArray(b.dotaznik)) t.dotaznik = b.dotaznik.slice(0, 20).map(sec => ({
      title: String(sec.title || '').slice(0, 80),
      fields: (Array.isArray(sec.fields) ? sec.fields : []).slice(0, 60).map(f => {
        const o = { k: String(f.k || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40), label: String(f.label || '').slice(0, 120) };
        if (f.std !== undefined) { o.std = String(f.std || '').slice(0, 200); o.opce = String(f.opce || '').slice(0, 200); if (f.opceVstup && typeof f.opceVstup === 'object') o.opceVstup = { placeholder: String(f.opceVstup.placeholder || '').slice(0, 60), unit: String(f.opceVstup.unit || '').slice(0, 20), num: !!f.opceVstup.num }; }
        else o.type = f.type === 'number' ? 'number' : 'text';
        return o;
      }).filter(f => f.k && f.label),
    })).filter(sec => sec.fields.length);
    save(d);
    json(res, 200, { ok: true, types: d.types });
    return true;
  }

  // ======================================================================
  //  VEŘEJNÁ ČÁST — klientský náhled (bez přihlášení, přes token)
  // ======================================================================
  async function handlePublic(req, res, u, p) {
    // stránka náhledu
    const mPage = /^\/konstrukce\/nahled\/([a-f0-9]{32,64})\/?$/.exec(p);
    if (mPage && req.method === 'GET') {
      htmlOut(res, 200, publicPage());
      return true;
    }
    // PDF ke stažení pro klienta
    const mPdf = /^\/konstrukce\/nahled\/([a-f0-9]{32,64})\/pdf$/.exec(p);
    if (mPdf && req.method === 'GET') {
      return servePublicPdf(res, mPdf[1], u.query);
    }
    // JSON data náhledu
    const mData = /^\/api\/konstrukce\/nahled\/([a-f0-9]{32,64})$/.exec(p);
    if (mData && req.method === 'GET') {
      return apiPublicData(req, res, mData[1]);
    }
    // akce klienta
    const mAkce = /^\/api\/konstrukce\/nahled\/([a-f0-9]{32,64})\/akce$/.exec(p);
    if (mAkce && req.method === 'POST') {
      return apiPublicAction(req, res, mAkce[1]);
    }
    if (p.startsWith('/api/')) { json(res, 404, { chyba: 'Neplatný odkaz.' }); return true; }
    htmlOut(res, 404, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">Odkaz nenalezen nebo vypršel.</p>');
    return true;
  }

  function findByToken(d, token) {
    return d.zakazky.find(z => z.link && z.link.token === token);
  }
  function linkOk(z) {
    return z && z.link && z.link.active && (!z.link.expiresAt || z.link.expiresAt > Date.now());
  }
  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  }

  function apiPublicData(req, res, token) {
    const d = load();
    const z = findByToken(d, token);
    if (!linkOk(z)) { json(res, 410, { chyba: 'Odkaz vypršel nebo byl deaktivován.' }); return true; }
    // volitelný PIN
    const pin = (req.headers['x-nahled-pin'] || (urlLib.parse(req.url, true).query.pin) || '');
    if (z.link.pin && String(pin) !== z.link.pin) { json(res, 401, { chyba: 'Zadejte PIN.', needPin: true }); return true; }
    z.link.accesses.push({ at: Date.now(), ip: clientIp(req), action: 'view' });
    if (z.link.accesses.length > 300) z.link.accesses.splice(0, z.link.accesses.length - 300);
    save(d);
    const cur = CURRENT_V(z);
    json(res, 200, {
      cislo: z.cislo, zakaznik: z.zakaznik, typName: typeOf(d, z.typKey).name,
      version: cur ? cur.v : null, versionCount: z.versions.length,
      hasPdf: !!(cur && cur.pdf),
      pdfUrl: '/konstrukce/nahled/' + token + '/pdf' + (z.link.pin ? '?pin=' + encodeURIComponent(z.link.pin) : ''),
      decided: z.clientDecision ? { action: z.clientDecision.action, at: z.clientDecision.at, name: z.clientDecision.name } : null,
      history: z.versions.map(v => ({ v: v.v, at: v.createdAt })),
      // veřejné komentáře = jen komunikace s klientem (žádné interní ceny/marže)
      comments: (z.comments || []).filter(c => c.role === 'client' || c.publicToClient).map(c => ({ author: c.role === 'client' ? (c.authorName || 'Klient') : 'ELKOPLAST', text: c.text, at: c.at })),
    });
    return true;
  }

  function servePublicPdf(res, token, query) {
    const d = load();
    const z = findByToken(d, token);
    if (!linkOk(z)) { res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Odkaz vypršel.'); return true; }
    if (z.link.pin && String(query.pin || '') !== z.link.pin) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('PIN'); return true; }
    const cur = CURRENT_V(z);
    if (!cur || !cur.pdf) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bez PDF'); return true; }
    const f = safePath(cur.pdf.path);
    if (!f || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Soubor chybí'); return true; }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="nahled-' + z.cislo + '.pdf"' });
    res.end(fs.readFileSync(f));
    return true;
  }

  async function apiPublicAction(req, res, token) {
    const d = load();
    const z = findByToken(d, token);
    if (!linkOk(z)) { json(res, 410, { chyba: 'Odkaz vypršel nebo byl deaktivován.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    if (z.link.pin && String(b.pin || '') !== z.link.pin) { json(res, 401, { chyba: 'Neplatný PIN.' }); return true; }
    if (z.stav !== 'klient') { json(res, 409, { chyba: 'K této verzi už bylo rozhodnuto.' }); return true; }
    const action = String(b.action || '');
    const name = String(b.name || '').trim().slice(0, 120);
    const ip = clientIp(req);
    const cur = CURRENT_V(z);
    if (cur) cur.locked = true;

    if (action === 'schvalit') {
      if (!name || !b.souhlas) { json(res, 400, { chyba: 'Vyplňte jméno a potvrďte souhlas.' }); return true; }
      z.clientDecision = { action: 'schvalit', name, at: Date.now(), ip, version: cur ? cur.v : null };
      z.link.accesses.push({ at: Date.now(), ip, action: 'schválil: ' + name });
      z.stav = 'schvaleno'; z.deadline = null;
      z.link.active = false;
      audit(z, name + ' (klient)', 'Klient schválil', 'verze v' + (cur ? cur.v : '?') + ', IP ' + ip);
      notify(d, z.obchodnikEmail, 'Klient SCHVÁLIL výkres ' + z.cislo + '.', z.id);
      employeesWithRole('sef').forEach(em => notify(d, em, 'Klient schválil výkres ' + z.cislo + '.', z.id));
      if (z.assignedTo) notify(d, z.assignedTo, 'Klient schválil výkres ' + z.cislo + '.', z.id);
      save(d);
      mail(z.obchodnikEmail, 'Klient schválil výkres · ' + z.cislo, 'Klient ' + name + ' schválil výkres ' + z.cislo + ' (' + z.zakaznik + ') dne ' + fmtDateTime(Date.now()) + '.\nMůžete zakázku dokončit a předat do výroby.');
    } else if (action === 'zamitnout') {
      const duvod = String(b.duvod || '').trim().slice(0, 1500);
      if (!duvod) { json(res, 400, { chyba: 'Uveďte prosím důvod zamítnutí.' }); return true; }
      z.clientDecision = { action: 'zamitnout', name, at: Date.now(), ip, duvod };
      addComment(z, { email: '', name: name || 'Klient' }, 'client', 'ZAMÍTNUTO: ' + duvod);
      z.link.accesses.push({ at: Date.now(), ip, action: 'zamítl' });
      z.link.active = false;
      z.stav = 'zamitnuto'; z.deadline = null; z.closedAt = Date.now();
      audit(z, (name || 'klient') + ' (klient)', 'Klient zamítl', duvod + ' — IP ' + ip);
      notify(d, z.obchodnikEmail, 'Klient ZAMÍTL výkres ' + z.cislo + '. Řešte další postup.', z.id);
      save(d);
      mail(z.obchodnikEmail, 'Klient zamítl výkres · ' + z.cislo, 'Klient ' + (name || '') + ' zamítl výkres ' + z.cislo + '.\nDůvod: ' + duvod + '\n\nDomluvte se zákazníkem na dalším postupu.');
    } else if (action === 'pripominky') {
      const text = String(b.text || '').trim().slice(0, 3000);
      if (!text) { json(res, 400, { chyba: 'Napište prosím připomínky.' }); return true; }
      z.clientDecision = null;
      addComment(z, { email: '', name: name || 'Klient' }, 'client', 'Připomínky klienta: ' + text);
      z.link.accesses.push({ at: Date.now(), ip, action: 'připomínky' });
      // založíme revizi: nová verze, zpět na konstruktéra
      z.revisionCount = (z.revisionCount || 0) + 1;
      const nv = { v: (cur ? cur.v : 0) + 1, author: z.assignedTo || '', createdAt: Date.now(), locked: false };
      z.versions.push(nv);
      enterState(d, z, 'revize');
      z.link.active = false; // původní odkaz se uzavře; po revizi se pošle nový
      audit(z, (name || 'klient') + ' (klient)', 'Klient poslal připomínky', 'založena revize v' + nv.v + ' — IP ' + ip);
      notify(d, z.obchodnikEmail, 'Klient poslal PŘIPOMÍNKY k ' + z.cislo + ' — založena revize v' + nv.v + '.', z.id);
      if (z.assignedTo) notify(d, z.assignedTo, 'Revize v' + nv.v + ' u výkresu ' + z.cislo + ' — zapracujte připomínky klienta.', z.id);
      employeesWithRole('sef').forEach(em => notify(d, em, 'Revize u ' + z.cislo + ' (připomínky klienta).', z.id));
      save(d);
      mail(z.obchodnikEmail, 'Klient poslal připomínky · ' + z.cislo, 'Klient ' + (name || '') + ' poslal připomínky k výkresu ' + z.cislo + '.\n\n' + text + '\n\nByla založena revize v' + nv.v + '.');
    } else {
      json(res, 400, { chyba: 'Neznámá akce.' }); return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  // ======================================================================
  //  Soubory
  // ======================================================================
  const ALLOWED_EXT = { pdf: ['pdf'], cad: ['dwg', 'dxf', 'step', 'stp', 'igs', 'iges', 'sldprt', 'sldasm', 'ipt', 'iam', 'prt', 'x_t', 'catpart', 'zip', 'pdf'] };
  function saveFile(zakId, name, dataUrl, kind) {
    const safeName = String(name || 'soubor').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    const ext = (safeName.split('.').pop() || '').toLowerCase();
    if (!(ALLOWED_EXT[kind] || []).includes(ext)) return { chyba: 'Nepodporovaný typ souboru pro ' + (kind === 'pdf' ? 'PDF náhled (očekává se .pdf)' : 'CAD (dwg, dxf, step, ipt, sldprt, zip…)') + '.' };
    let m = /^data:([^;]*);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return { chyba: 'Neplatný obsah souboru.' };
    const buf = Buffer.from(m[2], 'base64');
    const max = kind === 'pdf' ? 20e6 : 60e6;
    if (buf.length > max) return { chyba: 'Soubor je příliš velký (max ' + Math.round(max / 1e6) + ' MB).' };
    const dir = path.join(FILES_DIR, zakId.replace(/[^a-z0-9]/gi, ''));
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const fn = kind + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext;
    const abs = path.join(dir, fn);
    fs.writeFileSync(abs, buf);
    return { name: safeName, path: path.relative(FILES_DIR, abs) };
  }
  function safePath(rel) {
    if (!rel) return null;
    const abs = path.join(FILES_DIR, rel);
    if (!abs.startsWith(FILES_DIR + path.sep)) return null;
    return abs;
  }
  function deleteFile(rel) { const f = safePath(rel); if (f) { try { fs.unlinkSync(f); } catch (_) {} } }
  function serveInternalFile(res, query) {
    const d = load();
    const z = d.zakazky.find(x => x.id === query.id);
    if (!z) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Nenalezeno'); return true; }
    const v = z.versions.find(x => String(x.v) === String(query.v)) || CURRENT_V(z);
    const kind = query.kind === 'cad' ? 'cad' : 'pdf';
    const meta = v && v[kind];
    if (!meta) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bez souboru'); return true; }
    const f = safePath(meta.path);
    if (!f || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Soubor chybí'); return true; }
    const ct = kind === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    const disp = (kind === 'pdf' && query.dl !== '1') ? 'inline' : 'attachment';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store', 'Content-Disposition': disp + '; filename="' + encodeURIComponent(meta.name) + '"' });
    res.end(fs.readFileSync(f));
    return true;
  }

  function lockDraft(z) { const dr = z.versions.find(v => !v.locked); if (dr) dr.locked = true; }
  function unlockDraft(z) { const dr = z.versions[z.versions.length - 1]; if (dr) dr.locked = false; }

  // ======================================================================
  //  Eskalace (tick) — termíny, semafory, připomínky klientovi (kap. 5)
  // ======================================================================
  async function tick() {
    const d = load();
    let changed = false;
    const now = Date.now();
    const overdueForDirector = [];
    const cfg = (d.settings && d.settings.notif) || DEFAULT_NOTIF;
    const warnFrac = Math.min(1, Math.max(0, (Number(cfg.warnPct) || 80) / 100));
    const remind1 = Number(cfg.clientRemind1) || 0, remind2 = Number(cfg.clientRemind2) || 0;
    for (const z of d.zakazky) {
      const st = STAV[z.stav];
      if (!st || st.terminal || st.hold || z.stav === 'schvaleno') continue;
      if (!z.esc) z.esc = { key: z.stav + ':' + z.versions.length };
      const stepKey = z.stav + ':' + z.versions.length;
      if (z.esc.key !== stepKey) z.esc = { key: stepKey };

      // --- klient nereaguje (5 / 10 pracovních dnů) ---
      if (z.stav === 'klient' && z.stepStartedAt) {
        const bdays = businessDaysBetween(z.stepStartedAt, now);
        if (remind1 > 0 && bdays >= remind1 && !z.esc.klient5) {
          z.esc.klient5 = true; changed = true;
          notify(d, z.obchodnikEmail, 'Klient nereaguje na náhled ' + z.cislo + ' ' + remind1 + ' prac. dnů — odeslána připomínka.', z.id);
          if (z.kontaktEmail && z.link && z.link.active) {
            const base = host.mailFrom && host.mailFrom.publicUrl ? host.mailFrom.publicUrl : '';
            mail(z.kontaktEmail, 'Připomenutí — výkres ke schválení · ' + z.cislo, 'Dobrý den,\n\ndovolujeme si připomenout výkres ke schválení k zakázce ' + z.cislo + '.\nOdkaz: ' + base + '/konstrukce/nahled/' + z.link.token + '\n\nDěkujeme.');
          }
        }
        if (remind2 > 0 && bdays >= remind2 && !z.esc.klient10) {
          z.esc.klient10 = true; changed = true;
          notify(d, z.obchodnikEmail, 'ÚKOL: Klient nereaguje ' + remind2 + ' prac. dnů na ' + z.cislo + ' — kontaktujte ho telefonicky.', z.id);
          mail(z.obchodnikEmail, 'Klient nereaguje ' + remind2 + ' dnů · ' + z.cislo, 'Klient nereaguje na náhled výkresu ' + z.cislo + ' už ' + remind2 + ' pracovních dnů. Kontaktujte ho prosím telefonicky.');
        }
        continue;
      }

      if (!z.deadline) continue;
      const resp = responsibleEmail(z);
      // --- blíží se termín (oranžová, app-notifikace odpovědné osobě) — okno od bodu 0 (zadání) ---
      const warnBase = z.stav === 'revize' ? z.stepStartedAt : (z.createdAt || z.stepStartedAt);
      if (warnBase && z.deadline > warnBase) {
        const frac = (now - warnBase) / (z.deadline - warnBase);
        if (frac >= warnFrac && now < z.deadline && !z.esc.warned80) {
          z.esc.warned80 = true; changed = true;
          if (resp) notify(d, resp, 'Blíží se termín kroku „' + st.label + '" u ' + z.cislo + ' (do ' + fmtDate(z.deadline) + ').', z.id);
        }
      }
      // --- překročení termínu (červená, e-mail odpovědné + obchodník + šéf) ---
      if (now > z.deadline) {
        if (!z.esc.overdue) {
          z.esc.overdue = true; z.esc.overdueDay = fmtDate(now); changed = true;
          const komu = new Set([resp, z.obchodnikEmail, ...employeesWithRole('sef')].filter(Boolean));
          komu.forEach(em => notify(d, em, 'PO TERMÍNU: krok „' + st.label + '" u ' + z.cislo + ' překročil termín.', z.id));
          if (cfg.overdueEmail !== false) {
            const text = 'Zakázka ' + z.cislo + ' (' + z.zakaznik + ') překročila termín kroku „' + st.label + '" (' + fmtDate(z.deadline) + ').\nOdpovědná osoba: ' + (empName(resp) || '—') + '.';
            komu.forEach(em => mail(em, 'Po termínu · ' + z.cislo, text));
          }
        }
        // --- D+1 a dále: denní souhrn řediteli ---
        overdueForDirector.push(z);
      }
    }

    // denní souhrn řediteli (jednou za den, jsou-li zpožděné zakázky ≥ 1 den)
    if (overdueForDirector.length && cfg.directorDigest !== false) {
      const readyForDigest = overdueForDirector.filter(z => z.esc && z.esc.overdueDay && z.esc.overdueDay !== fmtDate(now));
      const today = fmtDate(now);
      if (readyForDigest.length && d._lastDirectorDigest !== today) {
        d._lastDirectorDigest = today; changed = true;
        const lines = readyForDigest.map(z => '• ' + z.cislo + ' (' + z.zakaznik + ') — „' + STAV[z.stav].label + '", termín byl ' + fmtDate(z.deadline) + ', odpovídá ' + (empName(responsibleEmail(z)) || '—')).join('\n');
        const text = 'Přehled zpožděných zakázek konstrukce k ' + today + ':\n\n' + lines;
        employeesWithRole('reditel').forEach(em => { notify(d, em, readyForDigest.length + ' zpožděných zakázek konstrukce.', null); mail(em, 'Zpožděné zakázky konstrukce · ' + today, text); });
      }
    }

    // Report o stavu — denně nebo týdně (zvolený den), zap./vyp. + příjemci v SET-UP
    try {
      if (d.settings && d.settings.reportEnabled && (d.settings.reportRecipients || []).length) {
        const freq = d.settings.reportFreq === 'daily' ? 'daily' : 'weekly';
        const dow = new Date(now).getUTCDay();
        let due = false, subject = 'Týdenní přehled konstrukce';
        if (freq === 'daily') {
          const day = fmtDate(now);
          if (d.settings._lastReportDay !== day) { d.settings._lastReportDay = day; due = true; }
          subject = 'Denní přehled konstrukce';
        } else {
          const wk = isoWeekKey(now), wantDow = typeof d.settings.reportDow === 'number' ? d.settings.reportDow : 1;
          if (dow === wantDow && d.settings._lastReportWeek !== wk) { d.settings._lastReportWeek = wk; due = true; }
        }
        if (due) {
          changed = true;
          const text = buildWeeklyReport(d);
          for (const em of d.settings.reportRecipients) await mail(em, subject, text);
        }
      }
    } catch (_) {}

    if (changed) save(d);
  }

  // ======================================================================
  //  Pomocné formátovače + veřejná HTML stránka
  // ======================================================================
  function fmtDate(ts) { if (!ts) return '—'; const dt = new Date(ts); return String(dt.getUTCDate()).padStart(2, '0') + '.' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '.' + dt.getUTCFullYear(); }
  function fmtDateTime(ts) { const dt = new Date(ts); return fmtDate(ts) + ' ' + String(dt.getUTCHours()).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0'); }
  function addDaysCal(ts, days) { return ts + days * 24 * 3600 * 1000; }

  function publicPage() {
    return PUBLIC_HTML;
  }

  // ======================================================================
  //  Evidence práce (timesheet) — denní zápis hodin po činnostech (kap. 8)
  // ======================================================================
  function tsCanSeeAll(me) { return me.isAdmin || me.role === 'sef' || me.role === 'reditel'; }
  function activityLabel(d, key, fallback) { const a = d.activities.find(x => x.key === key); return a ? a.label : (fallback || key || ''); }
  function activityKind(d, key) { const a = d.activities.find(x => x.key === key); return a ? a.kind : 'rezie'; }

  function apiTimesheetGet(req, res, q) {
    const me = roleOf(req);
    const d = load();
    const all = tsCanSeeAll(me);
    let list = d.timesheet.slice();
    if (!all) list = list.filter(t => (t.user || '').toLowerCase() === me.email);
    else if (q.user) list = list.filter(t => (t.user || '').toLowerCase() === String(q.user).toLowerCase());
    if (q.from) list = list.filter(t => t.date >= q.from);
    if (q.to) list = list.filter(t => t.date <= q.to);
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
    // seznam osob s evidencí (pro filtr managementu)
    const users = {};
    d.timesheet.forEach(t => { const u = (t.user || '').toLowerCase(); if (u) users[u] = (users[u] || 0) + (t.hours || 0); });
    json(res, 200, {
      me: { email: me.email, role: me.role || (me.isAdmin ? 'admin' : ''), canSeeAll: all },
      activities: d.activities,
      entries: list.map(t => ({ id: t.id, user: t.user, userName: empName(t.user), date: t.date, activityKey: t.activityKey || '', activity: t.activity || activityLabel(d, t.activityKey), kind: t.kind || activityKind(d, t.activityKey), zakId: t.zakId || '', zakCislo: t.zakId ? ((d.zakazky.find(z => z.id === t.zakId) || {}).cislo || '') : '', zakazka: t.zakazka || '', hours: t.hours || 0, percent: t.percent == null ? null : t.percent, note: t.note || '' })),
      users: Object.keys(users).map(u => ({ email: u, name: empName(u), hours: Math.round(users[u] * 10) / 10 })).sort((a, b) => b.hours - a.hours),
      zakazky: d.zakazky.map(z => ({ id: z.id, cislo: z.cislo, zakaznik: z.zakaznik })),
    });
    return true;
  }
  async function apiTimesheetSave(req, res) {
    const me = roleOf(req);
    if (!me.email && !me.isAdmin) { json(res, 403, { chyba: 'Neznámý uživatel.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const date = String(b.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { chyba: 'Zadejte platné datum.' }); return true; }
    const hours = Math.round((parseFloat(String(b.hours).replace(',', '.')) || 0) * 100) / 100;
    if (!(hours > 0)) { json(res, 400, { chyba: 'Zadejte počet hodin.' }); return true; }
    const activityKey = String(b.activityKey || '').trim();
    if (!activityKey && !b.activity) { json(res, 400, { chyba: 'Vyberte druh práce.' }); return true; }
    // cílový uživatel: sám sebe; management může zapsat na jiného
    let user = me.email;
    if (tsCanSeeAll(me) && b.user) user = String(b.user).toLowerCase().trim();
    const rec = {
      id: b.id && String(b.id) || 't' + crypto.randomBytes(6).toString('hex'),
      user, date, activityKey,
      activity: activityKey ? activityLabel(d, activityKey) : String(b.activity || '').slice(0, 120),
      kind: activityKey ? activityKind(d, activityKey) : 'rezie',
      zakId: String(b.zakId || '').trim(),
      zakazka: String(b.zakazka || '').trim().slice(0, 80),
      hours, percent: (b.percent === '' || b.percent == null) ? null : Math.max(0, Math.min(100, parseInt(b.percent, 10) || 0)),
      note: String(b.note || '').slice(0, 300), createdAt: Date.now(),
    };
    // pokud je zapsáno na workflow zakázku, doplň její kód do zakazka
    if (rec.zakId) { const z = d.zakazky.find(x => x.id === rec.zakId); if (z && !rec.zakazka) rec.zakazka = z.cislo; }
    const i = d.timesheet.findIndex(t => t.id === rec.id);
    if (i >= 0) {
      if (!tsCanSeeAll(me) && (d.timesheet[i].user || '').toLowerCase() !== me.email) { json(res, 403, { chyba: 'Můžete upravovat jen své záznamy.' }); return true; }
      rec.createdAt = d.timesheet[i].createdAt || rec.createdAt;
      d.timesheet[i] = rec;
    } else d.timesheet.push(rec);
    save(d);
    json(res, 200, { ok: true, id: rec.id });
    return true;
  }
  async function apiTimesheetDelete(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const t = d.timesheet.find(x => x.id === b.id);
    if (!t) { json(res, 404, { chyba: 'Záznam nenalezen.' }); return true; }
    if (!tsCanSeeAll(me) && (t.user || '').toLowerCase() !== me.email) { json(res, 403, { chyba: 'Můžete mazat jen své záznamy.' }); return true; }
    d.timesheet = d.timesheet.filter(x => x.id !== b.id);
    save(d);
    json(res, 200, { ok: true });
    return true;
  }
  async function apiAdminActivity(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const key = String(b.key || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (!key) { json(res, 400, { chyba: 'Chybí klíč činnosti.' }); return true; }
    if (b.delete) { d.activities = d.activities.filter(x => x.key !== key); save(d); json(res, 200, { ok: true, activities: d.activities }); return true; }
    let a = d.activities.find(x => x.key === key);
    if (!a) { a = { key }; d.activities.push(a); }
    a.label = String(b.label || a.label || key).slice(0, 120);
    a.kind = b.kind === 'zakazka' ? 'zakazka' : 'rezie';
    save(d);
    json(res, 200, { ok: true, activities: d.activities });
    return true;
  }
  async function apiAdminStredisko(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const key = String(b.key || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (!key) { json(res, 400, { chyba: 'Chybí název střediska.' }); return true; }
    if (b.delete) { d.strediska = d.strediska.filter(x => x.key !== key); save(d); json(res, 200, { ok: true, strediska: d.strediska }); return true; }
    let s = d.strediska.find(x => x.key === key);
    if (!s) { s = { key, reditelEmail: '' }; d.strediska.push(s); }
    if (b.label != null) s.label = String(b.label || s.label || key).slice(0, 60);
    if (b.reditel !== undefined) s.reditelEmail = String(b.reditel || '').toLowerCase().trim();
    save(d);
    json(res, 200, { ok: true, strediska: d.strediska });
    return true;
  }
  async function apiAdminImport(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const user = String(b.user || '').toLowerCase().trim();
    if (!user) { json(res, 400, { chyba: 'Zadejte e-mail konstruktéra, na kterého se historie zapíše.' }); return true; }
    let raw = [];
    try { raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'timesheet-import.json'), 'utf8')); } catch (e) { json(res, 400, { chyba: 'Importní soubor nenalezen.' }); return true; }
    const d = load();
    // mapování popisu na klíč činnosti (dle normalizované shody na label + alias z tabulky)
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const byNorm = {}; d.activities.forEach(a => { byNorm[norm(a.label)] = a; });
    // přesné (i překlepové) názvy z původního deníku → klíč činnosti
    const ALIAS = {
      'Vytvoření/modifikace modelu a OB-výkresu': 'vyt-model', 'Chystání sady výkresů, Kusovník, DXF': 'chystani-sady',
      'Model Nula. Aktualizace': 'nula-aktualizace', 'Model Nula. Vytvoření/úprava': 'nula-vytvoreni', 'Model Nula. Kontrola sady podkladů': 'nula-kontrola',
      'Změny podlé přání': 'zmeny-prani', 'Změny/opimizace podlé otázek výroby': 'zmeny-vyroba', 'Návrh prototypů': 'navrh-prototyp',
      'Vytvoření návrhu řešení. Posílání obchodníků': 'navrh-reseni', 'Díly SD/SP. Vytváření/modifikace dílů': 'dily-sdsp',
      'Přidání zakázek podlé NULA modelů': 'pridani-nula', 'Vytvoření dodatečně dokumentaci na vyžádání': 'dokumentace',
      'TENDR project. Vytvoření modelů/prototypu, OB-výkres': 'tendr', 'Spolupráce / konzultaci konstruktera': 'konzultace-konstr',
      'Spolupráce / konzultaci obchodnika': 'konzultace-obch', 'Řízení práce - konstruktéry': 'rizeni-prace',
      'Porada výrobní střediska': 'porada-stredisko', 'Porada podlé skutečně úkoly': 'porada-ukoly',
      'Vyřizování objednávek, e-mailů, dotazů z dílny a telefonátů': 'administrativa', 'jiná / dodatečně práce': 'jina',
    };
    const aliasNorm = {}; Object.keys(ALIAS).forEach(k => { const a = d.activities.find(x => x.key === ALIAS[k]); if (a) aliasNorm[norm(k)] = a; });
    if (b.mode === 'replace') d.timesheet = d.timesheet.filter(t => (t.user || '').toLowerCase() !== user);
    let n = 0;
    raw.forEach(r => {
      const label = r.activity || '';
      const match = byNorm[norm(label)] || aliasNorm[norm(label)];
      d.timesheet.push({
        id: 't' + crypto.randomBytes(6).toString('hex'), user, date: r.date,
        activityKey: match ? match.key : '', activity: match ? match.label : label,
        kind: match ? match.kind : (r.zakazka ? 'zakazka' : 'rezie'),
        zakId: '', zakazka: String(r.zakazka || '').slice(0, 80),
        hours: Math.round((r.hours || 0) * 100) / 100, percent: r.percent == null ? null : r.percent,
        note: String(r.note || '').slice(0, 300), createdAt: Date.now(), imported: true,
      });
      n++;
    });
    save(d);
    json(res, 200, { ok: true, count: n });
    return true;
  }

  // ======================================================================
  //  Ukázková („slepá") data — správce si je nahraje a zase smaže z modulu
  // ======================================================================
  const DEMO_PDF = Buffer.from('JVBERi0xLjEKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCnRyYWlsZXI8PC9Sb290IDEgMCBSL1NpemUgND4+CnN0YXJ0eHJlZgowCiUlRU9G', 'base64');
  function demoFile(zId, kind, ext, content) {
    const dir = path.join(FILES_DIR, zId.replace(/[^a-z0-9]/gi, ''));
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const fn = kind + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(dir, fn), content);
    return path.relative(FILES_DIR, path.join(dir, fn));
  }
  function demoVer(zId, v, author, at, locked, withCad) {
    const ver = { v, pdf: { name: 'vykres-v' + v + '.pdf', path: demoFile(zId, 'pdf', 'pdf', DEMO_PDF), at }, author, createdAt: at, locked: !!locked };
    if (withCad) ver.cad = { name: 'vykres-v' + v + '.step', path: demoFile(zId, 'cad', 'step', Buffer.from('ISO-10303-21; demo')), at };
    return ver;
  }
  function demoClear() {
    try { if (fs.existsSync(FILES_DIR)) fs.rmSync(FILES_DIR, { recursive: true, force: true }); } catch (_) {}
    try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}
    save({ seq: 0, roles: {}, fond: {}, types: JSON.parse(JSON.stringify(SEED_TYPES)), zakazky: [], notif: [] });
  }
  function demoSeed(adminEmail) {
    demoClear();
    const now = Date.now(), DAY = 86400000, H = 3600000;
    const A = (at, by, action, note) => ({ at, by, action, note: note || '', from: '', to: '' });
    const zid = () => 'z' + crypto.randomBytes(7).toString('hex');
    const OBCH = 'anna.obchodni@elkoplast.cz', SEF = 'martin.sef@elkoplast.cz', PEPA = 'pepa.novak@elkoplast.cz', KAREL = 'karel.dvorak@elkoplast.cz', JANA = 'jana.mala@elkoplast.cz', RED = 'reditel@elkoplast.cz', SEFV = 'josef.vyroba@elkoplast.cz';
    const P = { 'Vnitřní délka': '6000 mm', 'Výška bočnic': '1400 mm', 'Objem': '20 m³', 'Materiál': 'S355; dno 5 mm, bočnice 3 mm', 'Zadní čelo': 'dvoukřídlá vrata' };
    const Z = [];
    const a = zid(); Z.push({ id: a, cislo: 'VYK-2026-0101', createdAt: now - 4 * H, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: { 'Vnitřní délka': '5500 mm', 'Materiál': 'S235' }, zakaznik: 'Kovošrot Zlín s.r.o.', kontakt: 'Ing. Petr Malý', kontaktEmail: 'maly@kovosrot-zlin.cz', cisloPoptavky: 'P-2026-101', pozadovanyTermin: null, stav: 'novy', assignedTo: '', versions: [], comments: [], timeEntries: [], activeTimer: null, link: null, revisionCount: 0, stepStartedAt: now - 4 * H, deadline: now + DAY, esc: { key: 'novy:0' }, audit: [A(now - 4 * H, OBCH, 'Založení požadavku', 'typ: ABROLL kontejner (standardní)')] });
    const b = zid(); Z.push({ id: b, cislo: 'VYK-2026-0102', createdAt: now - DAY, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: P, zakaznik: 'Metalšrot Ostrava a.s.', kontakt: 'Jana Nová', kontaktEmail: 'nova@metalsrot.cz', cisloPoptavky: 'P-2026-102', pozadovanyTermin: null, stav: 'prace', assignedTo: PEPA, versions: [demoVer(b, 1, PEPA, now - 3 * H, false, true)], comments: [], timeEntries: [{ user: PEPA, seconds: 2 * 3600, at: now - 2 * H, note: 'timer' }], activeTimer: null, link: null, revisionCount: 0, stepStartedAt: now - 6 * H, deadline: now + 3 * DAY, esc: { key: 'prace:1' }, audit: [A(now - DAY, OBCH, 'Založení požadavku'), A(now - 20 * H, SEF, 'Přidělení', 'konstruktér: ' + PEPA)] });
    const c = zid(); Z.push({ id: c, cislo: 'VYK-2026-0098', createdAt: now - 8 * DAY, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: { 'Vnitřní délka': '7000 mm', 'Nosnost': '26 t' }, zakaznik: 'Recyklace Bruntál s.r.o.', kontakt: 'Tomáš Velký', kontaktEmail: 'velky@rec-bruntal.cz', cisloPoptavky: 'P-2026-098', pozadovanyTermin: null, stav: 'prace', assignedTo: KAREL, versions: [demoVer(c, 1, KAREL, now - 2 * DAY, false, true)], comments: [], timeEntries: [{ user: KAREL, seconds: 5 * 3600, at: now - DAY, note: 'timer' }], activeTimer: null, link: null, revisionCount: 0, stepStartedAt: now - 6 * DAY, deadline: now - 2 * DAY, esc: { key: 'prace:1', warned80: true, overdue: true, overdueDay: '01.01.2000' }, audit: [A(now - 8 * DAY, OBCH, 'Založení požadavku'), A(now - 7 * DAY, SEF, 'Přidělení', 'konstruktér: ' + KAREL)] });
    const dd = zid(); Z.push({ id: dd, cislo: 'VYK-2026-0100', createdAt: now - 3 * DAY, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: P, zakaznik: 'EKO Chomutov a.s.', kontakt: 'Lucie Bílá', kontaktEmail: 'bila@eko-chomutov.cz', cisloPoptavky: 'P-2026-100', pozadovanyTermin: null, stav: 'kontrola', assignedTo: JANA, versions: [demoVer(dd, 1, JANA, now - 6 * H, false, true)], comments: [], timeEntries: [{ user: JANA, seconds: 7 * 3600, at: now - 8 * H, note: 'timer' }], activeTimer: null, link: null, revisionCount: 0, stepStartedAt: now - 20 * H, deadline: now + 8 * H, esc: { key: 'kontrola:1' }, audit: [A(now - 3 * DAY, OBCH, 'Založení požadavku'), A(now - 2 * DAY, SEF, 'Přidělení', 'konstruktér: ' + JANA), A(now - 6 * H, JANA, 'Zkreslení hotovo', 'verze v1')] });
    const e = zid(), tok = crypto.randomBytes(24).toString('hex'); Z.push({ id: e, cislo: 'VYK-2026-0099', createdAt: now - 4 * DAY, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: P, zakaznik: 'Sběrné suroviny Zlín', kontakt: 'Martin Holý', kontaktEmail: 'holy@sbernesuroviny.cz', cisloPoptavky: 'P-2026-099', pozadovanyTermin: null, stav: 'klient', assignedTo: PEPA, versions: [demoVer(e, 1, PEPA, now - 2 * DAY, true, true)], comments: [], timeEntries: [{ user: PEPA, seconds: 8 * 3600, at: now - 2 * DAY, note: 'timer' }], activeTimer: null, link: { token: tok, active: true, createdAt: now - DAY, expiresAt: now + 29 * DAY, pin: '', accesses: [{ at: now - 12 * H, ip: '89.24.10.5', action: 'view' }] }, revisionCount: 0, stepStartedAt: now - DAY, deadline: now + 4 * DAY, esc: { key: 'klient:1' }, audit: [A(now - 4 * DAY, OBCH, 'Založení požadavku'), A(now - 3 * DAY, SEF, 'Přidělení', 'konstruktér: ' + PEPA), A(now - 2 * DAY, PEPA, 'Zkreslení hotovo', 'verze v1'), A(now - 30 * H, SEF, 'Interní kontrola OK'), A(now - 26 * H, OBCH, 'Obchodník potvrdil výkres'), A(now - DAY, OBCH, 'Odesláno klientovi', 'odkaz platí 30 dnů')] });
    const f = zid(); Z.push({ id: f, cislo: 'VYK-2026-0095', createdAt: now - 7 * DAY, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: P, zakaznik: 'Demont Group s.r.o.', kontakt: 'Eva Krátká', kontaktEmail: 'kratka@demont.cz', cisloPoptavky: 'P-2026-095', pozadovanyTermin: null, stav: 'revize', assignedTo: KAREL, versions: [demoVer(f, 1, KAREL, now - 4 * DAY, true, true), { v: 2, author: KAREL, createdAt: now - 12 * H, locked: false }], comments: [{ id: 'c' + crypto.randomBytes(5).toString('hex'), author: '', authorName: 'Martin Holý', role: 'client', text: 'Připomínky klienta: Prosím přidat žebřík a zvětšit výšku bočnic na 1600 mm.', at: now - 14 * H, versionRef: 1 }], timeEntries: [{ user: KAREL, seconds: 9 * 3600, at: now - 3 * DAY, note: 'timer' }], activeTimer: null, link: null, revisionCount: 1, stepStartedAt: now - 12 * H, deadline: now + 2 * DAY, esc: { key: 'revize:2' }, audit: [A(now - 7 * DAY, OBCH, 'Založení požadavku'), A(now - 6 * DAY, SEF, 'Přidělení', 'konstruktér: ' + KAREL), A(now - 4 * DAY, KAREL, 'Zkreslení hotovo', 'verze v1'), A(now - 3 * DAY, OBCH, 'Odesláno klientovi'), A(now - 14 * H, 'Martin Holý (klient)', 'Klient poslal připomínky', 'založena revize v2 — IP 89.24.10.5')] });
    const g = zid(); Z.push({ id: g, cislo: 'VYK-2026-0090', createdAt: now - 14 * DAY, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: P, zakaznik: 'Železárny Veselí a.s.', kontakt: 'Pavel Silný', kontaktEmail: 'silny@zelezarny.cz', cisloPoptavky: 'P-2026-090', pozadovanyTermin: null, stav: 'dokonceno', assignedTo: JANA, versions: [demoVer(g, 1, JANA, now - 11 * DAY, true, true)], comments: [], timeEntries: [{ user: JANA, seconds: 8 * 3600, at: now - 11 * DAY, note: 'timer' }], activeTimer: null, link: { token: crypto.randomBytes(24).toString('hex'), active: false, createdAt: now - 10 * DAY, expiresAt: now + 20 * DAY, pin: '', accesses: [] }, revisionCount: 0, closedAt: now - 8 * DAY, stepStartedAt: now - 8 * DAY, deadline: null, esc: { key: 'dokonceno:1' }, clientDecision: { action: 'schvalit', name: 'Pavel Silný', at: now - 9 * DAY, ip: '81.2.3.4', version: 1 }, audit: [A(now - 14 * DAY, OBCH, 'Založení požadavku'), A(now - 13 * DAY, SEF, 'Přidělení', 'konstruktér: ' + JANA), A(now - 11 * DAY, JANA, 'Zkreslení hotovo', 'verze v1'), A(now - 10 * DAY, SEF, 'Interní kontrola OK'), A(now - 10 * DAY, OBCH, 'Odesláno klientovi'), A(now - 9 * DAY, 'Pavel Silný (klient)', 'Klient schválil', 'verze v1, IP 81.2.3.4'), A(now - 8 * DAY, SEF, 'Dokončeno')] });
    // h) Předáno do výroby — čeká na přidělení střediska (šéf výroby na tahu)
    const hh = zid(); Z.push({ id: hh, cislo: 'VYK-2026-0093', createdAt: now - 10 * DAY, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: P, zakaznik: 'Technické služby Přerov', kontakt: 'Ivo Krátký', kontaktEmail: 'kratky@ts-prerov.cz', cisloPoptavky: 'P-2026-093', pozadovanyTermin: null, stav: 'vyroba', assignedTo: PEPA, versions: [demoVer(hh, 1, PEPA, now - 6 * DAY, true, true)], comments: [], timeEntries: [{ user: PEPA, seconds: 8 * 3600, at: now - 6 * DAY, note: 'timer' }], activeTimer: null, link: { token: crypto.randomBytes(24).toString('hex'), active: false, createdAt: now - 5 * DAY, expiresAt: now + 25 * DAY, pin: '', accesses: [] }, revisionCount: 0, strediskoKey: '', strediskoName: '', stepStartedAt: now - 6 * H, deadline: now + 18 * H, esc: { key: 'vyroba:1' }, clientDecision: { action: 'schvalit', name: 'Ivo Krátký', at: now - DAY, ip: '81.2.3.9', version: 1 }, audit: [A(now - 10 * DAY, OBCH, 'Založení požadavku'), A(now - 9 * DAY, SEF, 'Přidělení', 'konstruktér: ' + PEPA), A(now - 6 * DAY, PEPA, 'Zkreslení hotovo', 'verze v1'), A(now - 5 * DAY, SEF, 'Interní kontrola OK'), A(now - 4 * DAY, OBCH, 'Odesláno klientovi'), A(now - DAY, 'Ivo Krátký (klient)', 'Klient schválil', 'verze v1'), A(now - 6 * H, OBCH, 'Předáno do výroby')] });
    // i) Ve výrobním středisku (Supíkovice)
    const ii = zid(); Z.push({ id: ii, cislo: 'VYK-2026-0088', createdAt: now - 16 * DAY, createdBy: OBCH, obchodnikEmail: OBCH, typKey: 'dsd', params: P, zakaznik: 'AVE CZ odpadové hospodářství', kontakt: 'Petra Zelená', kontaktEmail: 'zelena@ave.cz', cisloPoptavky: 'P-2026-088', pozadovanyTermin: null, stav: 'stredisko', assignedTo: JANA, versions: [demoVer(ii, 1, JANA, now - 12 * DAY, true, true)], comments: [], timeEntries: [{ user: JANA, seconds: 8 * 3600, at: now - 12 * DAY, note: 'timer' }], activeTimer: null, link: { token: crypto.randomBytes(24).toString('hex'), active: false, createdAt: now - 11 * DAY, expiresAt: now + 19 * DAY, pin: '', accesses: [] }, revisionCount: 0, strediskoKey: 'supikovice', strediskoName: 'Supíkovice', stepStartedAt: now - 2 * DAY, deadline: null, esc: { key: 'stredisko:1' }, clientDecision: { action: 'schvalit', name: 'Petra Zelená', at: now - 3 * DAY, ip: '81.2.3.11', version: 1 }, audit: [A(now - 16 * DAY, OBCH, 'Založení požadavku'), A(now - 15 * DAY, SEF, 'Přidělení', 'konstruktér: ' + JANA), A(now - 12 * DAY, JANA, 'Zkreslení hotovo', 'verze v1'), A(now - 11 * DAY, SEF, 'Interní kontrola OK'), A(now - 10 * DAY, OBCH, 'Odesláno klientovi'), A(now - 3 * DAY, 'Petra Zelená (klient)', 'Klient schválil', 'verze v1'), A(now - 2 * DAY, OBCH, 'Předáno do výroby'), A(now - 2 * DAY, SEFV, 'Přiděleno výrobní středisko', 'Supíkovice')] });
    const nm = adminEmail || '';
    const notif = [
      { id: 'n' + crypto.randomBytes(5).toString('hex'), email: nm, text: 'PO TERMÍNU: krok „Zkreslení" u VYK-2026-0098 překročil termín.', zakId: c, at: now - 2 * H, read: false },
      { id: 'n' + crypto.randomBytes(5).toString('hex'), email: nm, text: 'Výkres VYK-2026-0093 je schválen a předán do výroby — přidělte středisko.', zakId: hh, at: now - 6 * H, read: false },
      { id: 'n' + crypto.randomBytes(5).toString('hex'), email: nm, text: 'Klient poslal PŘIPOMÍNKY k VYK-2026-0095 — založena revize v2.', zakId: f, at: now - 14 * H, read: true },
    ];
    const strediska = [
      { key: 'supikovice', label: 'Supíkovice', reditelEmail: SEFV },
      { key: 'bruntal', label: 'Bruntál', reditelEmail: '' },
      { key: 'bruntal-popelnice', label: 'Bruntál popelnice', reditelEmail: '' },
      { key: 'chomutov', label: 'Chomutov', reditelEmail: '' },
      { key: 'polsko', label: 'Polsko', reditelEmail: '' },
    ];
    save({ seq: 101, roles: { [OBCH]: 'obchodnik', [SEF]: 'sef', [PEPA]: 'konstrukter', [KAREL]: 'konstrukter', [JANA]: 'konstrukter', [RED]: 'reditel' }, fond: { [PEPA]: 40, [KAREL]: 32, [JANA]: 40 }, types: JSON.parse(JSON.stringify(SEED_TYPES)), strediska, zakazky: Z, notif });
    return Z.length;
  }
  async function apiAdminSeed(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    if (b.mode === 'clear') { demoClear(); json(res, 200, { ok: true, cleared: true }); return true; }
    const me = roleOf(req);
    const n = demoSeed(me.email);
    json(res, 200, { ok: true, count: n });
    return true;
  }

  async function apiAdminSettings(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen spravce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load(); d.settings = d.settings || {};
    if (b.phaseDays && typeof b.phaseDays === 'object') { d.settings.phaseDays = d.settings.phaseDays || {}; ['obchod', 'konstrukce', 'schvaleni', 'vyroba'].forEach(k => { if (b.phaseDays[k] != null) d.settings.phaseDays[k] = Math.max(0, Number(b.phaseDays[k]) || 0); }); }
    if (typeof b.reportEnabled === 'boolean') d.settings.reportEnabled = b.reportEnabled;
    if (Array.isArray(b.reportRecipients)) d.settings.reportRecipients = b.reportRecipients.map(e => String(e).trim().toLowerCase()).filter(Boolean);
    if (b.reportFreq === 'daily' || b.reportFreq === 'weekly') d.settings.reportFreq = b.reportFreq;
    if (b.reportDow != null) { const dw = parseInt(b.reportDow, 10); if (!isNaN(dw) && dw >= 0 && dw <= 6) d.settings.reportDow = dw; }
    if (b.notif && typeof b.notif === 'object') {
      d.settings.notif = d.settings.notif || {};
      const n = d.settings.notif;
      if (b.notif.warnPct != null) n.warnPct = Math.min(100, Math.max(1, parseInt(b.notif.warnPct, 10) || 80));
      if (b.notif.clientRemind1 != null) n.clientRemind1 = Math.max(0, parseInt(b.notif.clientRemind1, 10) || 0);
      if (b.notif.clientRemind2 != null) n.clientRemind2 = Math.max(0, parseInt(b.notif.clientRemind2, 10) || 0);
      if (typeof b.notif.overdueEmail === 'boolean') n.overdueEmail = b.notif.overdueEmail;
      if (typeof b.notif.directorDigest === 'boolean') n.directorDigest = b.notif.directorDigest;
      WARN_FRAC = Math.min(1, Math.max(0, (Number(n.warnPct) || 80) / 100));
    }
    save(d); json(res, 200, { ok: true, settings: d.settings }); return true;
  }
  async function apiReport(req, res, send) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen spravce.' }); return true; }
    const d = load(); const text = buildWeeklyReport(d);
    if (send) { const rec = (d.settings && d.settings.reportRecipients) || []; for (const em of rec) await mail(em, 'Týdenní přehled konstrukce', text); json(res, 200, { ok: true, sent: rec.length, recipients: rec, text }); return true; }
    json(res, 200, { ok: true, text }); return true;
  }
  return { handle, tick };
}

// Veřejná stránka náhledu (samostatná, bez závislostí na intranetu).
const PUBLIC_HTML = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Výkres ke schválení · ELKOPLAST</title>
<style>
:root{--g:#0e8a43;--g2:#0a6b34;--g3:#12a350;--ink:#0f1512;--mut:#5b635c;--line:#e3e7e0;--bg:#eef1ec;--red:#c23636;--amber:#b06f00}
*{box-sizing:border-box}
body{margin:0;font-family:Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg)}
.top{background:#fff;border-bottom:1px solid var(--line);padding:12px 18px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:5}
.top .brand{font-weight:800;color:var(--g2);letter-spacing:.5px}
.wrap{max-width:1000px;margin:0 auto;padding:18px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
h1{font-size:19px;margin:0 0 4px}
.muted{color:var(--mut);font-size:14px}
.meta{display:flex;flex-wrap:wrap;gap:6px 20px;margin-top:8px;font-size:14px}
.meta b{color:var(--mut);font-weight:600}
.pdfbox{position:relative;background:#333;border-radius:12px;overflow:hidden;min-height:60vh}
.pdfbox iframe{width:100%;height:78vh;border:0;display:block;background:#525659}
.wm{position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:center;overflow:hidden}
.wm span{color:rgba(255,255,255,.16);font-size:12vw;font-weight:800;transform:rotate(-30deg);white-space:nowrap;letter-spacing:.1em}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
button{font:inherit;border:0;border-radius:10px;padding:12px 18px;cursor:pointer;font-weight:600}
.ok{background:var(--g);color:#fff}.ok:hover{background:var(--g2)}
.rej{background:#fff;color:var(--red);border:1px solid var(--red)}
.note{background:#fff;color:#33513f;border:1px solid var(--line)}
.ghost{background:#eef1ec;color:#33513f}
textarea,input{width:100%;font:inherit;border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:6px}
label{display:block;font-size:14px;font-weight:600;margin-top:10px}
.done{padding:18px;border-radius:12px;text-align:center}
.done.ok{background:#e6f6ec;color:var(--g2);border:1px solid #bfe6cd}
.done.rej{background:#fdecea;color:var(--red);border:1px solid #f5c6cb}
.hide{display:none}
.chk{display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:14px}
.chk input{width:auto;margin-top:3px}
.err{color:var(--red);font-size:14px;margin-top:8px}
.foot{text-align:center;color:var(--mut);font-size:12px;padding:14px}
</style></head><body>
<div class="top"><span class="brand">ELKOPLAST</span><span class="muted">Náhled výkresu ke schválení</span></div>
<div class="wrap" id="root"><div class="card"><p class="muted">Načítám…</p></div></div>
<div class="foot">Zabezpečený náhled · dokument slouží jen ke schválení, nešiřte prosím odkaz dál.</div>
<script>
var TOKEN=location.pathname.split('/').filter(Boolean).pop();
var PIN='';
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function fdt(ts){if(!ts)return'';var d=new Date(ts);function p(n){return(n<10?'0':'')+n}return p(d.getDate())+'.'+p(d.getMonth()+1)+'.'+d.getFullYear()+' '+p(d.getHours())+':'+p(d.getMinutes())}
function api(){return fetch('/api/konstrukce/nahled/'+TOKEN+(PIN?('?pin='+encodeURIComponent(PIN)):''),{cache:'no-store'}).then(function(r){return r.json().then(function(j){return{status:r.status,j:j}})})}
function root(){return document.getElementById('root')}
function load(){
  api().then(function(o){
    if(o.status===401&&o.j.needPin){return pinPrompt()}
    if(o.status!==200){root().innerHTML='<div class="card"><p class="muted">'+esc(o.j.chyba||'Odkaz není platný.')+'</p></div>';return}
    render(o.j)
  }).catch(function(){root().innerHTML='<div class="card"><p class="muted">Nepodařilo se načíst náhled.</p></div>'})
}
function pinPrompt(){
  root().innerHTML='<div class="card"><h1>Zadejte PIN</h1><p class="muted">Tento náhled je chráněn PINem, který jste dostali zvlášť.</p>'+
   '<input id="pin" inputmode="numeric" placeholder="PIN"><div class="btns"><button class="ok" onclick="submitPin()">Pokračovat</button></div><div class="err" id="pe"></div></div>';
}
function submitPin(){PIN=document.getElementById('pin').value.trim();load()}
function render(j){
  var d=j.decided;
  var pdf=j.hasPdf?'<div class="pdfbox"><iframe src="'+esc(j.pdfUrl)+'#toolbar=1&navpanes=0"></iframe><div class="wm"><span>NÁHLED · '+esc(j.zakaznik||'')+'</span></div></div>':'<p class="muted">PDF výkresu není k dispozici.</p>';
  var head='<div class="card"><h1>Výkres '+esc(j.cislo)+'</h1><div class="muted">'+esc(j.typName||'')+'</div>'+
    '<div class="meta"><span><b>Zákazník:</b> '+esc(j.zakaznik)+'</span><span><b>Verze:</b> v'+esc(j.version||'—')+'</span></div></div>';
  var pdfCard='<div class="card">'+pdf+'</div>';
  var actions='';
  if(d){
    if(d.action==='schvalit')actions='<div class="done ok"><b>Výkres byl schválen.</b><br>'+esc(d.name||'')+' · '+fdt(d.at)+'</div>';
    else actions='<div class="done rej"><b>Výkres byl zamítnut.</b><br>'+fdt(d.at)+'</div>';
    actions='<div class="card">'+actions+'</div>';
  }else{
    actions='<div class="card"><p class="muted" style="margin-top:0">Prohlédněte si výkres a zvolte, jak chcete pokračovat:</p>'+
      '<div class="btns">'+
      '<button class="ok" onclick="show(\\'ok\\')">✓ Schválit</button>'+
      '<button class="note" onclick="show(\\'note\\')">✎ Poslat připomínky</button>'+
      '<button class="rej" onclick="show(\\'rej\\')">✕ Zamítnout</button>'+
      '</div>'+
      '<div id="form"></div><div class="err" id="err"></div></div>';
  }
  var comm='';
  if(j.comments&&j.comments.length){
    comm='<div class="card"><b>Komunikace</b>'+j.comments.map(function(c){return '<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><div class="muted">'+esc(c.author)+' · '+fdt(c.at)+'</div><div>'+esc(c.text)+'</div></div>'}).join('')+'</div>';
  }
  root().innerHTML=head+pdfCard+actions+comm;
}
function show(kind){
  var f=document.getElementById('form');if(!f)return;
  if(kind==='ok')f.innerHTML='<label>Vaše jméno<input id="nm" placeholder="Jméno a příjmení"></label>'+
    '<div class="chk"><input type="checkbox" id="sh"><span>Potvrzuji, že výkres odpovídá objednávce a schvaluji jej k výrobě.</span></div>'+
    '<div class="btns"><button class="ok" onclick="send(\\'schvalit\\')">Schválit výkres</button></div>';
  else if(kind==='note')f.innerHTML='<label>Vaše jméno<input id="nm" placeholder="Jméno a příjmení"></label>'+
    '<label>Připomínky k výkresu<textarea id="tx" rows="4" placeholder="Popište, co je třeba upravit…"></textarea></label>'+
    '<div class="btns"><button class="note" onclick="send(\\'pripominky\\')">Odeslat připomínky</button></div>';
  else f.innerHTML='<label>Vaše jméno<input id="nm" placeholder="Jméno a příjmení"></label>'+
    '<label>Důvod zamítnutí<textarea id="dv" rows="3" placeholder="Uveďte prosím důvod…"></textarea></label>'+
    '<div class="btns"><button class="rej" onclick="send(\\'zamitnout\\')">Zamítnout výkres</button></div>';
}
function send(action){
  var b={action:action,pin:PIN,name:(document.getElementById('nm')||{}).value||''};
  if(action==='schvalit')b.souhlas=(document.getElementById('sh')||{}).checked;
  if(action==='pripominky')b.text=(document.getElementById('tx')||{}).value||'';
  if(action==='zamitnout')b.duvod=(document.getElementById('dv')||{}).value||'';
  document.getElementById('err').textContent='';
  fetch('/api/konstrukce/nahled/'+TOKEN+'/akce',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
   .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
   .then(function(o){if(!o.ok){document.getElementById('err').textContent=o.j.chyba||'Nepodařilo se odeslat.';return}load();window.scrollTo(0,0)})
   .catch(function(){document.getElementById('err').textContent='Nepodařilo se odeslat.'})
}
load();
</script></body></html>`;

module.exports = { mount };

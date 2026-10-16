'use strict';
// ============================================================================
//  Modul „Vozový park" — evidence svěřených vozidel
// ============================================================================
//  Co modul hlídá (dle zadání):
//   1) u každého vozidla je přidělen SPRÁVCE VOZU (jeden člověk může mít víc vozů)
//   2) u vozidla se eviduje VIN a rok výroby; jednou za rok se opíše stav tachometru
//      (nájezd za rok = rozdíl proti loňskému zápisu, zpětně se nic nedoplňuje)
//   3) za STŘEDISKO zodpovídá konkrétní člověk (ředitel dopravy / výroby / střediska);
//      systém upozorňuje na blížící se konec technické prohlídky a provedení se odškrtne
//   4) sleduje se nájezd a z něj se odvozuje nejvhodnější období prodeje
//   5) k vozu patří fotografie a jednou za dva roky inventarizace svěřeného majetku
//
//  Mount v server.js:
//    const vozidla = require('./vozidla').mount({
//      send, readBody, deliver, empSession, isAdmin, baseUrl,
//      employeeModules, getState, logActivity, dataDir, mailFrom
//    });
//    if (vozidla && await vozidla.handle(req, res)) return;
//    vozidla.tick()  — jednou za hodinu (rozesílky upozornění)
//    vozidla.notifikace(email) — dlaždice na nástěnku intranetu
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');
const oceneni = require('./oceneni');
const trh = require('./trh');          // porovnání s inzercí (Sauto.cz)

const HTML_FILE = path.join(__dirname, 'vozidla.html');
const ODKUP_FILE = path.join(__dirname, 'odkup.html');
const SMERNICE_FILE = path.join(__dirname, 'smernice-sverene-vozidlo.html');
// Prvotní naplnění evidence: soubor se NEDÁVÁ do repa (je veřejné) — nahraje se na datový
// disk jako data/vozidla-import.json a modul ho při startu jednorázově naimportuje.

// Role člověka zodpovědného za středisko — dle zadání.
const ROLE = {
  'reditel-spolecnosti': 'Ředitel společnosti',
  'reditel': 'Ředitel',
  'reditel-dopravy': 'Ředitel dopravy',
  'reditel-vyroby': 'Ředitel výroby',
  'reditel-strediska': 'Ředitel střediska',
  'vedouci': 'Vedoucí',
};
const STAVY = { aktivni: 'V provozu', odstaveno: 'Odstaveno', prodano: 'Prodáno', vyrazeno: 'Vyřazeno' };
const TYPY = { osobni: 'Osobní', uzitkove: 'Užitkové', nakladni: 'Nákladní', tahac: 'Tahač', privees: 'Přívěs / návěs', stroj: 'Stroj' };

// Orientační pořizovací cena podle typu vozidla (Kč, nové). Slouží jen jako výchozí odhad pro ocenění,
// dokud u konkrétního vozu nikdo nezadá skutečnou pořizovací cenu; mění se v Nastavení.
const CENY_TYPU = { osobni: 700000, uzitkove: 950000, nakladni: 2600000, tahac: 3200000, privees: 450000, stroj: 1800000 };

// Lhůta technické prohlídky podle typu vozidla (roky) — orientační, admin ji může přepsat u vozu.
const STK_LHUTA = { osobni: 2, uzitkove: 2, nakladni: 1, tahac: 1, privees: 1, stroj: 2 };

// Štítek, kterým se cílí rozeslání směrnice. Drží ho modul podle skutečného stavu:
// má ho každý, komu je svěřené vozidlo, a každý vedoucí zodpovědný za středisko.
const TAG_SMERNICE = 'Svěřené vozidlo';

const DEN = 86400000;
const MAX_FOTO = 6e6;        // 6 MB na fotku (klient zmenšuje před odesláním)
const MAX_FOTEK = 12;
const MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'vozidla.json');
  const SEED_FILE = path.join(host.dataDir || __dirname, 'vozidla-import.json');
  const FILES_DIR = path.join(host.dataDir || __dirname, 'vozidla-files');
  try { if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const low = s => String(s || '').trim().toLowerCase();

  // ---- perzistence ---------------------------------------------------------
  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); } catch (_) {}
    if (!d || typeof d !== 'object') d = {};
    if (!Array.isArray(d.vozidla)) d.vozidla = [];
    if (!Array.isArray(d.zodpovedne)) d.zodpovedne = [];
    if (!d.nastaveni || typeof d.nastaveni !== 'object') d.nastaveni = {};
    const n = d.nastaveni;
    if (typeof n.prahKm !== 'number') n.prahKm = 250000;          // kdy vůz „dojel" svoje
    if (typeof n.prahRoky !== 'number') n.prahRoky = 8;
    if (typeof n.inventuraMesice !== 'number') n.inventuraMesice = 24;   // inventarizace 1× za 2 roky
    if (!Array.isArray(n.upozorneniDny)) n.upozorneniDny = [60, 30, 14, 7, 1];
    if (!Array.isArray(n.kopieNa)) n.kopieNa = [];               // komu chodí kopie všech upozornění
    if (typeof n.reditelEmail !== 'string') n.reditelEmail = '';  // ředitel společnosti — hlásí se mu každá škoda
    if (typeof n.reditelJmeno !== 'string') n.reditelJmeno = '';
    // ocenění a odkup: očekávaný roční nájezd (korekce tržní ceny), rezerva pro rychlý prodej,
    // délka účetního odpisu a kam hlásit nové nabídky odkupu (kromě zodpovědné osoby za středisko)
    if (typeof n.rocniKm !== 'number') n.rocniKm = 25000;
    if (typeof n.rezervaProdej !== 'number') n.rezervaProdej = 8;
    if (typeof n.odpisLet !== 'number') n.odpisLet = 5;
    if (typeof n.odkupEmail !== 'string') n.odkupEmail = '';
    // Orientační pořizovací ceny podle typu vozidla — použijí se, dokud u vozu není zadaná skutečná.
    // Bez nich je tabulka ocenění prázdná a není co srovnávat.
    // porovnání s inzercí: zapnuto, obnova jednou za týden
    if (typeof n.trhZapnuto !== 'boolean') n.trhZapnuto = true;
    if (typeof n.trhObnovaDni !== 'number') n.trhObnovaDni = 7;
    if (!n.cenyTypu || typeof n.cenyTypu !== 'object') n.cenyTypu = {};
    Object.keys(CENY_TYPU).forEach((k) => { if (typeof n.cenyTypu[k] !== 'number') n.cenyTypu[k] = CENY_TYPU[k]; });
    if (!Array.isArray(d.odkup)) d.odkup = [];                         // nabídky zaměstnanců na odkup vozu
    if (!d.odeslano || typeof d.odeslano !== 'object') d.odeslano = {};  // klíč → timestamp (ať se nespamuje)
    if (typeof n.upominkyOd !== 'string') n.upominkyOd = '';      // odklad upomínek po hromadném importu
    if (!d.seedImport && !d.vozidla.length) { if (importSeed(d)) save(d); }
    return d;
  }
  function save(d) { fs.writeFileSync(DATA_F, JSON.stringify(d, null, 2)); }

  // ---- lidé ----------------------------------------------------------------
  function zamestnanci() {
    let s = null;
    try { s = host.getState ? host.getState() : null; } catch (_) {}
    const emps = (s && Array.isArray(s.employees)) ? s.employees : [];
    return emps.filter(e => e && e.email).map(e => ({
      email: low(e.email), name: e.name || e.email,
      pozice: e.pozice || '', stredisko: e.stredisko || '',
      telefon: String(e.telefon || '').trim(), osCislo: String(e.osCislo || '').trim(),
    }));
  }
  function jmenoPodleMailu(email) {
    const e = zamestnanci().find(x => x.email === low(email));
    return e ? e.name : '';
  }
  // Kontakt se NIKDY neukládá k vozidlu — bere se živě z databáze zaměstnanců,
  // takže změna telefonu v Organizaci se hned projeví i tady.
  function kontakt(email) {
    if (!email) return null;
    const e = zamestnanci().find(x => x.email === low(email));
    return e ? { email: e.email, jmeno: e.name, telefon: e.telefon, pozice: e.pozice, stredisko: e.stredisko } : { email: low(email), jmeno: '', telefon: '', pozice: '', stredisko: '' };
  }

  // ---- párování osoby z firemní tabulky na zaměstnance -----------------------
  //  V tabulce stojí „002119 Vasiliadis Lazaros PhD." nebo „Krajčová Barbora".
  //  Nejspolehlivější je osobní číslo, jinak zkusíme jméno bez diakritiky a titulů.
  function bezDiakritiky(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  const TITULY = /\b(bc|ing|mgr|mudr|phdr|judr|dis|phd|ph|msc|mba|rndr|doc|prof)\b/g;
  function slovaJmena(jm) {
    const t = bezDiakritiky(jm).replace(/[^a-z ]/g, ' ').replace(TITULY, ' ');
    return t.split(/\s+/).filter(w => w.length > 1).sort();
  }
  function najdiZamestnance(osoba) {
    const txt = String(osoba || '').trim(); if (!txt) return null;
    const zam = zamestnanci();
    const m = /^(\d{4,6})\s+(.*)$/.exec(txt);
    const cislo = m ? m[1].replace(/^0+/, '') : '';
    const jmeno = m ? m[2] : txt;
    if (cislo) {
      const p = zam.find(e => e.osCislo && e.osCislo.replace(/^0+/, '') === cislo);
      if (p) return { emp: p, jak: 'osobní číslo' };
    }
    const s2 = slovaJmena(jmeno).join(' ');
    if (!s2) return null;
    const presne = zam.filter(e => slovaJmena(e.name).join(' ') === s2);
    if (presne.length === 1) return { emp: presne[0], jak: 'jméno' };
    // částečná shoda (v tabulce bývá jméno navíc: „Šmídová Rabie Suzan" × „Šmídová Suzan")
    const a = new Set(s2.split(' '));
    const cast = zam.filter(e => {
      const b = new Set(slovaJmena(e.name));
      if (!b.size) return false;
      const prunik = [...b].filter(w => a.has(w)).length;
      return prunik >= 2 && (prunik === b.size || prunik === a.size);
    });
    if (cast.length === 1) return { emp: cast[0], jak: 'jméno (částečná shoda)' };
    return null;
  }

  // ---- jednorázový import evidence z firemní tabulky --------------------------
  const TYP_Z_TABULKY = { 'osobní vozidlo': 'osobni', 'nákladní vozidlo': 'nakladni', 'užitkové vozidlo': 'uzitkove', 'přívěs': 'privees', 'návěs': 'privees', 'tahač': 'tahac' };
  function importSeed(d) {
    if (d.seedImport || d.vozidla.length) return null;
    let seed = [];
    try { seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); } catch (_) { return null; }
    if (!Array.isArray(seed) || !seed.length) return null;
    let sparovano = 0;
    seed.forEach(r => {
      const nalez = najdiZamestnance(r.osoba);
      const popis = String(r.popis || '').trim();
      const mezera = popis.indexOf(' ');
      const v = {
        id: 'v' + crypto.randomBytes(5).toString('hex'),
        vznik: Date.now(),
        spz: String(r.spz || '').trim().toUpperCase(),
        znacka: mezera > 0 ? popis.slice(0, mezera) : popis,
        model: mezera > 0 ? popis.slice(mezera + 1) : '',
        vin: '',
        rokVyroby: Number(r.rokVyroby) || 0,
        typ: TYP_Z_TABULKY[String(r.typ || '').toLowerCase()] || 'osobni',
        stav: 'aktivni',
        stredisko: String(r.stredisko || '').trim(),
        spravceEmail: nalez ? nalez.emp.email : '',
        spravceJmeno: nalez ? nalez.emp.name : '',
        spravceZTabulky: String(r.osoba || '').trim(),   // co bylo v tabulce (i když se nespároval)
        spravcePotvrzen: false,   // tabulka vede vozidlo účetně; kdo s ním fakticky jezdí, se potvrzuje v modulu
        spravceParovani: nalez ? nalez.jak : '',
        evidCislo: String(r.evid || '').trim(),
        utvar: String(r.utvar || '').trim(),
        cisloTp: String(r.cisloTp || '').trim(),
        majitel: String(r.majitel || '').trim(),
        stkDo: '',
        porizeno: '',
        poznamka: String(r.poznamka || '').trim(),
        km: [], fotky: [], inventury: [], stkHistorie: [], skody: [],
      };
      if (nalez) sparovano++;
      d.vozidla.push(v);
    });
    d.seedImport = { ts: Date.now(), vozidel: seed.length, sparovano, zdroj: 'Vozidla.xlsx' };
    try { fs.renameSync(SEED_FILE, SEED_FILE + '.hotovo'); } catch (_) {}   // ať se import nespustí podruhé
    // Aby import hned nerozeslal desítky výzev: upomínky se rozjedou až za 14 dní.
    d.nastaveni.upominkyOd = new Date(Date.now() + 14 * DEN).toISOString().slice(0, 10);
    console.log('[vozidla] import evidence: ' + seed.length + ' vozidel, správce spárován u ' + sparovano);
    return d.seedImport;
  }

  // ---- přístup -------------------------------------------------------------
  // Modul vidí správce intranetu, kdo má klíč „vozidla", a dále každý, komu je
  // svěřené auto nebo kdo zodpovídá za středisko — ti bez přidělování přístupu.
  function spravceModulu(req) {
    if (host.isAdmin(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    try { return (host.employeeModules(e.email) || []).includes('vozidla'); } catch (_) { return false; }
  }
  function mojeVozy(d, email) { email = low(email); return d.vozidla.filter(v => low(v.spravceEmail) === email); }
  function mojeStrediska(d, email) {
    email = low(email);
    return d.zodpovedne.filter(z => low(z.email) === email).map(z => z.stredisko);
  }
  function role(req) {
    const d = load(), e = host.empSession(req);
    const email = e ? low(e.email) : '';
    const admin = spravceModulu(req);
    const strediska = mojeStrediska(d, email);
    return {
      email, name: e ? (e.name || '') : '', admin,
      spravce: mojeVozy(d, email).length > 0,
      strediska,
      zodpovedny: strediska.length > 0,
    };
  }
  function maPristup(req) {
    const r = role(req);
    return !!(r.admin || r.spravce || r.zodpovedny);
  }
  // Vozový park vidí celý každý, kdo má do modulu přístup — přehled o firemních autech
  // není tajný a lidem pomáhá najít, kdo které auto má. Editovat smí jen svoje.
  function viditelna(d, r) { return d.vozidla; }
  function smiEditovat(v, r) {
    return !!(r.admin || low(v.spravceEmail) === r.email || r.strediska.indexOf(v.stredisko) >= 0);
  }
  // O prodeji, vyřazení a cenách rozhoduje správce modulu nebo zodpovědná osoba za středisko —
  // ne ten, kdo s vozem jezdí (ten může podat nabídku na odkup jako každý jiný zaměstnanec).
  function smiRozhodovat(v, r) {
    return !!(r.admin || r.strediska.indexOf(v.stredisko) >= 0);
  }

  // ---- výpočty -------------------------------------------------------------
  const dnes = () => new Date();
  function dniDo(datum) {
    if (!datum) return null;
    const t = Date.parse(datum + 'T00:00:00'); if (isNaN(t)) return null;
    return Math.round((t - new Date(new Date().toDateString()).getTime()) / DEN);
  }
  function posledniKm(v) {
    const k = (v.km || []).slice().sort((a, b) => a.rok - b.rok);
    return k.length ? k[k.length - 1] : null;
  }
  // Roční nájezd: z rozdílu prvního a posledního zápisu, jinak z celkových km a stáří vozu.
  // Nulový zápis je výplň, ne údaj — jinak z něj vyjde nesmyslný nájezd (0 → 318 519 za rok).
  function rocniNajezd(v) {
    const k = (v.km || []).filter(x => Number(x.km) > 0).sort((a, b) => a.rok - b.rok);
    if (k.length >= 2) {
      const roky = k[k.length - 1].rok - k[0].rok;
      if (roky > 0) return Math.max(0, Math.round((k[k.length - 1].km - k[0].km) / roky));
    }
    if (k.length === 1 && v.rokVyroby) {
      const stari = Math.max(1, k[0].rok - Number(v.rokVyroby) + 1);
      return Math.round(k[0].km / stari);
    }
    return 0;
  }
  // Zápis tachometru se chce jen za probíhající rok. Zpětně nemá smysl se ptát —
  // v půlce roku nikdo neví, kolik měl vůz na tachometru k 31. 12. předloni.
  // Roční nájezd stejně vychází z rozdílu dvou zápisů (2026: 24 000 → 2027: 36 000
  // = 12 000 km za rok), takže stačí jednou ročně opsat aktuální stav.
  // Starší zápisy zůstávají v archivu, jen je systém nevyžaduje.
  function chybejiciRoky(v) {
    const letos = dnes().getFullYear();
    const mame = new Set((v.km || []).map(x => Number(x.rok)));
    return mame.has(letos) ? [] : [letos];
  }
  // Nejvhodnější období prodeje. Heuristika, ne věštba — v UI je to napsané.
  const DOBRE_MESICE = [3, 4, 5, 9, 10];   // březen–květen a září–říjen: nejvyšší poptávka po ojetinách
  function doporuceniProdeje(v, nast) {
    const pk = posledniKm(v);
    if (!pk || !v.rokVyroby) return { text: 'Doplň rok výroby a stav tachometru — pak spočítám.', kdy: null };
    const najezd = rocniNajezd(v);
    const prahKm = Number(nast.prahKm) || 250000, prahRoky = Number(nast.prahRoky) || 8;
    const letos = dnes().getFullYear();
    // kolik měsíců zbývá do dosažení kilometrového prahu
    const zbyvaKm = prahKm - pk.km;
    const mesKm = najezd > 0 ? Math.round(zbyvaKm / (najezd / 12)) : null;
    // kolik měsíců zbývá do dosažení věkového prahu
    const mesRok = Math.round((Number(v.rokVyroby) + prahRoky - letos) * 12);
    let mes = [mesKm, mesRok].filter(x => x !== null && !isNaN(x)).reduce((a, b) => Math.min(a, b), Infinity);
    if (!isFinite(mes)) return { text: 'Chybí druhý roční zápis tachometru — bez něj neznám roční nájezd.', kdy: null };
    if (mes < 0) mes = 0;
    // posuň na nejbližší příznivý prodejní měsíc
    const cil = new Date(); cil.setDate(1); cil.setMonth(cil.getMonth() + mes);
    for (let i = 0; i < 12; i++) {
      if (DOBRE_MESICE.indexOf(cil.getMonth() + 1) >= 0) break;
      cil.setMonth(cil.getMonth() + 1);
    }
    const kdy = cil.getFullYear() + '-' + String(cil.getMonth() + 1).padStart(2, '0');
    const duvod = (mesKm !== null && mesKm <= mesRok)
      ? 'do ' + prahKm.toLocaleString('cs-CZ') + ' km zbývá ' + Math.max(0, zbyvaKm).toLocaleString('cs-CZ') + ' km při nájezdu ' + najezd.toLocaleString('cs-CZ') + ' km/rok'
      : 'vozu bude ' + prahRoky + ' let';
    return {
      text: (mes <= 0 ? 'Prodat co nejdřív — ' : 'Prodej plánovat na ') +
        (mes <= 0 ? duvod : mesicSlovy(cil) + ' (' + duvod + ')'),
      kdy, mesicu: mes, najezd,
    };
  }
  // ---- termín vyřazení a ocenění (podklad pro obměnu a odkup zaměstnanci) --------
  //  Stáří z data pořízení (nebo z roku výroby), nájezd z posledního zápisu tachometru
  //  dopočtený ročním nájezdem; pořizovací a ruční prodejní cenu zadává ten, kdo rozhoduje.
  function regVozu(v) {
    const m = /^(\d{4})-(\d{2})/.exec(String(v.porizeno || ''));
    if (m) return { reg: { y: +m[1], m: +m[2] }, zdroj: 'datum pořízení' };
    if (Number(v.rokVyroby)) return { reg: { y: Number(v.rokVyroby), m: 6 }, zdroj: 'rok výroby (bez měsíce — počítá se půlka roku)' };
    return { reg: null, zdroj: null };
  }
  function oceneniVozu(v, nast) {
    const r = regVozu(v), pk = posledniKm(v), naj = rocniNajezd(v), d0 = dnes();
    let tachoMes = 0;
    if (pk) tachoMes = pk.ts ? Math.max(0, (Date.now() - pk.ts) / (30.44 * DEN)) : Math.max(0, (d0.getFullYear() - pk.rok) * 12 + (d0.getMonth() + 1 - 7));
    return oceneni.spocitej({
      reg: r.reg, regZdroj: r.zdroj,
      tachometr: pk ? Number(pk.km) : null, tachometrRok: pk ? pk.rok : null, tachometrMesicu: tachoMes, kmMes: naj / 12,
      porizovaciCena: Number(v.porizovaciCena) || null, prodejniCena: Number(v.prodejniCena) || null, typ: v.typ,
      trh: v.trh || null,
    }, {
      maxLet: Number(nast.prahRoky) || 8, maxKm: Number(nast.prahKm) || 250000, rocniKm: Number(nast.rocniKm) || 25000,
      rezervaProdej: (nast.rezervaProdej != null && isFinite(nast.rezervaProdej)) ? Number(nast.rezervaProdej) : 8, odpisLet: Number(nast.odpisLet) || 5,
      cenyTypu: nast.cenyTypu || CENY_TYPU,
    }, d0);
  }
  // ---- porovnání s inzercí (Sauto.cz) ------------------------------------------
  //  Běží na pozadí: hodinový tick obnoví pár vozů, kterým je porovnání starší než
  //  trhObnovaDni; správce ho může spustit ručně pro jeden vůz nebo pro všechny.
  //  Každý vůz se načte a uloží zvlášť, aby se dlouhý běh nepral s editací v UI.
  const TRH_BEH = { bezi: false, hotovo: 0, celkem: 0, zacatek: null, konec: null, chyby: 0, posledni: '' };
  function trhVstup(v) {
    const r = regVozu(v), pk = posledniKm(v);
    return { znacka: v.znacka, model: v.model, typ: v.typ, rok: r.reg ? r.reg.y : null, km: pk ? Number(pk.km) : null };
  }
  async function trhObnovVozy(ids) {
    if (TRH_BEH.bezi) return false;
    Object.assign(TRH_BEH, { bezi: true, hotovo: 0, celkem: ids.length, zacatek: Date.now(), konec: null, chyby: 0, posledni: '' });
    try {
      for (const id of ids) {
        const d = load(); const v = d.vozidla.find(x => x.id === id);
        if (v) {
          v.trh = await trh.ohodnot(trhVstup(v));
          if (v.trh.stav === 'chyba') TRH_BEH.chyby++;
          TRH_BEH.posledni = (v.spz || v.vin || id) + ': ' + v.trh.stav + (v.trh.n != null ? ' (' + v.trh.n + ' inz.)' : '');
          console.log('[vozidla] inzerce ' + TRH_BEH.posledni + (v.trh.odhad ? ' → ' + v.trh.odhad.toLocaleString('cs-CZ') + ' Kč' : '') + (v.trh.zprava ? ' · ' + v.trh.zprava : ''));
          save(d);
        }
        TRH_BEH.hotovo++;
      }
    } finally { TRH_BEH.bezi = false; TRH_BEH.konec = Date.now(); }
    return true;
  }
  // Všechna vozidla, kterým porovnání chybí nebo je po lhůtě — nejstarší první. Vozy bez roku
  // výroby nemá smysl zkoušet. Žádný strop: po startu serveru se tak dorovná celý park najednou
  // (52 vozů × ~2,5 s), potom už jen to, co za týden zestárne.
  function trhKObnove(d) {
    const lhuta = (Number(d.nastaveni.trhObnovaDni) || 7) * DEN;
    return d.vozidla
      .filter(v => v.stav === 'aktivni' && regVozu(v).reg && (!v.trh || !v.trh.ts || Date.now() - v.trh.ts > lhuta || v.trh.stav === 'chyba'))
      .sort((a, b) => ((a.trh && a.trh.ts) || 0) - ((b.trh && b.trh.ts) || 0))
      .map(v => v.id);
  }
  async function trhTick(d) {
    if (!d.nastaveni.trhZapnuto || TRH_BEH.bezi) return;
    const ids = trhKObnove(d);
    if (!ids.length) return;
    try { await trhObnovVozy(ids); console.log('[vozidla] porovnání s inzercí obnoveno u ' + ids.length + ' vozidel, chyb ' + TRH_BEH.chyby); }
    catch (e) { console.warn('[vozidla] porovnání s inzercí selhalo: ' + e.message); }
  }
  async function apiTrh(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    if (b.vse) {
      if (!(r.admin || r.zodpovedny)) { json(res, 403, { chyba: 'Hromadné porovnání spouští správce modulu nebo zodpovědná osoba.' }); return true; }
      if (TRH_BEH.bezi) { json(res, 200, { ok: true, bezi: true, stav: TRH_BEH }); return true; }
      const ids = d.vozidla.filter(v => v.stav === 'aktivni' && regVozu(v).reg && (r.admin || smiRozhodovat(v, r))).map(v => v.id);
      if (!ids.length) { json(res, 400, { chyba: 'Není co porovnávat — žádné vozidlo nemá rok výroby.' }); return true; }
      trhObnovVozy(ids).catch(e => console.warn('[vozidla] hromadné porovnání: ' + e.message));   // běží dál na pozadí
      logAct('vozidla', req, 'Porovnání s inzercí spuštěno pro ' + ids.length + ' vozidel');
      json(res, 200, { ok: true, spusteno: ids.length, stav: TRH_BEH });
      return true;
    }
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiRozhodovat(v, r)) { json(res, 403, { chyba: 'Porovnání spouští správce modulu nebo zodpovědná osoba za středisko.' }); return true; }
    if (TRH_BEH.bezi) { json(res, 409, { chyba: 'Právě běží hromadné porovnání — počkejte, až doběhne.' }); return true; }
    v.trh = await trh.ohodnot(trhVstup(v));
    save(d);
    json(res, 200, { ok: true, trh: v.trh, oceneni: oceneniVozu(v, d.nastaveni) });
    return true;
  }

  const PLANY = { prodej: 'Plánovaný prodej', likvidace: 'Vyřazení — ekologická likvidace' };
  // Vozy nabízené zaměstnancům k odkupu: plán „prodej" u vozu, který ještě nebyl prodán ani vyřazen.
  function vozyKOdkupu(d) {
    return d.vozidla.filter(v => v.plan === 'prodej' && v.stav !== 'prodano' && v.stav !== 'vyrazeno').map(v => {
      const o = oceneniVozu(v, d.nastaveni);
      return { id: v.id, spz: v.spz, popis: [v.znacka, v.model].filter(Boolean).join(' '), typ: TYPY[v.typ] || v.typ, rokVyroby: v.rokVyroby || null,
        reg: o.reg, regZdroj: o.regZdroj, stariLet: o.stariLet, najezd: o.najezd, najezdZdroj: o.najezdZdroj,
        cena: o.cenaZamestnanec, prodejni: o.prodejni, termin: o.termin, planOd: v.planOd || null, planPozn: v.planPozn || '',
        stredisko: v.stredisko || '', spravceEmail: low(v.spravceEmail || ''), fotky: (v.fotky || []).length };
    });
  }
  const MESICE = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
  function mesicSlovy(dt) { return MESICE[dt.getMonth()] + ' ' + dt.getFullYear(); }

  function mesicuOd(ts) { return ts ? Math.floor((Date.now() - ts) / (30.44 * DEN)) : null; }
  function inventuraStav(v, nast) {
    const posl = (v.inventury || []).slice().sort((a, b) => b.ts - a.ts)[0];
    const limit = Number(nast.inventuraMesice) || 24;
    if (!posl) return { potreba: true, text: 'nikdy neproběhla', posledni: null };
    const m = mesicuOd(posl.ts);
    return { potreba: m >= limit, text: m + ' měsíců od poslední', posledni: posl };
  }

  // Souhrn stavu vozidla — používá UI, e-maily i nástěnka.
  function stavVozu(v, nast) {
    const dnyStk = dniDo(v.stkDo);
    const inv = inventuraStav(v, nast);
    const chybi = chybejiciRoky(v);
    const upoz = [];
    if (v.stav === 'aktivni') {
      // Chybějící údaj není totéž co propadlá prohlídka — urgentní je jen to druhé.
      if (dnyStk === null) upoz.push({ druh: 'stk-chybi', urgent: false, text: 'chybí datum platnosti technické prohlídky' });
      else if (dnyStk < 0) upoz.push({ druh: 'stk', urgent: true, text: 'technická prohlídka propadla před ' + (-dnyStk) + ' dny' });
      else if (dnyStk <= 60) upoz.push({ druh: 'stk', urgent: dnyStk <= 14, text: 'technická prohlídka končí za ' + dnyStk + ' ' + (dnyStk === 1 ? 'den' : dnyStk < 5 ? 'dny' : 'dní') });
      if (chybi.length) upoz.push({ druh: 'km', urgent: false, text: 'chybí stav tachometru za rok ' + chybi.join(', ') });
      if (inv.potreba) upoz.push({ druh: 'inventura', urgent: false, text: 'inventarizace svěřeného majetku — ' + inv.text });
      if (!v.spravceEmail) upoz.push({ druh: 'spravce', urgent: false, text: 'není přidělen správce vozu' });
      if (!v.vin) upoz.push({ druh: 'vin', urgent: false, text: 'chybí VIN' });
    }
    return { dnyStk, inventura: inv, chybejiciRoky: chybi, upozorneni: upoz, prodej: doporuceniProdeje(v, nast) };
  }

  // ---- žádost o doplnění chybějících údajů ----------------------------------
  //  Cíl je jeden e-mail na člověka se seznamem jeho vozidel, ne jeden e-mail na vozidlo.
  function chybejiciUdaje(v) {
    const out = [];
    if (!String(v.vin || '').trim()) out.push('VIN (velký technický průkaz, řádek E)');
    if (!Number(v.rokVyroby)) out.push('rok výroby');
    if (!v.stkDo) out.push('datum platnosti technické prohlídky');
    const letos = dnes().getFullYear();
    if (!(v.km || []).some(x => Number(x.rok) === letos)) out.push('stav tachometru za rok ' + letos);
    return out;
  }
  // Komu poslat: správci vozu; když není, zodpovědné osobě za středisko.
  function zadostiPrehled(d, r, jenId) {
    const lide = new Map();      // email → { email, jmeno, duvod, vozidla: [] }
    const bezAdresata = [];
    d.vozidla.filter(v => v.stav === 'aktivni').forEach(v => {
      if (jenId && v.id !== jenId) return;          // žádost jen k jednomu vozidlu
      if (r && !smiEditovat(v, r)) return;          // vedoucí řeší jen svoje středisko
      const chybi = chybejiciUdaje(v);
      if (!chybi.length) return;
      const zod = d.zodpovedne.find(z => z.stredisko === v.stredisko && z.email);
      const komu = v.spravceEmail ? { email: low(v.spravceEmail), duvod: 'správce vozu' }
        : (zod ? { email: low(zod.email), duvod: 'zodpovědná osoba za středisko ' + v.stredisko } : null);
      const radek = { spz: v.spz || v.vin || '—', popis: [v.znacka, v.model].filter(Boolean).join(' '), stredisko: v.stredisko || '', chybi };
      if (!komu) { bezAdresata.push(radek); return; }
      const zaznam = lide.get(komu.email) || { email: komu.email, jmeno: (kontakt(komu.email) || {}).jmeno || komu.email, duvod: komu.duvod, vozidla: [] };
      zaznam.vozidla.push(radek);
      lide.set(komu.email, zaznam);
    });
    const naposled = d.zadostiOdeslano || {};
    return {
      lide: Array.from(lide.values())
        .map(z => Object.assign(z, { naposled: naposled[z.email] || null }))
        .sort((a, b) => b.vozidla.length - a.vozidla.length || String(a.jmeno).localeCompare(String(b.jmeno), 'cs')),
      bezAdresata,
    };
  }
  function zadostText(z, odesilatel) {
    const n = z.vozidla.length;
    const spravce = String(z.duvod || '').indexOf('správce') === 0;
    const cich = spravce
      ? (n === 1 ? 'u vozidla, které máte svěřené' : 'u ' + n + ' vozidel, která máte svěřená')
      : (n === 1 ? 'u vozidla vašeho střediska, které nemá přiděleného správce' : 'u ' + n + ' vozidel vašeho střediska, která nemají přiděleného správce');
    return 'Dobrý den,\n\n'
      + 'v evidenci vozového parku chybí pár údajů ' + cich
      + (spravce ? ' — vyplní je jen ten, kdo s vozem jezdí' : '') + ':\n\n'
      + z.vozidla.map(v => '• ' + v.spz + (v.popis ? ' (' + v.popis + ')' : '') + ': ' + v.chybi.join(', ')).join('\n')
      + '\n\nDoplníte je přímo v přehledu, stačí kliknout do políčka:\n'
      + 'https://intranet.elkoplast.cz/#modul=vozidla\n\n'
      + 'VIN je ve velkém technickém průkazu na řádku E, platnost technické prohlídky na zadní straně malého technického průkazu. '
      + 'U tachometru stačí opsat dnešní stav — kolik se za rok najelo, spočítá evidence sama.\n\n'
      + 'Děkuji,\n' + (odesilatel || 'vozový park ELKOPLAST');
  }

  // ---- adresáti směrnice ----------------------------------------------------
  //  Směrnice se neposílá celé firmě: týká se lidí, kteří auto skutečně mají,
  //  a vedoucích, kteří za vozidla střediska odpovídají.
  function adresatiSmernice(d) {
    const spravci = Array.from(new Set(d.vozidla
      .filter(v => v.stav === 'aktivni' && v.spravceEmail)
      .map(v => low(v.spravceEmail))));
    const vedouci = Array.from(new Set(d.zodpovedne.map(z => low(z.email)).filter(Boolean)));
    return { spravci, vedouci, vse: Array.from(new Set(spravci.concat(vedouci))) };
  }
  // Štítek u zaměstnanců přerovnáme podle aktuálního stavu (běží i v tick(), takže se sám opraví).
  function synchronizujTag(d) {
    if (!host.nastavTag) return null;
    try { return host.nastavTag({ tag: TAG_SMERNICE, emaily: adresatiSmernice(d || load()).vse }); }
    catch (e) { console.error('[vozidla] štítek se nepodařilo nastavit:', e.message); return null; }
  }

  // ---- e-mail --------------------------------------------------------------
  // rezim 'souhrn' = zpráva nejde hned, ale do denního souhrnu (jeden e-mail ráno na člověka).
  // rezim 'hned'   = urgentní, nesmí čekat do rána ani správci (škoda, propadlá technická).
  async function mail(to, subject, text, rezim) {
    // Pozor: odesílatele NEvyžadujeme — při odesílání přes Resend bývá CFG.user prázdný
    // a podmínka na něj by upozornění tiše zahodila.
    if (!to || !host.deliver) return;
    const mf = host.mailFrom || {};
    const zprava = {
      to, subject, text,
      html: '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f1512;line-height:1.6">'
        + esc(text).replace(/\n/g, '<br>') + '</div>',
    };
    if (mf.user) { zprava.fromAddr = mf.user; zprava.fromName = mf.name || 'Intranet – vozový park'; }
    zprava.modul = 'Vozový park';
    if (rezim === 'souhrn') zprava.souhrn = 'denni';
    if (rezim === 'hned') zprava.urgent = true;
    try { await host.deliver(zprava); return true; }
    catch (e) { console.error('[vozidla] e-mail se nepodařilo odeslat:', e.message); return false; }
  }

  // ======================================================================
  //  ROUTER
  // ======================================================================
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (p !== '/vozidla' && p !== '/vozidla/' && p !== '/vozidla/odkup' && !p.startsWith('/api/vozidla')) return false;

    // Odkup vozidel je otevřený KAŽDÉMU přihlášenému zaměstnanci — ne jen lidem, kteří modul vidí.
    const proZamestnance = (p === '/vozidla/odkup' || p === '/api/vozidla/odkup');
    if (proZamestnance) {
      if (!host.empSession(req) && !host.isAdmin(req)) {
        if (p.startsWith('/api/')) json(res, 401, { chyba: 'Přihlaste se do intranetu.' });
        else htmlOut(res, 401, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">Pro nabídku odkupu se přihlaste do intranetu.</p>');
        return true;
      }
    } else if (!maPristup(req)) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'K modulu Vozový park nemáte přístup.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">'
        + 'K modulu Vozový park nemáte přístup. Uvidí ho správce vozu, člověk zodpovědný za středisko a správce intranetu.</p>');
      return true;
    }

    if ((p === '/vozidla' || p === '/vozidla/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí vozidla.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }
    if (p === '/vozidla/odkup' && req.method === 'GET') { htmlOut(res, 200, fs.readFileSync(ODKUP_FILE, 'utf8')); return true; }
    if (p === '/api/vozidla/foto' && req.method === 'GET') return servujFoto(res, u.query);

    try {
      if (p === '/api/vozidla/odkup' && req.method === 'GET') return apiOdkupData(req, res);
      if (p === '/api/vozidla/odkup' && req.method === 'POST') return apiOdkupPodat(req, res);
      if (p === '/api/vozidla/odkup/stav' && req.method === 'POST') return apiOdkupStav(req, res);
      if (p === '/api/vozidla/plan' && req.method === 'POST') return apiPlan(req, res);
      if (p === '/api/vozidla/cena' && req.method === 'POST') return apiCena(req, res);
      if (p === '/api/vozidla/trh' && req.method === 'POST') return apiTrh(req, res);
      if (p === '/api/vozidla/trh/stav' && req.method === 'GET') { json(res, 200, TRH_BEH); return true; }
      if (p === '/api/vozidla/data' && req.method === 'GET') return apiData(req, res);
      if (p === '/api/vozidla/vuz' && req.method === 'POST') return apiVuz(req, res);
      if (p === '/api/vozidla/vuz/smazat' && req.method === 'POST') return apiVuzSmazat(req, res);
      if (p === '/api/vozidla/km' && req.method === 'POST') return apiKm(req, res);
      if (p === '/api/vozidla/stk' && req.method === 'POST') return apiStk(req, res);
      if (p === '/api/vozidla/foto' && req.method === 'POST') return apiFotoPridat(req, res);
      if (p === '/api/vozidla/foto/smazat' && req.method === 'POST') return apiFotoSmazat(req, res);
      if (p === '/api/vozidla/inventura' && req.method === 'POST') return apiInventura(req, res);
      if (p === '/api/vozidla/skoda' && req.method === 'POST') return apiSkoda(req, res);
      if (p === '/api/vozidla/predat' && req.method === 'POST') return apiPredat(req, res);
      if (p === '/api/vozidla/potvrdit' && req.method === 'POST') return apiPotvrdit(req, res);
      if (p === '/api/vozidla/zadost' && req.method === 'POST') return apiZadost(req, res);
      if (p === '/api/vozidla/zodpovedny' && req.method === 'POST') return apiZodpovedny(req, res);
      if (p === '/api/vozidla/nastaveni' && req.method === 'POST') return apiNastaveni(req, res);
      if (p === '/api/vozidla/export' && req.method === 'GET') return apiExport(req, res);
      if (p === '/api/vozidla/smernice' && req.method === 'GET') return apiSmernice(req, res);
      if (p === '/api/vozidla/smernice/zalozit' && req.method === 'POST') return apiSmerniceZalozit(req, res);
    } catch (e) {
      console.error('[vozidla] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }
    json(res, 404, { chyba: 'Neznámý požadavek.' }); return true;
  }

  // ---- čtení ---------------------------------------------------------------
  function apiData(req, res) {
    const d = load(), r = role(req);
    const vozy = viditelna(d, r).map(v => Object.assign({}, v, {
      stav_: stavVozu(v, d.nastaveni),
      chybi: chybejiciUdaje(v),      // pro tlačítko „žádost o doplnění" u řádku
      smiEdit: smiEditovat(v, r),
      smiRozhodovat: smiRozhodovat(v, r),
      oceneni: oceneniVozu(v, d.nastaveni),
      planText: PLANY[v.plan] || '',
      // nabídky odkupu vidí jen ten, kdo o vozu rozhoduje
      nabidky: smiRozhodovat(v, r) ? d.odkup.filter(n => n.vozId === v.id).map(n => Object.assign({}, n, { kontakt: kontakt(n.email) })) : undefined,
      spravceKontakt: kontakt(v.spravceEmail),                    // živě z databáze zaměstnanců
      zodpovednyKontakt: (() => { const z = d.zodpovedne.find(x => x.stredisko === v.stredisko); return z ? Object.assign({ role: z.role }, kontakt(z.email)) : null; })(),
      fotky: (v.fotky || []).map((f, i) => ({ i, popis: f.popis || '', ts: f.ts, kdo: f.kdo || '', url: '/api/vozidla/foto?id=' + v.id + '&fi=' + i })),
    }));
    const strediska = Array.from(new Set(
      d.vozidla.map(v => v.stredisko).concat(zamestnanci().map(e => e.stredisko)).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, 'cs'));
    json(res, 200, {
      me: r,
      vozidla: vozy,
      zodpovedne: (r.admin ? d.zodpovedne : d.zodpovedne.filter(z => r.strediska.indexOf(z.stredisko) >= 0))
        .map(z => Object.assign({}, z, { kontakt: kontakt(z.email) })),
      seedImport: d.seedImport || null,
      adresatiSmernice: (() => { const a = adresatiSmernice(d); return {
        tag: TAG_SMERNICE,
        spravci: a.spravci.map(kontakt), vedouci: a.vedouci.map(e => {
          // Pozor na pořadí: kontakt() nese i domovské středisko zaměstnance a přepsalo by to,
          // za která střediska člověk ve vozovém parku odpovídá (to je tady podstatné).
          const zs = d.zodpovedne.filter(x => low(x.email) === e);
          return Object.assign(kontakt(e), {
            role: (zs[0] || {}).role,
            stredisko: zs.map(x => x.stredisko).filter(Boolean).join(', '),
          });
        }) }; })(),
      strediska, role: ROLE, stavy: STAVY, typy: TYPY, stkLhuta: STK_LHUTA, plany: PLANY,
      nastaveni: d.nastaveni,
      trhStav: TRH_BEH,             // běží hromadné porovnání s inzercí?
      zamestnanci: zamestnanci(),   // pro našeptávač; stejná data jako telefonní seznam intranetu
    });
    return true;
  }

  // ---- zápis vozidla -------------------------------------------------------
  async function apiVuz(req, res) {
    const r = role(req);
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load();
    let v = b.id ? d.vozidla.find(x => x.id === b.id) : null;
    const novy = !v;
    // Zakládat vozidla smí správce modulu; upravovat i ten, kdo za vozidlo odpovídá
    // (jeho správce nebo vedoucí jeho střediska) — jinak by museli všechno hlásit adminovi.
    if (novy && !r.admin) { json(res, 403, { chyba: 'Nové vozidlo může založit jen správce modulu.' }); return true; }
    if (!novy && !smiEditovat(v, r)) { json(res, 403, { chyba: 'Toto vozidlo nemáte v gesci.' }); return true; }
    if (novy) {
      v = { id: 'v' + crypto.randomBytes(5).toString('hex'), vznik: Date.now(), km: [], fotky: [], inventury: [], stkHistorie: [], skody: [] };
      d.vozidla.push(v);
    }
    const s = x => String(b[x] == null ? (v[x] || '') : b[x]).trim();
    v.spz = s('spz').toUpperCase();
    v.znacka = s('znacka'); v.model = s('model');
    v.vin = s('vin').toUpperCase().slice(0, 17);
    // pozor: prázdná hodnota musí rok SMAZAT, ne se tiše vrátit k původní
    v.rokVyroby = (b.rokVyroby === undefined) ? (Number(v.rokVyroby) || 0) : (Number(b.rokVyroby) || 0);
    v.typ = TYPY[b.typ] ? b.typ : (v.typ || 'osobni');
    v.stav = STAVY[b.stav] ? b.stav : (v.stav || 'aktivni');
    v.stredisko = s('stredisko');
    v.spravceEmail = low(b.spravceEmail != null ? b.spravceEmail : v.spravceEmail);
    const zmenaSpravce = b.spravceEmail !== undefined && low(b.spravceEmail) !== low(v.spravceEmail || '');
    v.spravceJmeno = v.spravceEmail ? (jmenoPodleMailu(v.spravceEmail) || s('spravceJmeno')) : '';
    if (zmenaSpravce) v.spravcePotvrzen = !!v.spravceEmail;   // koho zadá člověk, ten je potvrzený
    v.stkDo = s('stkDo');
    v.porizeno = s('porizeno');
    v.evidCislo = s('evidCislo'); v.cisloTp = s('cisloTp'); v.majitel = s('majitel');
    v.poznamka = String(b.poznamka == null ? (v.poznamka || '') : b.poznamka).slice(0, 2000);
    if (!v.spz && !v.vin) { json(res, 400, { chyba: 'Vyplň aspoň SPZ nebo VIN.' }); return true; }
    save(d);
    logAct('vozidla', req, (novy ? 'Založeno vozidlo ' : 'Upraveno vozidlo ') + (v.spz || v.vin));
    synchronizujTag(d);
    json(res, 200, { ok: true, id: v.id });
    return true;
  }
  async function apiVuzSmazat(req, res) {
    const r = role(req);
    if (!r.admin) { json(res, 403, { chyba: 'Mazat může jen správce modulu.' }); return true; }
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load();
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    (v.fotky || []).forEach(f => { try { fs.unlinkSync(path.join(FILES_DIR, f.soubor)); } catch (_) {} });
    d.vozidla = d.vozidla.filter(x => x.id !== b.id);
    save(d);
    logAct('vozidla', req, 'Smazáno vozidlo ' + (v.spz || v.vin));
    json(res, 200, { ok: true });
    return true;
  }

  // ---- roční stav tachometru ----------------------------------------------
  async function apiKm(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiEditovat(v, r)) { json(res, 403, { chyba: 'K tomuto vozidlu nemáte právo zapisovat.' }); return true; }
    const rok = Number(b.rok), km = Number(b.km);
    if (!rok || rok < 1990 || rok > dnes().getFullYear()) { json(res, 400, { chyba: 'Neplatný rok.' }); return true; }
    if (!(km >= 0) || km > 3000000) { json(res, 400, { chyba: 'Neplatný stav tachometru.' }); return true; }
    const drivejsi = (v.km || []).filter(x => x.rok < rok).sort((a, b2) => b2.rok - a.rok)[0];
    if (drivejsi && km < drivejsi.km) { json(res, 400, { chyba: 'Stav tachometru je nižší než v roce ' + drivejsi.rok + ' (' + drivejsi.km.toLocaleString('cs-CZ') + ' km).' }); return true; }
    v.km = (v.km || []).filter(x => Number(x.rok) !== rok);
    v.km.push({ rok, km, ts: Date.now(), kdo: r.name || r.email });
    v.km.sort((a, b2) => a.rok - b2.rok);
    save(d);
    logAct('vozidla', req, 'Tachometr ' + (v.spz || v.vin) + ': ' + km.toLocaleString('cs-CZ') + ' km za rok ' + rok);
    json(res, 200, { ok: true, stav: stavVozu(v, d.nastaveni) });
    return true;
  }

  // ---- technická prohlídka -------------------------------------------------
  async function apiStk(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiEditovat(v, r)) { json(res, 403, { chyba: 'K tomuto vozidlu nemáte právo zapisovat.' }); return true; }
    const provedeno = String(b.provedeno || '').slice(0, 10);   // datum provedení
    const platiDo = String(b.platiDo || '').slice(0, 10);       // nová platnost
    if (!/^\d{4}-\d{2}-\d{2}$/.test(platiDo)) { json(res, 400, { chyba: 'Vyplň, do kdy nová prohlídka platí.' }); return true; }
    v.stkHistorie = v.stkHistorie || [];
    v.stkHistorie.push({
      provedeno: provedeno || new Date().toISOString().slice(0, 10),
      platiDo, ts: Date.now(), kdo: r.name || r.email,
      poznamka: String(b.poznamka || '').slice(0, 500),
    });
    v.stkDo = platiDo;
    // po zapsání prohlídky ať upozornění začnou nanovo
    Object.keys(d.odeslano).forEach(k => { if (k.indexOf('stk:' + v.id + ':') === 0) delete d.odeslano[k]; });
    save(d);
    logAct('vozidla', req, 'Technická prohlídka ' + (v.spz || v.vin) + ' platí do ' + platiDo);
    json(res, 200, { ok: true, stav: stavVozu(v, d.nastaveni) });
    return true;
  }

  // ---- fotografie ----------------------------------------------------------
  async function apiFotoPridat(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiEditovat(v, r)) { json(res, 403, { chyba: 'K tomuto vozidlu nemáte právo zapisovat.' }); return true; }
    if ((v.fotky || []).length >= MAX_FOTEK) { json(res, 400, { chyba: 'Víc než ' + MAX_FOTEK + ' fotek k jednomu vozu neukládáme.' }); return true; }
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.data || '');
    if (!m) { json(res, 400, { chyba: 'Fotku se nepodařilo přečíst (podporujeme JPG, PNG a WEBP).' }); return true; }
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_FOTO) { json(res, 400, { chyba: 'Fotka je příliš velká (max 6 MB).' }); return true; }
    const soubor = crypto.randomBytes(8).toString('hex') + '.' + MIME[m[1]];
    fs.writeFileSync(path.join(FILES_DIR, soubor), buf);
    v.fotky = v.fotky || [];
    v.fotky.push({ soubor, mime: m[1], popis: String(b.popis || '').slice(0, 120), ts: Date.now(), kdo: r.name || r.email });
    save(d);
    json(res, 200, { ok: true });
    return true;
  }
  async function apiFotoSmazat(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v || !smiEditovat(v, r)) { json(res, 403, { chyba: 'K tomuto vozidlu nemáte právo zapisovat.' }); return true; }
    const i = Number(b.fi);
    const f = (v.fotky || [])[i];
    if (!f) { json(res, 404, { chyba: 'Fotka nenalezena.' }); return true; }
    try { fs.unlinkSync(path.join(FILES_DIR, f.soubor)); } catch (_) {}
    v.fotky.splice(i, 1);
    save(d);
    json(res, 200, { ok: true });
    return true;
  }
  function servujFoto(res, q) {
    const d = load();
    const v = d.vozidla.find(x => x.id === q.id);
    const f = v && (v.fotky || [])[Number(q.fi)];
    if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Fotka nenalezena'); return true; }
    const soubor = path.join(FILES_DIR, String(f.soubor).replace(/[^a-zA-Z0-9._-]/g, ''));
    if (!fs.existsSync(soubor)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Soubor chybí'); return true; }
    res.writeHead(200, { 'Content-Type': f.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
    res.end(fs.readFileSync(soubor));
    return true;
  }

  // ---- inventarizace -------------------------------------------------------
  async function apiInventura(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiEditovat(v, r)) { json(res, 403, { chyba: 'K tomuto vozidlu nemáte právo zapisovat.' }); return true; }
    const zaznam = {
      ts: Date.now(),
      datum: new Date().toISOString().slice(0, 10),
      kdo: r.name || r.email, kdoEmail: r.email,
      stav: ['v-poradku', 'drobne-zavady', 'zavazne-zavady'].indexOf(b.stav) >= 0 ? b.stav : 'v-poradku',
      km: Number(b.km) || null,
      vybava: String(b.vybava || '').slice(0, 1000),
      poznamka: String(b.poznamka || '').slice(0, 2000),
    };
    v.inventury = v.inventury || [];
    v.inventury.push(zaznam);
    // stav tachometru z inventury rovnou zapíšeme i do ročního přehledu
    if (zaznam.km) {
      const rok = new Date().getFullYear();
      const drivejsi = (v.km || []).filter(x => x.rok < rok).sort((a, b2) => b2.rok - a.rok)[0];
      if (!drivejsi || zaznam.km >= drivejsi.km) {
        v.km = (v.km || []).filter(x => Number(x.rok) !== rok);
        v.km.push({ rok, km: zaznam.km, ts: Date.now(), kdo: zaznam.kdo, zInventury: true });
        v.km.sort((a, b2) => a.rok - b2.rok);
      }
    }
    Object.keys(d.odeslano).forEach(k => { if (k.indexOf('inv:' + v.id) === 0) delete d.odeslano[k]; });
    save(d);
    logAct('vozidla', req, 'Inventarizace ' + (v.spz || v.vin) + ' — ' + zaznam.stav);
    // zodpovědné osobě dáme vědět, když se našly závady
    if (zaznam.stav !== 'v-poradku') {
      const zod = d.zodpovedne.find(z => z.stredisko === v.stredisko);
      // závažné závady = škoda na svěřeném majetku → i řediteli společnosti
      const komu = Array.from(new Set([zod && zod.email,
        zaznam.stav === 'zavazne-zavady' ? d.nastaveni.reditelEmail : null].filter(Boolean).map(low)));
      if (komu.length) {
        mail(komu.join(','), 'Inventarizace vozidla ' + (v.spz || v.vin) + ' — zjištěny závady',
          'Při inventarizaci svěřeného vozidla ' + (v.spz || '') + ' (' + [v.znacka, v.model].filter(Boolean).join(' ') + ') byly zjištěny '
          + (zaznam.stav === 'drobne-zavady' ? 'drobné závady' : 'závažné závady') + '.\n\n'
          + 'Provedl: ' + zaznam.kdo + '\nDatum: ' + zaznam.datum + '\n'
          + (zaznam.km ? 'Stav tachometru: ' + zaznam.km.toLocaleString('cs-CZ') + ' km\n' : '')
          + (zaznam.poznamka ? '\nPoznámka:\n' + zaznam.poznamka + '\n' : '')
          + '\nDetail v intranetu → Vozový park.');
      }
    }
    json(res, 200, { ok: true, stav: stavVozu(v, d.nastaveni) });
    return true;
  }

  // ---- předání vozidla jinému správci ---------------------------------------
  //  Evidence z firemní tabulky vede auto na toho, kdo ho má „na sobě" účetně.
  //  Kdo s ním fakticky jezdí, to ví jen on sám — proto si ho může předat.
  async function apiPredat(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiEditovat(v, r)) { json(res, 403, { chyba: 'K tomuto vozidlu nemáte právo zapisovat.' }); return true; }
    const novy = low(b.email);
    if (!novy) { json(res, 400, { chyba: 'Vyber, komu se vozidlo předává.' }); return true; }
    const puvodni = v.spravceEmail, puvodniJm = v.spravceJmeno;
    v.spravceEmail = novy;
    v.spravceJmeno = jmenoPodleMailu(novy) || novy;
    v.spravcePotvrzen = true;
    v.predani = v.predani || [];
    v.predani.push({ ts: Date.now(), datum: new Date().toISOString().slice(0, 10), zEmail: puvodni || '', zJmeno: puvodniJm || '',
      naEmail: novy, naJmeno: v.spravceJmeno, kdo: r.name || r.email, poznamka: String(b.poznamka || '').slice(0, 500) });
    // upomínky k tomuhle vozidlu ať začnou nanovo u nového správce
    Object.keys(d.odeslano).forEach(k => { if (k.indexOf(':' + v.id + ':') > 0 || k.indexOf(':' + v.id) > 0) delete d.odeslano[k]; });
    save(d);
    logAct('vozidla', req, 'Vozidlo ' + (v.spz || v.vin) + ' předáno: ' + (puvodniJm || '—') + ' → ' + v.spravceJmeno);
    synchronizujTag(d);
    const zod = d.zodpovedne.find(z => z.stredisko === v.stredisko);
    const popis = (v.spz || v.vin) + (v.znacka || v.model ? ' (' + [v.znacka, v.model].filter(Boolean).join(' ') + ')' : '');
    await mail(Array.from(new Set([novy, zod && zod.email, puvodni].filter(Boolean).map(low))).join(','),
      'Svěřené vozidlo ' + popis, 
      'Vozidlo ' + popis + ' je nově vedené na: ' + v.spravceJmeno + '.\n'
      + (puvodniJm ? 'Dosud bylo vedené na: ' + puvodniJm + '.\n' : '')
      + 'Předal: ' + (r.name || r.email) + ' (' + new Date().toLocaleDateString('cs-CZ') + ')\n'
      + (b.poznamka ? '\nPoznámka: ' + b.poznamka + '\n' : '')
      + '\nSprávce vozu doplňuje roční stav tachometru, hlídá technickou prohlídku a dělá inventarizaci.\n'
      + 'Detail: https://intranet.elkoplast.cz/#modul=vozidla');
    json(res, 200, { ok: true });
    return true;
  }
  // Správce potvrdí, že vozidlo skutečně užívá (u evidence převzaté z tabulky).
  async function apiPotvrdit(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiEditovat(v, r)) { json(res, 403, { chyba: 'K tomuto vozidlu nemáte právo zapisovat.' }); return true; }
    v.spravcePotvrzen = true;
    save(d);
    logAct('vozidla', req, 'Potvrzen správce vozidla ' + (v.spz || v.vin));
    json(res, 200, { ok: true });
    return true;
  }

  // ---- škodní událost -------------------------------------------------------
  //  Dle směrnice se každá škoda hlásí správci vozu, zodpovědné osobě za středisko
  //  A ŘEDITELI SPOLEČNOSTI — ten je v nastavení modulu.
  async function apiSkoda(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiEditovat(v, r)) { json(res, 403, { chyba: 'K tomuto vozidlu nemáte právo zapisovat.' }); return true; }
    const popis = String(b.popis || '').trim();
    if (!popis) { json(res, 400, { chyba: 'Popiš, co se stalo.' }); return true; }
    const zaznam = {
      id: 's' + crypto.randomBytes(5).toString('hex'),
      ts: Date.now(),
      datum: /^\d{4}-\d{2}-\d{2}$/.test(b.datum || '') ? b.datum : new Date().toISOString().slice(0, 10),
      kdo: r.name || r.email, kdoEmail: r.email,
      druh: ['nehoda', 'poskozeni', 'kradez', 'jine'].indexOf(b.druh) >= 0 ? b.druh : 'poskozeni',
      popis: popis.slice(0, 3000),
      odhadKc: Number(b.odhadKc) || null,
      policie: !!b.policie,
      viník: String(b.vinik || '').slice(0, 200),
      stav: 'nahlaseno',
    };
    v.skody = v.skody || [];
    v.skody.push(zaznam);
    save(d);
    logAct('vozidla', req, 'Škodní událost ' + (v.spz || v.vin) + ' — ' + zaznam.druh);
    const zod = d.zodpovedne.find(z => z.stredisko === v.stredisko);
    const prijemci = Array.from(new Set([
      v.spravceEmail, zod && zod.email, d.nastaveni.reditelEmail,
    ].concat(d.nastaveni.kopieNa).filter(Boolean).map(low)));
    const popisVozu = (v.spz || v.vin) + (v.znacka || v.model ? ' (' + [v.znacka, v.model].filter(Boolean).join(' ') + ')' : '');
    const DRUHY = { nehoda: 'Dopravní nehoda', poskozeni: 'Poškození vozidla', kradez: 'Krádež / vloupání', jine: 'Jiná škodní událost' };
    const odeslano = await mail(prijemci.join(','), (DRUHY[zaznam.druh] || 'Škodní událost') + ' — ' + popisVozu,
      (DRUHY[zaznam.druh] || 'Škodní událost') + ' na vozidle ' + popisVozu + '\n\n'
      + 'Datum: ' + zaznam.datum + '\nNahlásil: ' + zaznam.kdo + '\n'
      + 'Správce vozu: ' + (v.spravceJmeno || v.spravceEmail || 'nepřidělen') + '\n'
      + 'Středisko: ' + (v.stredisko || '—') + (zod ? ' · zodpovídá ' + zod.jmeno : '') + '\n'
      + (zaznam.odhadKc ? 'Odhad škody: ' + zaznam.odhadKc.toLocaleString('cs-CZ') + ' Kč\n' : '')
      + (zaznam.viník ? 'Viník: ' + zaznam.viník + '\n' : '')
      + 'Policie ČR: ' + (zaznam.policie ? 'přivolána' : 'nepřivolána') + '\n\n'
      + 'Co se stalo:\n' + zaznam.popis + '\n\n'
      + 'Fotodokumentaci přiložte k vozidlu v intranetu → Vozový park → detail vozidla.', 'hned');
    json(res, 200, { ok: true, komu: prijemci, odeslano, bezReditele: !d.nastaveni.reditelEmail });
    return true;
  }

  // ---- zodpovědné osoby za střediska a nastavení ---------------------------
  // Žádost o doplnění údajů: bez „nahled" se opravdu rozešle.
  async function apiZadost(req, res) {
    const d = load(), r = role(req);
    if (!r.admin && !r.zodpovedny) { json(res, 403, { chyba: 'Žádost rozesílá správce modulu nebo zodpovědná osoba za středisko.' }); return true; }
    const b = JSON.parse(await host.readBody(req) || '{}');
    const prehled = zadostiPrehled(d, r.admin ? null : r, String(b.id || '') || null);
    if (b.nahled) {
      const ukazka = prehled.lide.length ? zadostText(prehled.lide[0], r.name || '') : '';
      json(res, 200, Object.assign({ ok: true, ukazka }, prehled)); return true;
    }
    const jen = Array.isArray(b.komu) && b.komu.length ? b.komu.map(low) : null;
    const vybrani = prehled.lide.filter(z => !jen || jen.indexOf(z.email) >= 0);
    if (!vybrani.length) { json(res, 400, { chyba: 'Není komu poslat — všechny údaje jsou vyplněné.' }); return true; }
    d.zadostiOdeslano = d.zadostiOdeslano || {};
    let odeslano = 0; const selhalo = [];
    for (const z of vybrani) {
      const ok = await mail(z.email, 'Vozový park — prosím doplňte údaje u svěřeného vozidla', zadostText(z, r.name || ''), 'souhrn');
      if (ok !== true) selhalo.push(z.email); else { odeslano++; d.zadostiOdeslano[z.email] = Date.now(); }
    }
    save(d);
    logAct('vozidla', req, 'Žádost o doplnění údajů — odesláno ' + odeslano + ' lidem');
    json(res, 200, { ok: true, odeslano, selhalo });
    return true;
  }
  async function apiZodpovedny(req, res) {
    if (!spravceModulu(req)) { json(res, 403, { chyba: 'Zodpovědnou osobu nastavuje správce modulu.' }); return true; }
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load();
    const stredisko = String(b.stredisko || '').trim();
    if (!stredisko) { json(res, 400, { chyba: 'Chybí středisko.' }); return true; }
    d.zodpovedne = d.zodpovedne.filter(z => z.stredisko !== stredisko);
    if (b.email) {
      d.zodpovedne.push({
        stredisko, email: low(b.email),
        jmeno: jmenoPodleMailu(b.email) || String(b.jmeno || '').trim(),
        role: ROLE[b.role] ? b.role : 'reditel-strediska',
      });
    }
    save(d);
    logAct('vozidla', req, 'Zodpovědná osoba za středisko ' + stredisko + ': ' + (b.email || '— zrušeno'));
    synchronizujTag(d);
    json(res, 200, { ok: true });
    return true;
  }
  async function apiNastaveni(req, res) {
    if (!spravceModulu(req)) { json(res, 403, { chyba: 'Nastavení mění správce modulu.' }); return true; }
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load();
    if (b.prahKm != null) d.nastaveni.prahKm = Math.max(10000, Number(b.prahKm) || 250000);
    if (b.prahRoky != null) d.nastaveni.prahRoky = Math.max(1, Number(b.prahRoky) || 8);
    if (b.inventuraMesice != null) d.nastaveni.inventuraMesice = Math.max(1, Number(b.inventuraMesice) || 24);
    if (Array.isArray(b.kopieNa)) d.nastaveni.kopieNa = b.kopieNa.map(low).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (b.reditelEmail != null) {
      d.nastaveni.reditelEmail = low(b.reditelEmail);
      d.nastaveni.reditelJmeno = jmenoPodleMailu(b.reditelEmail) || String(b.reditelJmeno || '').trim();
    }
    if (b.rocniKm != null) d.nastaveni.rocniKm = Math.max(1000, Number(b.rocniKm) || 25000);
    if (b.rezervaProdej != null) d.nastaveni.rezervaProdej = Math.min(50, Math.max(0, Number(b.rezervaProdej) || 0));
    if (b.odpisLet != null) d.nastaveni.odpisLet = Math.max(1, Number(b.odpisLet) || 5);
    if (b.odkupEmail != null) d.nastaveni.odkupEmail = low(b.odkupEmail);
    if (b.trhZapnuto != null) d.nastaveni.trhZapnuto = !!b.trhZapnuto;
    if (b.trhObnovaDni != null) d.nastaveni.trhObnovaDni = Math.min(90, Math.max(1, Number(b.trhObnovaDni) || 7));
    if (b.cenyTypu && typeof b.cenyTypu === 'object') {
      Object.keys(CENY_TYPU).forEach((k) => {
        if (b.cenyTypu[k] == null) return;
        d.nastaveni.cenyTypu[k] = Math.max(0, Math.round(Number(String(b.cenyTypu[k]).replace(/\s/g, '')) || 0));
      });
    }
    save(d);
    json(res, 200, { ok: true, nastaveni: d.nastaveni });
    return true;
  }

  // ---- plán obměny (prodej / ekologická likvidace) a ceny ---------------------
  async function apiPlan(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiRozhodovat(v, r)) { json(res, 403, { chyba: 'O prodeji a vyřazení rozhoduje správce modulu nebo zodpovědná osoba za středisko.' }); return true; }
    const plan = PLANY[b.plan] ? b.plan : '';
    const zmena = (v.plan || '') !== plan;
    v.plan = plan;
    v.planOd = plan ? (zmena || !v.planOd ? Date.now() : v.planOd) : null;
    v.planKdo = plan ? (r.name || r.email) : '';
    v.planPozn = plan ? String(b.pozn == null ? (v.planPozn || '') : b.pozn).slice(0, 500) : '';
    save(d);
    logAct('vozidla', req, 'Plán u vozidla ' + (v.spz || v.vin) + ': ' + (plan ? PLANY[plan] : 'zrušen'));
    const popis = (v.spz || v.vin) + (v.znacka || v.model ? ' (' + [v.znacka, v.model].filter(Boolean).join(' ') + ')' : '');
    // Správce vozu se o plánovaném prodeji dozví první — může podat nabídku jako každý zaměstnanec.
    if (zmena && plan === 'prodej' && v.spravceEmail && low(v.spravceEmail) !== r.email) {
      const o = oceneniVozu(v, d.nastaveni);
      await mail(low(v.spravceEmail), 'Svěřené vozidlo ' + popis + ' je plánováno k prodeji',
        'Vozidlo ' + popis + ', které máte svěřené, je nově vedené jako plánovaný prodej'
        + (o.termin ? ' (termín obměny ' + oceneni.fmtMesic(o.termin) + ')' : '') + '.\n\n'
        + 'Firma ho nejdřív nabízí zaměstnancům k odkupu za cenu obvyklou'
        + (o.cenaZamestnanec ? ' ' + o.cenaZamestnanec.toLocaleString('cs-CZ') + ' Kč' : '') + '. '
        + 'Pokud máte zájem, podejte nabídku zde: https://intranet.elkoplast.cz/vozidla/odkup\n\n'
        + 'Rozhodl: ' + (r.name || r.email) + (b.pozn ? '\nPoznámka: ' + b.pozn : ''), 'souhrn');
    }
    json(res, 200, { ok: true, plan, oceneni: oceneniVozu(v, d.nastaveni) });
    return true;
  }
  async function apiCena(req, res) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load(), r = role(req);
    const v = d.vozidla.find(x => x.id === b.id);
    if (!v) { json(res, 404, { chyba: 'Vozidlo nenalezeno.' }); return true; }
    if (!smiRozhodovat(v, r)) { json(res, 403, { chyba: 'Ceny zadává správce modulu nebo zodpovědná osoba za středisko.' }); return true; }
    const cislo = x => { const n = Number(String(x == null ? '' : x).replace(/\s/g, '').replace(',', '.')); return n > 0 ? Math.round(n) : null; };
    // prázdné pole cenu SMAŽE (stejná past jako u roku výroby — nesmí se tiše vrátit k původní)
    if (b.porizovaciCena !== undefined) v.porizovaciCena = cislo(b.porizovaciCena);
    if (b.prodejniCena !== undefined) v.prodejniCena = cislo(b.prodejniCena);
    save(d);
    json(res, 200, { ok: true, oceneni: oceneniVozu(v, d.nastaveni) });
    return true;
  }

  // ---- odkup vozidel zaměstnanci ------------------------------------------------
  //  Vozy s plánem „prodej" vidí každý přihlášený zaměstnanec na /vozidla/odkup a může podat
  //  nabídku. Cena v nabídce = cena obvyklá (tržní): pod ní by šlo u zaměstnance o nepeněžní příjem.
  function apiOdkupData(req, res) {
    const d = load(), r = role(req);
    const vozy = vozyKOdkupu(d).map(v => Object.assign({}, v, { mojeVozidlo: !!r.email && v.spravceEmail === r.email }));
    const moje = d.odkup.filter(n => n.email === r.email);
    // nabídky k rozhodnutí: správce modulu všechny, zodpovědná osoba jen za svá střediska
    const rozhoduje = d.odkup.filter(n => { const v = d.vozidla.find(x => x.id === n.vozId); return v && smiRozhodovat(v, r); })
      .map(n => Object.assign({}, n, { kontakt: kontakt(n.email) }));
    json(res, 200, { vozy, moje, nabidky: (r.admin || r.zodpovedny) ? rozhoduje : undefined, ja: { email: r.email, jmeno: r.name } });
    return true;
  }
  async function apiOdkupPodat(req, res) {
    const d = load(), r = role(req);
    if (!r.email) { json(res, 401, { chyba: 'Přihlaste se do intranetu.' }); return true; }
    const b = JSON.parse(await host.readBody(req) || '{}');
    const vuz = vozyKOdkupu(d).find(v => v.id === b.id);
    if (!vuz) { json(res, 400, { chyba: 'Toto vozidlo není nabízeno k odkupu.' }); return true; }
    const cena = Number(String(b.cena == null ? '' : b.cena).replace(/\s/g, '').replace(',', '.'));
    if (!(cena > 0)) { json(res, 400, { chyba: 'Zadejte nabízenou cenu.' }); return true; }
    let n = d.odkup.find(x => x.vozId === vuz.id && x.email === r.email && x.stav === 'nova');   // jedna otevřená nabídka na vůz a zájemce
    if (n) { n.cena = Math.round(cena); n.pozn = String(b.pozn || '').trim().slice(0, 500); n.ts = Date.now(); }
    else {
      n = { id: 'n' + crypto.randomBytes(5).toString('hex'), vozId: vuz.id, spz: vuz.spz, email: r.email, jmeno: r.name || jmenoPodleMailu(r.email) || r.email,
        cena: Math.round(cena), pozn: String(b.pozn || '').trim().slice(0, 500), ts: Date.now(), stav: 'nova', mojeVozidlo: vuz.spravceEmail === r.email };
      d.odkup.push(n);
    }
    save(d);
    logAct('vozidla', req, 'Nabídka odkupu ' + vuz.spz + ': ' + n.cena.toLocaleString('cs-CZ') + ' Kč');
    const v = d.vozidla.find(x => x.id === vuz.id);
    const zod = d.zodpovedne.find(z => z.stredisko === v.stredisko);
    const komu = Array.from(new Set([zod && zod.email, d.nastaveni.odkupEmail].filter(Boolean).map(low)));
    if (komu.length) {
      await mail(komu.join(','), 'Nabídka odkupu vozidla ' + vuz.spz + ' — ' + n.cena.toLocaleString('cs-CZ') + ' Kč',
        (n.jmeno || n.email) + (n.mojeVozidlo ? ' (dosavadní správce vozu)' : '') + ' nabízí ' + n.cena.toLocaleString('cs-CZ') + ' Kč za vozidlo '
        + vuz.spz + (vuz.popis ? ' (' + vuz.popis + ')' : '') + '.\n'
        + 'Cena obvyklá: ' + (vuz.cena != null ? vuz.cena.toLocaleString('cs-CZ') + ' Kč' : 'nestanovena — doplňte pořizovací cenu u vozidla') + '\n'
        + (n.pozn ? 'Poznámka: ' + n.pozn + '\n' : '')
        + '\nNabídku přijmete nebo zamítnete v intranetu → Vozový park → Vyřazení a ocenění.');
    }
    json(res, 200, { ok: true, nabidka: n });
    return true;
  }
  async function apiOdkupStav(req, res) {
    const d = load(), r = role(req);
    const b = JSON.parse(await host.readBody(req) || '{}');
    const n = d.odkup.find(x => x.id === String(b.id || ''));
    if (!n) { json(res, 404, { chyba: 'Nabídka nenalezena.' }); return true; }
    const v = d.vozidla.find(x => x.id === n.vozId);
    if (!v || !smiRozhodovat(v, r)) { json(res, 403, { chyba: 'O nabídce rozhoduje správce modulu nebo zodpovědná osoba za středisko.' }); return true; }
    const stav = ['nova', 'prijata', 'zamitnuta'].indexOf(b.stav) >= 0 ? b.stav : null;
    if (!stav) { json(res, 400, { chyba: 'Neznámý stav nabídky.' }); return true; }
    n.stav = stav; n.stavTs = Date.now(); n.stavKdo = r.name || r.email;
    save(d);
    logAct('vozidla', req, 'Nabídka odkupu ' + n.spz + ' (' + n.jmeno + '): ' + stav);
    if (stav !== 'nova') {
      await mail(n.email, 'Vaše nabídka na odkup vozidla ' + n.spz + ' — ' + (stav === 'prijata' ? 'přijata' : 'zamítnuta'),
        'Vaše nabídka ' + n.cena.toLocaleString('cs-CZ') + ' Kč na odkup vozidla ' + n.spz + ' byla ' + (stav === 'prijata' ? 'PŘIJATA' : 'zamítnuta') + '.\n'
        + 'Rozhodl: ' + n.stavKdo + '\n\n' + (stav === 'prijata' ? 'Ozveme se vám kvůli kupní smlouvě a předání vozidla.' : 'Děkujeme za zájem.'), 'souhrn');
    }
    json(res, 200, { ok: true, nabidka: n });
    return true;
  }

  // ---- export --------------------------------------------------------------
  function apiExport(req, res) {
    const d = load(), r = role(req);
    const hl = ['SPZ', 'Značka', 'Model', 'VIN', 'Rok výroby', 'Typ', 'Stav', 'Středisko', 'Správce vozu', 'E-mail správce',
      'Zodpovědná osoba', 'STK do', 'Dní do STK', 'Poslední tachometr', 'Rok zápisu', 'Nájezd km/rok',
      'Poslední inventarizace', 'Doporučení prodeje', 'Termín vyřazení', 'Pořizovací cena', 'Zdroj pořizovací ceny',
      'Zůstatková cena', 'Tržní cena', 'Zdroj tržní ceny', 'Inzerce — počet', 'Inzerce — medián', 'Inzerce — rychlý prodej', 'Prodejní cena', 'Tržní − zůstatková', 'Plán'];
    const radky = viditelna(d, r).map(v => {
      const st = stavVozu(v, d.nastaveni), pk = posledniKm(v), o = oceneniVozu(v, d.nastaveni);
      const zod = d.zodpovedne.find(z => z.stredisko === v.stredisko);
      return [v.spz, v.znacka, v.model, v.vin, v.rokVyroby || '', TYPY[v.typ] || v.typ, STAVY[v.stav] || v.stav, v.stredisko,
        v.spravceJmeno, v.spravceEmail, zod ? zod.jmeno : '', v.stkDo || '', st.dnyStk == null ? '' : st.dnyStk,
        pk ? pk.km : '', pk ? pk.rok : '', st.prodej.najezd || '',
        st.inventura.posledni ? st.inventura.posledni.datum : 'nikdy', st.prodej.text,
        o.termin ? oceneni.fmtMesic(o.termin) : '', o.porizovaci || '', o.porizovaciZdroj || '',
        o.zustatkova == null ? '' : o.zustatkova, o.trzni == null ? '' : o.trzni, o.trzniZdroj || '',
        o.inzerce ? o.inzerce.n : '', o.inzerce ? o.inzerce.median : '', o.inzerce ? o.inzerce.rychly : '', o.prodejni == null ? '' : o.prodejni,
        o.rozdilZustatkova == null ? '' : o.rozdilZustatkova, PLANY[v.plan] || ''];
    });
    const csv = [hl].concat(radky).map(a => a.map(x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"').join(';')).join('\r\n');
    host.send(res, 200, '﻿' + csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="vozovy-park.csv"', 'Cache-Control': 'no-store',
    });
    return true;
  }

  // ---- směrnice ------------------------------------------------------------
  function smerniceHtml() {
    try { return fs.readFileSync(SMERNICE_FILE, 'utf8'); } catch (_) { return '<p>Text směrnice chybí.</p>'; }
  }
  // Směrnice publikovaná dřív, než modul uměl cílit, má prázdný okruh adresátů —
  // ve výběru příjemců pak není nikdo a štítek se nedá použít. Srovnáme to.
  function srovnejCileniSmernice() {
    if (!host.zalozSmernici) return;
    try { host.zalozSmernici({ title: 'Směrnice — svěřené služební vozidlo', html: smerniceHtml(), kategorie: 'Vozový park', assignTags: [TAG_SMERNICE], jenCileni: true }); }
    catch (_) {}
  }
  function apiSmernice(req, res) { htmlOut(res, 200, smerniceHtml()); return true; }
  async function apiSmerniceZalozit(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Směrnici zakládá správce intranetu.' }); return true; }
    if (!host.zalozSmernici) { json(res, 501, { chyba: 'Zakládání směrnic není z modulu dostupné.' }); return true; }
    try {
      const d = load();
      synchronizujTag(d);
      const adr = adresatiSmernice(d);
      const r = host.zalozSmernici({
        title: 'Směrnice — svěřené služební vozidlo',
        html: smerniceHtml(),
        kategorie: 'Vozový park',
        assignTags: [TAG_SMERNICE],
      });
      logAct('vozidla', req, 'Založena směrnice ke svěřenému vozidlu');
      const cile = ' na ' + adr.vse.length + ' lidí (' + adr.spravci.length + ' se svěřeným vozidlem + ' + adr.vedouci.length + ' vedoucích)';
      json(res, 200, { ok: true, id: r && r.id, adresatu: adr.vse.length,
        zprava: (r && r.jizByla
          ? (r.precileno ? 'Směrnice už mezi směrnicemi byla — přecílil jsem ji' + cile + '.' : 'Směrnice už mezi směrnicemi je, zacílená' + cile + '.')
          : 'Směrnice je založená a zacílená' + cile + '.')
          + ' V administraci → Směrnice si v dialogu Rozeslat vyber štítek „Svěřené vozidlo" a rozešli k seznámení.'
          + '\n\nPokud máš administraci otevřenou v jiné záložce, načti ji prosím znovu — jinak pracuje se starou kopií dat.' });
    } catch (e) { json(res, 500, { chyba: e.message }); }
    return true;
  }

  function logAct(typ, req, detail) {
    try {
      const e = host.empSession(req) || {};
      if (host.logActivity) host.logActivity(typ, { email: e.email || '', name: e.name || '' }, detail);
    } catch (_) {}
  }

  // ======================================================================
  //  UPOZORNĚNÍ — nástěnka intranetu a e-maily
  // ======================================================================
  // Dlaždice na nástěnku pro konkrétního člověka.
  function notifikace(email) {
    email = low(email); if (!email) return [];
    const d = load();
    const out = [];
    const moje = d.vozidla.filter(v => low(v.spravceEmail) === email && v.stav === 'aktivni');
    const strediska = mojeStrediska(d, email);
    const stred = strediska.length
      ? d.vozidla.filter(v => strediska.indexOf(v.stredisko) >= 0 && v.stav === 'aktivni' && low(v.spravceEmail) !== email)
      : [];
    moje.forEach(v => {
      const st = stavVozu(v, d.nastaveni);
      st.upozorneni.forEach(up => {
        if (up.druh === 'spravce') return;
        out.push({
          modul: 'vozidla', modulNazev: 'Vozový park', ikona: 'truck',
          text: (v.spz || v.vin) + ' — ' + up.text,
          sub: [v.znacka, v.model].filter(Boolean).join(' ') || 'svěřené vozidlo',
          urgent: !!up.urgent,
        });
      });
    });
    if (stred.length) {
      const problem = stred.filter(v => stavVozu(v, d.nastaveni).upozorneni.length);
      if (problem.length) out.push({
        modul: 'vozidla', modulNazev: 'Vozový park', ikona: 'truck',
        text: problem.length + (problem.length === 1 ? ' vozidlo ve středisku potřebuje pozornost' : problem.length < 5 ? ' vozidla ve středisku potřebují pozornost' : ' vozidel ve středisku potřebuje pozornost'),
        sub: problem.slice(0, 3).map(v => v.spz || v.vin).join(', '),
        urgent: problem.some(v => stavVozu(v, d.nastaveni).upozorneni.some(u => u.urgent)),
      });
    }
    // Odkup: vozy k prodeji vidí na nástěnce každý zaměstnanec; nové nabídky ten, kdo o nich rozhoduje.
    const kOdkupu = vozyKOdkupu(d);
    if (kOdkupu.length) out.push({
      modul: 'vozidla', modulNazev: 'Vozový park', ikona: 'truck',
      text: 'K odkupu zaměstnanci: ' + kOdkupu.map(v => v.spz + (v.cena ? ' za ' + v.cena.toLocaleString('cs-CZ') + ' Kč' : '')).join(', '),
      sub: 'nabídku podáte na intranet.elkoplast.cz/vozidla/odkup', url: '/vozidla/odkup', urgent: false,
    });
    const r0 = { email, admin: false, strediska };
    const nove = d.odkup.filter(n => n.stav === 'nova').filter(n => { const v = d.vozidla.find(x => x.id === n.vozId); return v && smiRozhodovat(v, r0); });
    if (nove.length) out.push({
      modul: 'vozidla', modulNazev: 'Vozový park', ikona: 'truck',
      text: nove.length + (nove.length === 1 ? ' nová nabídka' : nove.length < 5 ? ' nové nabídky' : ' nových nabídek') + ' na odkup vozidla čeká na rozhodnutí',
      sub: nove.slice(0, 3).map(n => n.spz + ' — ' + n.jmeno + ' ' + n.cena.toLocaleString('cs-CZ') + ' Kč').join(', '), urgent: false,
    });
    return out;
  }

  // E-maily: technická prohlídka, chybějící roční tachometr, inventarizace.
  // Dokud správce vozidlo nepotvrdil, přidáme do e-mailu možnost ho předat dál.
  function nezapomen(v) {
    return v.spravcePotvrzen ? ''
      : '\nPoznámka: vozidlo je na vás vedené podle firemní evidence. Pokud s ním fakticky jezdí někdo jiný, '
        + 'předejte ho v modulu tlačítkem „Předat jinému správci" — upomínky pak budou chodit jemu.\n';
  }
  async function tick() {
    const d = load();
    if (!d.vozidla.length) return;
    synchronizujTag(d);   // štítek pro rozeslání směrnice ať sedí, i když někdo přepsal stav zvenčí
    srovnejCileniSmernice();   // publikovaná směrnice bez cílení by nešla rozeslat
    const nast = d.nastaveni;
    const dnesStr = new Date().toISOString().slice(0, 10);
    let zmena = false;
    // Odešle upozornění nejvýš jednou za minDnu dní. Značku „odesláno" zapisujeme AŽ po
    // úspěšném odeslání — jinak by výpadek pošty upozornění navždy spolkl.
    const poslatJednou = async (klic, minDnu, to, predmet, text, rezim) => {
      const t = d.odeslano[klic];
      if (t && Date.now() - t < minDnu * DEN) return false;
      const ok = await mail(to, predmet, text, rezim);
      if (ok) { d.odeslano[klic] = Date.now(); zmena = true; }
      return ok;
    };
    // Porovnání s inzercí nezávisí na upomínkách — běží vždy, po malých dávkách.
    await trhTick(d);
    // Po hromadném importu evidence dáme lidem čas doplnit údaje, než začnou chodit upomínky.
    if (nast.upominkyOd && dnesStr < nast.upominkyOd) return;
    for (const v of d.vozidla) {
      if (v.stav !== 'aktivni') continue;
      const st = stavVozu(v, nast);
      const zod = d.zodpovedne.find(z => z.stredisko === v.stredisko);
      // Termíny a škody zajímají i vedoucího střediska; úkoly „doplň tachometr" a
      // „udělej inventarizaci" patří tomu, kdo vozidlo fakticky má — jinak by vedoucímu
      // chodil e-mail za každé auto ve středisku.
      const terminy = Array.from(new Set([v.spravceEmail, zod && zod.email].concat(nast.kopieNa).filter(Boolean).map(low)));
      const ukoly = Array.from(new Set([v.spravceEmail].concat(nast.kopieNa).filter(Boolean).map(low)));
      if (!terminy.length) continue;
      const popis = (v.spz || v.vin) + (v.znacka || v.model ? ' (' + [v.znacka, v.model].filter(Boolean).join(' ') + ')' : '');

      // 1) technická prohlídka
      if (st.dnyStk !== null) {
        const prah = (nast.upozorneniDny || []).filter(x => st.dnyStk <= x).sort((a, b) => a - b)[0];
        if (st.dnyStk >= 0 && prah !== undefined) {
          await poslatJednou('stk:' + v.id + ':' + prah, 300, terminy.join(','),
            'Technická prohlídka končí — ' + popis,
            'Vozidlu ' + popis + ' končí technická prohlídka ' + v.stkDo + ' (zbývá ' + st.dnyStk + ' dní).\n\n'
            + 'Správce vozu: ' + (v.spravceJmeno || v.spravceEmail || 'nepřidělen') + '\n'
            + 'Středisko: ' + (v.stredisko || '—') + (zod ? ' · zodpovídá ' + zod.jmeno : '') + '\n\n'
            + 'Po absolvování prohlídky ji prosím odškrtněte v intranetu → Vozový park (zapíše se nové datum platnosti).', 'souhrn');
        } else if (st.dnyStk < 0) {
          await poslatJednou('stk-po:' + v.id + ':' + dnesStr.slice(0, 7), 25, terminy.join(','),
            'PROPADLÁ technická prohlídka — ' + popis,
            'Vozidlo ' + popis + ' má propadlou technickou prohlídku (platila do ' + v.stkDo + ', tedy před ' + (-st.dnyStk) + ' dny).\n\n'
            + 'S propadlou prohlídkou nesmí vozidlo do provozu. Zajistěte prohlídku a zapište ji v intranetu → Vozový park.', 'hned');
        }
      }

      // 2) roční stav tachometru — připomínáme od ledna, pak jednou měsíčně
      if (st.chybejiciRoky.length && v.spravceEmail) {
        await poslatJednou('km:' + v.id + ':' + dnesStr.slice(0, 7), 25,
          [v.spravceEmail].concat(nast.kopieNa).join(','), 'Doplňte stav tachometru — ' + popis,
          'U svěřeného vozidla ' + popis + ' chybí letošní zápis stavu tachometru (rok ' + st.chybejiciRoky.join(', ') + ').\n\n'
          + 'Stačí opsat, kolik má vůz teď na tachometru: https://intranet.elkoplast.cz/#modul=vozidla → detail vozidla → Stav tachometru po letech.\n'
          + 'Zpětně nic dohledávat nemusíte — kolik se za rok najelo, spočítá systém z rozdílu proti loňskému zápisu.\n'
          + nezapomen(v), 'souhrn');
      }

      // 3) inventarizace svěřeného majetku (jednou za dva roky)
      if (st.inventura.potreba && v.spravceEmail) {
        await poslatJednou('inv:' + v.id + ':' + dnesStr.slice(0, 7), 25, ukoly.join(','),
          'Inventarizace svěřeného vozidla — ' + popis,
          'U vozidla ' + popis + ' je potřeba provést inventarizaci svěřeného majetku (' + st.inventura.text + ').\n\n'
          + 'Projděte vozidlo, doplňte stav tachometru, vyfoťte ho ze čtyř stran a zápis uložte zde:\n'
          + 'https://intranet.elkoplast.cz/#modul=vozidla → detail vozidla → Inventarizace svěřeného majetku.\n'
          + 'Inventarizace se dělá jednou za ' + (nast.inventuraMesice / 12) + ' roky.\n'
          + nezapomen(v), 'souhrn');
      }
    }
    if (zmena) save(d);
  }

  // Při startu si data načteme — tím proběhne i jednorázový import evidence z firemní tabulky.
  try { load(); } catch (e) { console.error('[vozidla] data se nepodařilo načíst:', e.message); }

  return { handle, tick, notifikace, hasAccess: (email) => {
    const d = load(); email = low(email);
    return d.vozidla.some(v => low(v.spravceEmail) === email) || d.zodpovedne.some(z => low(z.email) === email);
  } };
}

module.exports = { mount };

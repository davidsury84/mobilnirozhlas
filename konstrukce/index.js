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

const HTML_FILE = path.join(__dirname, 'konstrukce.html');

// ---- Stavy zakázky (kap. 4 dokumentu) --------------------------------------
const STAV = {
  novy:      { label: 'Nový',              onTurn: 'sef',        terminal: false },
  prace:     { label: 'V práci',           onTurn: 'konstrukter', terminal: false },
  kontrola:  { label: 'Interní kontrola',  onTurn: 'sef',        terminal: false },
  obchodnik: { label: 'U obchodníka',      onTurn: 'obchodnik',  terminal: false },
  klient:    { label: 'U klienta',         onTurn: 'obchodnik',  terminal: false }, // hlídá obchodník
  revize:    { label: 'Revize',            onTurn: 'konstrukter', terminal: false },
  podklady:  { label: 'Čeká na podklady',  onTurn: 'obchodnik',  terminal: false, hold: true },
  schvaleno: { label: 'Schváleno klientem', onTurn: null,        terminal: false },
  dokonceno: { label: 'Dokončeno',         onTurn: null,        terminal: true },
  zamitnuto: { label: 'Zamítnuto / Storno', onTurn: null,        terminal: true },
};

// ---- Výchozí číselník výrobků (seed) — vzorový ABROLL kontejner ------------
const SEED_TYPES = [{
  key: 'abroll',
  name: 'ABROLL kontejner (standardní)',
  standard: true,
  normohodiny: 8,
  revizeNh: 2,
  lhutaZkresleniDays: 3,
  lhutaRevizeDays: 2,
  lhutaPrideleniDays: 1,
  lhutaKontrolaDays: 1,
  lhutaObchodnikDays: 1,
  lhutaKlientDays: 5,
  internalCheck: true,
  linkValidDays: 30,
  params: [
    { label: 'Vnitřní délka', examples: '5000 / 5500 / 6000 / 6500 / 7000 mm' },
    { label: 'Výška bočnic', examples: '1000 – 2300 mm dle řady' },
    { label: 'Objem', examples: '8 – 38 m³ (dopočítá se z rozměrů)' },
    { label: 'Nosnost', examples: 'dle nosiče, např. 8 – 26 t' },
    { label: 'Výška háku', examples: '1570 mm (DIN 30722), příp. jiná' },
    { label: 'Zadní čelo', examples: 'dvoukřídlá vrata / sklopná klapka / kombinace' },
    { label: 'Materiál', examples: 'ocel S235 / S355; dno 4–5 mm, bočnice 3 mm' },
    { label: 'Povrchová úprava', examples: 'otryskání, základ + vrchní lak (RAL)' },
    { label: 'Doplňky', examples: 'plachta / síť, žebřík, rolny, úchyty, kapsa na dokumenty…' },
  ],
}];

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
  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); } catch (_) {}
    if (!d || typeof d !== 'object') d = {};
    if (typeof d.seq !== 'number') d.seq = 0;
    if (!d.roles || typeof d.roles !== 'object') d.roles = {};
    if (!d.fond || typeof d.fond !== 'object') d.fond = {};      // email -> hodin/týden
    if (!Array.isArray(d.types) || !d.types.length) d.types = JSON.parse(JSON.stringify(SEED_TYPES));
    if (!Array.isArray(d.zakazky)) d.zakazky = [];
    if (!Array.isArray(d.notif)) d.notif = [];
    return d;
  }
  function save(d) { fs.writeFileSync(DATA_F, JSON.stringify(d, null, 2)); }

  // ---- role a přístup ------------------------------------------------------
  function maModul(req) {
    if (host.isAdmin(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    try {
      if ((host.employeeModules(e.email) || []).includes('konstrukce')) return true;
    } catch (_) {}
    const d = load();
    return !!d.roles[(e.email || '').toLowerCase()];
  }
  // Efektivní role uživatele: admin vidí vše (sef+reditel+config); jinak z číselníku rolí.
  function roleOf(req) {
    const e = host.empSession(req);
    const isAdm = host.isAdmin(req);
    const email = e ? (e.email || '').toLowerCase() : '';
    const d = load();
    const r = email ? (d.roles[email] || '') : '';
    return { email, name: e ? e.name : '', isAdmin: isAdm, role: r };
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
    return '';
  }
  function semafor(z) {
    const st = STAV[z.stav];
    if (!st || st.terminal || st.hold || z.stav === 'schvaleno') return 'none';
    if (!z.deadline || !z.stepStartedAt) return 'green';
    const now = Date.now();
    if (now > z.deadline) return 'red';
    const total = z.deadline - z.stepStartedAt;
    const elapsed = now - z.stepStartedAt;
    if (total > 0 && elapsed >= 0.8 * total) return 'amber';
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
    const dayMap = {
      novy: t.lhutaPrideleniDays, prace: t.lhutaZkresleniDays, kontrola: t.lhutaKontrolaDays,
      obchodnik: t.lhutaObchodnikDays, klient: t.lhutaKlientDays, revize: t.lhutaRevizeDays,
    };
    const days = dayMap[stav];
    z.deadline = days ? addBusinessDays(Date.now(), days) : null;
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
      else list = [];
    }
    const view = list.map(z => publicShape(d, z, me)).sort((a, b) => b.createdAt - a.createdAt);

    // kapacitní přehled konstruktérů (pro šéfa/admin)
    let kapacita = null;
    if (me.isAdmin || me.role === 'sef') kapacita = capacityOverview(d);

    const myNotif = d.notif.filter(n => n.email === me.email);
    json(res, 200, {
      me: { email: me.email, name: me.name, isAdmin: me.isAdmin, role: me.role || (me.isAdmin ? 'admin' : '') },
      zakazky: view,
      types: d.types,
      kapacita,
      konstrukteri: employeesWithRole('konstrukter').map(em => ({ email: em, name: empName(em) })),
      roles: (me.isAdmin) ? adminRolesTable(d) : undefined,
      notif: myNotif.slice(0, 40),
      notifUnread: myNotif.filter(n => !n.read).length,
      now: Date.now(),
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
  function adminRolesTable(d) {
    // všichni zaměstnanci intranetu + jejich role v modulu
    let emps = [];
    try { emps = (host.getState().employees || []).map(e => ({ email: (e.email || '').toLowerCase(), name: e.name || e.email })); } catch (_) {}
    // doplníme i ty, co mají roli, ale nejsou v seznamu
    Object.keys(d.roles).forEach(em => { if (!emps.find(x => x.email === em)) emps.push({ email: em, name: empName(em) }); });
    return emps.filter(e => e.email).map(e => ({ email: e.email, name: e.name, role: d.roles[e.email] || '', fond: d.fond[e.email] || null }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
  }

  // Tvar zakázky pro frontend (bez interních tajností klienta se řeší v public části).
  function publicShape(d, z, me) {
    const t = typeOf(d, z.typKey);
    const cur = CURRENT_V(z);
    const totalSec = (z.timeEntries || []).reduce((s, e) => s + (e.seconds || 0), 0);
    const myTimer = z.activeTimer && me && z.activeTimer.user === me.email ? z.activeTimer : null;
    return {
      id: z.id, cislo: z.cislo, createdAt: z.createdAt,
      typKey: z.typKey, typName: t.name,
      zakaznik: z.zakaznik, kontakt: z.kontakt, kontaktEmail: z.kontaktEmail,
      cisloPoptavky: z.cisloPoptavky, pozadovanyTermin: z.pozadovanyTermin || null,
      params: z.params || {},
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
      holdReason: z.holdReason || '', prevStav: z.prevStav || '',
      clientDecision: z.clientDecision || null,
      audit: z.audit || [],
    };
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
      zakaznik, kontakt: String(b.kontakt || '').trim(), kontaktEmail: String(b.kontaktEmail || '').trim(),
      cisloPoptavky: String(b.cisloPoptavky || '').trim(),
      pozadovanyTermin: b.pozadovanyTermin ? String(b.pozadovanyTermin).slice(0, 10) : null,
      stav: 'novy', versions: [], comments: [], timeEntries: [], activeTimer: null,
      assignedTo: '', link: null, revisionCount: 0, audit: [],
    };
    enterState(d, z, 'novy');
    audit(z, me.email, 'Založení požadavku', 'typ: ' + t.name);
    d.zakazky.push(z);
    // kontrola realizovatelnosti požadovaného termínu (aprox z výchozích lhůt)
    let warn = null;
    if (z.pozadovanyTermin) {
      const internalDays = (t.lhutaPrideleniDays + t.lhutaZkresleniDays + (t.internalCheck ? t.lhutaKontrolaDays : 0) + t.lhutaObchodnikDays);
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
      case 'dokoncit': { // schválený výkres → dokončeno (archiv/výroba)
        if (!(isSef || isObch)) { err = 'Dokončit smí šéf konstrukce nebo obchodník.'; break; }
        if (z.stav !== 'schvaleno') { err = 'Dokončit lze jen schválenou zakázku.'; break; }
        z.stav = 'dokonceno'; z.deadline = null; z.closedAt = Date.now();
        if (z.link) z.link.active = false;
        audit(z, me.email, 'Dokončeno', note);
        break;
      }
      default: err = 'Neznámá akce „' + action + '".';
    }
    if (err) { json(res, 400, { chyba: err }); return true; }
    save(d);
    json(res, 200, { ok: true });
    return true;
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
    else if (['obchodnik', 'sef', 'konstrukter', 'reditel'].includes(role)) d.roles[email] = role;
    else { json(res, 400, { chyba: 'Neplatná role.' }); return true; }
    save(d);
    json(res, 200, { ok: true, roles: adminRolesTable(d) });
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
    const numFields = ['normohodiny', 'revizeNh', 'lhutaZkresleniDays', 'lhutaRevizeDays', 'lhutaPrideleniDays', 'lhutaKontrolaDays', 'lhutaObchodnikDays', 'lhutaKlientDays', 'linkValidDays'];
    t.name = String(b.name || t.name || key).slice(0, 120);
    t.standard = !!b.standard;
    t.internalCheck = b.internalCheck !== false;
    numFields.forEach(f => { if (b[f] != null && !isNaN(parseInt(b[f], 10))) t[f] = parseInt(b[f], 10); });
    ['lhutaPrideleniDays', 'lhutaKontrolaDays', 'lhutaObchodnikDays', 'lhutaKlientDays'].forEach(f => { if (t[f] == null) t[f] = SEED_TYPES[0][f]; });
    if (Array.isArray(b.params)) t.params = b.params.slice(0, 40).map(pp => ({ label: String(pp.label || '').slice(0, 80), examples: String(pp.examples || '').slice(0, 200) })).filter(pp => pp.label);
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
    for (const z of d.zakazky) {
      const st = STAV[z.stav];
      if (!st || st.terminal || st.hold || z.stav === 'schvaleno') continue;
      if (!z.esc) z.esc = { key: z.stav + ':' + z.versions.length };
      const stepKey = z.stav + ':' + z.versions.length;
      if (z.esc.key !== stepKey) z.esc = { key: stepKey };

      // --- klient nereaguje (5 / 10 pracovních dnů) ---
      if (z.stav === 'klient' && z.stepStartedAt) {
        const bdays = businessDaysBetween(z.stepStartedAt, now);
        if (bdays >= 5 && !z.esc.klient5) {
          z.esc.klient5 = true; changed = true;
          notify(d, z.obchodnikEmail, 'Klient nereaguje na náhled ' + z.cislo + ' 5 prac. dnů — odeslána připomínka.', z.id);
          if (z.kontaktEmail && z.link && z.link.active) {
            const base = host.mailFrom && host.mailFrom.publicUrl ? host.mailFrom.publicUrl : '';
            mail(z.kontaktEmail, 'Připomenutí — výkres ke schválení · ' + z.cislo, 'Dobrý den,\n\ndovolujeme si připomenout výkres ke schválení k zakázce ' + z.cislo + '.\nOdkaz: ' + base + '/konstrukce/nahled/' + z.link.token + '\n\nDěkujeme.');
          }
        }
        if (bdays >= 10 && !z.esc.klient10) {
          z.esc.klient10 = true; changed = true;
          notify(d, z.obchodnikEmail, 'ÚKOL: Klient nereaguje 10 prac. dnů na ' + z.cislo + ' — kontaktujte ho telefonicky.', z.id);
          mail(z.obchodnikEmail, 'Klient nereaguje 10 dnů · ' + z.cislo, 'Klient nereaguje na náhled výkresu ' + z.cislo + ' už 10 pracovních dnů. Kontaktujte ho prosím telefonicky.');
        }
        continue;
      }

      if (!z.deadline) continue;
      const resp = responsibleEmail(z);
      // --- 80 % lhůty (oranžová, app-notifikace odpovědné osobě) ---
      if (z.stepStartedAt && z.deadline > z.stepStartedAt) {
        const frac = (now - z.stepStartedAt) / (z.deadline - z.stepStartedAt);
        if (frac >= 0.8 && now < z.deadline && !z.esc.warned80) {
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
          const text = 'Zakázka ' + z.cislo + ' (' + z.zakaznik + ') překročila termín kroku „' + st.label + '" (' + fmtDate(z.deadline) + ').\nOdpovědná osoba: ' + (empName(resp) || '—') + '.';
          komu.forEach(em => mail(em, 'Po termínu · ' + z.cislo, text));
        }
        // --- D+1 a dále: denní souhrn řediteli ---
        overdueForDirector.push(z);
      }
    }

    // denní souhrn řediteli (jednou za den, jsou-li zpožděné zakázky ≥ 1 den)
    if (overdueForDirector.length) {
      const readyForDigest = overdueForDirector.filter(z => z.esc && z.esc.overdueDay && z.esc.overdueDay !== fmtDate(now));
      const today = fmtDate(now);
      if (readyForDigest.length && d._lastDirectorDigest !== today) {
        d._lastDirectorDigest = today; changed = true;
        const lines = readyForDigest.map(z => '• ' + z.cislo + ' (' + z.zakaznik + ') — „' + STAV[z.stav].label + '", termín byl ' + fmtDate(z.deadline) + ', odpovídá ' + (empName(responsibleEmail(z)) || '—')).join('\n');
        const text = 'Přehled zpožděných zakázek konstrukce k ' + today + ':\n\n' + lines;
        employeesWithRole('reditel').forEach(em => { notify(d, em, readyForDigest.length + ' zpožděných zakázek konstrukce.', null); mail(em, 'Zpožděné zakázky konstrukce · ' + today, text); });
      }
    }

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

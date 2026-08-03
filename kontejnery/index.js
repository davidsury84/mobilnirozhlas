'use strict';
// ============================================================================
//  Modul „Lodní kontejnery" — veřejný prezentační web + poptávky do intranetu
// ============================================================================
//  Veřejná stránka (/kontejnery, bez přihlášení) promuje prodej/pronájem lodních
//  kontejnerů ELKOPLAST CZ a obsahuje nezávazný poptávkový formulář. Poptávky
//  padají do evidence v intranetu (data/kontejnery-poptavky.json). Správce v
//  intranetu přiřadí konkrétního obchodníka, který tvoří nabídku; obchodník i
//  správce vidí poptávky a mění stav. Nová poptávka chodí e-mailem určeným
//  příjemcům (výběr správcem), přiřazení obchodník dostane e-mail o přidělení.
//
//  Mount v server.js (jako reklamace):
//    const kontejnery = require('./kontejnery').mount({ send, readBody, deliver,
//      empSession, isAdmin, baseUrl, employeeModules, getState, logActivity,
//      dataDir, mailFrom });
//    if (kontejnery && await kontejnery.handle(req, res)) return;
//
//  Veřejné cesty (/kontejnery GET, /api/kontejnery/poptavka POST) musí být v
//  server.js vyjmuté z přihlašovací závory (proměnná kontejneryPublic).
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');

const STAVY = {
  nova: 'Nová',
  vresenu: 'V řešení',
  nabidka: 'Nabídka odeslána',
  uzavreno: 'Uzavřeno (objednáno)',
  zamitnuto: 'Zamítnuto / ztraceno',
};
// Typy kontejnerů nabízené ve formuláři (kvůli konzistenci evidence).
const TYPY = ['20′ skladový', '40′ skladový', '20′ High Cube', '40′ High Cube', 'Chladírenský (reefer)', 'Kancelářský / obytný', 'Na míru / poradit'];
// Obchodníci, kteří mohou být přiřazeni k poptávce lodních kontejnerů (dohledáni v DB zaměstnanců podle jména).
const OBCHODNICI_JMENA = ['Jana Rychlíková', 'Josef Beránek'];
const REZIM = ['Koupě', 'Pronájem', 'Ještě nevím'];
// Google tabulka, kam padají poptávky (i z Meta lead reklam). ID lze přepsat proměnnou.
const SHEET_ID_DEFAULT = process.env.KONTEJNERY_SHEET_ID || '11SjL5D9-S0HG0D4zNE5eS0zU-uC2U64GcL4Pgqnm4pk';
const SHEET_RANGE = 'A1:Z10000';
// Výchozí příjemci týdenního reportu (odeslané + nevyřízené nabídky). Odpovědné osoby = obchodníci na střídačku.
const REPORT_TO_DEFAULT = [{ email: 'david.sury@elkoplast.cz', name: 'David Surý' }, { email: 'tomas.bursa@elkoplast.cz', name: 'Tomáš Burša' }];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'kontejnery-poptavky.json');

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- perzistence ----
  function load() {
    let db;
    try { const j = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); db = (j && Array.isArray(j.items)) ? j : { items: [], seq: 0 }; }
    catch (_) { db = { items: [], seq: 0 }; }
    if (!db.config) db.config = { notify: [] };
    if (!Array.isArray(db.config.notify)) db.config.notify = [];
    if (!Array.isArray(db.config.fotky)) db.config.fotky = [];
    if (!Array.isArray(db.config.rotace)) db.config.rotace = [];   // obchodníci na střídačku (round-robin)
    if (typeof db.config.rotaceIdx !== 'number') db.config.rotaceIdx = 0;
    if (!Array.isArray(db.config.dohled)) db.config.dohled = [];   // kopie všech poptávek (kontrola)
    // Google tabulka poptávek + týdenní report
    if (typeof db.config.sheetId !== 'string') db.config.sheetId = SHEET_ID_DEFAULT;
    if (!Array.isArray(db.config.leadKeys)) db.config.leadKeys = [];   // deduplikace importovaných řádků
    if (!db.config.report || typeof db.config.report !== 'object') db.config.report = { enabled: true, weekday: 1, to: [], lastWeek: '' };
    if (typeof db.config.report.enabled !== 'boolean') db.config.report.enabled = true;
    if (typeof db.config.report.weekday !== 'number') db.config.report.weekday = 1;   // pondělí
    if (!Array.isArray(db.config.report.to)) db.config.report.to = [];
    if (!db.config._reportSeeded) { db.config.report.to = REPORT_TO_DEFAULT.slice(); db.config._reportSeeded = true; }
    return db;
  }
  function save(db) { try { fs.writeFileSync(DATA_F, JSON.stringify(db, null, 2)); } catch (e) { console.error('[kontejnery] zápis selhal:', e.message); } }

  // ---- role ----
  function mods(email) { try { return host.employeeModules(email) || []; } catch (_) { return []; } }
  function meOf(req) {
    const e = host.empSession(req);
    const email = e ? (e.email || '').toLowerCase() : '';
    const admin = host.isAdmin(req);
    const m = email ? mods(email) : [];
    const isObchodnik = admin || m.indexOf('obchod') >= 0 || m.indexOf('obchodexp') >= 0 || isHandler(email);
    return { email, name: e ? (e.name || '') : (admin ? 'Správce' : ''), isAdmin: admin, isObchodnik };
  }
  // Zaměstnanec, který má co dělat s kontejnerovými poptávkami (viditelnost dlaždice a přístup):
  // je v seznamu notifikací (výchozí příjemce) NEBO má přiřazenou nějakou poptávku.
  function isHandler(email) {
    email = (email || '').toLowerCase(); if (!email) return false;
    const db = load();
    if (db.config.notify.some(n => (n.email || '').toLowerCase() === email)) return true;
    return db.items.some(x => x.obchodnik && (x.obchodnik.email || '').toLowerCase() === email);
  }
  function employeesForPicker() {
    let emps = [];
    try { const s = host.getState ? host.getState() : null; emps = (s && s.employees) || []; } catch (_) {}
    return emps.map(e => ({ email: (e.email || '').toLowerCase(), name: e.name || e.email || '' }))
      .filter(e => e.email).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  }
  // Obchodníci pro přiřazení k poptávce = jen jmenovaní (OBCHODNICI_JMENA), dohledaní v DB (celé jméno + e-mail).
  function normJm(s) { return String(s || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ').trim(); }
  function obchodniciPicker() {
    const emps = employeesForPicker();
    const out = [];
    OBCHODNICI_JMENA.forEach((cil) => {
      const toks = normJm(cil).split(' ').filter(Boolean);
      const found = emps.find(e => toks.every(t => normJm(e.name).indexOf(t) >= 0));
      if (found && !out.some(x => x.email === found.email)) out.push(found);
    });
    return out;
  }

  // ---- e-mail ----
  function mailHtml(text) {
    const safe = esc(text).replace(/\n/g, '<br>');
    return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1c1d1a;line-height:1.6">' + safe +
      '<hr style="border:0;border-top:1px solid #e6e9e3;margin:18px 0"><div style="font-size:12px;color:#8a938a">Intranet ELKOPLAST CZ · Lodní kontejnery</div></div>';
  }
  async function notify(to, subject, text) {
    if (!to || !host.deliver || !host.mailFrom || !host.mailFrom.user) return;
    try { await host.deliver({ to, fromAddr: host.mailFrom.user, fromName: host.mailFrom.name || 'ELKOPLAST — kontejnery', subject, text, html: mailHtml(text) }); }
    catch (e) { console.error('[kontejnery] e-mail neodeslán (' + to + '):', e.message); }
  }
  function logAct(type, who, detail) { try { if (host.logActivity) host.logActivity(type, who, detail); } catch (_) {} }
  function baseUrlOf(req) { try { return host.baseUrl(req).replace(/\/$/, ''); } catch (_) { return ''; } }

  // ======================================================================
  //  KLIENTSKÁ DOMÉNA (lodaky.elkoplast.cz) — běží PŘED přihlašovací závorou.
  //  Na této doméně servírujeme jen prezentační web + příjem poptávky; nic z
  //  intranetu se sem nedostane (bezpečné oddělení klientů od interní aplikace).
  // ======================================================================
  // ======================================================================
  //  ROUTER
  // ======================================================================
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (!p.startsWith('/api/kontejnery')) return false;

    // -------- SERVER-TO-SERVER (Bearer = SSO tajemství): z aplikace lodni-kontejnery --------
    if (p === '/api/kontejnery/ingest' && req.method === 'POST') return apiIngest(req, res);
    if (p === '/api/kontejnery/detail' && req.method === 'GET') return apiDetail(req, res);
    if (p === '/api/kontejnery/nabidka-ext' && req.method === 'POST') return apiNabidkaExt(req, res);
    if (p === '/api/kontejnery/nastaveni-ext' && req.method === 'GET') return apiCfgGetExt(req, res);
    if (p === '/api/kontejnery/nastaveni-ext' && req.method === 'POST') return apiCfgSetExt(req, res);

    // -------- INTERNÍ: rozdělovník poptávek (vyžaduje přístup obchodníka) --------
    const me = meOf(req);
    if (!me.isObchodnik) { json(res, 403, { chyba: 'K poptávkám kontejnerů nemáte přístup.' }); return true; }
    try {
      if (p === '/api/kontejnery/me' && req.method === 'GET') return apiMe(req, res);
      if (p === '/api/kontejnery' && req.method === 'GET') return apiList(req, res);
      if (p === '/api/kontejnery/prirad' && req.method === 'POST') return apiPrirad(req, res);
      if (p === '/api/kontejnery/smazat' && req.method === 'POST') return apiSmazat(req, res);
      if (p === '/api/kontejnery/nastaveni' && req.method === 'GET') return apiCfgGet(req, res);
      if (p === '/api/kontejnery/nastaveni' && req.method === 'POST') return apiCfgSet(req, res);
    } catch (e) {
      console.error('[kontejnery] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }
    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  // ======================================================================
  //  VEŘEJNÉ API — odeslání poptávky
  // ======================================================================
  async function apiPoptavka(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const jmeno = String(b.jmeno || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().slice(0, 160);
    const telefon = String(b.telefon || '').trim().slice(0, 60);
    if (!jmeno || (!email && !telefon)) { json(res, 400, { chyba: 'Vyplňte jméno a e-mail nebo telefon.' }); return true; }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { json(res, 400, { chyba: 'Neplatný e-mail.' }); return true; }
    if (String(b.web || '').trim()) { json(res, 200, { ok: true }); return true; } // honeypot: tvař se OK, nic neukládej
    const db = load();
    db.seq = (db.seq || 0) + 1;
    const now = Date.now();
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      cislo: db.seq,
      jmeno, firma: String(b.firma || '').trim().slice(0, 160),
      email, telefon,
      typ: TYPY.indexOf(String(b.typ || '')) >= 0 ? b.typ : (String(b.typ || '').trim().slice(0, 80) || null),
      rezim: REZIM.indexOf(String(b.rezim || '')) >= 0 ? b.rezim : null,
      mesto: String(b.mesto || '').trim().slice(0, 120),
      pocet: (b.pocet === '' || b.pocet == null || isNaN(Number(b.pocet))) ? null : Math.max(1, Math.round(Number(b.pocet))),
      zprava: String(b.zprava || '').trim().slice(0, 4000),
      cenaOd: (b.cenaOd == null || isNaN(Number(b.cenaOd))) ? null : Math.round(Number(b.cenaOd)),
      cenaDo: (b.cenaDo == null || isNaN(Number(b.cenaDo))) ? null : Math.round(Number(b.cenaDo)),
      konfigurace: String(b.konfigurace || '').trim().slice(0, 300) || null,
      stav: 'nova', obchodnik: null,
      createdAt: now, updatedAt: now,
      historie: [{ stav: 'nova', note: 'Poptávka z webu', by: { name: jmeno }, at: now }],
    };
    // Automatické přiřazení obchodníka na střídačku (round-robin).
    let prideleno = null;
    if (db.config.rotace.length) {
      const n = db.config.rotace.length;
      const idx = ((db.config.rotaceIdx % n) + n) % n;
      const o = db.config.rotace[idx];
      db.config.rotaceIdx = idx + 1;
      if (o && o.email) {
        item.obchodnik = { email: (o.email || '').toLowerCase(), name: o.name || o.email };
        prideleno = item.obchodnik;
        item.historie.push({ stav: 'nova', note: 'Automaticky přiřazeno (střídačka): ' + item.obchodnik.name, by: { name: 'systém' }, at: now });
      }
    }
    db.items.push(item);
    save(db);
    logAct('kontejnery', { email, name: jmeno }, 'Nová poptávka kontejneru #' + item.cislo + (item.typ ? ' · ' + item.typ : '') + (prideleno ? ' → ' + prideleno.name : ''));
    const link = baseUrlOf(req) + '/#modul=kontejnery';
    const text = 'Nová poptávka lodního kontejneru z webu (#' + item.cislo + '):\n\n'
      + '• Jméno: ' + jmeno + (item.firma ? ' (' + item.firma + ')' : '') + '\n'
      + (email ? '• E-mail: ' + email + '\n' : '')
      + (telefon ? '• Telefon: ' + telefon + '\n' : '')
      + (item.typ ? '• Typ: ' + item.typ + '\n' : '')
      + (item.rezim ? '• Režim: ' + item.rezim + '\n' : '')
      + (item.pocet ? '• Počet: ' + item.pocet + ' ks\n' : '')
      + (item.mesto ? '• Místo: ' + item.mesto + '\n' : '')
      + (item.zprava ? '• Zpráva: ' + item.zprava + '\n' : '')
      + (prideleno ? '\n→ Přiřazeno (na střídačku): ' + prideleno.name + '\n' : '')
      + '\nDetail v intranetu → Poptávky:\n' + link;
    // Příjemci e-mailu: přiřazený obchodník + dohled (kopie ke kontrole) + obecní notify. Deduplikace.
    const prijemci = [];
    const addRec = (o) => { const e = (o && o.email || '').toLowerCase(); if (e && prijemci.indexOf(e) < 0) prijemci.push(e); };
    if (prideleno) addRec(prideleno);
    (db.config.dohled || []).forEach(addRec);
    (db.config.notify || []).forEach(addRec);
    for (const e of prijemci) await notify(e, 'Nová poptávka kontejneru #' + item.cislo + (prideleno ? ' — ' + prideleno.name : ''), text);
    json(res, 200, { ok: true, cislo: item.cislo, prideleno: prideleno ? prideleno.name : null });
    return true;
  }

  // ======================================================================
  //  INTERNÍ API
  // ======================================================================
  function apiMe(req, res) {
    const me = meOf(req);
    json(res, 200, { email: me.email, name: me.name, isAdmin: me.isAdmin, isObchodnik: me.isObchodnik, stavy: STAVY, typy: TYPY, employees: obchodniciPicker() });
    return true;
  }
  function apiList(req, res) {
    const me = meOf(req);
    const db = load();
    let items = db.items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    json(res, 200, { items, stavy: STAVY, role: { isAdmin: me.isAdmin, isObchodnik: me.isObchodnik }, me: { email: me.email, name: me.name }, employees: obchodniciPicker(), notify: db.config.notify });
    return true;
  }
  async function apiPrirad(req, res) {
    const me = meOf(req);
    if (!me.isObchodnik) { json(res, 403, { chyba: 'Nemáte oprávnění.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load();
    const it = db.items.find(x => x.id === String(b.id || ''));
    if (!it) { json(res, 404, { chyba: 'Poptávka nenalezena.' }); return true; }
    const now = Date.now();
    let zmena = [];
    // Přiřazení obchodníka — jen správce.
    if (b.obchodnik !== undefined) {
      if (!me.isAdmin) { json(res, 403, { chyba: 'Obchodníka přiřazuje jen správce.' }); return true; }
      const email = (typeof b.obchodnik === 'string' ? b.obchodnik : (b.obchodnik && b.obchodnik.email) || '').toLowerCase();
      if (!email) { it.obchodnik = null; zmena.push('obchodník odebrán'); }
      else {
        const emp = employeesForPicker().find(e => e.email === email);
        it.obchodnik = { email, name: (emp && emp.name) || email };
        zmena.push('přiřazen ' + it.obchodnik.name);
      }
    }
    const note = String(b.note || '').trim();
    if (b.stav !== undefined) {
      if (!STAVY[b.stav]) { json(res, 400, { chyba: 'Neznámý stav.' }); return true; }
      it.stav = b.stav; zmena.push('stav → ' + STAVY[b.stav]);
    }
    if (!zmena.length && !note) { json(res, 400, { chyba: 'Nic ke změně.' }); return true; }
    it.updatedAt = now;
    it.historie = it.historie || [];
    it.historie.push({ stav: it.stav, note: (zmena.join(', ') + (note ? ' — ' + note : '')).trim(), by: { email: me.email, name: me.name }, at: now });
    save(db);
    logAct('kontejnery', { email: me.email, name: me.name }, 'Poptávka #' + it.cislo + ': ' + zmena.join(', '));
    // notifikace nově přiřazenému obchodníkovi
    if (b.obchodnik !== undefined && it.obchodnik && it.obchodnik.email) {
      const link = baseUrlOf(req) + '/#modul=kontejnery';
      await notify(it.obchodnik.email, 'Přiřazena poptávka kontejneru #' + it.cislo,
        'Dobrý den,\n\nbyla vám přiřazena poptávka lodního kontejneru #' + it.cislo + ':\n\n'
        + '• Zákazník: ' + it.jmeno + (it.firma ? ' (' + it.firma + ')' : '') + '\n'
        + (it.email ? '• E-mail: ' + it.email + '\n' : '') + (it.telefon ? '• Telefon: ' + it.telefon + '\n' : '')
        + (it.typ ? '• Typ: ' + it.typ + '\n' : '') + (it.rezim ? '• Režim: ' + it.rezim + '\n' : '')
        + (it.zprava ? '• Zpráva: ' + it.zprava + '\n' : '')
        + '\nZpracujte nabídku a aktualizujte stav v intranetu → Lodní kontejnery:\n' + link);
    }
    json(res, 200, { ok: true, item: it });
    return true;
  }
  // ---- kalkulace / nabídka (obchodník sestaví položky + ceny a odešle klientovi) ----
  function pocitejNabidku(radky, dph) {
    const r = (Array.isArray(radky) ? radky : []).map(x => {
      const popis = String((x && x.popis) || '').trim().slice(0, 300);
      const pocet = Math.max(0, Number(x && x.pocet) || 0);
      const cena = Math.max(0, Number(x && x.cena) || 0);
      return { popis, pocet, cena, radek: Math.round(pocet * cena * 100) / 100 };
    }).filter(x => x.popis || x.radek);
    const zaklad = Math.round(r.reduce((s, x) => s + x.radek, 0) * 100) / 100;
    const sazba = Math.max(0, Number(dph) || 0);
    const dphCastka = Math.round(zaklad * sazba / 100 * 100) / 100;
    return { radky: r, zaklad, dph: sazba, dphCastka, celkem: Math.round((zaklad + dphCastka) * 100) / 100 };
  }
  function fmtKc(n) { return (Math.round(n * 100) / 100).toLocaleString('cs-CZ') + ' Kč'; }
  // Bearer ověření (server-to-server z aplikace lodni-kontejnery).
  function bearerOk(req) {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth || !host.ssoSecret) return false;
    try { return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(String(host.ssoSecret))); } catch (_) { return false; }
  }
  // Ingest poptávky z klientské aplikace (push).
  async function apiIngest(req, res) {
    if (!bearerOk(req)) { json(res, 401, { chyba: 'Neplatné tajemství.' }); return true; }
    return apiPoptavka(req, res);
  }
  // Detail poptávky pro nástroj obchodníka v aplikaci.
  function apiDetail(req, res) {
    if (!bearerOk(req)) { json(res, 401, { chyba: 'Neplatné tajemství.' }); return true; }
    const u = urlLib.parse(req.url, true);
    const it = load().items.find(x => x.id === String(u.query.id || ''));
    if (!it) { json(res, 404, { chyba: 'Poptávka nenalezena.' }); return true; }
    json(res, 200, { item: it, stavy: STAVY }); return true;
  }
  // Odeslání nabídky z nástroje obchodníka (aplikace) — počítá, e-mailuje klientovi, aktualizuje poptávku.
  async function apiNabidkaExt(req, res) {
    if (!bearerOk(req)) { json(res, 401, { chyba: 'Neplatné tajemství.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    return _applyNabidka(res, b, b.by || {});
  }
  async function _applyNabidka(res, b, by) {
    const db = load();
    const it = db.items.find(x => x.id === String(b.id || ''));
    if (!it) { json(res, 404, { chyba: 'Poptávka nenalezena.' }); return true; }
    const calc = pocitejNabidku(b.radky, b.dph);
    if (!calc.radky.length) { json(res, 400, { chyba: 'Nabídka nemá žádné položky.' }); return true; }
    const now = Date.now();
    const send = !!b.send;
    const byWho = { email: (by && by.email) || '', name: (by && by.name) || '' };
    it.nabidka = { radky: calc.radky, zaklad: calc.zaklad, dph: calc.dph, dphCastka: calc.dphCastka, celkem: calc.celkem, mena: 'Kč', poznamka: String(b.poznamka || '').trim().slice(0, 2000), platnost: String(b.platnost || '').trim().slice(0, 60), by: byWho, updatedAt: now, odeslano: it.nabidka && it.nabidka.odeslano || false, odeslanoAt: it.nabidka && it.nabidka.odeslanoAt || null };
    let odeslano = false;
    if (send) {
      if (!it.email) { json(res, 400, { chyba: 'Poptávka nemá e-mail klienta — nabídku nelze odeslat.' }); return true; }
      const radkyText = calc.radky.map(r => '• ' + r.popis + '  —  ' + r.pocet + ' × ' + fmtKc(r.cena) + ' = ' + fmtKc(r.radek)).join('\n');
      const text = 'Dobrý den' + (it.jmeno ? ', ' + it.jmeno : '') + ',\n\nděkujeme za vaši poptávku lodního kontejneru. Zasíláme nezávaznou cenovou nabídku:\n\n'
        + radkyText + '\n\nMezisoučet: ' + fmtKc(calc.zaklad) + '\nDPH ' + calc.dph + ' %: ' + fmtKc(calc.dphCastka) + '\nCelkem: ' + fmtKc(calc.celkem) + '\n'
        + (it.nabidka.platnost ? '\nPlatnost nabídky: ' + it.nabidka.platnost + '\n' : '')
        + (it.nabidka.poznamka ? '\n' + it.nabidka.poznamka + '\n' : '')
        + '\nV případě zájmu nebo dotazů nás neváhejte kontaktovat.\n\nS pozdravem\n' + (byWho.name || 'ELKOPLAST CZ') + '\nELKOPLAST CZ, s.r.o.';
      await notify(it.email, 'Nabídka lodního kontejneru — ELKOPLAST CZ (poptávka #' + it.cislo + ')', text);
      it.nabidka.odeslano = true; it.nabidka.odeslanoAt = now;
      it.stav = 'nabidka'; odeslano = true;
    }
    it.updatedAt = now; it.historie = it.historie || [];
    it.historie.push({ stav: it.stav, note: (send ? 'Nabídka odeslána klientovi' : 'Nabídka uložena') + ' (' + fmtKc(calc.celkem) + ')', by: byWho, at: now });
    save(db);
    logAct('kontejnery', byWho, 'Poptávka #' + it.cislo + ': ' + (send ? 'nabídka odeslána' : 'nabídka uložena') + ' ' + fmtKc(calc.celkem));
    json(res, 200, { ok: true, odeslano, item: it });
    return true;
  }
  // Normalizace seznamu příjemců (e-mail povinný; jméno z DB, jinak e-mail). Nemusí to být zaměstnanci.
  function normRecips(arr) {
    const names = {}; employeesForPicker().forEach(e => { names[e.email] = e.name; });
    const seen = {}; const out = [];
    (Array.isArray(arr) ? arr : []).forEach(x => {
      const email = (typeof x === 'string' ? x : (x && x.email) || '').toLowerCase().trim();
      if (!email || seen[email] || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return; seen[email] = 1;
      out.push({ email, name: (x && x.name) || names[email] || email });
    });
    return out;
  }
  // Data konfigurace (sdílené pro session i Bearer/aplikaci).
  function cfgData() { const db = load(); return { rotace: db.config.rotace, dohled: db.config.dohled, employees: employeesForPicker() }; }
  function cfgApply(b) {
    const db = load();
    if (Array.isArray(b.rotace)) { db.config.rotace = normRecips(b.rotace); db.config.rotaceIdx = 0; }
    if (Array.isArray(b.dohled)) { db.config.dohled = normRecips(b.dohled); }
    save(db);
    return { rotace: db.config.rotace, dohled: db.config.dohled };
  }
  // Bearer (server-to-server z aplikace /spravce) — správu obchodníků/notifikací dělá aplikace.
  function apiCfgGetExt(req, res) { if (!bearerOk(req)) { json(res, 401, { chyba: 'Neplatné tajemství.' }); return true; } json(res, 200, cfgData()); return true; }
  async function apiCfgSetExt(req, res) {
    if (!bearerOk(req)) { json(res, 401, { chyba: 'Neplatné tajemství.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const out = cfgApply(b);
    logAct('kontejnery', { name: (b.by && b.by.name) || 'aplikace' }, 'Notifikace poptávek upraveny z aplikace — střídačka: ' + (out.rotace.map(x => x.name).join(', ') || '(nikdo)') + ' · dohled: ' + (out.dohled.map(x => x.name).join(', ') || '(nikdo)'));
    json(res, 200, { ok: true, rotace: out.rotace, dohled: out.dohled });
    return true;
  }
  function apiCfgGet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    const db = load();
    json(res, 200, { rotace: db.config.rotace, dohled: db.config.dohled, notify: db.config.notify, employees: employeesForPicker() });
    return true;
  }
  async function apiCfgSet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load();
    if (Array.isArray(b.rotace)) { db.config.rotace = normRecips(b.rotace); db.config.rotaceIdx = 0; }
    if (Array.isArray(b.dohled)) { db.config.dohled = normRecips(b.dohled); }
    if (Array.isArray(b.notify)) { db.config.notify = normRecips(b.notify); }
    save(db);
    logAct('kontejnery', meOf(req), 'Notifikace poptávek — střídačka: ' + (db.config.rotace.map(x => x.name).join(', ') || '(nikdo)') + ' · dohled: ' + (db.config.dohled.map(x => x.name).join(', ') || '(nikdo)'));
    json(res, 200, { ok: true, rotace: db.config.rotace, dohled: db.config.dohled });
    return true;
  }

  // Smazání poptávky (jen správce).
  async function apiSmazat(req, res) {
    const me = meOf(req);
    if (!me.isAdmin) { json(res, 403, { chyba: 'Smazat poptávku může jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load(); const id = String(b.id || ''); const before = db.items.length;
    db.items = db.items.filter(x => x.id !== id);
    if (db.items.length === before) { json(res, 404, { chyba: 'Poptávka nenalezena.' }); return true; }
    save(db); logAct('kontejnery', me, 'Smazána poptávka ' + id);
    json(res, 200, { ok: true }); return true;
  }

  // ======================================================================
  //  IMPORT POPTÁVEK Z GOOGLE TABULKY (i z Meta lead reklam) → nevyřízené poptávky
  // ======================================================================
  function assignRotace(db, item, now) {
    if (db.config.rotace.length) {
      const n = db.config.rotace.length;
      const idx = ((db.config.rotaceIdx % n) + n) % n;
      const o = db.config.rotace[idx];
      db.config.rotaceIdx = idx + 1;
      if (o && o.email) {
        item.obchodnik = { email: (o.email || '').toLowerCase(), name: o.name || o.email };
        item.historie.push({ stav: 'nova', note: 'Automaticky přiřazeno (střídačka): ' + item.obchodnik.name, by: { name: 'systém' }, at: now });
        return item.obchodnik;
      }
    }
    return null;
  }
  function normHdr(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }
  function pickCol(headers, cands) { for (const c of cands) { const i = headers.findIndex(h => h.indexOf(c) >= 0); if (i >= 0) return i; } return -1; }
  const COL_MAP = {
    jmeno: ['full name', 'full_name', 'fullname', 'jmeno', 'jméno', 'cele jmeno', 'name', 'kontakt', 'zakaznik'],
    email: ['email', 'e-mail', 'mail'],
    telefon: ['phone', 'phone_number', 'telefon', 'tel', 'mobil', 'cislo'],
    firma: ['company', 'firma', 'spolecnost', 'organizace'],
    typ: ['typ', 'kontejner', 'container', 'type', 'produkt'],
    rezim: ['rezim', 'forma', 'koupe', 'pronajem'],
    mesto: ['mesto', 'lokalita', 'city', 'misto', 'adresa', 'psc'],
    zprava: ['zprava', 'poznamka', 'message', 'pozn', 'popis', 'note', 'text', 'dotaz'],
    idcol: ['lead id', 'leadgen_id', 'lead_id', 'id'],
    created: ['created', 'created_time', 'cas', 'time', 'timestamp', 'datum', 'date'],
  };
  async function syncSheet() {
    const db = load();
    const sheetId = db.config.sheetId;
    if (!sheetId || !host.sheetsGet) return 0;
    let vals;
    try { const r = await host.sheetsGet(sheetId, SHEET_RANGE); vals = (r && r.values) || []; }
    catch (e) { console.error('[kontejnery] Sheets čtení selhalo:', e.message); return 0; }
    if (vals.length < 2) return 0;
    const headers = vals[0].map(normHdr);
    const idx = {}; Object.keys(COL_MAP).forEach(k => { idx[k] = pickCol(headers, COL_MAP[k]); });
    const seen = new Set(db.config.leadKeys);
    const firstImport = !db.config._sheetBackfilled;
    const cell = (row, i) => (i >= 0 && i < row.length) ? String(row[i] || '').trim() : '';
    const now = Date.now();
    const created = [];
    for (let ri = 1; ri < vals.length; ri++) {
      const row = vals[ri]; if (!row || !row.length) continue;
      const jmeno = cell(row, idx.jmeno).slice(0, 120);
      const email = cell(row, idx.email).slice(0, 160);
      const telefon = cell(row, idx.telefon).slice(0, 60);
      if (!jmeno && !email && !telefon) continue;                 // prázdný řádek
      const rawId = cell(row, idx.idcol);
      const key = rawId ? ('id:' + rawId) : ('h:' + crypto.createHash('sha1').update([email, telefon, cell(row, idx.created), jmeno].join('|')).digest('hex').slice(0, 16));
      if (seen.has(key)) continue;
      seen.add(key); db.config.leadKeys.push(key);
      db.seq = (db.seq || 0) + 1;
      const item = {
        id: crypto.randomBytes(8).toString('hex'), cislo: db.seq,
        jmeno: jmeno || '(bez jména)', firma: cell(row, idx.firma).slice(0, 160),
        email, telefon,
        typ: cell(row, idx.typ).slice(0, 80) || null,
        rezim: (function () { const rz = cell(row, idx.rezim); return REZIM.indexOf(rz) >= 0 ? rz : (rz ? rz.slice(0, 40) : null); })(),
        mesto: cell(row, idx.mesto).slice(0, 120), pocet: null,
        zprava: cell(row, idx.zprava).slice(0, 4000),
        cenaOd: null, cenaDo: null, konfigurace: null,
        stav: 'nova', obchodnik: null, zdroj: 'Google tabulka / Meta',
        createdAt: now, updatedAt: now,
        historie: [{ stav: 'nova', note: 'Import z Google tabulky (Meta)', by: { name: 'systém' }, at: now }],
      };
      assignRotace(db, item, now);
      db.items.push(item); created.push(item);
    }
    if (db.config.leadKeys.length > 8000) db.config.leadKeys = db.config.leadKeys.slice(-8000);
    if (created.length || firstImport) { db.config._sheetBackfilled = true; save(db); }
    // e-maily: při prvním (backfill) importu neposílej záplavu; jen napříště o nových
    if (created.length && !firstImport) {
      for (const it of created) {
        const prijemci = []; const addRec = (o) => { const e = (o && o.email || '').toLowerCase(); if (e && prijemci.indexOf(e) < 0) prijemci.push(e); };
        if (it.obchodnik) addRec(it.obchodnik); (db.config.dohled || []).forEach(addRec); (db.config.notify || []).forEach(addRec);
        const text = 'Nová poptávka lodního kontejneru z Google tabulky (Meta) (#' + it.cislo + '):\n\n'
          + '• Jméno: ' + it.jmeno + (it.firma ? ' (' + it.firma + ')' : '') + '\n'
          + (it.email ? '• E-mail: ' + it.email + '\n' : '') + (it.telefon ? '• Telefon: ' + it.telefon + '\n' : '')
          + (it.typ ? '• Typ: ' + it.typ + '\n' : '') + (it.mesto ? '• Místo: ' + it.mesto + '\n' : '')
          + (it.zprava ? '• Zpráva: ' + it.zprava + '\n' : '')
          + (it.obchodnik ? '\n→ Přiřazeno (na střídačku): ' + it.obchodnik.name + '\n' : '')
          + '\nDetail v intranetu → Poptávky.';
        for (const e of prijemci) await notify(e, 'Nová poptávka kontejneru #' + it.cislo + (it.obchodnik ? ' — ' + it.obchodnik.name : ''), text);
      }
    }
    if (created.length) console.log('[kontejnery] import z tabulky: ' + created.length + ' nových poptávek' + (firstImport ? ' (první naplnění, bez e-mailů)' : ''));
    return created.length;
  }

  // ======================================================================
  //  TÝDENNÍ REPORT — odeslané + nevyřízené nabídky (pojistka 1×/ISO-týden)
  // ======================================================================
  function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const wk = 1 + Math.round(((t - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  function fmtD(ts) { try { return new Date(ts).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }); } catch (_) { return ''; } }
  function reportHtml(odeslane, nevyrizene, period) {
    const line = (it) => '<tr><td style="padding:3px 8px 3px 0;font-size:13px;white-space:nowrap">#' + it.cislo + '</td>'
      + '<td style="padding:3px 8px 3px 0;font-size:13px">' + esc(it.jmeno) + (it.firma ? ' (' + esc(it.firma) + ')' : '') + '</td>'
      + '<td style="padding:3px 8px 3px 0;font-size:13px;color:#5b6b60">' + esc(it.typ || '—') + '</td>'
      + '<td style="padding:3px 0;font-size:13px;color:#5b6b60">' + (it.obchodnik ? esc(it.obchodnik.name) : '<span style="color:#a86a00">nepřiřazeno</span>') + '</td></tr>';
    const tbl = (arr) => arr.length ? '<table style="border-collapse:collapse;margin:4px 0 2px">' + arr.map(line).join('') + '</table>' : '<div style="color:#8a938a;font-size:13px">—</div>';
    return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#16211a;max-width:640px">'
      + '<h2 style="margin:0 0 4px">Lodní kontejnery — týdenní report</h2>'
      + '<div style="color:#6b7a70;font-size:13px;margin-bottom:14px">Období ' + esc(period) + '.</div>'
      + '<h3 style="font-size:15px;margin:14px 0 2px;color:#1f5e22">Odeslané nabídky (7 dní) — ' + odeslane.length + '</h3>' + tbl(odeslane)
      + '<h3 style="font-size:15px;margin:16px 0 2px;color:#a4560f">Nevyřízené poptávky — ' + nevyrizene.length + '</h3>' + tbl(nevyrizene)
      + '<hr style="border:0;border-top:1px solid #e6e9e3;margin:20px 0"><div style="font-size:12px;color:#8a938a">Automatický týdenní report · Intranet ELKOPLAST CZ → Lodní kontejnery.</div></div>';
  }
  async function tick() {
    try {
      const db = load(); const rep = db.config.report;
      if (!rep.enabled || !Array.isArray(rep.to) || !rep.to.length) return;
      const now = new Date(); const wk = isoWeek(now);
      if (now.getDay() < rep.weekday) return;
      if (rep.lastWeek === wk) return;
      const since = now.getTime() - 7 * 24 * 3600 * 1000;
      const odeslane = db.items.filter(x => x.stav === 'nabidka' && (x.updatedAt || 0) >= since).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const nevyrizene = db.items.filter(x => x.stav === 'nova' || x.stav === 'vresenu').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const period = fmtD(since) + '–' + fmtD(now.getTime()) + ' (' + wk + ')';
      const html = reportHtml(odeslane, nevyrizene, period);
      const t = (it) => '#' + it.cislo + ' · ' + it.jmeno + (it.typ ? ' · ' + it.typ : '') + (it.obchodnik ? ' — ' + it.obchodnik.name : ' — nepřiřazeno');
      const text = 'Lodní kontejnery — týdenní report (' + period + ')\n\n'
        + 'ODESLANÉ NABÍDKY (7 dní): ' + odeslane.length + '\n' + (odeslane.map(t).join('\n') || '—') + '\n\n'
        + 'NEVYŘÍZENÉ POPTÁVKY: ' + nevyrizene.length + '\n' + (nevyrizene.map(t).join('\n') || '—');
      for (const r of rep.to) await notify(r.email, 'Lodní kontejnery — týdenní report (odeslané ' + odeslane.length + ' · nevyřízené ' + nevyrizene.length + ')', text, html);
      rep.lastWeek = wk; rep.lastAt = now.toISOString(); save(db);
      console.log('[kontejnery] týdenní report ' + wk + ' → ' + rep.to.map(r => r.email).join(', '));
    } catch (e) { console.error('[kontejnery] report tick:', e.message); }
  }

  // Jednorázový úklid testovacích poptávek (e-maily @example.*, jména TEST…/Klient N) — jen při prvním startu.
  (function purgeTest() {
    try {
      const db = load();
      if (!db.config._testPurged) {
        db.config._testPurged = true;
        const before = db.items.length;
        db.items = db.items.filter(x => !(/@example\.(cz|com)$/i.test(x.email || '') || /^TEST\b/i.test(String(x.jmeno || '')) || /^Klient \d/.test(String(x.jmeno || ''))));
        save(db);
        if (before !== db.items.length) console.log('[kontejnery] úklid: smazáno ' + (before - db.items.length) + ' testovacích poptávek');
      }
    } catch (_) {}
  })();

  // Jednorázový seed notifikací dle zadání (střídačka Jana/Josef, kopie David) — jen při prvním startu.
  (function initNotif() {
    try {
      const db = load();
      if (!db.config._notifInit) {
        db.config._notifInit = true;
        if (!db.config.rotace.length) db.config.rotace = [{ email: 'jana.rychlikova@elkoplast.cz', name: 'Jana Rychlíková' }, { email: 'josef.beranek@elkoplast.cz', name: 'Josef Beránek' }];
        if (!db.config.dohled.length) db.config.dohled = [{ email: 'david.sury@elkoplast.cz', name: 'David Surý' }];
        save(db);
      }
    } catch (_) {}
  })();

  return { handle, isHandler, syncSheet, tick };
}

module.exports = { mount };

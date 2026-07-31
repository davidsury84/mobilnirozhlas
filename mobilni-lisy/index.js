'use strict';
// ============================================================================
//  Modul „Mobilní lisy" (mobilní-lisy.cz) — veřejný web + dotazník → přihlášky
// ============================================================================
//  Veřejná stránka (/mobilni-lisy, bez přihlášení) promuje mobilní lisovací
//  kontejnery ELKOPLAST CZ pro obce a sběrné dvory a obsahuje dotazník (papír +
//  plast: kontejnery, objemy, četnost svozu, roční tonáž). Vyplněné přihlášky
//  padají do evidence v intranetu (data/mobilni-lisy-prihlasky.json) a „sbíhají"
//  obchodníkovi, který má mobilní lisy na starosti (výchozí příjemce = J.
//  Horálek dle portfolia; správce může změnit i přiřadit konkrétní přihlášku).
//  1× týdně chodí souhrnný report na nastavené příjemce (výchozí David Surý +
//  Hana Ondrašíková).
//
//  Mount v server.js (vzor: kontejnery):
//    const mobilniLisy = require('./mobilni-lisy').mount({ send, readBody,
//      deliver, empSession, isAdmin, baseUrl, employeeModules, getState,
//      logActivity, dataDir, mailFrom });
//    if (mobilniLisy && await mobilniLisy.handleClientHost(req, res)) return;  // doména mobilní-lisy.cz
//    if (mobilniLisy && await mobilniLisy.handle(req, res)) return;
//    mobilniLisy.tick();  // + setInterval po 6 h  → týdenní report
//
//  Veřejné cesty (/mobilni-lisy GET, /api/mobilni-lisy/prihlaska POST) musí být
//  v server.js vyjmuté z přihlašovací závory (proměnná mobilniLisyPublic).
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');

const WEB_FILE = path.join(__dirname, 'mobilni-lisy-web.html');
const SPRAVA_FILE = path.join(__dirname, 'mobilni-lisy-sprava.html');
// Klientská doména — alias na TUTÉŽ aplikaci; servíruje jen prezentaci + dotazník (žádný intranet).
const CLIENT_HOST = (process.env.MOBILNI_LISY_HOST || 'mobilni-lisy.cz').toLowerCase();
// Výchozí příjemci týdenního reportu (editovatelné správcem v aplikaci).
const REPORT_DEFAULT = [
  { email: 'david.sury@elkoplast.cz', name: 'David Surý' },
  { email: 'hana.ondrasikova@elkoplast.cz', name: 'Hana Ondrašíková' },
];

const STAVY = {
  nova: 'Nová',
  kontakt: 'Kontaktováno',
  schuzka: 'Schůzka / v jednání',
  nabidka: 'Nabídka odeslána',
  uzavreno: 'Uzavřeno (objednáno)',
  zamitnuto: 'Nerelevantní / ztraceno',
};

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function s160(v) { return String(v == null ? '' : v).trim().slice(0, 160); }
function s300(v) { return String(v == null ? '' : v).trim().slice(0, 300); }

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'mobilni-lisy-prihlasky.json');

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- perzistence ----
  function load() {
    let db;
    try { const j = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); db = (j && Array.isArray(j.items)) ? j : { items: [], seq: 0 }; }
    catch (_) { db = { items: [], seq: 0 }; }
    if (!db.config) db.config = {};
    if (!Array.isArray(db.config.notify)) db.config.notify = [];
    if (!db.config.report || typeof db.config.report !== 'object') db.config.report = {};
    const rep = db.config.report;
    if (!Array.isArray(rep.to)) rep.to = REPORT_DEFAULT.slice();
    if (typeof rep.weekday !== 'number' || rep.weekday < 0 || rep.weekday > 6) rep.weekday = 1; // pondělí
    if (typeof rep.enabled !== 'boolean') rep.enabled = true;
    return db;
  }
  function save(db) { try { fs.writeFileSync(DATA_F, JSON.stringify(db, null, 2)); } catch (e) { console.error('[mobilni-lisy] zápis selhal:', e.message); } }

  // Při prvním startu nasměruj nové přihlášky na obchodníka „Horálek" (dle portfolia),
  // pokud správce zatím nikoho nenastavil. Poté už do seznamu nesahá (respektuje volbu správce).
  function seedNotify() {
    const db = load();
    if (db.config.notifySeeded) return;
    db.config.notifySeeded = true;
    if (!db.config.notify.length) {
      const emp = employeesForPicker().find(e => /horálek|horalek/i.test(e.name));
      if (emp) db.config.notify = [{ email: emp.email, name: emp.name }];
    }
    save(db);
  }

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
  // Zaměstnanec, který má co dělat s přihláškami mobilních lisů (viditelnost + přístup):
  // je v seznamu notifikací (výchozí příjemce) NEBO má přiřazenou nějakou přihlášku.
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

  // ---- e-mail ----
  function mailHtml(text) {
    const safe = esc(text).replace(/\n/g, '<br>');
    return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1c1d1a;line-height:1.6">' + safe +
      '<hr style="border:0;border-top:1px solid #e6e9e3;margin:18px 0"><div style="font-size:12px;color:#8a938a">Intranet ELKOPLAST CZ · Mobilní lisy</div></div>';
  }
  async function notify(to, subject, text, htmlBody) {
    if (!to || !host.deliver || !host.mailFrom || !host.mailFrom.user) return;
    try { await host.deliver({ to, fromAddr: host.mailFrom.user, fromName: host.mailFrom.name || 'ELKOPLAST — mobilní lisy', subject, text, html: htmlBody || mailHtml(text) }); }
    catch (e) { console.error('[mobilni-lisy] e-mail neodeslán (' + to + '):', e.message); }
  }
  function logAct(type, who, detail) { try { if (host.logActivity) host.logActivity(type, who, detail); } catch (_) {} }
  function baseUrlOf(req) { try { return host.baseUrl(req).replace(/\/$/, ''); } catch (_) { return ''; } }

  // ---- pole dotazníku → čitelný přehled (pro e-mail i evidenci) ----
  function prehledRadky(it) {
    const r = [];
    if (it.pozice) r.push(['Pozice', it.pozice]);
    if (it.pocetDvoru) r.push(['Počet sběrných dvorů', it.pocetDvoru]);
    if (it.kontejneryPapir) r.push(['Kontejnery na papír', it.kontejneryPapir]);
    if (it.kontejneryPlast) r.push(['Kontejnery na plast', it.kontejneryPlast]);
    if (it.svozPapirCetnost) r.push(['Četnost svozu papíru', it.svozPapirCetnost]);
    if (it.svozPlastCetnost) r.push(['Četnost svozu plastu', it.svozPlastCetnost]);
    if (it.odvozPapirKg) r.push(['Papír — 1 svoz', it.odvozPapirKg + ' kg']);
    if (it.odvozPlastKg) r.push(['Plast — 1 svoz', it.odvozPlastKg + ' kg']);
    if (it.rocnePapirTun) r.push(['Papír — ročně', it.rocnePapirTun + ' t/rok']);
    if (it.rocnePlastTun) r.push(['Plast — ročně', it.rocnePlastTun + ' t/rok']);
    if (it.problem) r.push(['Největší problém dvora', it.problem]);
    return r;
  }

  // ======================================================================
  //  KLIENTSKÁ DOMÉNA (mobilní-lisy.cz) — běží PŘED přihlašovací závorou.
  // ======================================================================
  function isClientHost(req) {
    const h = (req.headers.host || '').toLowerCase().split(':')[0];
    return h === CLIENT_HOST || h.startsWith('mobilni-lisy.') || h.startsWith('mobilnilisy.');
  }
  async function handleClientHost(req, res) {
    if (!isClientHost(req)) return false;
    const u = urlLib.parse(req.url, true); const p = u.pathname;
    if (p === '/healthz') return false; // healthz ať řeší server
    if (p === '/api/mobilni-lisy/prihlaska' && req.method === 'POST') return apiPrihlaska(req, res);
    if (req.method === 'GET') {
      if (!fs.existsSync(WEB_FILE)) { htmlOut(res, 404, '<h1>Chybí mobilni-lisy-web.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(WEB_FILE, 'utf8')); return true;
    }
    json(res, 405, { chyba: 'Jen GET.' }); return true;
  }

  // ======================================================================
  //  ROUTER
  // ======================================================================
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (p !== '/mobilni-lisy' && !p.startsWith('/mobilni-lisy/') && !p.startsWith('/api/mobilni-lisy')) return false;

    // -------- VEŘEJNÉ: prezentační web + odeslání dotazníku --------
    if ((p === '/mobilni-lisy' || p === '/mobilni-lisy/') && req.method === 'GET') {
      if (!fs.existsSync(WEB_FILE)) { htmlOut(res, 404, '<h1>Chybí mobilni-lisy-web.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(WEB_FILE, 'utf8')); return true;
    }
    if (p === '/api/mobilni-lisy/prihlaska' && req.method === 'POST') return apiPrihlaska(req, res);

    // -------- INTERNÍ: evidence + přiřazení (vyžaduje přístup) --------
    const me = meOf(req);
    if (!me.isObchodnik) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'K přihláškám mobilních lisů nemáte přístup.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K přihláškám mobilních lisů nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }
    if ((p === '/mobilni-lisy/sprava' || p === '/mobilni-lisy/sprava/') && req.method === 'GET') {
      if (!fs.existsSync(SPRAVA_FILE)) { htmlOut(res, 404, '<h1>Chybí mobilni-lisy-sprava.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(SPRAVA_FILE, 'utf8')); return true;
    }
    try {
      if (p === '/api/mobilni-lisy' && req.method === 'GET') return apiList(req, res);
      if (p === '/api/mobilni-lisy/prirad' && req.method === 'POST') return apiPrirad(req, res);
      if (p === '/api/mobilni-lisy/nastaveni' && req.method === 'GET') return apiCfgGet(req, res);
      if (p === '/api/mobilni-lisy/nastaveni' && req.method === 'POST') return apiCfgSet(req, res);
    } catch (e) {
      console.error('[mobilni-lisy] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }
    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  // ======================================================================
  //  VEŘEJNÉ API — odeslání dotazníku (přihlášky)
  // ======================================================================
  async function apiPrihlaska(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const mesto = s160(b.mesto);
    const jmeno = s160(b.jmeno);
    const email = s160(b.email);
    const telefon = String(b.telefon || '').trim().slice(0, 60);
    if (!mesto || !jmeno || !email) { json(res, 400, { chyba: 'Vyplňte prosím město/obec, jméno a e-mail.' }); return true; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { json(res, 400, { chyba: 'Neplatný e-mail.' }); return true; }
    if (!b.souhlas) { json(res, 400, { chyba: 'Bez souhlasu se zpracováním údajů nelze přihlášku odeslat.' }); return true; }
    if (String(b.web || '').trim()) { json(res, 200, { ok: true }); return true; } // honeypot: tvař se OK, nic neukládej

    const db = load();
    db.seq = (db.seq || 0) + 1;
    const now = Date.now();
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      cislo: db.seq,
      mesto, jmeno, email, telefon,
      pozice: s160(b.pozice),
      pocetDvoru: s160(b.pocetDvoru),
      kontejneryPapir: s300(b.kontejneryPapir),
      kontejneryPlast: s300(b.kontejneryPlast),
      svozPapirCetnost: s160(b.svozPapirCetnost),
      svozPlastCetnost: s160(b.svozPlastCetnost),
      odvozPapirKg: s160(b.odvozPapirKg),
      odvozPlastKg: s160(b.odvozPlastKg),
      rocnePapirTun: s160(b.rocnePapirTun),
      rocnePlastTun: s160(b.rocnePlastTun),
      problem: String(b.problem || '').trim().slice(0, 4000),
      stav: 'nova', obchodnik: null,
      createdAt: now, updatedAt: now,
      historie: [{ stav: 'nova', note: 'Přihláška z dotazníku (web)', by: { name: jmeno }, at: now }],
    };
    db.items.push(item);
    save(db);
    logAct('mobilni-lisy', { email, name: jmeno }, 'Nová přihláška mobilních lisů #' + item.cislo + ' · ' + mesto);

    const link = baseUrlOf(req) + '/mobilni-lisy/sprava';
    const prehled = prehledRadky(item).map(r => '• ' + r[0] + ': ' + r[1]).join('\n');
    const text = 'Nová přihláška z dotazníku mobilních lisů (#' + item.cislo + '):\n\n'
      + '• Město/obec: ' + mesto + '\n'
      + '• Kontakt: ' + jmeno + '\n'
      + '• E-mail: ' + email + '\n'
      + (telefon ? '• Telefon: ' + telefon + '\n' : '')
      + (prehled ? '\n' + prehled + '\n' : '')
      + '\nPřihláška je v intranetu → Mobilní lisy:\n' + link;
    for (const n of load().config.notify) await notify(n.email, 'Nová přihláška mobilních lisů #' + item.cislo + ' · ' + mesto, text);
    json(res, 200, { ok: true, cislo: item.cislo });
    return true;
  }

  // ======================================================================
  //  INTERNÍ API
  // ======================================================================
  function decorate(it) { return Object.assign({}, it, { prehled: prehledRadky(it) }); }
  function apiList(req, res) {
    const me = meOf(req);
    const db = load();
    const items = db.items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(decorate);
    json(res, 200, { items, stavy: STAVY, role: { isAdmin: me.isAdmin, isObchodnik: me.isObchodnik }, me: { email: me.email, name: me.name }, employees: employeesForPicker(), notify: db.config.notify, report: db.config.report });
    return true;
  }
  async function apiPrirad(req, res) {
    const me = meOf(req);
    if (!me.isObchodnik) { json(res, 403, { chyba: 'Nemáte oprávnění.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load();
    const it = db.items.find(x => x.id === String(b.id || ''));
    if (!it) { json(res, 404, { chyba: 'Přihláška nenalezena.' }); return true; }
    const now = Date.now();
    const zmena = [];
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
    logAct('mobilni-lisy', { email: me.email, name: me.name }, 'Přihláška #' + it.cislo + ': ' + zmena.join(', '));
    // notifikace nově přiřazenému obchodníkovi
    if (b.obchodnik !== undefined && it.obchodnik && it.obchodnik.email) {
      const link = baseUrlOf(req) + '/mobilni-lisy/sprava';
      const prehled = prehledRadky(it).map(r => '• ' + r[0] + ': ' + r[1]).join('\n');
      await notify(it.obchodnik.email, 'Přiřazena přihláška mobilních lisů #' + it.cislo + ' · ' + it.mesto,
        'Dobrý den,\n\nbyla vám přiřazena přihláška mobilních lisů #' + it.cislo + ':\n\n'
        + '• Město/obec: ' + it.mesto + '\n'
        + '• Kontakt: ' + it.jmeno + '\n'
        + (it.email ? '• E-mail: ' + it.email + '\n' : '') + (it.telefon ? '• Telefon: ' + it.telefon + '\n' : '')
        + (prehled ? '\n' + prehled + '\n' : '')
        + '\nDetail a stav zpracujte v intranetu → Mobilní lisy:\n' + link);
    }
    json(res, 200, { ok: true, item: decorate(it) });
    return true;
  }
  function apiCfgGet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    const db = load();
    json(res, 200, { notify: db.config.notify, report: db.config.report, employees: employeesForPicker() });
    return true;
  }
  async function apiCfgSet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load();
    const names = {}; employeesForPicker().forEach(e => { names[e.email] = e.name; });
    // příjemci notifikací nových přihlášek (interní obchodníci)
    if (Array.isArray(b.notify)) {
      const seen = {}; const notifyList = [];
      b.notify.forEach(x => {
        const email = (typeof x === 'string' ? x : (x && x.email) || '').toLowerCase();
        if (!email || seen[email]) return; seen[email] = 1;
        notifyList.push({ email, name: (x && x.name) || names[email] || email });
      });
      db.config.notify = notifyList; db.config.notifySeeded = true;
    }
    // příjemci týdenního reportu (mohou být i externí adresy)
    if (b.report && typeof b.report === 'object') {
      if (Array.isArray(b.report.to)) {
        const seen = {}; const to = [];
        b.report.to.forEach(x => {
          const email = (typeof x === 'string' ? x : (x && x.email) || '').toLowerCase().trim();
          if (!email || seen[email] || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return; seen[email] = 1;
          to.push({ email, name: (x && x.name) || names[email] || email });
        });
        db.config.report.to = to;
      }
      if (typeof b.report.enabled === 'boolean') db.config.report.enabled = b.report.enabled;
      if (b.report.weekday != null && b.report.weekday >= 0 && b.report.weekday <= 6) db.config.report.weekday = +b.report.weekday;
    }
    save(db);
    logAct('mobilni-lisy', meOf(req), 'Upraveno nastavení příjemců (přihlášky / report)');
    json(res, 200, { ok: true, notify: db.config.notify, report: db.config.report });
    return true;
  }

  // ======================================================================
  //  TÝDENNÍ REPORT (pojistka 1×/ISO-týden, vzor nakup-report)
  // ======================================================================
  function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const wk = 1 + Math.round(((t - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  function reportBody(items, period) {
    const wrapRow = (l, v) => '<tr><td style="padding:3px 10px 3px 0;color:#6b7a70;font-size:12.5px;white-space:nowrap;vertical-align:top">' + esc(l) + '</td><td style="padding:3px 0;font-size:13.5px">' + esc(v) + '</td></tr>';
    const cards = items.map(it => {
      const rows = prehledRadky(it).map(r => wrapRow(r[0], r[1])).join('');
      const kontakt = [it.email, it.telefon].filter(Boolean).join(' · ');
      return '<div style="border:1px solid #e2e8e0;border-radius:12px;padding:12px 14px;margin:10px 0">'
        + '<div style="font-weight:700;font-size:15px">#' + it.cislo + ' · ' + esc(it.mesto) + '</div>'
        + '<div style="color:#6b7a70;font-size:13px;margin:2px 0 8px">' + esc(it.jmeno) + (kontakt ? ' — ' + esc(kontakt) : '')
        + ' · <b style="color:#1f5e22">' + esc(STAVY[it.stav] || it.stav) + '</b>'
        + (it.obchodnik ? ' · obchodník: ' + esc(it.obchodnik.name) : ' · <span style="color:#a86a00">nepřiřazeno</span>') + '</div>'
        + (rows ? '<table style="border-collapse:collapse">' + rows + '</table>' : '')
        + '</div>';
    }).join('');
    return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#16211a;max-width:640px">'
      + '<h2 style="margin:0 0 4px">Mobilní lisy — týdenní report</h2>'
      + '<div style="color:#6b7a70;font-size:13px;margin-bottom:14px">Nové přihlášky z dotazníku za období ' + esc(period) + '. Celkem <b>' + items.length + '</b>.</div>'
      + (items.length ? cards : '<div style="border:1px dashed #cfe0c2;border-radius:12px;padding:16px;color:#6b7a70">Tento týden nepřišla žádná nová přihláška.</div>')
      + '<hr style="border:0;border-top:1px solid #e6e9e3;margin:20px 0"><div style="font-size:12px;color:#8a938a">Automatický týdenní report · Intranet ELKOPLAST CZ → Mobilní lisy. Příjemce a zapnutí spravuje správce v aplikaci.</div></div>';
  }
  async function tick() {
    try {
      const db = load();
      const rep = db.config.report;
      if (!rep.enabled || !Array.isArray(rep.to) || !rep.to.length) return;
      const now = new Date(); const wk = isoWeek(now);
      if (now.getDay() < rep.weekday) return;       // pošli v den >= zvolený weekday
      if (rep.lastWeek === wk) return;              // jednou za ISO-týden
      // přihlášky za posledních 7 dní
      const since = now.getTime() - 7 * 24 * 3600 * 1000;
      const items = db.items.filter(x => (x.createdAt || 0) >= since).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const fmt = d => d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
      const period = fmt(new Date(since)) + '–' + fmt(now) + ' (' + wk + ')';
      const html = reportBody(items, period);
      const textLines = items.length
        ? items.map(it => '#' + it.cislo + ' · ' + it.mesto + ' — ' + it.jmeno + ' (' + (STAVY[it.stav] || it.stav) + (it.obchodnik ? ', ' + it.obchodnik.name : ', nepřiřazeno') + ')').join('\n')
        : 'Tento týden nepřišla žádná nová přihláška.';
      const text = 'Mobilní lisy — týdenní report (' + period + ')\nNových přihlášek: ' + items.length + '\n\n' + textLines;
      for (const r of rep.to) await notify(r.email, 'Mobilní lisy — týdenní report (' + items.length + ' nových)', text, html);
      rep.lastWeek = wk; rep.lastAt = now.toISOString();
      save(db);
      console.log('[mobilni-lisy] týdenní report ' + wk + ': ' + items.length + ' přihlášek → ' + rep.to.map(r => r.email).join(', '));
    } catch (e) { console.error('[mobilni-lisy] tick:', e.message); }
  }

  seedNotify();
  return { handle, handleClientHost, isHandler, tick };
}

module.exports = { mount };

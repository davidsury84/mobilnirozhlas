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

const WEB_FILE = path.join(__dirname, 'kontejnery-web.html');
const SPRAVA_FILE = path.join(__dirname, 'kontejnery-sprava.html');
// Klientská doména — alias na TUTÉŽ aplikaci; servíruje jen prezentaci + poptávku (žádný intranet).
const CLIENT_HOST = (process.env.KONTEJNERY_HOST || 'lodaky.elkoplast.cz').toLowerCase();

const STAVY = {
  nova: 'Nová',
  vresenu: 'V řešení',
  nabidka: 'Nabídka odeslána',
  uzavreno: 'Uzavřeno (objednáno)',
  zamitnuto: 'Zamítnuto / ztraceno',
};
// Typy kontejnerů nabízené ve formuláři (kvůli konzistenci evidence).
const TYPY = ['20′ skladový', '40′ skladový', '20′ High Cube', '40′ High Cube', 'Chladírenský (reefer)', 'Kancelářský / obytný', 'Na míru / poradit'];
const REZIM = ['Koupě', 'Pronájem', 'Ještě nevím'];

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
    return db;
  }
  function save(db) { try { fs.writeFileSync(DATA_F, JSON.stringify(db, null, 2)); } catch (e) { console.error('[kontejnery] zápis selhal:', e.message); } }

  // ---- fotky na veřejný web (banner + galerie) — nahrává správce z intranetu ----
  const FOTKY_DIR = path.join(host.dataDir || __dirname, 'kontejnery-fotky');
  try { if (!fs.existsSync(FOTKY_DIR)) fs.mkdirSync(FOTKY_DIR, { recursive: true }); } catch (_) {}
  const FOTO_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const FOTO_CT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  function saveFotka(dataUrl) {
    const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > 6e6) return null;
    const name = crypto.randomBytes(8).toString('hex') + '.' + (FOTO_EXT[m[1]] || 'jpg');
    try { fs.writeFileSync(path.join(FOTKY_DIR, name), buf); return name; } catch (_) { return null; }
  }
  function fotkySeznam() { return (load().config.fotky || []).map(f => (typeof f === 'string' ? { file: f, popis: '' } : f)).filter(f => f && f.file); }
  function serveFotka(res, name) {
    const safe = path.basename(String(name || ''));
    const fp = path.join(FOTKY_DIR, safe);
    if (!safe || !fs.existsSync(fp)) { host.send(res, 404, 'Nenalezeno', { 'Content-Type': 'text/plain' }); return true; }
    const ext = (safe.split('.').pop() || '').toLowerCase();
    try { res.writeHead(200, { 'Content-Type': FOTO_CT[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' }); res.end(fs.readFileSync(fp)); }
    catch (_) { host.send(res, 500, 'Chyba', { 'Content-Type': 'text/plain' }); }
    return true;
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
  function isClientHost(req) {
    const h = (req.headers.host || '').toLowerCase().split(':')[0];
    return h === CLIENT_HOST || h.startsWith('lodaky.');
  }
  async function handleClientHost(req, res) {
    if (!isClientHost(req)) return false;
    const u = urlLib.parse(req.url, true); const p = u.pathname;
    if (p === '/healthz') return false; // healthz ať řeší server
    if (p === '/api/kontejnery/poptavka' && req.method === 'POST') return apiPoptavka(req, res);
    if (p === '/api/kontejnery/fotky' && req.method === 'GET') { json(res, 200, { fotky: fotkySeznam().map(f => ({ url: '/kontejnery/foto/' + f.file, popis: f.popis || '' })) }); return true; }
    if (p.startsWith('/kontejnery/foto/') && req.method === 'GET') return serveFotka(res, p.slice('/kontejnery/foto/'.length));
    if (req.method === 'GET') {
      if (!fs.existsSync(WEB_FILE)) { htmlOut(res, 404, '<h1>Chybí kontejnery-web.html</h1>'); return true; }
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
    if (p !== '/kontejnery' && !p.startsWith('/kontejnery/') && !p.startsWith('/api/kontejnery')) return false;

    // -------- VEŘEJNÉ: prezentační web + odeslání poptávky --------
    if ((p === '/kontejnery' || p === '/kontejnery/') && req.method === 'GET') {
      if (!fs.existsSync(WEB_FILE)) { htmlOut(res, 404, '<h1>Chybí kontejnery-web.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(WEB_FILE, 'utf8')); return true;
    }
    if (p === '/api/kontejnery/poptavka' && req.method === 'POST') return apiPoptavka(req, res);
    // veřejné fotky pro prezentační web (banner + galerie)
    if (p === '/api/kontejnery/fotky' && req.method === 'GET') { json(res, 200, { fotky: fotkySeznam().map(f => ({ url: '/kontejnery/foto/' + f.file, popis: f.popis || '' })) }); return true; }
    if (p.startsWith('/kontejnery/foto/') && req.method === 'GET') return serveFotka(res, p.slice('/kontejnery/foto/'.length));

    // -------- INTERNÍ: evidence + přiřazení (vyžaduje přístup) --------
    const me = meOf(req);
    if (!me.isObchodnik) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'K poptávkám kontejnerů nemáte přístup.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K poptávkám kontejnerů nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }
    if ((p === '/kontejnery/sprava' || p === '/kontejnery/sprava/') && req.method === 'GET') {
      if (!fs.existsSync(SPRAVA_FILE)) { htmlOut(res, 404, '<h1>Chybí kontejnery-sprava.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(SPRAVA_FILE, 'utf8')); return true;
    }
    try {
      if (p === '/api/kontejnery/me' && req.method === 'GET') return apiMe(req, res);
      if (p === '/api/kontejnery' && req.method === 'GET') return apiList(req, res);
      if (p === '/api/kontejnery/prirad' && req.method === 'POST') return apiPrirad(req, res);
      if (p === '/api/kontejnery/nabidka' && req.method === 'POST') return apiNabidka(req, res);
      if (p === '/api/kontejnery/nastaveni' && req.method === 'GET') return apiCfgGet(req, res);
      if (p === '/api/kontejnery/nastaveni' && req.method === 'POST') return apiCfgSet(req, res);
      if (p === '/api/kontejnery/fotky' && req.method === 'POST') return apiFotky(req, res);
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
      stav: 'nova', obchodnik: null,
      createdAt: now, updatedAt: now,
      historie: [{ stav: 'nova', note: 'Poptávka z webu', by: { name: jmeno }, at: now }],
    };
    db.items.push(item);
    save(db);
    logAct('kontejnery', { email, name: jmeno }, 'Nová poptávka kontejneru #' + item.cislo + (item.typ ? ' · ' + item.typ : ''));
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
      + '\nPřiřaďte obchodníka v intranetu → Lodní kontejnery:\n' + link;
    for (const n of load().config.notify) await notify(n.email, 'Nová poptávka kontejneru #' + item.cislo, text);
    json(res, 200, { ok: true, cislo: item.cislo });
    return true;
  }

  // ======================================================================
  //  INTERNÍ API
  // ======================================================================
  function apiMe(req, res) {
    const me = meOf(req);
    json(res, 200, { email: me.email, name: me.name, isAdmin: me.isAdmin, isObchodnik: me.isObchodnik, stavy: STAVY, typy: TYPY, employees: employeesForPicker() });
    return true;
  }
  function apiList(req, res) {
    const me = meOf(req);
    const db = load();
    let items = db.items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    json(res, 200, { items, stavy: STAVY, role: { isAdmin: me.isAdmin, isObchodnik: me.isObchodnik }, me: { email: me.email, name: me.name }, employees: employeesForPicker(), notify: db.config.notify });
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
  async function apiNabidka(req, res) {
    const me = meOf(req);
    if (!me.isObchodnik) { json(res, 403, { chyba: 'Nemáte oprávnění.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load();
    const it = db.items.find(x => x.id === String(b.id || ''));
    if (!it) { json(res, 404, { chyba: 'Poptávka nenalezena.' }); return true; }
    const calc = pocitejNabidku(b.radky, b.dph);
    if (!calc.radky.length) { json(res, 400, { chyba: 'Nabídka nemá žádné položky.' }); return true; }
    const now = Date.now();
    const send = !!b.send;
    it.nabidka = { radky: calc.radky, zaklad: calc.zaklad, dph: calc.dph, dphCastka: calc.dphCastka, celkem: calc.celkem, mena: 'Kč', poznamka: String(b.poznamka || '').trim().slice(0, 2000), platnost: String(b.platnost || '').trim().slice(0, 60), by: { email: me.email, name: me.name }, updatedAt: now, odeslano: it.nabidka && it.nabidka.odeslano || false, odeslanoAt: it.nabidka && it.nabidka.odeslanoAt || null };
    let odeslano = false;
    if (send) {
      if (!it.email) { json(res, 400, { chyba: 'Poptávka nemá e-mail klienta — nabídku nelze odeslat.' }); return true; }
      const radkyText = calc.radky.map(r => '• ' + r.popis + '  —  ' + r.pocet + ' × ' + fmtKc(r.cena) + ' = ' + fmtKc(r.radek)).join('\n');
      const text = 'Dobrý den' + (it.jmeno ? ', ' + it.jmeno : '') + ',\n\nděkujeme za vaši poptávku lodního kontejneru. Zasíláme nezávaznou cenovou nabídku:\n\n'
        + radkyText + '\n\nMezisoučet: ' + fmtKc(calc.zaklad) + '\nDPH ' + calc.dph + ' %: ' + fmtKc(calc.dphCastka) + '\nCelkem: ' + fmtKc(calc.celkem) + '\n'
        + (it.nabidka.platnost ? '\nPlatnost nabídky: ' + it.nabidka.platnost + '\n' : '')
        + (it.nabidka.poznamka ? '\n' + it.nabidka.poznamka + '\n' : '')
        + '\nV případě zájmu nebo dotazů nás neváhejte kontaktovat.\n\nS pozdravem\n' + (me.name || 'ELKOPLAST CZ') + '\nELKOPLAST CZ, s.r.o.';
      await notify(it.email, 'Nabídka lodního kontejneru — ELKOPLAST CZ (poptávka #' + it.cislo + ')', text);
      it.nabidka.odeslano = true; it.nabidka.odeslanoAt = now;
      it.stav = 'nabidka'; odeslano = true;
    }
    it.updatedAt = now; it.historie = it.historie || [];
    it.historie.push({ stav: it.stav, note: (send ? 'Nabídka odeslána klientovi' : 'Nabídka uložena') + ' (' + fmtKc(calc.celkem) + ')', by: { email: me.email, name: me.name }, at: now });
    save(db);
    logAct('kontejnery', { email: me.email, name: me.name }, 'Poptávka #' + it.cislo + ': ' + (send ? 'nabídka odeslána' : 'nabídka uložena') + ' ' + fmtKc(calc.celkem));
    json(res, 200, { ok: true, odeslano, item: it });
    return true;
  }
  async function apiFotky(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku (fotka může být příliš velká, max ~5 MB).' }); return true; }
    const db = load();
    if (b.image) {
      const name = saveFotka(b.image);
      if (!name) { json(res, 400, { chyba: 'Nepodařilo se uložit — jen JPG/PNG/WEBP do 6 MB.' }); return true; }
      db.config.fotky.push({ file: name, popis: String(b.popis || '').trim().slice(0, 120) });
      save(db);
      logAct('kontejnery', meOf(req), 'Přidána fotka na web');
    } else if (b.remove) {
      const rm = path.basename(String(b.remove));
      db.config.fotky = (db.config.fotky || []).filter(f => (typeof f === 'string' ? f : f.file) !== rm);
      save(db);
      try { fs.unlinkSync(path.join(FOTKY_DIR, rm)); } catch (_) {}
      logAct('kontejnery', meOf(req), 'Odebrána fotka z webu');
    } else if (Array.isArray(b.order)) {
      const cur = fotkySeznam(); const byFile = {}; cur.forEach(f => { byFile[f.file] = f; });
      const seen = {}; const next = [];
      b.order.forEach(x => { const f = path.basename(String(x)); if (byFile[f] && !seen[f]) { seen[f] = 1; next.push(byFile[f]); } });
      cur.forEach(f => { if (!seen[f.file]) next.push(f); });
      db.config.fotky = next; save(db);
    } else { json(res, 400, { chyba: 'Nic k provedení.' }); return true; }
    json(res, 200, { ok: true, fotky: fotkySeznam().map(f => ({ url: '/kontejnery/foto/' + f.file, popis: f.popis || '' })) });
    return true;
  }
  function apiCfgGet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    json(res, 200, { notify: load().config.notify, employees: employeesForPicker() });
    return true;
  }
  async function apiCfgSet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const incoming = Array.isArray(b.notify) ? b.notify : [];
    const names = {}; employeesForPicker().forEach(e => { names[e.email] = e.name; });
    const seen = {}; const notifyList = [];
    incoming.forEach(x => {
      const email = (typeof x === 'string' ? x : (x && x.email) || '').toLowerCase();
      if (!email || seen[email]) return; seen[email] = 1;
      notifyList.push({ email, name: (x && x.name) || names[email] || email });
    });
    const db = load(); db.config.notify = notifyList; save(db);
    logAct('kontejnery', meOf(req), 'Nastaveni příjemci poptávek: ' + (notifyList.map(x => x.name).join(', ') || '(nikdo)'));
    json(res, 200, { ok: true, notify: notifyList });
    return true;
  }

  return { handle, handleClientHost, isHandler };
}

module.exports = { mount };

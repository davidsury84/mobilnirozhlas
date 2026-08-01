'use strict';
// ============================================================================
//  Modul „LOXXER" — protipožární skříně na skladování a nabíjení Li-Ion baterií
// ============================================================================
//  Veřejná prezentační stránka (/loxxer, bez přihlášení) promuje protipožární
//  skříně LOXXER (skladování a nabíjení lithiových baterií — e-kola, koloběžky,
//  ruční a zahradní nářadí, drony…) pro firmy, půjčovny, sklady a prodejny.
//  Vyzdvihuje benefity a prodejní argumenty a nabízí poptávkový formulář se
//  zájmem o KOUPI nebo PRONÁJEM. Odeslané poptávky padají do evidence v
//  intranetu (data/loxxer-poptavky.json) a „sbíhají" obchodníkovi, který má
//  LOXXER na starosti. Notifikace o nové poptávce jde obchodníkovi(-ům) i
//  obchodnímu řediteli. Obchodník poté zákazníkovi pošle nabídku a její
//  odeslání zaznamená (prodej / pronájem) — správce i obchodní ředitel pak
//  vidí statistiku, kolik a jakých nabídek bylo odesláno. 1× týdně chodí
//  souhrnný report na nastavené příjemce. K dispozici jsou i připravené
//  smlouvy na PRODEJ i PRONÁJEM skříně (tisknutelné šablony).
//
//  Mount v server.js (vzor: mobilni-lisy):
//    const loxxer = require('./loxxer').mount({ send, readBody, deliver,
//      empSession, isAdmin, baseUrl, employeeModules, getState, logActivity,
//      dataDir, mailFrom });
//    if (loxxer && await loxxer.handleClientHost(req, res)) return;  // doména loxxer.*
//    if (loxxer && await loxxer.handle(req, res)) return;
//    loxxer.tick();  // + setInterval po 6 h  → týdenní report
//
//  Veřejné cesty (/loxxer GET, /api/loxxer/poptavka POST, /api/loxxer/pozadi
//  GET) musí být v server.js vyjmuté z přihlašovací závory.
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');

const WEB_FILE = path.join(__dirname, 'loxxer-web.html');
const SPRAVA_FILE = path.join(__dirname, 'loxxer-sprava.html');
const SMLOUVA_PRODEJ_FILE = path.join(__dirname, 'smlouva-prodej.html');
const SMLOUVA_PRONAJEM_FILE = path.join(__dirname, 'smlouva-pronajem.html');
// Klientská doména — alias na TUTÉŽ aplikaci; servíruje jen prezentaci + poptávku (žádný intranet).
const CLIENT_HOST = (process.env.LOXXER_HOST || 'loxxer.cz').toLowerCase();
// Výchozí příjemci týdenního reportu (editovatelné správcem v aplikaci).
const REPORT_DEFAULT = [
  { email: 'david.sury@elkoplast.cz', name: 'David Surý' },
];

const STAVY = {
  nova: 'Nová',
  kontakt: 'Kontaktováno',
  schuzka: 'Schůzka / v jednání',
  nabidka: 'Nabídka odeslána',
  uzavreno: 'Uzavřeno (objednáno)',
  zamitnuto: 'Nerelevantní / ztraceno',
};
// Druhy nabídky (co obchodník zákazníkovi poslal).
const NABIDKA_TYPY = { prodej: 'Prodej', pronajem: 'Pronájem', oboji: 'Prodej i pronájem' };
// Zájem zákazníka z formuláře.
const ZAJEM = { koupe: 'Koupě', pronajem: 'Pronájem', poradit: 'Zatím nevím / poradit' };

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function s160(v) { return String(v == null ? '' : v).trim().slice(0, 160); }
function s300(v) { return String(v == null ? '' : v).trim().slice(0, 300); }

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'loxxer-poptavky.json');
  const BG_FILE = path.join(host.dataDir || __dirname, 'loxxer-hero.bin'); // úvodní fotka přes celou stránku (na volume, ne v JSON)

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- perzistence ----
  function load() {
    let db;
    try { const j = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); db = (j && Array.isArray(j.items)) ? j : { items: [], seq: 0 }; }
    catch (_) { db = { items: [], seq: 0 }; }
    if (!db.config) db.config = {};
    if (!Array.isArray(db.config.notify)) db.config.notify = [];       // obchodníci — komu chodí nové poptávky
    if (!Array.isArray(db.config.reditel)) db.config.reditel = [];     // obchodní ředitel(é) — kopie + statistika
    if (!db.config.report || typeof db.config.report !== 'object') db.config.report = {};
    const rep = db.config.report;
    if (!Array.isArray(rep.to)) rep.to = REPORT_DEFAULT.slice();
    if (typeof rep.weekday !== 'number' || rep.weekday < 0 || rep.weekday > 6) rep.weekday = 1; // pondělí
    if (typeof rep.enabled !== 'boolean') rep.enabled = true;
    return db;
  }
  function save(db) { try { fs.writeFileSync(DATA_F, JSON.stringify(db, null, 2)); } catch (e) { console.error('[loxxer] zápis selhal:', e.message); } }

  // ---- veřejná prezentační stránka (s volitelnou úvodní fotkou přes celou stránku) ----
  function serveWeb(res) {
    if (!fs.existsSync(WEB_FILE)) { htmlOut(res, 404, '<h1>Chybí loxxer-web.html</h1>'); return true; }
    let html = fs.readFileSync(WEB_FILE, 'utf8');
    try {
      const db = load();
      if (db.config && db.config.bg && fs.existsSync(BG_FILE)) {
        // úvodní fotka přes celou stránku (přes tmavý překryv, aby text zůstal čitelný)
        const style = '<style id="heroBg">.hero{background:linear-gradient(rgba(11,20,15,.62),rgba(11,20,15,.72)),url("/api/loxxer/pozadi") center/cover no-repeat}</style>';
        html = html.replace('</head>', style + '</head>');
      }
    } catch (_) {}
    htmlOut(res, 200, html);
    return true;
  }
  function serveBg(res) {
    try {
      const db = load();
      if (!db.config || !db.config.bg || !fs.existsSync(BG_FILE)) { json(res, 404, { chyba: 'Bez fotky.' }); return true; }
      const buf = fs.readFileSync(BG_FILE);
      res.writeHead(200, { 'Content-Type': db.config.bg.type || 'image/jpeg', 'Cache-Control': 'public, max-age=300' });
      res.end(buf);
    } catch (_) { json(res, 404, { chyba: 'Bez fotky.' }); }
    return true;
  }
  async function apiBgSet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/.exec(String(b.dataUrl || ''));
    if (!m) { json(res, 400, { chyba: 'Nahrajte obrázek ve formátu JPG, PNG nebo WEBP.' }); return true; }
    let buf; try { buf = Buffer.from(m[2], 'base64'); } catch (_) { json(res, 400, { chyba: 'Neplatný obrázek.' }); return true; }
    if (!buf.length || buf.length > 6 * 1024 * 1024) { json(res, 400, { chyba: 'Obrázek musí být do 6 MB.' }); return true; }
    try { fs.writeFileSync(BG_FILE, buf); } catch (_) { json(res, 500, { chyba: 'Uložení obrázku selhalo.' }); return true; }
    const db = load(); db.config.bg = { type: m[1] }; save(db);
    logAct('loxxer', meOf(req), 'Nastavena úvodní fotka prezentace');
    json(res, 200, { ok: true });
    return true;
  }
  function apiBgDel(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    try { if (fs.existsSync(BG_FILE)) fs.unlinkSync(BG_FILE); } catch (_) {}
    const db = load(); if (db.config) db.config.bg = null; save(db);
    logAct('loxxer', meOf(req), 'Odebrána úvodní fotka prezentace');
    json(res, 200, { ok: true });
    return true;
  }

  // ---- role ----
  function mods(email) { try { return host.employeeModules(email) || []; } catch (_) { return []; } }
  function meOf(req) {
    const e = host.empSession(req);
    const email = e ? (e.email || '').toLowerCase() : '';
    const admin = host.isAdmin(req);
    const m = email ? mods(email) : [];
    const reditel = isReditel(email);
    const isObchodnik = admin || m.indexOf('obchod') >= 0 || m.indexOf('obchodexp') >= 0 || reditel || isHandler(email);
    return { email, name: e ? (e.name || '') : (admin ? 'Správce' : ''), isAdmin: admin, isReditel: reditel, isObchodnik, canStats: admin || reditel };
  }
  // Obchodní ředitel — vidí statistiku + kopie notifikací. Nastavuje správce.
  function isReditel(email) {
    email = (email || '').toLowerCase(); if (!email) return false;
    try { return load().config.reditel.some(n => (n.email || '').toLowerCase() === email); } catch (_) { return false; }
  }
  // Zaměstnanec, který má co dělat s poptávkami LOXXER (viditelnost + přístup):
  // je v seznamu notifikací (výchozí příjemce) NEBO má přiřazenou nějakou poptávku.
  function isHandler(email) {
    email = (email || '').toLowerCase(); if (!email) return false;
    const db = load();
    if (db.config.notify.some(n => (n.email || '').toLowerCase() === email)) return true;
    return db.items.some(x => x.obchodnik && (x.obchodnik.email || '').toLowerCase() === email);
  }
  // Kdokoli s přístupem do sekce LOXXER (pro flag v /api/my a viditelnost v menu).
  function isAny(email) { return isHandler(email) || isReditel(email); }
  function employeesForPicker() {
    let emps = [];
    try { const s = host.getState ? host.getState() : null; emps = (s && s.employees) || []; } catch (_) {}
    return emps.map(e => ({ email: (e.email || '').toLowerCase(), name: e.name || e.email || '' }))
      .filter(e => e.email).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  }

  // ---- e-mail ----
  function mailHtml(text) {
    const safe = esc(text).replace(/\n/g, '<br>');
    return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#12211a;line-height:1.6">' + safe +
      '<hr style="border:0;border-top:1px solid #e6e9e3;margin:18px 0"><div style="font-size:12px;color:#8a938a">Intranet ELKOPLAST CZ · LOXXER — skříně na Li-Ion baterie</div></div>';
  }
  async function notify(to, subject, text, htmlBody) {
    if (!to || !host.deliver || !host.mailFrom || !host.mailFrom.user) return;
    try { await host.deliver({ to, fromAddr: host.mailFrom.user, fromName: host.mailFrom.name || 'ELKOPLAST — LOXXER', subject, text, html: htmlBody || mailHtml(text) }); }
    catch (e) { console.error('[loxxer] e-mail neodeslán (' + to + '):', e.message); }
  }
  function logAct(type, who, detail) { try { if (host.logActivity) host.logActivity(type, who, detail); } catch (_) {} }
  function baseUrlOf(req) { try { return host.baseUrl(req).replace(/\/$/, ''); } catch (_) { return ''; } }

  // ---- pole poptávky → čitelný přehled (pro e-mail i evidenci) ----
  function prehledRadky(it) {
    const r = [];
    if (it.zajem) r.push(['Zájem', ZAJEM[it.zajem] || it.zajem]);
    if (it.model) r.push(['Uvažovaný model', it.model]);
    if (it.pocet) r.push(['Počet skříní', it.pocet]);
    if (it.baterie) r.push(['Druh baterií', it.baterie]);
    if (it.mnozstvi) r.push(['Množství baterií', it.mnozstvi]);
    if (it.umisteni) r.push(['Umístění skříně', it.umisteni]);
    if (it.termin) r.push(['Časový horizont', it.termin]);
    if (it.pozice) r.push(['Pozice kontaktu', it.pozice]);
    return r;
  }

  // ======================================================================
  //  KLIENTSKÁ DOMÉNA (loxxer.*) — běží PŘED přihlašovací závorou.
  // ======================================================================
  function isClientHost(req) {
    const h = (req.headers.host || '').toLowerCase().split(':')[0];
    return h === CLIENT_HOST || h.startsWith('loxxer.');
  }
  async function handleClientHost(req, res) {
    if (!isClientHost(req)) return false;
    const u = urlLib.parse(req.url, true); const p = u.pathname;
    if (p === '/healthz') return false; // healthz ať řeší server
    if (p === '/api/loxxer/poptavka' && req.method === 'POST') return apiPoptavka(req, res);
    if (p === '/api/loxxer/pozadi' && req.method === 'GET') return serveBg(res);
    if (req.method === 'GET') return serveWeb(res);
    json(res, 405, { chyba: 'Jen GET.' }); return true;
  }

  // ======================================================================
  //  ROUTER
  // ======================================================================
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (p !== '/loxxer' && !p.startsWith('/loxxer/') && !p.startsWith('/api/loxxer')) return false;

    // -------- VEŘEJNÉ: prezentační web + odeslání poptávky + úvodní fotka --------
    if ((p === '/loxxer' || p === '/loxxer/') && req.method === 'GET') return serveWeb(res);
    if (p === '/api/loxxer/pozadi' && req.method === 'GET') return serveBg(res);
    if (p === '/api/loxxer/poptavka' && req.method === 'POST') return apiPoptavka(req, res);

    // -------- INTERNÍ: evidence + přiřazení + nabídky + smlouvy (vyžaduje přístup) --------
    const me = meOf(req);
    if (!me.isObchodnik) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'K poptávkám LOXXER nemáte přístup.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K poptávkám LOXXER nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }
    if ((p === '/loxxer/sprava' || p === '/loxxer/sprava/') && req.method === 'GET') {
      if (!fs.existsSync(SPRAVA_FILE)) { htmlOut(res, 404, '<h1>Chybí loxxer-sprava.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(SPRAVA_FILE, 'utf8')); return true;
    }
    if (p === '/loxxer/smlouva/prodej' && req.method === 'GET') {
      if (!fs.existsSync(SMLOUVA_PRODEJ_FILE)) { htmlOut(res, 404, '<h1>Chybí smlouva-prodej.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(SMLOUVA_PRODEJ_FILE, 'utf8')); return true;
    }
    if (p === '/loxxer/smlouva/pronajem' && req.method === 'GET') {
      if (!fs.existsSync(SMLOUVA_PRONAJEM_FILE)) { htmlOut(res, 404, '<h1>Chybí smlouva-pronajem.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(SMLOUVA_PRONAJEM_FILE, 'utf8')); return true;
    }
    try {
      if (p === '/api/loxxer' && req.method === 'GET') return apiList(req, res);
      if (p === '/api/loxxer/prirad' && req.method === 'POST') return apiPrirad(req, res);
      if (p === '/api/loxxer/nabidka' && req.method === 'POST') return apiNabidka(req, res);
      if (p === '/api/loxxer/smazat' && req.method === 'POST') return apiSmazat(req, res);
      if (p === '/api/loxxer/nastaveni' && req.method === 'GET') return apiCfgGet(req, res);
      if (p === '/api/loxxer/nastaveni' && req.method === 'POST') return apiCfgSet(req, res);
      if (p === '/api/loxxer/pozadi' && req.method === 'POST') return apiBgSet(req, res);
      if (p === '/api/loxxer/pozadi' && req.method === 'DELETE') return apiBgDel(req, res);
    } catch (e) {
      console.error('[loxxer] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }
    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  // ======================================================================
  //  VEŘEJNÉ API — odeslání poptávky
  // ======================================================================
  async function apiPoptavka(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const firma = s160(b.firma);
    const jmeno = s160(b.jmeno);
    const email = s160(b.email);
    const telefon = String(b.telefon || '').trim().slice(0, 60);
    if (!firma || !jmeno || !email) { json(res, 400, { chyba: 'Vyplňte prosím firmu/organizaci, jméno a e-mail.' }); return true; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { json(res, 400, { chyba: 'Neplatný e-mail.' }); return true; }
    if (!b.souhlas) { json(res, 400, { chyba: 'Bez souhlasu se zpracováním údajů nelze poptávku odeslat.' }); return true; }
    if (String(b.web || '').trim()) { json(res, 200, { ok: true }); return true; } // honeypot: tvař se OK, nic neukládej

    const zajem = ZAJEM[b.zajem] ? b.zajem : '';
    const db = load();
    db.seq = (db.seq || 0) + 1;
    const now = Date.now();
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      cislo: db.seq,
      firma, jmeno, email, telefon,
      pozice: s160(b.pozice),
      zajem,
      model: s160(b.model),
      pocet: s160(b.pocet),
      baterie: s300(b.baterie),
      mnozstvi: s160(b.mnozstvi),
      umisteni: s160(b.umisteni),
      termin: s160(b.termin),
      zprava: String(b.zprava || '').trim().slice(0, 4000),
      stav: 'nova', obchodnik: null, nabidka: null,
      createdAt: now, updatedAt: now,
      historie: [{ stav: 'nova', note: 'Poptávka z webu', by: { name: jmeno }, at: now }],
    };
    db.items.push(item);
    save(db);
    logAct('loxxer', { email, name: jmeno }, 'Nová poptávka LOXXER #' + item.cislo + ' · ' + firma + (zajem ? ' (' + ZAJEM[zajem] + ')' : ''));

    const link = baseUrlOf(req) + '/loxxer/sprava';
    const prehled = prehledRadky(item).map(r => '• ' + r[0] + ': ' + r[1]).join('\n');
    const text = 'Nová poptávka z webu LOXXER (#' + item.cislo + '):\n\n'
      + '• Firma / organizace: ' + firma + '\n'
      + '• Kontakt: ' + jmeno + '\n'
      + '• E-mail: ' + email + '\n'
      + (telefon ? '• Telefon: ' + telefon + '\n' : '')
      + (prehled ? '\n' + prehled + '\n' : '')
      + (item.zprava ? '\nPoznámka zákazníka:\n' + item.zprava + '\n' : '')
      + '\nPoptávka je v intranetu → LOXXER:\n' + link;
    const subj = 'Nová poptávka LOXXER #' + item.cislo + ' · ' + firma + (zajem ? ' — ' + ZAJEM[zajem] : '');
    // obchodníci + obchodní ředitel (bez duplicit)
    const seen = {};
    for (const n of db.config.notify.concat(db.config.reditel)) {
      const e = (n.email || '').toLowerCase(); if (!e || seen[e]) continue; seen[e] = 1;
      await notify(n.email, subj, text);
    }
    json(res, 200, { ok: true, cislo: item.cislo });
    return true;
  }

  // ======================================================================
  //  INTERNÍ API
  // ======================================================================
  function decorate(it) { return Object.assign({}, it, { prehled: prehledRadky(it) }); }
  function statsOf(items) {
    const s = { celkem: items.length, nove: 0, nabidky: 0, prodej: 0, pronajem: 0, oboji: 0, uzavreno: 0 };
    items.forEach(it => {
      if (it.stav === 'nova') s.nove++;
      if (it.stav === 'uzavreno') s.uzavreno++;
      if (it.nabidka && it.nabidka.typ) {
        s.nabidky++;
        if (it.nabidka.typ === 'prodej') s.prodej++;
        else if (it.nabidka.typ === 'pronajem') s.pronajem++;
        else if (it.nabidka.typ === 'oboji') { s.oboji++; s.prodej++; s.pronajem++; }
      }
    });
    return s;
  }
  function apiList(req, res) {
    const me = meOf(req);
    const db = load();
    const items = db.items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(decorate);
    json(res, 200, {
      items, stavy: STAVY, nabidkaTypy: NABIDKA_TYPY, zajemy: ZAJEM,
      role: { isAdmin: me.isAdmin, isReditel: me.isReditel, isObchodnik: me.isObchodnik, canStats: me.canStats },
      me: { email: me.email, name: me.name },
      stats: me.canStats ? statsOf(db.items) : null,
      employees: employeesForPicker(), notify: db.config.notify, reditel: db.config.reditel, report: db.config.report,
      bg: !!(db.config && db.config.bg),
    });
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
    logAct('loxxer', { email: me.email, name: me.name }, 'Poptávka #' + it.cislo + ': ' + zmena.join(', '));
    // notifikace nově přiřazenému obchodníkovi
    if (b.obchodnik !== undefined && it.obchodnik && it.obchodnik.email) {
      const link = baseUrlOf(req) + '/loxxer/sprava';
      const prehled = prehledRadky(it).map(r => '• ' + r[0] + ': ' + r[1]).join('\n');
      await notify(it.obchodnik.email, 'Přiřazena poptávka LOXXER #' + it.cislo + ' · ' + it.firma,
        'Dobrý den,\n\nbyla vám přiřazena poptávka LOXXER #' + it.cislo + ':\n\n'
        + '• Firma / organizace: ' + it.firma + '\n'
        + '• Kontakt: ' + it.jmeno + '\n'
        + (it.email ? '• E-mail: ' + it.email + '\n' : '') + (it.telefon ? '• Telefon: ' + it.telefon + '\n' : '')
        + (prehled ? '\n' + prehled + '\n' : '')
        + '\nDetail a stav zpracujte v intranetu → LOXXER:\n' + link);
    }
    json(res, 200, { ok: true, item: decorate(it) });
    return true;
  }
  // Zaznamenání odeslané nabídky (prodej / pronájem / oboji) — obchodník i správce.
  async function apiNabidka(req, res) {
    const me = meOf(req);
    if (!me.isObchodnik) { json(res, 403, { chyba: 'Nemáte oprávnění.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load();
    const it = db.items.find(x => x.id === String(b.id || ''));
    if (!it) { json(res, 404, { chyba: 'Poptávka nenalezena.' }); return true; }
    const typ = String(b.typ || '');
    if (!NABIDKA_TYPY[typ]) { json(res, 400, { chyba: 'Vyberte druh nabídky (prodej / pronájem).' }); return true; }
    const now = Date.now();
    const castka = s160(b.castka);
    it.nabidka = { typ, castka, at: now, by: { email: me.email, name: me.name } };
    it.stav = 'nabidka';
    it.updatedAt = now;
    it.historie = it.historie || [];
    it.historie.push({ stav: 'nabidka', note: 'Odeslána nabídka — ' + NABIDKA_TYPY[typ] + (castka ? ' (' + castka + ')' : ''), by: { email: me.email, name: me.name }, at: now });
    save(db);
    logAct('loxxer', { email: me.email, name: me.name }, 'Poptávka #' + it.cislo + ': odeslána nabídka — ' + NABIDKA_TYPY[typ]);
    // kopie obchodnímu řediteli (přehled o odeslaných nabídkách)
    for (const r of db.config.reditel) {
      await notify(r.email, 'LOXXER — odeslána nabídka #' + it.cislo + ' · ' + it.firma,
        (me.name || 'Obchodník') + ' odeslal(a) zákazníkovi nabídku LOXXER.\n\n'
        + '• Poptávka #' + it.cislo + ' · ' + it.firma + '\n'
        + '• Druh nabídky: ' + NABIDKA_TYPY[typ] + '\n'
        + (castka ? '• Částka: ' + castka + '\n' : '')
        + '• Obchodník: ' + (me.name || me.email) + '\n');
    }
    json(res, 200, { ok: true, item: decorate(it), stats: statsOf(db.items) });
    return true;
  }
  async function apiSmazat(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Mazat může jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load();
    const i = db.items.findIndex(x => x.id === String(b.id || ''));
    if (i < 0) { json(res, 404, { chyba: 'Poptávka nenalezena.' }); return true; }
    const [it] = db.items.splice(i, 1);
    save(db);
    logAct('loxxer', meOf(req), 'Smazána poptávka #' + it.cislo + ' · ' + it.firma);
    json(res, 200, { ok: true });
    return true;
  }
  function apiCfgGet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    const db = load();
    json(res, 200, { notify: db.config.notify, reditel: db.config.reditel, report: db.config.report, employees: employeesForPicker(), bg: !!(db.config && db.config.bg) });
    return true;
  }
  async function apiCfgSet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const db = load();
    const names = {}; employeesForPicker().forEach(e => { names[e.email] = e.name; });
    const dedupe = (arr) => {
      const seen = {}; const out = [];
      (Array.isArray(arr) ? arr : []).forEach(x => {
        const email = (typeof x === 'string' ? x : (x && x.email) || '').toLowerCase().trim();
        if (!email || seen[email] || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return; seen[email] = 1;
        out.push({ email, name: (x && x.name) || names[email] || email });
      });
      return out;
    };
    // příjemci notifikací nových poptávek (interní obchodníci)
    if (Array.isArray(b.notify)) db.config.notify = dedupe(b.notify);
    // obchodní ředitel(é) — kopie notifikací + statistika
    if (Array.isArray(b.reditel)) db.config.reditel = dedupe(b.reditel);
    // příjemci týdenního reportu (mohou být i externí adresy)
    if (b.report && typeof b.report === 'object') {
      if (Array.isArray(b.report.to)) db.config.report.to = dedupe(b.report.to);
      if (typeof b.report.enabled === 'boolean') db.config.report.enabled = b.report.enabled;
      if (b.report.weekday != null && b.report.weekday >= 0 && b.report.weekday <= 6) db.config.report.weekday = +b.report.weekday;
    }
    save(db);
    logAct('loxxer', meOf(req), 'Upraveno nastavení (obchodníci / ředitel / report)');
    json(res, 200, { ok: true, notify: db.config.notify, reditel: db.config.reditel, report: db.config.report });
    return true;
  }

  // ======================================================================
  //  TÝDENNÍ REPORT (pojistka 1×/ISO-týden, vzor mobilni-lisy)
  // ======================================================================
  function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const wk = 1 + Math.round(((t - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  function reportBody(items, period, stats) {
    const wrapRow = (l, v) => '<tr><td style="padding:3px 10px 3px 0;color:#6b7a70;font-size:12.5px;white-space:nowrap;vertical-align:top">' + esc(l) + '</td><td style="padding:3px 0;font-size:13.5px">' + esc(v) + '</td></tr>';
    const cards = items.map(it => {
      const rows = prehledRadky(it).map(r => wrapRow(r[0], r[1])).join('');
      const kontakt = [it.email, it.telefon].filter(Boolean).join(' · ');
      return '<div style="border:1px solid #e2e8e0;border-radius:12px;padding:12px 14px;margin:10px 0">'
        + '<div style="font-weight:700;font-size:15px">#' + it.cislo + ' · ' + esc(it.firma) + '</div>'
        + '<div style="color:#6b7a70;font-size:13px;margin:2px 0 8px">' + esc(it.jmeno) + (kontakt ? ' — ' + esc(kontakt) : '')
        + ' · <b style="color:#1f5e22">' + esc(STAVY[it.stav] || it.stav) + '</b>'
        + (it.obchodnik ? ' · obchodník: ' + esc(it.obchodnik.name) : ' · <span style="color:#a86a00">nepřiřazeno</span>') + '</div>'
        + (rows ? '<table style="border-collapse:collapse">' + rows + '</table>' : '')
        + '</div>';
    }).join('');
    const statBox = stats ? ('<table style="border-collapse:collapse;margin:6px 0 14px">'
      + wrapRow('Nabídek odesláno (celkem)', String(stats.nabidky))
      + wrapRow('— z toho prodej', String(stats.prodej))
      + wrapRow('— z toho pronájem', String(stats.pronajem))
      + wrapRow('Uzavřeno (objednáno)', String(stats.uzavreno))
      + '</table>') : '';
    return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#12211a;max-width:640px">'
      + '<h2 style="margin:0 0 4px">LOXXER — týdenní report</h2>'
      + '<div style="color:#6b7a70;font-size:13px;margin-bottom:10px">Nové poptávky z webu za období ' + esc(period) + '. Celkem <b>' + items.length + '</b>.</div>'
      + statBox
      + (items.length ? cards : '<div style="border:1px dashed #cfe0c2;border-radius:12px;padding:16px;color:#6b7a70">Tento týden nepřišla žádná nová poptávka.</div>')
      + '<hr style="border:0;border-top:1px solid #e6e9e3;margin:20px 0"><div style="font-size:12px;color:#8a938a">Automatický týdenní report · Intranet ELKOPLAST CZ → LOXXER. Příjemce a zapnutí spravuje správce v aplikaci.</div></div>';
  }
  async function tick() {
    try {
      const db = load();
      const rep = db.config.report;
      if (!rep.enabled || !Array.isArray(rep.to) || !rep.to.length) return;
      const now = new Date(); const wk = isoWeek(now);
      if (now.getDay() < rep.weekday) return;       // pošli v den >= zvolený weekday
      if (rep.lastWeek === wk) return;              // jednou za ISO-týden
      const since = now.getTime() - 7 * 24 * 3600 * 1000;
      const items = db.items.filter(x => (x.createdAt || 0) >= since).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const fmt = d => d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
      const period = fmt(new Date(since)) + '–' + fmt(now) + ' (' + wk + ')';
      const stats = statsOf(db.items);
      const html = reportBody(items, period, stats);
      const textLines = items.length
        ? items.map(it => '#' + it.cislo + ' · ' + it.firma + ' — ' + it.jmeno + ' (' + (STAVY[it.stav] || it.stav) + (it.obchodnik ? ', ' + it.obchodnik.name : ', nepřiřazeno') + ')').join('\n')
        : 'Tento týden nepřišla žádná nová poptávka.';
      const text = 'LOXXER — týdenní report (' + period + ')\nNových poptávek: ' + items.length
        + '\nNabídek celkem: ' + stats.nabidky + ' (prodej ' + stats.prodej + ', pronájem ' + stats.pronajem + '), uzavřeno ' + stats.uzavreno + '\n\n' + textLines;
      for (const r of rep.to) await notify(r.email, 'LOXXER — týdenní report (' + items.length + ' nových)', text, html);
      rep.lastWeek = wk; rep.lastAt = now.toISOString();
      save(db);
      console.log('[loxxer] týdenní report ' + wk + ': ' + items.length + ' poptávek → ' + rep.to.map(r => r.email).join(', '));
    } catch (e) { console.error('[loxxer] tick:', e.message); }
  }

  return { handle, handleClientHost, isHandler, isAny, tick };
}

module.exports = { mount };

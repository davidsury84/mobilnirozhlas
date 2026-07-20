'use strict';
// ============================================================================
//  Modul „Reklamace" — veřejný reklamační formulář na klientský odkaz
// ============================================================================
//  Každý klient dostane vlastní neveřejný odkaz (/reklamace/r/<token>). Přes něj
//  bez přihlášení podává reklamace: výrobní číslo, datum předání, popis vady,
//  datum zjištění, fotografie/video, údaje o použití/zatížení/prostředí a
//  kontaktní osobu pro prohlídku. Data padají do evidence v intranetu
//  (data/reklamace.json + přílohy) a volitelně do Google tabulky.
//
//  Mount v server.js:
//    const reklamace = require('./reklamace').mount({
//      send, readBody, deliver, empSession, isAdmin, baseUrl,
//      employeeModules, getState, logActivity, dataDir, mailFrom
//    });
//    if (reklamace && await reklamace.handle(req, res)) return;
//
//  Veřejné cesty (/reklamace/r/*, /api/reklamace/verejny/*) musí být v server.js
//  vyjmuté z přihlašovací závory (viz proměnná reklamacePublic).
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');

let sheets = null;
try { sheets = require('./lib/sheets'); } catch (_) { sheets = null; }

const HTML_FILE = path.join(__dirname, 'reklamace.html');
const PUBLIC_HTML_FILE = path.join(__dirname, 'reklamace-verejny.html');

// Povinné údaje reklamace (dle smluvní úpravy). Používá se pro výpočet úplnosti.
const REQUIRED = [
  { key: 'vyrobniCislo', label: 'Výrobní číslo dotčeného kusu' },
  { key: 'datumPredani', label: 'Datum předání' },
  { key: 'popisVady', label: 'Přesný popis vady' },
  { key: 'datumZjisteni', label: 'Datum zjištění vady' },
  { key: 'kontaktOsoba', label: 'Kontaktní osoba pro prohlídku' },
];
// Maximální velikosti příloh.
const MAX_IMG = 15e6, MAX_VIDEO = 80e6, MAX_MEDIA_COUNT = 12;
const ALLOWED_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-msvideo': 'avi', 'video/3gpp': '3gp',
};

const STAVY = {
  nova: 'Nová',
  doplnit: 'K doplnění',
  reseni: 'V řešení',
  uzavrena: 'Uzavřená',
  zamitnuta: 'Zamítnutá',
};

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'reklamace.json');
  const FILES_DIR = path.join(host.dataDir || __dirname, 'reklamace-files');
  try { if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- perzistence ---------------------------------------------------------
  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); } catch (_) {}
    if (!d || typeof d !== 'object') d = {};
    if (typeof d.seq !== 'number') d.seq = 0;
    if (!Array.isArray(d.clients)) d.clients = [];
    if (!Array.isArray(d.cases)) d.cases = [];
    if (!d.settings || typeof d.settings !== 'object') d.settings = {};
    if (!Array.isArray(d.settings.notifyEmails)) d.settings.notifyEmails = [];
    if (typeof d.settings.sheetId !== 'string') d.settings.sheetId = '';
    if (typeof d.settings.sheetTab !== 'string') d.settings.sheetTab = '';
    return d;
  }
  function save(d) { fs.writeFileSync(DATA_F, JSON.stringify(d, null, 2)); }

  // ---- přístup -------------------------------------------------------------
  function maModul(req) {
    if (host.isAdmin(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    try { if ((host.employeeModules(e.email) || []).includes('reklamace')) return true; } catch (_) {}
    return false;
  }
  function meOf(req) {
    const e = host.empSession(req);
    return { email: e ? (e.email || '').toLowerCase() : '', name: e ? (e.name || '') : '', isAdmin: host.isAdmin(req) };
  }
  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  }

  // ---- e-mail (best-effort) ------------------------------------------------
  async function mail(to, subject, text) {
    if (!to || !host.deliver || !host.mailFrom || !host.mailFrom.user) return;
    try {
      await host.deliver({ to, fromAddr: host.mailFrom.user, fromName: host.mailFrom.name || 'Intranet – reklamace', subject, text, html: mailHtml(text) });
    } catch (e) { console.error('[reklamace] e-mail se nepodařilo odeslat:', e.message); }
  }
  function mailHtml(text) {
    return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f1512;line-height:1.55">'
      + esc(text).replace(/\n/g, '<br>') + '</div>';
  }

  // ======================================================================
  //  ROUTER
  // ======================================================================
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (!p.startsWith('/reklamace') && !p.startsWith('/api/reklamace')) return false;

    // ---------- VEŘEJNÉ cesty klientského formuláře (bez SSO) --------------
    if (p.startsWith('/reklamace/r/') || p.startsWith('/api/reklamace/verejny/')) {
      return await handlePublic(req, res, u, p);
    }

    // ---------- interní část: vyžaduje přístup k modulu --------------------
    if (!maModul(req)) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'Nemáte přístup k modulu Reklamace.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K modulu Reklamace nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }

    if ((p === '/reklamace' || p === '/reklamace/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí reklamace.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }

    // interní stažení přílohy
    if (p === '/api/reklamace/soubor' && req.method === 'GET') {
      return serveInternalFile(res, u.query);
    }

    try {
      if (p === '/api/reklamace/me' && req.method === 'GET') return apiMe(req, res);
      if (p === '/api/reklamace/data' && req.method === 'GET') return apiData(req, res);
      if (p === '/api/reklamace/klient' && req.method === 'POST') return apiClientSave(req, res);
      if (p === '/api/reklamace/klient/stav' && req.method === 'POST') return apiClientToggle(req, res);
      if (p === '/api/reklamace/klient/token' && req.method === 'POST') return apiClientRegen(req, res);
      if (p === '/api/reklamace/stav' && req.method === 'POST') return apiCaseStav(req, res);
      if (p === '/api/reklamace/sync' && req.method === 'POST') return apiCaseSync(req, res);
      if (p === '/api/reklamace/nastaveni' && req.method === 'POST') return apiSettings(req, res);
      if (p === '/api/reklamace/test-sheet' && req.method === 'POST') return apiTestSheet(req, res);
    } catch (e) {
      console.error('[reklamace] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }

    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  // ======================================================================
  //  INTERNÍ API
  // ======================================================================
  // Efektivní cíl zápisu: ID/list z nastavení modulu, jinak fallback na env.
  function effectiveSheet(d) {
    const s = d.settings || {};
    const envId = (sheets && sheets.envSheetId()) || '';
    const envTab = (sheets && sheets.envSheetTab()) || '';
    const id = (s.sheetId || envId || '').trim();
    const tab = (s.sheetTab || envTab || 'Reklamace').trim();
    return { id, tab, source: s.sheetId ? 'nastavení' : (envId ? 'env' : ''), fromEnv: !!envId && !s.sheetId };
  }
  function apiMe(req, res) {
    const me = meOf(req);
    const d = load();
    const eff = effectiveSheet(d);
    json(res, 200, {
      email: me.email, name: me.name, isAdmin: me.isAdmin,
      sheet: {
        saReady: !!(sheets && sheets.saReady()),
        saEmail: (sheets && sheets.saEmail()) || '',
        id: eff.id, tab: eff.tab, source: eff.source,
        active: !!(sheets && sheets.saReady() && eff.id),
      },
    });
    return true;
  }

  function baseUrlOf(req) { try { return host.baseUrl(req).replace(/\/$/, ''); } catch (_) { return ''; } }

  function apiData(req, res) {
    const d = load();
    const base = baseUrlOf(req);
    const clients = d.clients.map(c => ({
      id: c.id, name: c.name, ico: c.ico || '', email: c.email || '', note: c.note || '',
      active: c.active !== false, createdAt: c.createdAt, token: c.token,
      url: base + '/reklamace/r/' + c.token,
      pocet: d.cases.filter(x => x.clientId === c.id).length,
    })).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
    const cases = d.cases.map(publicCaseView).sort((a, b) => b.createdAt - a.createdAt);
    json(res, 200, { clients, cases, stavy: STAVY, required: REQUIRED, settings: d.settings });
    return true;
  }
  // Pohled na reklamaci pro interní přehled (vč. cest k přílohám).
  function publicCaseView(c) {
    return {
      id: c.id, cislo: c.cislo, clientId: c.clientId, clientName: c.clientName,
      createdAt: c.createdAt, uplatnenoAt: c.uplatnenoAt || null,
      vyrobniCislo: c.vyrobniCislo, datumPredani: c.datumPredani, popisVady: c.popisVady,
      datumZjisteni: c.datumZjisteni,
      kontaktOsoba: c.kontaktOsoba, kontaktTelefon: c.kontaktTelefon, kontaktEmail: c.kontaktEmail,
      media: (c.media || []).map((m, i) => ({ i, name: m.name, kind: m.kind, mime: m.mime, size: m.size, url: '/api/reklamace/soubor?id=' + c.id + '&mi=' + i })),
      uplna: !!c.uplna, chybi: c.chybi || [],
      stav: c.stav || 'nova', interniPozn: c.interniPozn || '',
      historie: c.historie || [], sheetSync: c.sheetSync || null, ip: c.ip || '',
    };
  }

  async function apiClientSave(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const me = meOf(req);
    const name = String(b.name || '').trim().slice(0, 160);
    if (!name) { json(res, 400, { chyba: 'Zadejte název klienta.' }); return true; }
    const d = load();
    let c = b.id ? d.clients.find(x => x.id === b.id) : null;
    if (c) {
      c.name = name; c.ico = String(b.ico || '').trim().slice(0, 20);
      c.email = String(b.email || '').trim().slice(0, 160); c.note = String(b.note || '').trim().slice(0, 500);
    } else {
      c = {
        id: 'cl' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        name, ico: String(b.ico || '').trim().slice(0, 20), email: String(b.email || '').trim().slice(0, 160),
        note: String(b.note || '').trim().slice(0, 500),
        token: crypto.randomBytes(24).toString('hex'), active: true, createdAt: Date.now(), createdBy: me.email,
      };
      d.clients.push(c);
    }
    save(d);
    logAct('reklamace-klient', me, (b.id ? 'Úprava klienta: ' : 'Nový klient: ') + name);
    json(res, 200, { ok: true, id: c.id, url: baseUrlOf(req) + '/reklamace/r/' + c.token });
    return true;
  }

  async function apiClientToggle(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const c = d.clients.find(x => x.id === b.id);
    if (!c) { json(res, 404, { chyba: 'Klient nenalezen.' }); return true; }
    c.active = !!b.active;
    save(d);
    json(res, 200, { ok: true, active: c.active });
    return true;
  }

  async function apiClientRegen(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const c = d.clients.find(x => x.id === b.id);
    if (!c) { json(res, 404, { chyba: 'Klient nenalezen.' }); return true; }
    c.token = crypto.randomBytes(24).toString('hex');
    save(d);
    logAct('reklamace-klient', meOf(req), 'Nový odkaz pro klienta: ' + c.name);
    json(res, 200, { ok: true, url: baseUrlOf(req) + '/reklamace/r/' + c.token });
    return true;
  }

  async function apiCaseStav(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const me = meOf(req);
    const d = load();
    const c = d.cases.find(x => x.id === b.id);
    if (!c) { json(res, 404, { chyba: 'Reklamace nenalezena.' }); return true; }
    const stav = String(b.stav || '').trim();
    if (stav && STAVY[stav]) c.stav = stav;
    if (typeof b.interniPozn === 'string') c.interniPozn = b.interniPozn.slice(0, 3000);
    c.historie = c.historie || [];
    c.historie.push({ at: Date.now(), kdo: me.name || me.email, akce: 'Úprava: ' + (STAVY[c.stav] || c.stav), pozn: String(b.pozn || '').slice(0, 500) });
    save(d);
    json(res, 200, { ok: true, case: publicCaseView(c) });
    return true;
  }

  // Ruční (opětovný) zápis reklamace do Google tabulky.
  async function apiCaseSync(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const c = d.cases.find(x => x.id === b.id);
    if (!c) { json(res, 404, { chyba: 'Reklamace nenalezena.' }); return true; }
    const r = await syncSheet(c, d);
    c.sheetSync = r;
    save(d);
    json(res, r.ok ? 200 : 502, { ok: r.ok, sheetSync: r });
    return true;
  }

  async function apiSettings(req, res) {
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    const d = load();
    if (Array.isArray(b.notifyEmails)) {
      d.settings.notifyEmails = b.notifyEmails.map(e => String(e || '').trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 20);
    }
    if (typeof b.sheetId === 'string') {
      // přijmi buď holé ID, nebo celou URL tabulky (…/d/<ID>/…)
      const raw = b.sheetId.trim();
      const m = raw.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
      d.settings.sheetId = (m ? m[1] : raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
    }
    if (typeof b.sheetTab === 'string') d.settings.sheetTab = b.sheetTab.trim().slice(0, 100);
    save(d);
    json(res, 200, { ok: true, settings: d.settings });
    return true;
  }

  // Zkušební zápis do tabulky (jen správce) — ověří sdílení a přístup SA.
  async function apiTestSheet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    const d = load();
    if (!sheets || !sheets.saReady()) { json(res, 400, { ok: false, chyba: 'Service account není nastaven na serveru (GOOGLE_SA_*).' }); return true; }
    const eff = effectiveSheet(d);
    if (!eff.id) { json(res, 400, { ok: false, chyba: 'Nejprve zadejte ID Google tabulky.' }); return true; }
    try {
      await sheets.appendRow(eff.id, eff.tab, ['— test —', new Date().toLocaleString('cs-CZ'), 'Zkušební zápis z intranetu (můžete řádek smazat)'], SHEET_HEADER);
      json(res, 200, { ok: true, sheet: { id: eff.id, tab: eff.tab } });
    } catch (e) {
      json(res, 502, { ok: false, chyba: e.message });
    }
    return true;
  }

  // ======================================================================
  //  VEŘEJNÁ ČÁST — klientský formulář (bez přihlášení, přes token)
  // ======================================================================
  async function handlePublic(req, res, u, p) {
    // stránka formuláře
    const mPage = /^\/reklamace\/r\/([a-f0-9]{32,64})\/?$/.exec(p);
    if (mPage && req.method === 'GET') {
      if (!fs.existsSync(PUBLIC_HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí reklamace-verejny.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(PUBLIC_HTML_FILE, 'utf8')); return true;
    }
    // ověření odkazu + info o klientovi
    const mData = /^\/api\/reklamace\/verejny\/([a-f0-9]{32,64})$/.exec(p);
    if (mData && req.method === 'GET') return apiPublicInfo(req, res, mData[1]);
    // nahrání jedné přílohy (raw binární tok — obchází 12MB limit readBody, umožní i video)
    const mUp = /^\/api\/reklamace\/verejny\/([a-f0-9]{32,64})\/priloha$/.exec(p);
    if (mUp && req.method === 'POST') return apiPublicUpload(req, res, mUp[1], u.query);
    // odeslání reklamace
    const mSend = /^\/api\/reklamace\/verejny\/([a-f0-9]{32,64})$/.exec(p);
    if (mSend && req.method === 'POST') return apiPublicSubmit(req, res, mSend[1]);

    if (p.startsWith('/api/')) { json(res, 404, { chyba: 'Neplatný odkaz.' }); return true; }
    htmlOut(res, 404, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">Odkaz nenalezen nebo byl deaktivován.</p>');
    return true;
  }

  function findClientByToken(d, token) { return d.clients.find(c => c.token === token); }

  function apiPublicInfo(req, res, token) {
    const d = load();
    const c = findClientByToken(d, token);
    if (!c || c.active === false) { json(res, 410, { chyba: 'Odkaz je neplatný nebo byl deaktivován. Kontaktujte prosím ELKOPLAST CZ.' }); return true; }
    json(res, 200, { clientName: c.name, required: REQUIRED.map(r => r.label) });
    return true;
  }

  async function apiPublicSubmit(req, res, token) {
    const d = load();
    const c = findClientByToken(d, token);
    if (!c || c.active === false) { json(res, 410, { chyba: 'Odkaz je neplatný nebo byl deaktivován.' }); return true; }

    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }

    const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 2000);
    const rec = {
      id: 'rk' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      clientId: c.id, clientName: c.name,
      createdAt: Date.now(), ip: clientIp(req),
      vyrobniCislo: s(b.vyrobniCislo, 120),
      datumPredani: s(b.datumPredani, 40),
      popisVady: s(b.popisVady, 4000),
      datumZjisteni: s(b.datumZjisteni, 40),
      kontaktOsoba: s(b.kontaktOsoba, 160),
      kontaktTelefon: s(b.kontaktTelefon, 60),
      kontaktEmail: s(b.kontaktEmail, 160),
      media: [],
      historie: [], sheetSync: null,
    };

    // minimum, aby vůbec šlo reklamaci přijmout (písemné uplatnění s identifikací)
    if (!rec.vyrobniCislo || !rec.popisVady || (!rec.kontaktEmail && !rec.kontaktTelefon)) {
      json(res, 400, { chyba: 'Uveďte prosím alespoň výrobní číslo, popis vady a kontakt (e-mail nebo telefon).' });
      return true;
    }
    if (rec.kontaktEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.kontaktEmail)) {
      json(res, 400, { chyba: 'Zadejte platnou e-mailovou adresu.' });
      return true;
    }

    // přílohy: klient je předem nahrál do „draftu" a teď posílá jen jejich reference
    const draftId = String(b.draftId || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
    const refs = Array.isArray(b.media) ? b.media.slice(0, MAX_MEDIA_COUNT) : [];
    if (refs.length) {
      const moved = moveDraftMedia(draftId, rec.id, refs);
      if (moved.chyba) { json(res, 400, { chyba: moved.chyba }); return true; }
      rec.media = moved.media;
    }
    sweepDrafts(); // úklid neodeslaných draftů starších než 24 h

    // úplnost dle povinných údajů + fotodokumentace
    const chybi = [];
    for (const f of REQUIRED) { if (!rec[f.key]) chybi.push(f.label); }
    if (!rec.media.length) chybi.push('Fotografie nebo video');
    rec.chybi = chybi;
    rec.uplna = chybi.length === 0;
    rec.uplatnenoAt = rec.uplna ? rec.createdAt : null; // řádně uplatněno až po doplnění údajů
    rec.stav = rec.uplna ? 'nova' : 'doplnit';
    rec.cislo = nextCislo(d);
    rec.historie.push({ at: rec.createdAt, kdo: c.name + ' (klient)', akce: 'Reklamace uplatněna' + (rec.uplna ? '' : ' — neúplná'), pozn: '' });

    d.cases.push(rec);
    save(d);

    logAct('reklamace-nova', { email: '', name: c.name + ' (klient)' }, 'Reklamace ' + rec.cislo + (rec.uplna ? '' : ' (neúplná)'));

    // zápis do Google tabulky (best-effort, neblokuje odpověď klientovi)
    syncSheet(rec, d).then(r => { try { const dd = load(); const cc = dd.cases.find(x => x.id === rec.id); if (cc) { cc.sheetSync = r; save(dd); } } catch (_) {} });
    // notifikace pověřeným osobám
    notify(d, rec, c);

    json(res, 200, {
      ok: true, cislo: rec.cislo, uplna: rec.uplna,
      chybi: rec.chybi,
      zprava: rec.uplna
        ? 'Reklamace byla přijata a řádně uplatněna. Ozveme se vám ke sjednání prohlídky.'
        : 'Reklamaci jsme přijali. Je však neúplná — za řádně uplatněnou se považuje až po doplnění chybějících údajů. Prosíme o doplnění: ' + rec.chybi.join(', ') + '.',
    });
    return true;
  }

  function nextCislo(d) {
    d.seq = (d.seq || 0) + 1;
    const rok = new Date().getFullYear();
    return 'RKL-' + rok + '-' + String(d.seq).padStart(4, '0');
  }

  // ---- přílohy -------------------------------------------------------------
  const DRAFTS_DIR = path.join(FILES_DIR, '_drafts');
  function sanitizeName(name, isVideo) {
    return String(name || (isVideo ? 'video' : 'foto')).replace(/[^\w.\- ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]+/g, '_').slice(0, 120);
  }
  // Nahrání přílohy: raw binární tok přímo na disk (obchází 12MB limit readBody).
  function apiPublicUpload(req, res, token, query) {
    const d = load();
    const c = findClientByToken(d, token);
    if (!c || c.active === false) { json(res, 410, { chyba: 'Odkaz je neplatný nebo byl deaktivován.' }); return true; }
    const draftId = String(query.draft || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
    if (draftId.length < 6) { json(res, 400, { chyba: 'Chybí identifikátor formuláře.' }); return true; }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = ALLOWED_MIME[mime];
    if (!ext) { json(res, 415, { chyba: 'Nepodporovaný typ přílohy (' + (mime || 'neznámý') + '). Povolené: JPG, PNG, WEBP, HEIC, MP4, MOV, WEBM.' }); return true; }
    const isVideo = mime.startsWith('video/');
    const max = isVideo ? MAX_VIDEO : MAX_IMG;
    const dir = path.join(DRAFTS_DIR, draftId);
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    // omez počet příloh v draftu
    try { if (fs.readdirSync(dir).length >= MAX_MEDIA_COUNT) { json(res, 400, { chyba: 'Nahráli jste už maximum příloh (' + MAX_MEDIA_COUNT + ').' }); return true; } } catch (_) {}
    const fn = crypto.randomBytes(8).toString('hex') + '.' + ext;
    const abs = path.join(dir, fn);
    const ws = fs.createWriteStream(abs);
    let size = 0, aborted = false;
    const fail = (code, msg) => { if (aborted) return; aborted = true; try { ws.destroy(); } catch (_) {} try { fs.unlinkSync(abs); } catch (_) {} json(res, code, { chyba: msg }); };
    req.on('data', (ch) => { size += ch.length; if (size > max) { fail(413, 'Příloha je příliš velká (max ' + Math.round(max / 1e6) + ' MB pro ' + (isVideo ? 'video' : 'fotografii') + ').'); try { req.destroy(); } catch (_) {} } });
    req.on('error', () => fail(400, 'Přenos přílohy selhal.'));
    req.pipe(ws);
    ws.on('error', () => fail(500, 'Uložení přílohy selhalo.'));
    ws.on('finish', () => {
      if (aborted) return;
      if (!size) { fail(400, 'Prázdná příloha.'); return; }
      const name = sanitizeName(query.name && decodeURIComponent(query.name), isVideo);
      json(res, 200, { ok: true, ref: { file: fn, name, mime, kind: isVideo ? 'video' : 'image', size } });
    });
    return true;
  }
  // Přesun draftových příloh do složky reklamace + sestavení metadat.
  function moveDraftMedia(draftId, caseId, refs) {
    if (draftId.length < 6) return { chyba: 'Chybí identifikátor formuláře pro přílohy.' };
    const src = path.join(DRAFTS_DIR, draftId);
    const dst = path.join(FILES_DIR, caseId.replace(/[^a-z0-9]/gi, ''));
    try { if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true }); } catch (_) {}
    const media = [];
    for (const r of refs) {
      const file = String((r && r.file) || '');
      // název draftového souboru = <hex>.<přípona> (viz apiPublicUpload); validujeme, nemrvíme
      if (!/^[a-f0-9]{8,}\.[a-z0-9]{2,5}$/i.test(file)) continue;
      const from = path.join(src, file);
      if (!from.startsWith(src + path.sep) || !fs.existsSync(from)) continue;
      const to = path.join(dst, file);
      try { fs.renameSync(from, to); } catch (_) { try { fs.copyFileSync(from, to); fs.unlinkSync(from); } catch (_) { continue; } }
      const isVideo = String(r.kind || '') === 'video' || String(r.mime || '').startsWith('video/');
      let size = r.size; try { size = fs.statSync(to).size; } catch (_) {}
      media.push({ name: sanitizeName(r.name, isVideo), path: path.join(caseId.replace(/[^a-z0-9]/gi, ''), file), mime: String(r.mime || 'application/octet-stream'), kind: isVideo ? 'video' : 'image', size, at: Date.now() });
    }
    try { if (fs.existsSync(src) && !fs.readdirSync(src).length) fs.rmdirSync(src); } catch (_) {}
    return { media };
  }
  // Úklid neodeslaných draftů starších než 24 h.
  let _lastSweep = 0;
  function sweepDrafts() {
    const now = Date.now();
    if (now - _lastSweep < 6 * 3600e3) return; _lastSweep = now;
    try {
      for (const id of fs.readdirSync(DRAFTS_DIR)) {
        const dir = path.join(DRAFTS_DIR, id);
        try { const st = fs.statSync(dir); if (st.isDirectory() && now - st.mtimeMs > 24 * 3600e3) { for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} } fs.rmdirSync(dir); } } catch (_) {}
      }
    } catch (_) {}
  }
  function safePath(rel) {
    if (!rel) return null;
    const abs = path.join(FILES_DIR, rel);
    if (!abs.startsWith(FILES_DIR + path.sep)) return null;
    return abs;
  }
  function serveInternalFile(res, query) {
    const d = load();
    const c = d.cases.find(x => x.id === query.id);
    const mi = parseInt(query.mi, 10);
    const meta = c && c.media && c.media[mi];
    if (!meta) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Příloha nenalezena'); return true; }
    const f = safePath(meta.path);
    if (!f || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Soubor chybí'); return true; }
    const disp = query.dl === '1' ? 'attachment' : 'inline';
    res.writeHead(200, { 'Content-Type': meta.mime || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Disposition': disp + '; filename="' + encodeURIComponent(meta.name) + '"' });
    res.end(fs.readFileSync(f));
    return true;
  }

  // ---- Google tabulka ------------------------------------------------------
  const SHEET_HEADER = ['Číslo', 'Přijato', 'Klient', 'Výrobní číslo', 'Datum předání', 'Popis vady', 'Datum zjištění', 'Kontaktní osoba', 'Telefon', 'E-mail', 'Přílohy', 'Úplná', 'Stav'];
  async function syncSheet(c, d) {
    if (!sheets || !sheets.saReady()) return { ok: false, at: Date.now(), err: 'Service account není nastaven (GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY).' };
    const eff = effectiveSheet(d || load());
    if (!eff.id) return { ok: false, at: Date.now(), err: 'Není zadané ID Google tabulky — doplňte v Nastavení modulu.' };
    try {
      const row = [
        c.cislo, new Date(c.createdAt).toLocaleString('cs-CZ'), c.clientName,
        c.vyrobniCislo, c.datumPredani, c.popisVady, c.datumZjisteni,
        c.kontaktOsoba, c.kontaktTelefon, c.kontaktEmail,
        (c.media || []).length + ' ks', c.uplna ? 'ANO' : 'NE — ' + (c.chybi || []).join('; '),
        STAVY[c.stav] || c.stav || '',
      ];
      await sheets.appendRow(eff.id, eff.tab, row, SHEET_HEADER);
      return { ok: true, at: Date.now(), err: '' };
    } catch (e) {
      console.error('[reklamace] zápis do Google tabulky selhal:', e.message);
      return { ok: false, at: Date.now(), err: e.message };
    }
  }

  // ---- notifikace + log ----------------------------------------------------
  function notify(d, rec, client) {
    const to = (d.settings.notifyEmails || []).slice();
    if (process.env.REKLAMACE_NOTIFY_TO) to.push(...String(process.env.REKLAMACE_NOTIFY_TO).split(/[;,]/).map(x => x.trim()).filter(Boolean));
    const uniq = Array.from(new Set(to.map(x => x.toLowerCase()))).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (!uniq.length) return;
    const text = 'Nová reklamace ' + rec.cislo + (rec.uplna ? '' : ' (NEÚPLNÁ — k doplnění)') + '\n\n'
      + 'Klient: ' + client.name + '\n'
      + 'Výrobní číslo: ' + rec.vyrobniCislo + '\n'
      + 'Datum předání: ' + (rec.datumPredani || '—') + '\n'
      + 'Datum zjištění: ' + (rec.datumZjisteni || '—') + '\n'
      + 'Popis vady: ' + rec.popisVady + '\n'
      + 'Kontakt: ' + rec.kontaktOsoba + ' · ' + [rec.kontaktTelefon, rec.kontaktEmail].filter(Boolean).join(' · ') + '\n'
      + 'Přílohy: ' + (rec.media || []).length + ' ks\n'
      + (rec.uplna ? '' : 'Chybí: ' + (rec.chybi || []).join(', ') + '\n')
      + '\nDetail v intranetu → modul Reklamace.';
    mail(uniq.join(','), 'Reklamace ' + rec.cislo + ' · ' + client.name, text);
  }
  function logAct(type, who, detail) { try { if (host.logActivity) host.logActivity(type, who, detail); } catch (_) {} }

  function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  return { handle };
}

module.exports = { mount };

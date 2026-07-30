'use strict';
// ============================================================================
//  Modul „Požadavky nákupu" — E-shop žádá nákupčího o objednání N kusů
// ============================================================================
//  E-shop (modul „eshop") vytváří požadavek přímo v SMI aplikaci (u produktu,
//  kde vidí skladem/obrátku) tlačítkem „Požádat nákupčího". Požadavek nese kód
//  a název produktu + snímek stavu ze SMI (skladem, obrátka) + počet kusů a
//  důvod. Padá do fronty, kterou řeší nákupčí (modul „nakupci"): mění stav a
//  E-shop vidí, jak se s požadavkem naložilo. Nákupčí dostane nový požadavek
//  e-mailem, E-shop dostane e-mail při každé změně stavu.
//
//  Mount v server.js:
//    const pozadavky = require('./pozadavky').mount({
//      send, readBody, deliver, empSession, isAdmin, baseUrl,
//      employeeModules, getState, logActivity, dataDir, mailFrom
//    });
//    if (pozadavky && await pozadavky.handle(req, res)) return;
//
//  Vše je za přihlašovací závorou (žádné veřejné cesty).
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');

const HTML_FILE = path.join(__dirname, 'pozadavky.html');

// Stavy požadavku (klíč → label). Pořadí = přirozený tok.
const STAVY = {
  novy: 'Nový',
  objednano: 'Objednáno',
  vyrizeno: 'Vyřízeno',
  zamitnuto: 'Zamítnuto',
};

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'pozadavky.json');

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- perzistence ----
  function load() {
    try { const j = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); if (Array.isArray(j)) return { items: j, seq: j.length }; return j && Array.isArray(j.items) ? j : { items: [], seq: 0 }; }
    catch (_) { return { items: [], seq: 0 }; }
  }
  function save(db) { try { fs.writeFileSync(DATA_F, JSON.stringify(db, null, 2)); } catch (e) { console.error('[pozadavky] zápis selhal:', e.message); } }

  // ---- role ----
  function mods(email) { try { return host.employeeModules(email) || []; } catch (_) { return []; } }
  function meOf(req) {
    const e = host.empSession(req);
    const email = e ? (e.email || '').toLowerCase() : '';
    const admin = host.isAdmin(req);
    const m = email ? mods(email) : [];
    return {
      email, name: e ? (e.name || '') : (admin ? 'Správce' : ''),
      isAdmin: admin,
      isBuyer: admin || m.indexOf('nakupci') >= 0,
      isRequester: admin || m.indexOf('eshop') >= 0,
    };
  }
  function maPristup(req) { const me = meOf(req); return me.isBuyer || me.isRequester; }

  // Seznam nákupčích (pro notifikace a přehled) z živé DB zaměstnanců.
  function nakupci() {
    let emps = [];
    try { const s = host.getState ? host.getState() : null; emps = (s && s.employees) || []; } catch (_) {}
    return emps.filter(e => Array.isArray(e.modules) && e.modules.indexOf('nakupci') >= 0)
      .map(e => ({ email: (e.email || '').toLowerCase(), name: e.name || e.email || '' }))
      .filter(e => e.email);
  }

  // ---- e-mail ----
  function mailHtml(text) {
    const safe = String(text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
    return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1c1d1a;line-height:1.6">' + safe +
      '<hr style="border:0;border-top:1px solid #e6e9e3;margin:18px 0"><div style="font-size:12px;color:#8a938a">Intranet ELKOPLAST CZ · modul Požadavky nákupu</div></div>';
  }
  async function notify(to, subject, text) {
    if (!to || !host.deliver || !host.mailFrom || !host.mailFrom.user) return;
    try { await host.deliver({ to, fromAddr: host.mailFrom.user, fromName: host.mailFrom.name || 'Intranet – požadavky', subject, text, html: mailHtml(text) }); }
    catch (e) { console.error('[pozadavky] e-mail neodeslán (' + to + '):', e.message); }
  }
  function logAct(type, who, detail) { try { if (host.logActivity) host.logActivity(type, who, detail); } catch (_) {} }

  // ======================================================================
  //  ROUTER
  // ======================================================================
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (p !== '/pozadavky' && p !== '/pozadavky/' && !p.startsWith('/api/pozadavky')) return false;

    if (!maPristup(req)) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'K modulu Požadavky nákupu nemáte přístup.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K modulu Požadavky nákupu nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }

    if ((p === '/pozadavky' || p === '/pozadavky/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí pozadavky.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }

    try {
      if (p === '/api/pozadavky/me' && req.method === 'GET') return apiMe(req, res);
      if (p === '/api/pozadavky' && req.method === 'GET') return apiList(req, res);
      if (p === '/api/pozadavky' && req.method === 'POST') return apiCreate(req, res);
      if (p === '/api/pozadavky/stav' && req.method === 'POST') return apiStav(req, res);
    } catch (e) {
      console.error('[pozadavky] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }
    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  // ======================================================================
  //  API
  // ======================================================================
  function apiMe(req, res) {
    const me = meOf(req);
    json(res, 200, { email: me.email, name: me.name, isAdmin: me.isAdmin, isBuyer: me.isBuyer, isRequester: me.isRequester, stavy: STAVY, buyers: nakupci().map(b => b.name), buyersCount: nakupci().length });
    return true;
  }

  function apiList(req, res) {
    const me = meOf(req);
    const db = load();
    let items = db.items.slice();
    // E-shop (jen requester, ne nákupčí/admin) vidí jen své požadavky.
    if (!me.isBuyer) items = items.filter(x => (x.requester && (x.requester.email || '').toLowerCase()) === me.email);
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    json(res, 200, { items, stavy: STAVY, role: { isBuyer: me.isBuyer, isRequester: me.isRequester, isAdmin: me.isAdmin }, me: { email: me.email, name: me.name } });
    return true;
  }

  async function apiCreate(req, res) {
    const me = meOf(req);
    if (!(me.isRequester || me.isBuyer)) { json(res, 403, { chyba: 'Nemáte oprávnění vytvořit požadavek.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const kod = String(b.kod || '').trim();
    const nazev = String(b.nazev || '').trim();
    const mnozstvi = Math.round(Number(b.mnozstvi) || 0);
    if (!nazev && !kod) { json(res, 400, { chyba: 'Chybí produkt (kód nebo název).' }); return true; }
    if (!(mnozstvi > 0)) { json(res, 400, { chyba: 'Zadejte kladný počet kusů.' }); return true; }
    const db = load();
    db.seq = (db.seq || 0) + 1;
    const now = Date.now();
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      cislo: db.seq,
      kod, nazev, mnozstvi, jednotka: 'ks',
      skladem: (b.skladem === '' || b.skladem == null || isNaN(Number(b.skladem))) ? null : Number(b.skladem),
      obratka: String(b.obratka || '').trim() || null,
      duvod: String(b.duvod || '').trim(),
      zdroj: String(b.zdroj || '').trim() || 'intranet',
      requester: { email: me.email, name: me.name },
      stav: 'novy',
      createdAt: now, updatedAt: now,
      historie: [{ stav: 'novy', note: '', by: { email: me.email, name: me.name }, at: now }],
    };
    db.items.push(item);
    save(db);
    logAct('pozadavky', { email: me.email, name: me.name }, 'Nový požadavek #' + item.cislo + ' · ' + mnozstvi + ' ks · ' + (nazev || kod));
    // notifikace nákupčím
    const bs = nakupci();
    const link = baseUrlOf(req) + '/#modul=pozadavky';
    const text = 'Dobrý den,\n\nE-shop (' + (me.name || me.email) + ') zadal nový požadavek na nákup:\n\n'
      + '• Produkt: ' + (nazev || '—') + (kod ? ' (kód ' + kod + ')' : '') + '\n'
      + '• Požadovaný počet: ' + mnozstvi + ' ks\n'
      + (item.skladem != null ? '• Aktuálně skladem: ' + item.skladem + ' ks\n' : '')
      + (item.obratka ? '• Obrátka (SMI): ' + item.obratka + '\n' : '')
      + (item.duvod ? '• Důvod: ' + item.duvod + '\n' : '')
      + '\nPožadavek najdete v intranetu → Požadavky nákupu:\n' + link;
    for (const nb of bs) await notify(nb.email, 'Nový požadavek na nákup #' + item.cislo + ' — ' + (nazev || kod), text);
    json(res, 200, { ok: true, id: item.id, cislo: item.cislo, notified: bs.length });
    return true;
  }

  async function apiStav(req, res) {
    const me = meOf(req);
    if (!me.isBuyer) { json(res, 403, { chyba: 'Stav mění jen nákupčí.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { chyba: 'Neplatné tělo požadavku.' }); return true; }
    const id = String(b.id || '');
    const stav = String(b.stav || '');
    const note = String(b.note || '').trim();
    if (!STAVY[stav]) { json(res, 400, { chyba: 'Neznámý stav.' }); return true; }
    const db = load();
    const it = db.items.find(x => x.id === id);
    if (!it) { json(res, 404, { chyba: 'Požadavek nenalezen.' }); return true; }
    const now = Date.now();
    it.stav = stav; it.updatedAt = now;
    it.historie = it.historie || [];
    it.historie.push({ stav, note, by: { email: me.email, name: me.name }, at: now });
    save(db);
    logAct('pozadavky', { email: me.email, name: me.name }, 'Požadavek #' + it.cislo + ' → ' + STAVY[stav] + (note ? ' (' + note + ')' : ''));
    // notifikace žadateli
    if (it.requester && it.requester.email) {
      const link = baseUrlOf(req) + '/#modul=pozadavky';
      const text = 'Dobrý den,\n\nváš požadavek na nákup #' + it.cislo + ' (' + (it.nazev || it.kod) + ', ' + it.mnozstvi + ' ks) má nový stav:\n\n'
        + '→ ' + STAVY[stav] + '\n'
        + (note ? '\nPoznámka nákupčího: ' + note + '\n' : '')
        + '\nDetail v intranetu → Požadavky nákupu:\n' + link;
      await notify(it.requester.email, 'Požadavek #' + it.cislo + ' — ' + STAVY[stav], text);
    }
    json(res, 200, { ok: true, item: it });
    return true;
  }

  function baseUrlOf(req) { try { return host.baseUrl(req).replace(/\/$/, ''); } catch (_) { return ''; } }

  return { handle };
}

module.exports = { mount };

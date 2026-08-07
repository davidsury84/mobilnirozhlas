'use strict';
// Modul „Zápisy z interních jednání" — strukturovaná evidence zápisů.
// Data: DATA_DIR/zapisy-jednani.json — každý zápis má normalizované pole `hledani`
// (malá písmena, bez diakritiky) pro rychlé fulltextové vyhledávání.
// Zapojení v server.js:
//   zapisyMod = require('./zapisy').mount({ send, readBody, empSession, isAdmin, logActivity, dataDir });
//   ...v handleru: if (zapisyMod && await zapisyMod.handle(req, res)) return;

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const urlLib = require('url');

const OBLASTI = ['Marketing', 'Obchod', 'Výroba', 'Nákup', 'Vedení', 'Provoz', 'IT', 'Ostatní'];

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'zapisy-jednani.json');

  function load() { try { const j = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); if (j && Array.isArray(j.items)) return j; } catch (_) {} return { seq: 0, items: [] }; }
  function save(db) { fs.writeFileSync(DATA_F, JSON.stringify(db, null, 2)); }
  function json(res, code, obj) { host.send(res, code, obj); }

  // Normalizace pro vyhledávání: malá písmena, bez diakritiky, sjednocené mezery.
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }
  function blob(z) { return norm([z.nazev, z.oblast, z.ucastnici, z.text, (z.tagy || []).join(' '), z.datum].join(' ')); }

  function meOf(req) {
    const e = host.empSession(req);
    if (e) return { email: e.email, name: e.name, admin: host.isAdmin(req) };
    if (host.isAdmin(req)) return { email: '', name: 'správce', admin: true };
    return null;
  }
  function smiUpravit(me, it) { return me.admin || ((it.by && it.by.email) || '').toLowerCase() === (me.email || '').toLowerCase(); }

  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname || '';
    if (!p.startsWith('/api/zapisy')) return false;
    const me = meOf(req);
    if (!me) { json(res, 401, { error: 'Nepřihlášeno.' }); return true; }

    if (p === '/api/zapisy' && req.method === 'GET') {
      const db = load();
      const items = db.items.slice().sort((a, b) => (b.datum || '').localeCompare(a.datum || '') || ((b.createdAt || 0) - (a.createdAt || 0)));
      json(res, 200, { items, oblasti: OBLASTI, me: { email: me.email, name: me.name, admin: me.admin } });
      return true;
    }

    if (p === '/api/zapisy' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) { json(res, 400, { error: 'Neplatné tělo.' }); return true; }
      const datum = String(b.datum || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) { json(res, 400, { error: 'Zadejte datum jednání.' }); return true; }
      const nazev = String(b.nazev || '').trim().slice(0, 200);
      if (!nazev) { json(res, 400, { error: 'Zadejte název / téma jednání.' }); return true; }
      const rec = {
        datum, nazev,
        oblast: String(b.oblast || 'Ostatní').trim().slice(0, 60) || 'Ostatní',
        ucastnici: String(b.ucastnici || '').trim().slice(0, 500),
        text: String(b.text || '').trim().slice(0, 20000),
        tagy: (Array.isArray(b.tagy) ? b.tagy : String(b.tagy || '').split(',')).map(t => String(t).trim()).filter(Boolean).slice(0, 15),
      };
      const db = load();
      const now = Date.now();
      let it;
      if (b.id) {
        it = db.items.find(x => x.id === String(b.id));
        if (!it) { json(res, 404, { error: 'Zápis nenalezen.' }); return true; }
        if (!smiUpravit(me, it)) { json(res, 403, { error: 'Upravit může jen autor zápisu nebo správce.' }); return true; }
        Object.assign(it, rec); it.updatedAt = now; it.updatedBy = { email: me.email, name: me.name };
      } else {
        db.seq = (db.seq || 0) + 1;
        it = Object.assign({ id: crypto.randomBytes(8).toString('hex'), cislo: db.seq, by: { email: me.email, name: me.name }, createdAt: now, updatedAt: now }, rec);
        db.items.push(it);
      }
      it.hledani = blob(it);
      save(db);
      if (host.logActivity) host.logActivity('zapisy', { email: me.email, name: me.name }, 'Zápis z jednání ' + (b.id ? 'upraven' : 'přidán') + ': ' + it.nazev + ' (' + it.datum + ', ' + it.oblast + ')');
      json(res, 200, { ok: true, item: it });
      return true;
    }

    if (p === '/api/zapisy/smazat' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) { json(res, 400, { error: 'Neplatné tělo.' }); return true; }
      const db = load();
      const i = db.items.findIndex(x => x.id === String(b.id || ''));
      if (i < 0) { json(res, 404, { error: 'Zápis nenalezen.' }); return true; }
      if (!smiUpravit(me, db.items[i])) { json(res, 403, { error: 'Smazat může jen autor zápisu nebo správce.' }); return true; }
      const it = db.items.splice(i, 1)[0];
      save(db);
      if (host.logActivity) host.logActivity('zapisy', { email: me.email, name: me.name }, 'Zápis z jednání smazán: ' + it.nazev + ' (' + it.datum + ')');
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return { handle };
}

module.exports = { mount };

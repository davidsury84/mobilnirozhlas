'use strict';
// ============================================================================
//  Modul „Zahraniční pobočky a partneři" — sekce Kontakty
// ============================================================================
//  Jeden živý seznam zahraničních poboček ELKOPLAST, obchodních partnerů,
//  produktových specialistů a českých provozů. Nahrazuje kolující tabulku
//  „_Elkoplast Divisions" — v intranetu ji vidí a EDITUJE každý zaměstnanec.
//
//  Mount v server.js:
//    const kontakty = require('./kontakty').mount({
//      send, readBody, empSession, isAdmin, getState, logActivity, dataDir
//    });
//    if (kontakty && await kontakty.handle(req, res)) return;
//
//  Data: data/kontakty.json na datovém disku. Prvotní naplnění se NEDÁVÁ do
//  repa (je veřejné) — nahraje se jako data/kontakty-import.json a modul ho
//  při prvním spuštění jednorázově převezme (pak přejmenuje na .hotovo).
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');

const HTML_FILE = path.join(__dirname, 'kontakty.html');

// Úseky seznamu. Klíč = co se ukládá, popis = co vidí uživatel.
const USEKY = {
  pobocky: 'Zahraniční pobočky',
  partneri: 'Obchodní partneři',
  specialiste: 'Produktoví specialisté',
  provozy: 'Provozy a výroba',
};

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'kontakty.json');
  const SEED_F = path.join(host.dataDir || __dirname, 'kontakty-import.json');

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
  const id = () => 'k' + crypto.randomBytes(5).toString('hex');

  // ---- perzistence ---------------------------------------------------------
  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); } catch (_) {}
    if (!d || typeof d !== 'object') d = {};
    Object.keys(USEKY).forEach(k => { if (!Array.isArray(d[k])) d[k] = []; });
    if (!d.importOk && !d.pobocky.length && !d.partneri.length) { if (importSeed(d)) save(d); }
    return d;
  }
  function save(d) { fs.writeFileSync(DATA_F, JSON.stringify(d, null, 2)); }

  // Jednorázový import z nahraného souboru (stejný postup jako u vozového parku).
  function importSeed(d) {
    let seed = null;
    try { seed = JSON.parse(fs.readFileSync(SEED_F, 'utf8')); } catch (_) { return null; }
    if (!seed || typeof seed !== 'object') return null;
    Object.keys(USEKY).forEach(k => {
      (Array.isArray(seed[k]) ? seed[k] : []).forEach(r => {
        const zaznam = Object.assign({}, r, { id: r.id || id(), zmena: null });
        if (k === 'pobocky' && !Array.isArray(zaznam.lide)) zaznam.lide = [];
        if (k === 'pobocky') zaznam.lide = (zaznam.lide || []).map(o => Object.assign({ id: id() }, o));
        d[k].push(zaznam);
      });
    });
    d.importOk = { ts: Date.now(), zdroj: seed.zdroj || 'tabulka _Elkoplast Divisions' };
    try { fs.renameSync(SEED_F, SEED_F + '.hotovo'); } catch (_) {}
    console.log('[kontakty] import: ' + Object.keys(USEKY).map(k => d[k].length + ' ' + k).join(', '));
    return d.importOk;
  }

  // ---- kdo jsem ------------------------------------------------------------
  // Kontakty jsou pro celou firmu: vidí i edituje každý přihlášený zaměstnanec.
  function ja(req) {
    const e = host.empSession(req);
    const admin = host.isAdmin ? host.isAdmin(req) : false;
    if (!e && !admin) return null;
    return { email: (e && e.email) || '', jmeno: (e && e.name) || 'Správce', admin };
  }
  function logAct(req, detail) {
    try {
      const e = host.empSession(req) || {};
      if (host.logActivity) host.logActivity('kontakty', { email: e.email || '', name: e.name || '' }, detail);
    } catch (_) {}
  }
  function podpis(me) { return { kdo: me.jmeno || me.email, email: me.email, ts: Date.now() }; }

  // ---- tvary záznamů -------------------------------------------------------
  function osobaZTela(b, stara) {
    return {
      id: (stara && stara.id) || id(),
      jmeno: txt(b.jmeno, 120),
      role: txt(b.role, 160),
      email: txt(b.email, 160),
      telefon: txt(b.telefon, 60),
    };
  }
  const TVARY = {
    pobocky: (b, s) => ({
      zeme: txt(b.zeme, 80),
      kod: txt(b.kod, 8).toUpperCase(),
      spolecnost: txt(b.spolecnost, 200),
      adresa: txt(b.adresa, 600),
      adresa2: txt(b.adresa2, 600),      // sklad / druhá adresa
      identifikace: txt(b.identifikace, 300),   // IČ / VAT / registrace
      web: txt(b.web, 200),
      poznamka: txt(b.poznamka, 800),
      lide: Array.isArray(s && s.lide) ? s.lide : [],
    }),
    partneri: (b) => ({
      zeme: txt(b.zeme, 80),
      spolecnost: txt(b.spolecnost, 200),
      osoba: txt(b.osoba, 120),
      telefon: txt(b.telefon, 60),
      email: txt(b.email, 160),
      web: txt(b.web, 200),
      poznamka: txt(b.poznamka, 800),
    }),
    specialiste: (b) => ({
      jmeno: txt(b.jmeno, 120),
      oblast: txt(b.oblast, 200),
      email: txt(b.email, 160),
      telefon: txt(b.telefon, 60),
    }),
    provozy: (b) => ({
      druh: txt(b.druh, 60),
      typ: txt(b.typ, 60),
      osoba: txt(b.osoba, 120),
      adresa: txt(b.adresa, 400),
      email: txt(b.email, 160),
      telefon: txt(b.telefon, 60),
    }),
  };

  // ---- API -----------------------------------------------------------------
  function apiData(req, res, me) {
    const d = load();
    const out = { me: { email: me.email, jmeno: me.jmeno, admin: me.admin }, useky: USEKY };
    Object.keys(USEKY).forEach(k => { out[k] = d[k]; });
    out.zdroj = d.importOk || null;
    json(res, 200, out);
    return true;
  }

  async function apiUlozit(req, res, me, usek) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load();
    const seznam = d[usek];
    let z = b.id ? seznam.find(x => x.id === b.id) : null;
    const novy = !z;
    if (novy) { z = { id: id() }; seznam.push(z); }
    Object.assign(z, TVARY[usek](b, z));
    z.zmena = podpis(me);
    save(d);
    logAct(req, (novy ? 'Přidán záznam · ' : 'Upraven záznam · ') + USEKY[usek] + ' · ' + popisZaznamu(usek, z));
    json(res, 200, { ok: true, id: z.id });
    return true;
  }

  async function apiSmazat(req, res, me, usek) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load();
    const z = d[usek].find(x => x.id === String(b.id || ''));
    if (!z) { json(res, 404, { chyba: 'Záznam nenalezen.' }); return true; }
    d[usek] = d[usek].filter(x => x.id !== z.id);
    save(d);
    logAct(req, 'Smazán záznam · ' + USEKY[usek] + ' · ' + popisZaznamu(usek, z));
    json(res, 200, { ok: true });
    return true;
  }

  // Lidé u pobočky — přidání, úprava i smazání jednoho řádku.
  async function apiOsoba(req, res, me) {
    const b = JSON.parse(await host.readBody(req) || '{}');
    const d = load();
    const pob = d.pobocky.find(x => x.id === String(b.pobocka || ''));
    if (!pob) { json(res, 404, { chyba: 'Pobočka nenalezena.' }); return true; }
    pob.lide = Array.isArray(pob.lide) ? pob.lide : [];
    if (b.smazat) {
      const o = pob.lide.find(x => x.id === String(b.id || ''));
      if (!o) { json(res, 404, { chyba: 'Kontakt nenalezen.' }); return true; }
      pob.lide = pob.lide.filter(x => x.id !== o.id);
      logAct(req, 'Smazán kontakt ' + (o.jmeno || '') + ' · ' + (pob.zeme || pob.spolecnost));
    } else {
      const stara = b.id ? pob.lide.find(x => x.id === b.id) : null;
      const o = osobaZTela(b, stara);
      if (!o.jmeno && !o.email) { json(res, 400, { chyba: 'Vyplňte aspoň jméno nebo e-mail.' }); return true; }
      if (stara) Object.assign(stara, o); else pob.lide.push(o);
      logAct(req, (stara ? 'Upraven kontakt ' : 'Přidán kontakt ') + o.jmeno + ' · ' + (pob.zeme || pob.spolecnost));
    }
    pob.zmena = podpis(me);
    save(d);
    json(res, 200, { ok: true });
    return true;
  }

  function popisZaznamu(usek, z) {
    if (usek === 'pobocky') return [z.zeme, z.spolecnost].filter(Boolean).join(' — ');
    if (usek === 'partneri') return [z.zeme, z.spolecnost].filter(Boolean).join(' — ');
    if (usek === 'specialiste') return [z.jmeno, z.oblast].filter(Boolean).join(' — ');
    return [z.druh, z.osoba].filter(Boolean).join(' — ');
  }

  // CSV pro tisk / sdílení ven (jedna řádka na kontakt).
  function apiExport(req, res) {
    const d = load();
    const radky = [['Úsek', 'Země', 'Společnost / oblast', 'Jméno', 'Pozice', 'E-mail', 'Telefon', 'Web', 'Adresa']];
    d.pobocky.forEach(p => {
      if (!p.lide || !p.lide.length) radky.push(['Pobočka', p.zeme, p.spolecnost, '', '', '', '', p.web, p.adresa]);
      (p.lide || []).forEach(o => radky.push(['Pobočka', p.zeme, p.spolecnost, o.jmeno, o.role, o.email, o.telefon, p.web, p.adresa]));
    });
    d.partneri.forEach(p => radky.push(['Partner', p.zeme, p.spolecnost, p.osoba, '', p.email, p.telefon, p.web, '']));
    d.specialiste.forEach(s => radky.push(['Specialista', '', s.oblast, s.jmeno, '', s.email, s.telefon, '', '']));
    d.provozy.forEach(v => radky.push(['Provoz', '', v.druh + (v.typ ? ' / ' + v.typ : ''), v.osoba, '', v.email, v.telefon, '', v.adresa]));
    const csv = '﻿' + radky.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""').replace(/\n/g, ' ') + '"').join(';')).join('\r\n');
    host.send(res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="kontakty-pobocky-partneri.csv"',
      'Cache-Control': 'no-store',
    });
    return true;
  }

  // ---- router --------------------------------------------------------------
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (p !== '/kontakty' && p !== '/kontakty/' && !p.startsWith('/api/kontakty')) return false;

    const me = ja(req);
    if (!me) {
      if (p.startsWith('/api/')) json(res, 401, { chyba: 'Nepřihlášeno.' });
      else htmlOut(res, 401, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">Přihlaste se prosím do intranetu.</p>');
      return true;
    }

    if ((p === '/kontakty' || p === '/kontakty/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí kontakty.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(HTML_FILE, 'utf8'));
      return true;
    }

    try {
      if (p === '/api/kontakty/data' && req.method === 'GET') return apiData(req, res, me);
      if (p === '/api/kontakty/export' && req.method === 'GET') return apiExport(req, res);
      if (p === '/api/kontakty/osoba' && req.method === 'POST') return await apiOsoba(req, res, me);
      const m = /^\/api\/kontakty\/(pobocky|partneri|specialiste|provozy)(\/smazat)?$/.exec(p);
      if (m && req.method === 'POST') {
        return m[2] ? await apiSmazat(req, res, me, m[1]) : await apiUlozit(req, res, me, m[1]);
      }
    } catch (e) {
      console.error('[kontakty] ' + p + ':', e.message);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message });
      return true;
    }
    json(res, 404, { chyba: 'Neznámý požadavek.' });
    return true;
  }

  return { handle };
}

module.exports = { mount };

'use strict';
// ============================================================================
//  Modul „Pipedrive — aktivita obchodníků"
// ============================================================================
//  Přehled práce obchodníků načítaný živě z Pipedrive API: kolik aktivit
//  (hovory, schůzky, e-maily, úkoly…) kdo za období dokončil, co má naplánováno,
//  co je po termínu, a kolik dealů založil / vyhrál / prohrál.
//
//  Mount v server.js:
//    const pipedrive = require('./pipedrive').mount({
//      send, readBody, empSession, isAdmin, employeeModules, logActivity, dataDir
//    });
//    if (pipedrive && await pipedrive.handle(req, res)) return;
//
//  Přístup: modul „pipedrive" v matici přístupů, nebo správce.
//  API token: proměnná PIPEDRIVE_API_TOKEN, nebo ho správce uloží přímo v modulu
//  (data/pipedrive.json na datovém disku — do repa se nedostane).
//  Pipedrive: Nastavení → Osobní předvolby → API. Token posíláme jen v hlavičce
//  x-api-token, nikdy v adrese.
//
//  Použité endpointy (https://pipedrive.readme.io/docs/getting-started):
//    GET /v1/users, /v1/users/me, /v1/activityTypes
//    GET /api/v2/activities   (done, updated_since, cursor, limit ≤ 500)
//    GET /api/v2/deals        (updated_since, cursor, limit ≤ 500)
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const urlLib = require('url');

const HTML_FILE = path.join(__dirname, 'pipedrive.html');
const API_BASE = (process.env.PIPEDRIVE_API_BASE || 'https://api.pipedrive.com').replace(/\/+$/, '');
const CACHE_MS = 10 * 60 * 1000;        // přehled za období držíme 10 minut
const CISELNIKY_MS = 60 * 60 * 1000;    // uživatelé a typy aktivit hodinu
const MAX_STRAN = 40;                   // pojistka: nejvýš 40 × 500 záznamů na dotaz
const MAX_DNI = 400;

const denFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
const den = d => denFmt.format(d);                       // YYYY-MM-DD v pražském čase
// Pipedrive vrací časy jako „2026-01-05T10:20:00Z" i „2026-01-05 10:20:00" (UTC).
function cas(s) {
  if (!s) return null;
  let t = String(s).trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  const d = new Date(t);
  return isNaN(d) ? null : d;
}
const denZ = s => { const d = cas(s); return d ? den(d) : ''; };
const jeDen = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s + 'T00:00:00Z'));

function mount(host) {
  const CFG_F = path.join(host.dataDir || __dirname, 'pipedrive.json');

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- nastavení (token) ---------------------------------------------------
  function konfig() {
    const env = (process.env.PIPEDRIVE_API_TOKEN || '').trim();
    if (env) return { token: env, zdroj: 'env' };
    let d = null;
    try { d = JSON.parse(fs.readFileSync(CFG_F, 'utf8')); } catch (_) {}
    const t = d && typeof d.token === 'string' ? d.token.trim() : '';
    return { token: t, zdroj: t ? 'soubor' : '', zmena: (d && d.zmena) || null };
  }

  // ---- kdo jsem ------------------------------------------------------------
  function ja(req) {
    const e = host.empSession(req);
    const admin = host.isAdmin ? host.isAdmin(req) : false;
    if (!e && !admin) return null;
    const mods = (e && host.employeeModules) ? host.employeeModules(e.email) : [];
    return { email: (e && e.email) || '', jmeno: (e && e.name) || 'Správce', admin, pristup: admin || mods.indexOf('pipedrive') >= 0 };
  }

  // ---- volání Pipedrive ----------------------------------------------------
  async function pd(cesta, params, token) {
    const u = new URL(API_BASE + cesta);
    Object.keys(params || {}).forEach(k => { if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k])); });
    for (let pokus = 0; ; pokus++) {
      const r = await fetch(u, { headers: { 'x-api-token': token, 'Accept': 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (r.status === 429 && pokus < 3) { await new Promise(ok => setTimeout(ok, 2000 * (pokus + 1))); continue; }
      const j = await r.json().catch(() => null);
      if (r.status === 401) throw new Error('Pipedrive odmítl API token (401). Zkontrolujte token v nastavení modulu.');
      if (r.status === 403) throw new Error('Token nemá v Pipedrive oprávnění k těmto datům (403).');
      if (r.status === 429) throw new Error('Pipedrive hlásí překročený limit požadavků (429). Zkuste to za chvíli.');
      if (!r.ok || !j || j.success === false) throw new Error('Pipedrive ' + cesta + ': HTTP ' + r.status + (j && j.error ? ' — ' + j.error : ''));
      return j;
    }
  }
  // Všechny stránky v2 endpointu (stránkování kurzorem).
  async function pdVse(cesta, params, token) {
    const out = []; let cursor = null; let orez = false;
    for (let i = 0; ; i++) {
      if (i >= MAX_STRAN) { orez = true; break; }
      const j = await pd(cesta, Object.assign({ limit: 500 }, params, cursor ? { cursor } : {}), token);
      (j.data || []).forEach(x => out.push(x));
      cursor = j.additional_data && j.additional_data.next_cursor;
      if (!cursor) break;
    }
    return { data: out, orez };
  }

  // ---- číselníky: uživatelé, typy aktivit, doména firmy --------------------
  let ciselniky = null;
  async function nactiCiselniky(token) {
    if (ciselniky && ciselniky.token === token && Date.now() - ciselniky.ts < CISELNIKY_MS) return ciselniky;
    const [uz, typy, me] = await Promise.all([
      pd('/v1/users', null, token),
      pd('/v1/activityTypes', null, token),
      pd('/v1/users/me', null, token).catch(() => null),
    ]);
    ciselniky = {
      token, ts: Date.now(),
      uzivatele: (uz.data || []).map(u => ({ id: u.id, jmeno: u.name || u.email || ('#' + u.id), email: u.email || '', aktivni: u.active_flag !== false })),
      typy: (typy.data || []).map(t => ({ klic: t.key_string, nazev: t.name || t.key_string, poradi: t.order_nr || 0 })),
      domena: (me && me.data && me.data.company_domain) || '',
    };
    return ciselniky;
  }

  // ---- přehled za období ---------------------------------------------------
  const cache = new Map();     // 'od|do' → { ts, data }
  const bezi = new Map();      // 'od|do' → Promise (souběžné dotazy čekají na jedno načtení)

  function prehled(od, doo, znovu) {
    const klic = od + '|' + doo;
    const c = cache.get(klic);
    if (!znovu && c && Date.now() - c.ts < CACHE_MS) return Promise.resolve(c.data);
    if (bezi.has(klic)) return bezi.get(klic);
    const p = sestav(od, doo).then(data => {
      cache.set(klic, { ts: Date.now(), data });
      if (cache.size > 30) cache.delete(cache.keys().next().value);
      return data;
    }).finally(() => bezi.delete(klic));
    bezi.set(klic, p);
    return p;
  }

  async function sestav(od, doo) {
    const { token } = konfig();
    if (!token) { const e = new Error('Není nastaven API token Pipedrive.'); e.kod = 'bez-tokenu'; throw e; }
    // Dokončení i změna stavu dealu vždy posune update_time, takže stačí brát změny
    // od začátku období (den rezerva kvůli časovým pásmům).
    const odCas = new Date(new Date(od + 'T00:00:00Z').getTime() - 36 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    const [cis, hot, otev, dealy] = await Promise.all([
      nactiCiselniky(token),
      pdVse('/api/v2/activities', { done: true, updated_since: odCas, sort_by: 'update_time', sort_direction: 'desc' }, token),
      pdVse('/api/v2/activities', { done: false, sort_by: 'due_date', sort_direction: 'asc' }, token),
      pdVse('/api/v2/deals', { updated_since: odCas, sort_by: 'update_time', sort_direction: 'desc' }, token),
    ]);
    const dnes = den(new Date());
    const vObdobi = d => d && d >= od && d <= doo;

    const lide = new Map();
    const clovek = id => {
      if (!lide.has(id)) {
        const u = cis.uzivatele.find(x => x.id === id);
        lide.set(id, {
          id, jmeno: u ? u.jmeno : ('Uživatel #' + id), email: u ? u.email : '', aktivni: u ? u.aktivni : false,
          hotovo: 0, podleTypu: {}, podleDne: {}, naplanovano: 0, poTerminu: 0, posledni: '',
          dealyNove: 0, dealyVyhrane: 0, dealyProhrane: 0, vyhranoHodnota: {}, noveHodnota: {},
          aktivity: [], otevrene: [], dealy: [],
        });
      }
      return lide.get(id);
    };
    cis.uzivatele.filter(u => u.aktivni).forEach(u => clovek(u.id));

    const tvarAktivity = (a, kdy) => ({
      id: a.id, predmet: String(a.subject || '').slice(0, 200), typ: a.type || '', den: kdy,
      termin: a.due_date || '', cas: (a.due_time || '').slice(0, 5), deal: a.deal_id || null,
    });

    hot.data.forEach(a => {
      if (a.is_deleted || a.owner_id == null) return;
      const kdy = denZ(a.marked_as_done_time) || a.due_date || denZ(a.add_time);
      if (!vObdobi(kdy)) return;
      const c = clovek(a.owner_id);
      c.hotovo++;
      const t = a.type || 'jine';
      c.podleTypu[t] = (c.podleTypu[t] || 0) + 1;
      c.podleDne[kdy] = (c.podleDne[kdy] || 0) + 1;
      if (kdy > c.posledni) c.posledni = kdy;
      c.aktivity.push(tvarAktivity(a, kdy));
    });
    otev.data.forEach(a => {
      if (a.is_deleted || a.owner_id == null) return;
      const c = clovek(a.owner_id);
      const po = !!a.due_date && a.due_date < dnes;
      if (po) c.poTerminu++; else c.naplanovano++;
      c.otevrene.push(Object.assign(tvarAktivity(a, a.due_date || ''), { poTerminu: po }));
    });
    const pricti = (o, mena, kolik) => { if (kolik) { const m = mena || '—'; o[m] = Math.round(((o[m] || 0) + Number(kolik)) * 100) / 100; } };
    dealy.data.forEach(d => {
      if (d.is_deleted || d.status === 'deleted' || d.owner_id == null) return;
      const zal = denZ(d.add_time), vyh = d.status === 'won' ? denZ(d.won_time) : '', proh = d.status === 'lost' ? denZ(d.lost_time) : '';
      const udalosti = [];
      if (vObdobi(zal)) udalosti.push(['novy', zal]);
      if (vObdobi(vyh)) udalosti.push(['vyhrany', vyh]);
      if (vObdobi(proh)) udalosti.push(['prohrany', proh]);
      if (!udalosti.length) return;
      const c = clovek(d.owner_id);
      udalosti.forEach(([co, kdy]) => {
        if (co === 'novy') { c.dealyNove++; pricti(c.noveHodnota, d.currency, d.value); }
        if (co === 'vyhrany') { c.dealyVyhrane++; pricti(c.vyhranoHodnota, d.currency, d.value); }
        if (co === 'prohrany') c.dealyProhrane++;
        c.dealy.push({ id: d.id, nazev: String(d.title || '').slice(0, 200), co, den: kdy, hodnota: Number(d.value) || 0, mena: d.currency || '' });
      });
    });

    const seznam = Array.from(lide.values());
    seznam.forEach(c => {
      c.aktivity.sort((a, b) => (b.den + b.cas).localeCompare(a.den + a.cas));
      c.otevrene.sort((a, b) => (a.den || '9').localeCompare(b.den || '9'));
      c.dealy.sort((a, b) => b.den.localeCompare(a.den));
    });
    seznam.sort((a, b) => b.hotovo - a.hotovo || a.jmeno.localeCompare(b.jmeno, 'cs'));
    return {
      od, do: doo, dnes, nacteno: Date.now(), domena: cis.domena, typy: cis.typy, lide: seznam,
      orez: hot.orez || otev.orez || dealy.orez,
    };
  }

  // ---- API -----------------------------------------------------------------
  function obdobi(q) {
    const dnes = den(new Date());
    let doo = jeDen(q.do) ? q.do : dnes;
    let od = jeDen(q.od) ? q.od : den(new Date(Date.now() - 29 * 86400000));
    if (od > doo) { const t = od; od = doo; doo = t; }
    const dni = (new Date(doo + 'T00:00:00Z') - new Date(od + 'T00:00:00Z')) / 86400000;
    if (dni > MAX_DNI) od = den(new Date(new Date(doo + 'T12:00:00Z').getTime() - MAX_DNI * 86400000));
    return { od, doo };
  }

  async function apiData(req, res, me, q) {
    const k = konfig();
    const hlava = { me: { jmeno: me.jmeno, admin: me.admin }, nastaveno: !!k.token, zdrojTokenu: k.zdroj };
    if (!k.token) { json(res, 200, hlava); return true; }
    const { od, doo } = obdobi(q);
    try {
      const d = await prehled(od, doo, q.obnovit === '1');
      // Seznamy aktivit a dealů jdou zvlášť (/detail), ať je přehled lehký.
      const lide = d.lide.map(c => { const o = Object.assign({}, c); delete o.aktivity; delete o.otevrene; delete o.dealy; return o; });
      json(res, 200, Object.assign(hlava, { od: d.od, do: d.do, dnes: d.dnes, nacteno: d.nacteno, typy: d.typy, lide, orez: d.orez }));
    } catch (e) {
      console.error('[pipedrive] načtení:', e.message);
      json(res, 200, Object.assign(hlava, { od, do: doo, chyba: e.message }));
    }
    return true;
  }

  async function apiDetail(req, res, me, q) {
    const { od, doo } = obdobi(q);
    const d = await prehled(od, doo, false);
    const c = d.lide.find(x => String(x.id) === String(q.uzivatel || ''));
    if (!c) { json(res, 404, { chyba: 'Obchodník nenalezen.' }); return true; }
    json(res, 200, {
      id: c.id, jmeno: c.jmeno, domena: d.domena,
      aktivity: c.aktivity.slice(0, 500), aktivitCelkem: c.aktivity.length,
      otevrene: c.otevrene.slice(0, 300), otevrenychCelkem: c.otevrene.length,
      dealy: c.dealy.slice(0, 300),
    });
    return true;
  }

  // Správce uloží (nebo smaže) API token; rovnou ho ověříme proti Pipedrive.
  async function apiNastaveni(req, res, me) {
    if (!me.admin) { json(res, 403, { chyba: 'Token může nastavit jen správce.' }); return true; }
    if ((process.env.PIPEDRIVE_API_TOKEN || '').trim()) { json(res, 400, { chyba: 'Token je nastaven proměnnou prostředí PIPEDRIVE_API_TOKEN — změňte ho tam.' }); return true; }
    const b = JSON.parse(await host.readBody(req) || '{}');
    const token = String(b.token || '').trim();
    if (token && !/^[A-Za-z0-9_-]{20,200}$/.test(token)) { json(res, 400, { chyba: 'Tohle nevypadá jako API token Pipedrive.' }); return true; }
    let firma = '';
    if (token) {
      try { const j = await pd('/v1/users/me', null, token); firma = (j.data && (j.data.company_name || j.data.company_domain)) || ''; }
      catch (e) { json(res, 400, { chyba: e.message }); return true; }
    }
    fs.writeFileSync(CFG_F, JSON.stringify({ token, zmena: { kdo: me.jmeno || me.email, ts: Date.now() } }, null, 2));
    cache.clear(); ciselniky = null;
    try { if (host.logActivity) host.logActivity('pipedrive', { email: me.email, name: me.jmeno }, token ? 'Nastaven API token Pipedrive' : 'Odebrán API token Pipedrive'); } catch (_) {}
    json(res, 200, { ok: true, firma });
    return true;
  }

  // ---- router --------------------------------------------------------------
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (p !== '/pipedrive' && p !== '/pipedrive/' && !p.startsWith('/api/pipedrive')) return false;

    const me = ja(req);
    if (!me || !me.pristup) {
      const kod = me ? 403 : 401;
      const zprava = me ? 'K modulu Pipedrive nemáte přístup.' : 'Přihlaste se prosím do intranetu.';
      if (p.startsWith('/api/')) json(res, kod, { chyba: zprava });
      else htmlOut(res, kod, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">' + zprava + '</p>');
      return true;
    }

    if ((p === '/pipedrive' || p === '/pipedrive/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí pipedrive.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(HTML_FILE, 'utf8'));
      return true;
    }

    try {
      if (p === '/api/pipedrive/data' && req.method === 'GET') return await apiData(req, res, me, u.query);
      if (p === '/api/pipedrive/detail' && req.method === 'GET') return await apiDetail(req, res, me, u.query);
      if (p === '/api/pipedrive/nastaveni' && req.method === 'POST') return await apiNastaveni(req, res, me);
    } catch (e) {
      console.error('[pipedrive] ' + p + ':', e.message);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message });
      return true;
    }
    json(res, 404, { chyba: 'Neznámý požadavek.' });
    return true;
  }

  return { handle };
}

module.exports = { mount };

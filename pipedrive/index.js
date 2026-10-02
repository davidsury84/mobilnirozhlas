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
//    GET /v1/notes            (start_date, end_date, start, limit ≤ 500)
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
// Poznámky jsou v Pipedrive HTML — do intranetu jde jen čistý text.
function cisti(html, max) {
  const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (m, k) => ENT[k])
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, max || 600);
}
const jeDen = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s + 'T00:00:00Z'));

function mount(host) {
  const CFG_F = path.join(host.dataDir || __dirname, 'pipedrive.json');

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- nastavení (token) ---------------------------------------------------
  function konfig() {
    const env = (process.env.PIPEDRIVE_API_TOKEN || '').trim();
    if (env) return { token: env, zdroj: 'env' };
    const d = ctiSoubor();
    const t = typeof d.token === 'string' ? d.token.trim() : '';
    return { token: t, zdroj: t ? 'soubor' : '', zmena: d.zmena || null };
  }
  function ctiSoubor() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(CFG_F, 'utf8')); } catch (_) {}
    return (d && typeof d === 'object') ? d : {};
  }
  function zapisSoubor(zmeny) { fs.writeFileSync(CFG_F, JSON.stringify(Object.assign(ctiSoubor(), zmeny), null, 2)); }
  // Účty Pipedrive, které nejsou obchodníci (vývoj, administrativa…) — správce je skryje z přehledu.
  function skryti() { const a = ctiSoubor().skryti; return Array.isArray(a) ? a.map(Number) : []; }

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
  // Všechny stránky v1 endpointu (stránkování start/limit).
  async function pdVseV1(cesta, params, token) {
    const out = []; let start = 0; let orez = false;
    for (let i = 0; ; i++) {
      if (i >= MAX_STRAN) { orez = true; break; }
      const j = await pd(cesta, Object.assign({ limit: 500 }, params, { start }), token);
      (j.data || []).forEach(x => out.push(x));
      const pg = j.additional_data && j.additional_data.pagination;
      if (!pg || !pg.more_items_in_collection) break;
      start = pg.next_start != null ? pg.next_start : start + 500;
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
  // Otevřené aktivity nezávisí na období — jedno načtení poslouží i srovnání s minulým obdobím.
  let otevreneC = null;
  function otevrene(token) {
    if (otevreneC && otevreneC.token === token && Date.now() - otevreneC.ts < CACHE_MS) return otevreneC.p;
    const p = pdVse('/api/v2/activities', { done: false, sort_by: 'due_date', sort_direction: 'asc' }, token);
    otevreneC = { token, ts: Date.now(), p };
    p.catch(() => { if (otevreneC && otevreneC.p === p) otevreneC = null; });
    return p;
  }

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
    const posunDen = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
    const [cis, hot, otev, dealy, pozn] = await Promise.all([
      nactiCiselniky(token),
      pdVse('/api/v2/activities', { done: true, updated_since: odCas, sort_by: 'update_time', sort_direction: 'desc' }, token),
      otevrene(token),
      pdVse('/api/v2/deals', { updated_since: odCas, sort_by: 'update_time', sort_direction: 'desc' }, token),
      pdVseV1('/v1/notes', { start_date: posunDen(od, -1), end_date: posunDen(doo, 1), sort: 'add_time DESC' }, token),
    ]);
    const dnes = den(new Date());
    const vObdobi = d => d && d >= od && d <= doo;

    const lide = new Map();
    const clovek = id => {
      if (!lide.has(id)) {
        const u = cis.uzivatele.find(x => x.id === id);
        lide.set(id, {
          id, jmeno: u ? u.jmeno : ('Uživatel #' + id), email: u ? u.email : '', aktivni: u ? u.aktivni : false,
          hotovo: 0, podleTypu: {}, podleDne: {}, podleDneTypu: {}, naplanovano: 0, poTerminu: 0, posledni: '',
          dealyNove: 0, dealyVyhrane: 0, dealyProhrane: 0, vyhranoHodnota: {}, noveHodnota: {},
          poznamky: 0, aktivity: [], otevrene: [], dealy: [], poznamkySeznam: [],
        });
      }
      return lide.get(id);
    };
    cis.uzivatele.filter(u => u.aktivni).forEach(u => clovek(u.id));

    const tvarAktivity = (a, kdy) => ({
      id: a.id, predmet: String(a.subject || '').slice(0, 200), typ: a.type || '', den: kdy,
      termin: a.due_date || '', cas: (a.due_time || '').slice(0, 5), deal: a.deal_id || null,
      poznamka: cisti(a.note, 400),
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
      const dt = c.podleDneTypu[kdy] || (c.podleDneTypu[kdy] = {});
      dt[t] = (dt[t] || 0) + 1;
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

    pozn.data.forEach(n => {
      if (n.active_flag === false || n.user_id == null) return;
      const kdy = denZ(n.add_time);
      if (!vObdobi(kdy)) return;
      const c = clovek(n.user_id);
      c.poznamky++;
      c.poznamkySeznam.push({
        id: n.id, den: kdy, text: cisti(n.content, 600), deal: n.deal_id || null,
        dealNazev: String((n.deal && n.deal.title) || '').slice(0, 160),
        firma: String((n.organization && n.organization.name) || '').slice(0, 160),
        osoba: String((n.person && n.person.name) || '').slice(0, 160),
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
      orez: hot.orez || otev.orez || dealy.orez || pozn.orez,
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
      if (q.obnovit === '1') otevreneC = null;
      // Stejně dlouhé období těsně před zvoleným — pro srovnání na dashboardu.
      const dni = Math.round((new Date(doo + 'T00:00:00Z') - new Date(od + 'T00:00:00Z')) / 86400000) + 1;
      const posun = (s, n) => new Date(new Date(s + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
      const mOd = posun(od, -dni), mDo = posun(od, -1);
      const [d, m] = await Promise.all([
        prehled(od, doo, q.obnovit === '1'),
        prehled(mOd, mDo, false).catch(e => { console.error('[pipedrive] minulé období:', e.message); return null; }),
      ]);
      const skr = skryti();
      const vse = me.admin && q.vse === '1';
      // Seznamy aktivit a dealů jdou zvlášť (/detail), ať je přehled lehký.
      const lide = d.lide.filter(c => vse || skr.indexOf(c.id) < 0).map(c => {
        const o = Object.assign({}, c, { skryty: skr.indexOf(c.id) >= 0 });
        delete o.aktivity; delete o.otevrene; delete o.dealy; delete o.poznamkySeznam; return o;
      });
      let minule = null;
      if (m) {
        minule = { od: mOd, do: mDo, lide: {} };
        m.lide.forEach(c => { minule.lide[c.id] = { hotovo: c.hotovo, poznamky: c.poznamky, dealyNove: c.dealyNove, dealyVyhrane: c.dealyVyhrane, dealyProhrane: c.dealyProhrane }; });
      }
      json(res, 200, Object.assign(hlava, { od: d.od, do: d.do, dnes: d.dnes, nacteno: d.nacteno, typy: d.typy, lide, minule,
        skrytych: d.lide.filter(c => skr.indexOf(c.id) >= 0).length, orez: d.orez || !!(m && m.orez) }));
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
      poznamky: c.poznamkySeznam.slice(0, 300), poznamekCelkem: c.poznamkySeznam.length,
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
    zapisSoubor({ token, zmena: { kdo: me.jmeno || me.email, ts: Date.now() } });
    cache.clear(); ciselniky = null; otevreneC = null;
    try { if (host.logActivity) host.logActivity('pipedrive', { email: me.email, name: me.jmeno }, token ? 'Nastaven API token Pipedrive' : 'Odebrán API token Pipedrive'); } catch (_) {}
    json(res, 200, { ok: true, firma });
    return true;
  }

  // ---- plnění měsíčního plánu schůzek a hovorů ------------------------------
  // Cíle na měsíc: výchozí pro všechny + výjimky po lidech (data/pipedrive.json → cile).
  const TYP_SCHUZKA = (process.env.PIPEDRIVE_TYP_SCHUZKA || 'meeting'), TYP_HOVOR = (process.env.PIPEDRIVE_TYP_HOVOR || 'call');
  const cil = v => { const n = Math.round(Number(v)); return n > 0 && n <= 100000 ? n : 0; };
  function cile() {
    const c = ctiSoubor().cile || {};
    const v = c.vychozi || {};
    const lide = {};
    Object.keys(c.lide || {}).forEach(id => { const o = c.lide[id] || {}; lide[id] = { schuzky: o.schuzky == null ? null : cil(o.schuzky), hovory: o.hovory == null ? null : cil(o.hovory) }; });
    return { vychozi: { schuzky: cil(v.schuzky), hovory: cil(v.hovory) }, lide };
  }
  async function apiPlan(req, res, me, q) {
    const k = konfig();
    if (!k.token) { json(res, 200, { nastaveno: false }); return true; }
    const dnes = den(new Date());
    const mesic = /^\d{4}-(0[1-9]|1[0-2])$/.test(q.mesic || '') ? q.mesic : dnes.slice(0, 7);
    const [r, m] = mesic.split('-').map(Number);
    const posledni = mesic + '-' + String(new Date(Date.UTC(r, m, 0)).getUTCDate()).padStart(2, '0');
    const od = mesic + '-01';
    // pracovní dny (po–pá, bez svátků) — kolik jich v měsíci je a kolik už uplynulo včetně dneška
    let pracDni = 0, uplynulo = 0;
    for (let d = new Date(od + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= posledni; d.setUTCDate(d.getUTCDate() + 1)) {
      const wd = d.getUTCDay(); if (wd === 0 || wd === 6) continue;
      pracDni++; if (d.toISOString().slice(0, 10) <= dnes) uplynulo++;
    }
    if (od > dnes) { json(res, 200, { nastaveno: true, mesic, dnes, pracDni, uplynulo: 0, lide: [], cile: cile(), me: { admin: me.admin } }); return true; }
    let d;
    try { d = await prehled(od, posledni < dnes ? posledni : dnes, q.obnovit === '1'); }
    catch (e) { console.error('[pipedrive] plán:', e.message); json(res, 200, { nastaveno: true, mesic, chyba: e.message }); return true; }
    const c = cile(), skr = skryti();
    const lide = d.lide.filter(x => skr.indexOf(x.id) < 0).map(x => {
      const o = c.lide[x.id] || {};
      return {
        id: x.id, jmeno: x.jmeno, aktivni: x.aktivni,
        schuzky: x.podleTypu[TYP_SCHUZKA] || 0, hovory: x.podleTypu[TYP_HOVOR] || 0,
        cilSchuzky: o.schuzky != null ? o.schuzky : c.vychozi.schuzky,
        cilHovory: o.hovory != null ? o.hovory : c.vychozi.hovory,
        vlastniCil: o.schuzky != null || o.hovory != null,
      };
    });
    json(res, 200, { nastaveno: true, mesic, dnes, nacteno: d.nacteno, pracDni, uplynulo, lide, cile: c, orez: d.orez, me: { admin: me.admin } });
    return true;
  }
  async function apiCile(req, res, me) {
    if (!me.admin) { json(res, 403, { chyba: 'Cíle může nastavit jen správce.' }); return true; }
    const b = JSON.parse(await host.readBody(req) || '{}');
    const v = b.vychozi || {};
    const lide = {};
    Object.keys(b.lide || {}).forEach(id => {
      if (!/^\d{1,12}$/.test(id)) return;
      const o = b.lide[id] || {};
      const z = { schuzky: o.schuzky === '' || o.schuzky == null ? null : cil(o.schuzky), hovory: o.hovory === '' || o.hovory == null ? null : cil(o.hovory) };
      if (z.schuzky != null || z.hovory != null) lide[id] = z;
    });
    zapisSoubor({ cile: { vychozi: { schuzky: cil(v.schuzky), hovory: cil(v.hovory) }, lide, zmena: { kdo: me.jmeno || me.email, ts: Date.now() } } });
    try { if (host.logActivity) host.logActivity('pipedrive', { email: me.email, name: me.jmeno }, 'Upraveny měsíční cíle schůzek a hovorů'); } catch (_) {}
    json(res, 200, { ok: true });
    return true;
  }

  // Správce skryje / vrátí účet, který do přehledu obchodníků nepatří.
  async function apiSkryt(req, res, me) {
    if (!me.admin) { json(res, 403, { chyba: 'Skrývat účty může jen správce.' }); return true; }
    const b = JSON.parse(await host.readBody(req) || '{}');
    const id = Number(b.id);
    if (!Number.isInteger(id)) { json(res, 400, { chyba: 'Chybí uživatel.' }); return true; }
    const s = skryti().filter(x => x !== id);
    if (b.skryt) s.push(id);
    zapisSoubor({ skryti: s });
    try { if (host.logActivity) host.logActivity('pipedrive', { email: me.email, name: me.jmeno }, (b.skryt ? 'Skryt účet ' : 'Vrácen účet ') + String(b.jmeno || id).slice(0, 80)); } catch (_) {}
    json(res, 200, { ok: true });
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
      if (p === '/api/pipedrive/plan' && req.method === 'GET') return await apiPlan(req, res, me, u.query);
      if (p === '/api/pipedrive/cile' && req.method === 'POST') return await apiCile(req, res, me);
      if (p === '/api/pipedrive/skryt' && req.method === 'POST') return await apiSkryt(req, res, me);
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

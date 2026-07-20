'use strict';
// Modul „Smlouvy" (Hlídač smluv) pro intranet elkoplast-smernice.
// Zapojení v server.js:
//   const smlouvy = require('./smlouvy').mount({ send, readBody, deliver,
//       empSession, isAdmin, baseUrl, employeeModules, getState,
//       dataDir: DATA_DIR, eskalaceEmail: SUPERADMIN });
//   ...v handleru: if (await smlouvy.handle(req, res)) return;
//   ...ve startu:  smlouvy.tick(); setInterval(smlouvy.tick, 6*3600*1000);
// Veřejné cesty (mimo SSO závoru): /smlouvy/potvrdit/*, /api/smlouvy/webhook/resend

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const urlLib = require('url');

const { openDb } = require('./db');
const engine = require('./engine');
const importSvc = require('./import');
const { todayPrague, daysUntil, formatCz } = require('./lib/datum');
const L = require('./lib/logic');
const wikiTerminy = require('./lib/wikiTerminy');
const drive = require('./lib/drive');

const HTML_FILE = path.join(__dirname, 'smlouvy.html');

function mount(host) {
  const dbFile = path.join(host.dataDir || __dirname, 'smlouvy.db');
  const M = openDb(dbFile);
  // Zdroj registru lhůt z wiki: env, jinak lokální soubor nahraný přes /api/wiki-registr (bez GitHubu).
  function wikiSrc() {
    if (process.env.WIKI_TERMINY_URL) return process.env.WIKI_TERMINY_URL;
    const f = path.join(host.dataDir || __dirname, 'wiki-terminy.md');
    return fs.existsSync(f) ? f : '';
  }

  // Jednorázový import registru (1× přes meta guard, idempotentní).
  try { require('./seed-registr').seedOnce(M); }
  catch (e) { console.error('[smlouvy] seed registru selhal:', e.message); }
  // Jednorázové doplnění odkazů na Disk k naimportovaným smlouvám.
  try { require('./seed-drive-urls').seedDriveUrls(M); }
  catch (e) { console.error('[smlouvy] seed drive_url selhal:', e.message); }
  // Jednorázová reklasifikace podmíněných závazků (expozice/majetek).
  try { require('./seed-hodnota-typ').seedHodnotaTyp(M); }
  catch (e) { console.error('[smlouvy] seed hodnota_typ selhal:', e.message); }
  // Rozpad souhrnných KS bloků na jednotlivé profily smluv.
  try { require('./seed-ks-rozpad').seedKsRozpad(M); }
  catch (e) { console.error('[smlouvy] seed KS rozpad selhal:', e.message); }
  // Doplnění dodatků z Disku, které v registru chyběly jako záznam.
  try {
    const sd = require('./seed-dodatky');
    sd.seedDodatky(M);
    sd.seedOpravaCdCargo(M);
  } catch (e) { console.error('[smlouvy] seed dodatky selhal:', e.message); }
  // Anotace „o čem smlouva je" (z předmětu + PDF).
  try { require('./seed-anotace').seedAnotace(M); }
  catch (e) { console.error('[smlouvy] seed anotace selhal:', e.message); }
  // Doplnění všech hlídaných termínů z registru (indexace, audity, záruky…).
  try { require('./seed-terminy').seedTerminy(M); }
  catch (e) { console.error('[smlouvy] seed termínů selhal:', e.message); }
  // Doplnění IČO protistran (z PDF smluv).
  try { require('./seed-ico').seedIco(M); }
  catch (e) { console.error('[smlouvy] seed IČO selhal:', e.message); }
  // Vazba smlouva → konkrétní dokument(y) na Disku; přestavba KS z reálných souborů.
  try { require('./seed-soubory').seedSoubory(M); }
  catch (e) { console.error('[smlouvy] seed soubory selhal:', e.message); }

  // ---- pomocné -----------------------------------------------------
  const json = (res, code, obj) => host.send(res, code, obj);
  const html = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  async function body(req) { try { return JSON.parse(await host.readBody(req)); } catch { return {}; } }

  // Správci smluv = plný editační pohled jako admin, ale BEZ globálního admina
  // intranetu. Default = Simona; přepsatelné env SMLOUVY_SPRAVCI (čárkou odděl.).
  const SPRAVCI = (process.env.SMLOUVY_SPRAVCI || 'simona.janeckova@elkoplast.cz')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  function jeSpravce(req) {
    const e = host.empSession(req);
    return !!(e && e.email && SPRAVCI.includes(String(e.email).toLowerCase()));
  }
  function smiCist(req) { const e = host.empSession(req); return e ? e.email : null; }
  function smiPsat(req) { return host.isAdmin(req) || jeSpravce(req); }
  // Řešit plnění smlouvy smí admin/správce vždy; jinak jen garant TÉTO smlouvy.
  function smiResit(req, smlouva) {
    if (host.isAdmin(req) || jeSpravce(req)) return true;
    const e = host.empSession(req);
    return !!(e && smlouva && smlouva.garant_email && e.email &&
      e.email.toLowerCase() === String(smlouva.garant_email).toLowerCase());
  }
  function maModul(req) {
    if (host.isAdmin(req) || jeSpravce(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    try { return (host.employeeModules(e.email) || []).includes('smlouvy'); } catch { return false; }
  }

  // ---- data pro dashboard -----------------------------------------
  function dashboardData(now = new Date()) {
    const dnes = todayPrague(now);
    const rows = M.termin.aktivniCekajici(dnes)
      .concat(M.db.prepare(`SELECT t.*, s.garant_email, s.spravce_email, s.cislo_smlouvy, s.protistrana_nazev
        FROM termin t JOIN smlouva s ON s.id=t.smlouva_id
        WHERE t.stav='eskalovano' AND s.stav='aktivni' AND s.je_placeholder=0`).all());
    const seen = new Set(); const cervene = []; const zlute = [];
    for (const x of rows) {
      if (seen.has(x.id)) continue; seen.add(x.id);
      const dny = daysUntil(x.datum, dnes);
      const z = { ...x, dny };
      if (dny < 30) cervene.push(z); else if (dny <= 90) zlute.push(z);
    }
    return {
      dnes, cervene, zlute,
      zavazky: L.rozpadZavazku(M.smlouva.zavazky()),
      eskalovane: rows.filter((x) => x.stav === 'eskalovano').length,
      bounced: M.notifikace.bouncenute().length,
      // Nové soubory stažené z Disku, u kterých Simona ještě nedoplnila údaje.
      kDoplneni: M.db.prepare(`SELECT id, cislo_smlouvy, drive_url, created_at FROM smlouva
        WHERE created_by='drive-sync' AND je_placeholder=1 AND stav='aktivni' ORDER BY created_at DESC`).all(),
      driveSync: !!(process.env.SMLOUVY_DRIVE_FOLDER_ID && drive.configured()),
    };
  }

  // ---- synchronizace složky na Disku: nové PDF → návrh smlouvy + e-mail správci ----
  async function driveSync() {
    const folderId = process.env.SMLOUVY_DRIVE_FOLDER_ID || '';
    if (!folderId || !drive.configured()) return { skipped: true };
    const files = await drive.listFolder(folderId);
    // První běh: stávající obsah složky je archiv — jen si zapamatujeme čas (baseline).
    // Návrhy se zakládají až pro soubory nahrané POTOM (jinak by se založilo 166 návrhů naráz).
    const BASE_KEY = 'drive_sync_baseline';
    const baseline = M.meta.get(BASE_KEY);
    if (!baseline) {
      M.meta.set(BASE_KEY, new Date().toISOString());
      console.log('[smlouvy] drive sync: první běh — baseline nastavena, ' + files.length + ' stávajících souborů bráno jako archiv');
      return { baseline: true, celkem: files.length };
    }
    const novejsi = files.filter((f) => f.createdTime && new Date(f.createdTime) > new Date(baseline));
    const existuje = M.db.prepare(`SELECT COUNT(*) n FROM smlouva WHERE drive_url LIKE ?`);
    // Soubor už může být veden jako dokument existující smlouvy (tabulka soubor) —
    // pak z něj NEZAKLÁDÁME nový návrh (jinak by se KS dokumenty importovaly znovu).
    const existujeSoub = M.db.prepare(`SELECT COUNT(*) n FROM soubor WHERE drive_id=? OR url LIKE ?`);
    const nove = [];
    for (const f of novejsi) {
      if (existuje.get('%' + f.id + '%').n > 0) continue;   // už evidováno (dle ID souboru v odkazu)
      if (existujeSoub.get(f.id, '%' + f.id + '%').n > 0) continue;   // už je dokumentem jiné smlouvy
      const nazev = String(f.name || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim().slice(0, 80) || f.id;
      // Kategorii předvyplní název podsložky na Disku (Dodavatelské/Odběratelské); Simona může upravit.
      const slozka = String(f.folder || '').toLowerCase();
      const kategorie = slozka.startsWith('odb') ? 'odberatelska' : 'dodavatelska';
      const s = M.smlouva.create({
        cislo_smlouvy: nazev,
        kategorie,
        protistrana_nazev: '(doplnit — nové z Disku)',
        stav: 'aktivni', je_placeholder: 1,
        stav_popis: 'Staženo z Disku ' + todayPrague() + (f.folder ? ' (složka ' + f.folder + ')' : '') + ' — čeká na doplnění údajů.',
        drive_url: f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view'),
      }, 'drive-sync');
      nove.push({ id: s.id, name: f.name, url: f.webViewLink });
    }
    console.log('[smlouvy] drive sync: ve složce ' + files.length + ' souborů, od baseline nových ' + novejsi.length + ', založeno ' + nove.length);
    if (nove.length) {
      const to = process.env.SMLOUVY_SPRAVCE_EMAIL || host.eskalaceEmail;
      if (to) {
        const base = host.publicBaseUrl || '';
        const lines = nove.map((n) => `• ${n.name}\n  PDF: ${n.url || '(odkaz v intranetu)'}`).join('\n');
        try {
          await host.deliver({ to, subject: `[Smlouvy] ${nove.length === 1 ? 'Nová smlouva na Disku — doplňte údaje' : nove.length + ' nových smluv na Disku — doplňte údaje'}`,
            text: `Dobrý den,\n\nve složce smluv na Disku ${nove.length === 1 ? 'přibyl nový soubor' : 'přibyly nové soubory'}:\n\n${lines}\n\nProsíme o doplnění klíčových údajů (protistrana, platnost, výpovědní lhůta, hodnota, garant) v intranetu:\n${base ? base + '/smlouvy' : 'modul Smlouvy v intranetu'} — panel „Nové z Disku — čeká na doplnění".\n\nJakmile údaje uložíte, termíny smlouvy se začnou automaticky hlídat.` });
        } catch (e) { console.error('[smlouvy] e-mail o nových z Disku selhal:', e.message); }
      }
    }
    return { nove: nove.length, celkem: files.length };
  }

  // ---- webhook (veřejné) ------------------------------------------
  const DORUCENI = { 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.opened': 'opened', 'email.complained': 'failed' };
  async function webhook(req, res) {
    const raw = await host.readBody(req);
    if (!overPodpis(process.env.RESEND_WEBHOOK_SECRET, req.headers, raw)) return json(res, 401, { chyba: 'Neplatný podpis.' });
    let p; try { p = JSON.parse(raw); } catch { return json(res, 400, { chyba: 'Neplatné tělo.' }); }
    const stav = DORUCENI[p.type]; const msgId = p.data && (p.data.email_id || p.data.id);
    if (stav && msgId) {
      const row = M.notifikace.aktualizujDoruceni(msgId, stav);
      if (stav === 'bounced' && row) await eskalujBounce(row).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }
  async function eskalujBounce(row) {
    const t = M.termin.getById(row.termin_id); if (!t) return;
    const s = M.smlouva.getById(t.smlouva_id);
    const to = (s && s.spravce_email) || host.eskalaceEmail;
    if (!to) return;
    await host.deliver({ to, subject: `[Smlouvy] NEDORUČENO: ${s ? s.cislo_smlouvy : ''}`,
      text: `Upozornění na termín (${t.typ}, ${t.datum}) se nepodařilo doručit (${row.komu_email}). Prověřte adresu garanta.` });
  }

  // ---- potvrzení termínu (veřejné, přes token) --------------------
  function nactiToken(tok) {
    const n = M.notifikace.najdiPodleTokenu(tok);
    if (!n) return { chyba: 'Neplatný odkaz.' };
    if (n.token_used_at) return { chyba: 'Tento termín už byl potvrzen.', hotovo: true };
    if (n.token_expires_at && new Date(n.token_expires_at) < new Date()) return { chyba: 'Platnost odkazu vypršela.' };
    return { n };
  }
  function potvrzeniPage({ chyba, hotovo, termin, smlouva, token }) {
    const box = (inner) => `<!doctype html><meta charset="utf-8"><title>Potvrzení termínu</title>
      <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;margin:48px auto;padding:24px;border:1px solid #e5e8eb;border-radius:10px;text-align:center">${inner}</div>`;
    if (chyba) return box(`<h2>${hotovo ? '✓ Hotovo' : 'Nelze potvrdit'}</h2><p style="color:#7f8c8d">${engineEsc(chyba)}</p>`);
    if (hotovo) return box(`<h2 style="color:#27ae60">✓ Termín potvrzen</h2>
      <p>Termín <strong>${engineEsc(termin.typ)}</strong> u smlouvy <strong>${engineEsc(smlouva ? smlouva.cislo_smlouvy : '')}</strong> byl označen jako vyřešený.</p>
      <p style="color:#7f8c8d">Děkujeme. Okno můžete zavřít.</p>`);
    return box(`<h2>Potvrdit vyřešení termínu</h2>
      <p>Smlouva <strong>${engineEsc(smlouva ? smlouva.cislo_smlouvy : '')}</strong> — ${engineEsc(smlouva ? smlouva.protistrana_nazev : '')}</p>
      <p style="color:#7f8c8d">${engineEsc(termin.typ)} · ${engineEsc(formatCz(termin.datum))}${termin.popis ? ' · ' + engineEsc(termin.popis) : ''}</p>
      <form method="post" action="/smlouvy/potvrdit/${engineEsc(token)}" style="margin-top:16px">
        <button type="submit" style="background:#27ae60;color:#fff;border:none;padding:12px 22px;border-radius:6px;font-weight:700;font-size:15px;cursor:pointer">Označit jako „Vyřešeno"</button>
      </form>`);
  }

  // ---- hlavní dispatch --------------------------------------------
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true); const p = u.pathname;
    if (!p.startsWith('/smlouvy') && !p.startsWith('/api/smlouvy')) return false;

    // ---- VEŘEJNÉ ----
    if (p === '/api/smlouvy/webhook/resend' && req.method === 'POST') { await webhook(req, res); return true; }

    const mToken = p.match(/^\/smlouvy\/potvrdit\/([A-Za-z0-9-]+)$/);
    if (mToken) {
      const tok = mToken[1];
      const st = nactiToken(tok);
      if (req.method === 'GET') {
        if (st.chyba) { html(res, st.hotovo ? 200 : 410, potvrzeniPage({ ...st, token: tok })); return true; }
        const t = M.termin.getById(st.n.termin_id); const s = M.smlouva.getById(t.smlouva_id);
        html(res, 200, potvrzeniPage({ termin: t, smlouva: s, token: tok })); return true;
      }
      if (req.method === 'POST') {
        if (st.chyba) { html(res, st.hotovo ? 200 : 410, potvrzeniPage({ ...st, token: tok })); return true; }
        engine.uzavriTermin(M, st.n.termin_id, st.n.komu_email);
        M.notifikace.oznacTokenPouzity(tok);
        const t = M.termin.getById(st.n.termin_id); const s = M.smlouva.getById(t.smlouva_id);
        html(res, 200, potvrzeniPage({ hotovo: true, termin: t, smlouva: s, token: tok })); return true;
      }
    }

    // ---- CHRÁNĚNÉ (přihlášený zaměstnanec + modul smlouvy) ----
    if (!maModul(req)) { json(res, 403, { chyba: 'Nemáte přístup k modulu Smlouvy.' }); return true; }

    // UI stránka
    if ((p === '/smlouvy' || p === '/smlouvy/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { html(res, 404, '<h1>Chybí smlouvy.html</h1>'); return true; }
      html(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }

    // API
    try {
      if (p === '/api/smlouvy/me' && req.method === 'GET') {
        const e = host.empSession(req) || {};
        json(res, 200, { email: e.email || null, admin: smiPsat(req) }); return true;
      }
      // Seznam zaměstnanců (pro našeptávač garanta v seznamu smluv).
      if (p === '/api/smlouvy/lide' && req.method === 'GET') {
        let lide = [];
        try { lide = (host.getState().employees || []).map((e) => ({ email: e.email, name: e.name })).filter((x) => x.email); } catch (_) {}
        json(res, 200, lide); return true;
      }
      if (p === '/api/smlouvy/dashboard' && req.method === 'GET') { json(res, 200, dashboardData()); return true; }

      // Lhůty z LLM-wiki (terminy.md) — jeden zdroj pravdy sdílený s wiki repozitářem.
      if (p === '/api/smlouvy/wiki-terminy' && req.method === 'GET') {
        const src = wikiSrc();
        if (!src) { json(res, 200, { configured: false, items: [] }); return true; }
        try {
          const rows = await wikiTerminy.nacti(src, { force: u.query.force === '1' });
          const dnes = todayPrague();
          // Jen doména smluv — BOZP má vlastní modul v intranetu, sortiment hlídá ranges-watchdog.
          const items = rows
            .filter((r) => (r.stav === 'aktivni' || !r.stav) && /^smlouv/.test((r.domena || '').toLowerCase()))
            .map((r) => ({ ...r, dny: daysUntil(r.termin, dnes) }))
            .sort((a, b) => a.dny - b.dny);
          json(res, 200, { configured: true, source: src, dnes, items }); return true;
        } catch (e) { json(res, 200, { configured: true, chyba: e.message, items: [] }); return true; }
      }

      if (p === '/api/smlouvy/list' && req.method === 'GET') {
        json(res, 200, M.smlouva.list({ kategorie: u.query.kategorie, garant: u.query.garant, stav: u.query.stav, q: u.query.q })); return true;
      }
      if (p === '/api/smlouvy/detail' && req.method === 'GET') {
        const s = M.smlouva.getById(Number(u.query.id));
        if (!s) { json(res, 404, { chyba: 'Nenalezeno.' }); return true; }
        const terminy = M.termin.listBySmlouva(s.id);
        const historie = {}; terminy.forEach((t) => { historie[t.id] = M.notifikace.historieProTermin(t.id); });
        json(res, 200, {
          smlouva: s, dodatky: M.dodatek.listBySmlouva(s.id), terminy, historie,
          reseni: M.reseni.listBySmlouva(s.id), soubory: M.soubor.listBySmlouva(s.id),
          muzuResit: smiResit(req, s),
        }); return true;
      }
      if (p === '/api/smlouvy/kalendar' && req.method === 'GET') {
        const dnes = todayPrague();
        const rows = M.db.prepare(`SELECT t.id,t.typ,t.datum,t.popis,t.stav,t.smlouva_id,s.cislo_smlouvy,s.protistrana_nazev
          FROM termin t JOIN smlouva s ON s.id=t.smlouva_id WHERE t.stav IN ('ceka','eskalovano') ORDER BY t.datum`).all();
        json(res, 200, rows.map((x) => ({ ...x, dny: daysUntil(x.datum, dnes) }))); return true;
      }

      // Změna stavu termínu: Hotovo (vyřešeno) / Neaktivní / zpět Aktivní.
      if (p === '/api/smlouvy/termin-stav' && req.method === 'POST') {
        const t = M.termin.getById(Number(u.query.id));
        if (!t) { json(res, 404, { chyba: 'Termín nenalezen.' }); return true; }
        const s = M.smlouva.getById(t.smlouva_id);
        if (!smiResit(req, s)) { json(res, 403, { chyba: 'Měnit stav termínu smí správce, admin nebo garant této smlouvy.' }); return true; }
        const b = await body(req); const stav = b.stav;
        if (!['vyreseno', 'neaktivni', 'ceka'].includes(stav)) { json(res, 400, { chyba: 'Neplatný stav.' }); return true; }
        const who = (host.empSession(req) || {}).email;
        if (stav === 'vyreseno') engine.uzavriTermin(M, t.id, who); // uzavře + u opakujícího založí další výskyt
        else M.termin.nastavStav(t.id, stav);
        json(res, 200, M.termin.getById(t.id)); return true;
      }

      // Řešení plnění: přidat záznam (admin/správce nebo garant TÉTO smlouvy).
      if (p === '/api/smlouvy/reseni' && req.method === 'POST') {
        const s = M.smlouva.getById(Number(u.query.id));
        if (!s) { json(res, 404, { chyba: 'Smlouva nenalezena.' }); return true; }
        if (!smiResit(req, s)) { json(res, 403, { chyba: 'Řešit plnění smí správce, admin nebo garant této smlouvy.' }); return true; }
        const b = await body(req);
        if (!b.text || !String(b.text).trim()) { json(res, 400, { chyba: 'Chybí text záznamu.' }); return true; }
        const who = (host.empSession(req) || {}).email;
        json(res, 201, M.reseni.create({ smlouva_id: s.id, text: String(b.text).trim(), autor_email: who })); return true;
      }

      // zápisové akce → jen admin/správce
      if (p.startsWith('/api/smlouvy/') && req.method === 'POST') {
        if (!smiPsat(req)) { json(res, 403, { chyba: 'Jen správce/admin.' }); return true; }
        const b = await body(req); const who = (host.empSession(req) || {}).email;

        if (p === '/api/smlouvy/create') {
          const s = M.smlouva.create(b, who); syncOdvozene(s); json(res, 201, s); return true;
        }
        if (p === '/api/smlouvy/update') {
          const s = M.smlouva.update(Number(u.query.id), b, who);
          if (s && s.stav !== 'aktivni') M.termin.deaktivujProSmlouvu(s.id);
          if (s) syncOdvozene(s);
          json(res, 200, s); return true;
        }
        if (p === '/api/smlouvy/dodatek') { json(res, 201, M.dodatek.create({ smlouva_id: Number(u.query.id), ...b })); return true; }
        if (p === '/api/smlouvy/termin') { json(res, 201, M.termin.create({ smlouva_id: Number(u.query.id), ...b })); return true; }
        if (p === '/api/smlouvy/termin-snooze') { M.termin.snooze(Number(u.query.id), b.do); json(res, 200, M.termin.getById(Number(u.query.id))); return true; }

        // Ruční spuštění synchronizace složky na Disku (jinak běží v ticku co 6 h).
        if (p === '/api/smlouvy/drive-sync') {
          try { json(res, 200, await driveSync()); } catch (e) { json(res, 200, { chyba: e.message }); }
          return true;
        }

        if (p === '/api/smlouvy/import-nahled') { json(res, 200, importSvc.nahled(b.radky || [], b.garantMapa || {})); return true; }
        if (p === '/api/smlouvy/import-uloz') {
          const v = importSvc.uloz({ smlouva: M.smlouva, termin: M.termin }, b.plan, { by: who, zakladatOdvozeneTerminy: true });
          engine.runOnce(M, ctxWith(req)); // catch-up
          json(res, 200, v); return true;
        }
      }
    } catch (e) { json(res, 500, { chyba: e.message }); return true; }

    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  function syncOdvozene(s) {
    const d = L.odvozenyDeadlineVypovedi(s);
    if (d) M.termin.updateDatumOdvozenych(s.id, 'deadline_vypovedi', d);
  }
  function ctxWith(req) { return { deliver: host.deliver, baseUrl: host.baseUrl(req), eskalaceEmail: host.eskalaceEmail }; }

  // ---- lhůty z wiki: digest e-mail (max 1× denně na změněnou sadu) ----
  async function wikiUpozorneni() {
    const src = wikiSrc(); if (!src) return;
    const to = process.env.WIKI_TERMINY_EMAIL || host.eskalaceEmail; if (!to) return;
    let rows; try { rows = await wikiTerminy.nacti(src, { force: true }); } catch { return; }
    const dnes = todayPrague();
    const due = rows.filter((r) => r.stav === 'aktivni' && daysUntil(r.termin, dnes) <= 30)
      .sort((a, b) => daysUntil(a.termin, dnes) - daysUntil(b.termin, dnes));
    if (!due.length) return;
    const stavFile = path.join(host.dataDir || __dirname, 'wiki-terminy-notif.json');
    const hash = crypto.createHash('sha1').update(dnes + '|' + due.map((d) => d.id + d.termin).join(',')).digest('hex');
    let last = {}; try { last = JSON.parse(fs.readFileSync(stavFile, 'utf8')); } catch {}
    if (last.hash === hash) return; // stejná sada už dnes odeslána
    const lines = due.map((d) => {
      const dny = daysUntil(d.termin, dnes);
      return `• ${d.termin} (${dny < 0 ? 'po termínu ' + (-dny) + ' d' : 'za ' + dny + ' d'}) — ${d.domena}: ${d.subjekt} — ${d.popis}`;
    }).join('\n');
    try {
      await host.deliver({ to, subject: `[Wiki termíny] ${due.length} lhůt do 30 dnů`,
        text: `Blížící se lhůty z LLM-wiki (terminy.md):\n\n${lines}\n\nZdroj: ${src}` });
      fs.writeFileSync(stavFile, JSON.stringify({ hash, at: Date.now() }));
    } catch (e) { console.error('[smlouvy] wiki upozornění chyba:', e.message); }
  }

  // ---- cron tick ---------------------------------------------------
  async function tick() {
    try { await engine.tick(M, { deliver: host.deliver, baseUrl: host.publicBaseUrl || '', eskalaceEmail: host.eskalaceEmail }); }
    catch (e) { console.error('[smlouvy] tick chyba:', e.message); }
    try { await wikiUpozorneni(); }
    catch (e) { console.error('[smlouvy] wiki tick chyba:', e.message); }
    try { await driveSync(); }
    catch (e) { console.error('[smlouvy] drive sync chyba:', e.message); }
  }

  return { handle, tick, _models: M, _dashboardData: dashboardData };
}

function engineEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function overPodpis(secret, headers, rawBody) {
  if (!secret) return true;
  try {
    const id = headers['svix-id']; const ts = headers['svix-timestamp']; const sig = headers['svix-signature'] || '';
    if (!id || !ts || !sig) return false;
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
    return sig.split(' ').some((part) => { const v = part.includes(',') ? part.split(',')[1] : part;
      try { return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); } catch { return false; } });
  } catch { return false; }
}

module.exports = { mount, overPodpis };

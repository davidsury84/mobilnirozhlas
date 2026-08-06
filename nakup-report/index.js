// Modul „Týdenní reporty nákupu" — dva pravidelné e-maily z dat SMI (obrat plasty):
//   A) ZLEVNĚNÍ / mrtvé zásoby — co zlevnit (stárnoucí/mrtvá/přeskladněná zásoba)
//   B) NÁKUP — co objednat (sezónní ROP od aktuálního měsíce)
// Příjemci jsou editovatelní (config v data/nakup-report.json). Plánováno týdně (pojistka 1×/ISO-týden).
// Data čte z kořenového smi-nakup-data.json (generováno při aktualizaci obrat plasty; data/ je gitignored).
const fs = require('fs');
const path = require('path');
const urlLib = require('url');
let drive = null; try { drive = require('../smlouvy/lib/drive'); } catch (_) {}   // Google Drive přes service account (reuse)
const xlsxMini = require('./xlsx-mini');                                          // pure-Node čtečka .xlsx

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = n => Math.round(+n || 0).toLocaleString('cs-CZ');
const kc = n => fmt(n) + ' Kč';

function mount(host) {
  const CFG_F = path.join(host.dataDir || __dirname, 'nakup-report.json');          // config (writable)
  const STATE_F = path.join(host.dataDir || __dirname, 'nakup-report-state.json');  // stav odeslání (writable)
  const SRC_F = path.join(__dirname, '..', 'smi-nakup-data.json');                  // data SMI (commitnuto v kořeni)
  const OBJ_SEED = path.join(__dirname, '..', 'smi-objednavky-data.json');          // commitnutý seed (poslední ruční snapshot)
  const OBJ_LIVE = path.join(host.dataDir || __dirname, 'smi-objednavky-data.json'); // denně aktualizováno z Google Drive (volume)
  const SYNC_STATE = path.join(host.dataDir || __dirname, 'objednavky-sync.json');   // stav Drive sync (poslední soubor/den)
  const OBJ_FOLDER = process.env.OBJEDNAVKY_DRIVE_FOLDER || '1n8OCCiXFw86e4EXnkyX8C5i5uu404aO1'; // sdílená složka s SA, denně nový soubor
  const loadObj = () => { for (const f of [OBJ_LIVE, OBJ_SEED]) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} } return { rows: [], columns: [], date: '' }; };

  // ---- parse ERP xlsx (názvy sloupců robustně) ----
  function parseObjXlsx(buf) {
    const rows = xlsxMini.parse(buf); if (!rows.length) return { rows: [], columns: [] };
    const hdr = rows[0].map(x => String(x == null ? '' : x).trim());
    const find = (...names) => { for (const nm of names) { const i = hdr.findIndex(h => h.toLowerCase() === nm.toLowerCase()); if (i >= 0) return i; } return -1; };
    const ci = { sk: find('SK'), reg: find('Registrační číslo', 'Reg. číslo'), nazev: find('Název 1'), skupina: find('Název'), dodKod: find('Doplňkový kód'), stock: find('Mn.po p/v'), avail: find('K dispo. po p/v'), unitPrice: find('Vypočtený průměr'), unitCost: find('Průměr+SN'), onOrder: find('Objednáno'), reserved: find('Rezervováno'), lead: find('Dodací lhůta') };
    const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : Math.round(n * 1000) / 1000; };
    const str = v => String(v == null ? '' : v).trim();
    const out = [];
    for (let r = 1; r < rows.length; r++) { const row = rows[r]; if ((row[ci.sk] == null || row[ci.sk] === '') && (row[ci.reg] == null || row[ci.reg] === '')) continue;
      out.push({ sk: str(row[ci.sk]), reg: str(row[ci.reg]), nazev: str(row[ci.nazev]), skupina: str(row[ci.skupina]), dodKod: str(row[ci.dodKod]), stock: num(row[ci.stock]), avail: num(row[ci.avail]), unitPrice: num(row[ci.unitPrice]), unitCost: num(row[ci.unitCost]), onOrder: num(row[ci.onOrder]), reserved: num(row[ci.reserved]), lead: num(row[ci.lead]) }); }
    return { columns: hdr, rows: out };
  }

  // ---- pohyby (denní rozdíly skladu → odhad výdeje) ----
  const PREV_F = path.join(host.dataDir || __dirname, 'objednavky-prev.json');   // předchozí momentka (pro rozdíly)
  const MOVE_F = path.join(host.dataDir || __dirname, 'objednavky-pohyby.json'); // historie pohybů (výdej/den z rozdílů)
  const loadMoves = () => { try { return JSON.parse(fs.readFileSync(MOVE_F, 'utf8')); } catch (_) { return {}; } };
  const snapMap = rows => { const m = {}; (rows || []).forEach(r => { m[r.sk + '-' + r.reg] = { stock: r.stock, onOrder: r.onOrder }; }); return m; };
  // odhad výdeje za interval: příjem (pokles Objednáno) − nárůst skladu = kolik se vydalo
  const dispatchDiff = (p, n) => { const prijem = Math.max(0, (p.onOrder || 0) - (n.onOrder || 0)); return Math.max(0, prijem - ((n.stock || 0) - (p.stock || 0))); };
  const daysBetween = (d1, d2) => { const a = Date.parse(d1), b = Date.parse(d2); return (isNaN(a) || isNaN(b)) ? 1 : Math.max(1, Math.round((b - a) / 86400000)); };
  function applyMovement(prevRows, prevDate, nowRows, nowDate) {
    const mv = loadMoves(), pm = snapMap(prevRows), dd = daysBetween(prevDate, nowDate);
    nowRows.forEach(r => { const k = r.sk + '-' + r.reg, p = pm[k]; if (!p) return;
      const v = dispatchDiff(p, r), e = mv[k] || (mv[k] = { sum: 0, days: 0, hist: [] });
      e.sum += v; e.days += dd; e.hist.push({ d: nowDate, v: Math.round(v) }); if (e.hist.length > 90) e.hist.shift(); });
    try { fs.writeFileSync(MOVE_F, JSON.stringify(mv)); } catch (_) {}
  }
  const dateOfName = nm => { const m = /(\d{4})[-.]?(\d{2})[-.]?(\d{2})/.exec(nm || ''); return m ? (m[1] + '-' + m[2] + '-' + m[3]) : null; };
  // bootstrap: projde až 14 nejnovějších denních souborů chronologicky a spočítá rozdíly (rozjezd historie)
  async function bootstrapMovements(xls, newest, parsedNewest, newestDate) {
    const recent = xls.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(-14);
    let prevRows = null, prevDate = null;
    for (const f of recent) {
      let rows, dt;
      if (f.id === newest.id) { rows = parsedNewest.rows; dt = newestDate; }
      else { const dl = await drive.downloadFileBase64(f.id, 20 * 1024 * 1024); rows = parseObjXlsx(Buffer.from(dl.base64, 'base64')).rows; dt = dateOfName(f.name); }
      if (prevRows && dt && prevDate && dt !== prevDate) applyMovement(prevRows, prevDate, rows, dt);
      prevRows = rows; prevDate = dt;
    }
    console.log('[nakup-report] bootstrap pohybů z ' + recent.length + ' souborů');
  }

  // ---- denní stažení nejnovějšího souboru z Drive (SA), rozparsování, uložení na volume ----
  async function syncObjednavky(force) {
    if (!drive || !drive.configured()) return { ok: false, error: 'Service account (GOOGLE_SA_*) není nastavený.' };
    let st = {}; try { st = JSON.parse(fs.readFileSync(SYNC_STATE, 'utf8')) || {}; } catch (_) {}
    const today = new Date().toISOString().slice(0, 10);
    // Nezkracujeme podle dne — kontrolujeme složku vždy a stahujeme jen když je NOVĚJŠÍ soubor (dle ID).
    // (Nový soubor tam bývá ~7:00; server ho vezme při nejbližší kontrole.)
    const files = await drive.listFolder(OBJ_FOLDER);
    const xls = (files || []).filter(f => /\.xlsx$/i.test(f.name || '') || /spreadsheetml/.test(f.mimeType || ''));
    if (!xls.length) return { ok: false, error: 'Ve složce nejsou .xlsx soubory (nasdílena SA?).' };
    xls.sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || '')) || String(b.name || '').localeCompare(String(a.name || '')));
    const newest = xls[0];
    if (!force && st.lastFileId === newest.id) {
      // I bez nového souboru: pokud ještě nejsou pohyby, dopočítej je z historie složky.
      if (Object.keys(loadMoves()).length === 0) {
        try {
          let parsedNow = null; try { parsedNow = JSON.parse(fs.readFileSync(OBJ_LIVE, 'utf8')); } catch (_) {}
          if (parsedNow && parsedNow.rows) { await bootstrapMovements(xls, newest, parsedNow, parsedNow.date || dateOfName(newest.name) || today); }
        } catch (e) { console.warn('[nakup-report] pohyby (skip):', e.message); }
      }
      st.lastSyncDate = today; try { fs.writeFileSync(SYNC_STATE, JSON.stringify(st, null, 2)); } catch (_) {}
      return { ok: true, skipped: true, file: newest.name, rows: st.lastRows };
    }
    const dl = await drive.downloadFileBase64(newest.id, 20 * 1024 * 1024);
    const parsed = parseObjXlsx(Buffer.from(dl.base64, 'base64'));
    if (!parsed.rows.length) return { ok: false, error: 'Soubor ' + newest.name + ' se nepodařilo rozparsovat.' };
    const dataDate = dateOfName(newest.name) || today;
    // --- POHYBY: rozdíl vůči předchozí momentce; při prázdné historii bootstrap z denních souborů ---
    try {
      let prev = null; try { prev = JSON.parse(fs.readFileSync(PREV_F, 'utf8')); } catch (_) {}
      if (prev && prev.rows && prev.date) { if (prev.date !== dataDate) applyMovement(prev.rows, prev.date, parsed.rows, dataDate); }
      else if (Object.keys(loadMoves()).length === 0) { await bootstrapMovements(xls, newest, parsed, dataDate); }
      fs.writeFileSync(PREV_F, JSON.stringify({ date: dataDate, rows: parsed.rows.map(r => ({ sk: r.sk, reg: r.reg, stock: r.stock, onOrder: r.onOrder })) }));
    } catch (e) { console.warn('[nakup-report] pohyby:', e.message); }
    fs.writeFileSync(OBJ_LIVE, JSON.stringify({ source: newest.name, date: dataDate, columns: parsed.columns, rows: parsed.rows, syncedAt: new Date().toISOString() }));
    st = { lastSyncDate: today, lastFileId: newest.id, lastFileName: newest.name, lastRows: parsed.rows.length, lastAt: new Date().toISOString() };
    try { fs.writeFileSync(SYNC_STATE, JSON.stringify(st, null, 2)); } catch (_) {}
    console.log('[nakup-report] Drive sync: ' + newest.name + ' → ' + parsed.rows.length + ' položek');
    return { ok: true, file: newest.name, rows: parsed.rows.length };
  }

  const DEF_MD = ['michaela.lizancova@elkoplast.cz', 'jan.benicek@elkoplast.cz'];
  const DEF_PU = ['hana.faltynkova@elkoplast.cz', 'david.sury@elkoplast.cz'];

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---------- config ----------
  function loadCfg() {
    let c = {}; try { c = JSON.parse(fs.readFileSync(CFG_F, 'utf8')) || {}; } catch (_) {}
    return {
      markdownTo: Array.isArray(c.markdownTo) ? c.markdownTo : DEF_MD.slice(),
      enabled: c.enabled !== undefined ? !!c.enabled : false,   // bezpečně vypnuto — zapne správce po náhledu
      weekday: (c.weekday >= 0 && c.weekday <= 6) ? c.weekday : 1, // 1 = pondělí
      // objednávkový report (ERP, 1× za 14 dní) — příjemci editovatelní správcem
      objednavkyTo: Array.isArray(c.objednavkyTo) ? c.objednavkyTo : ['jan.benicek@elkoplast.cz', 'michaela.lizancova@elkoplast.cz', 'david.sury@elkoplast.cz', 'hana.faltynkova@elkoplast.cz'],
      objednavkyEnabled: c.objednavkyEnabled !== undefined ? !!c.objednavkyEnabled : false, // ZATÍM VYPNUTO (uživatel: „zatím nic neposílej")
      objednavkyDay: (c.objednavkyDay >= 0 && c.objednavkyDay <= 6) ? c.objednavkyDay : 1,
      // parametry modelu (výchozí = jako v appce)
      lead: +c.lead || 30, slow: +c.slow || 4, aging: +c.aging || 7, dead: +c.dead || 10,
      covslow: +c.covslow || 12, covaging: +c.covaging || 24, covdead: +c.covdead || 48,
      d1: c.d1 != null ? +c.d1 : 0.15, d2: c.d2 != null ? +c.d2 : 0.25,
      cover: +c.cover || 2, Z: +c.Z || 1.65, MOQ: +c.MOQ || 1, topN: +c.topN || 40
    };
  }
  function saveCfg(c) { try { fs.writeFileSync(CFG_F, JSON.stringify(c, null, 2)); } catch (e) { console.error('[nakup-report] zápis config:', e.message); } }
  const loadData = () => { try { return JSON.parse(fs.readFileSync(SRC_F, 'utf8')); } catch (_) { return { rows: [], period: '' }; } };
  const cleanEmails = a => (Array.isArray(a) ? a : String(a || '').split(/[;,\n]/)).map(x => String(x).trim().toLowerCase()).filter(x => /@/.test(x));

  // ---------- výpočet (port klasifikace + markdown + nákup z klientské appky) ----------
  function analyze(cfg) {
    const data = loadData(), rows = data.rows || [], m0 = new Date().getMonth();
    const sd = (sales, months) => { let s = 0; for (let k = 0; k < Math.ceil(months); k++) { const fr = Math.min(1, months - k); s += (sales[(m0 + k) % 12] || 0) * fr; } return s; };
    const items = rows.map(r => {
      const sales = (r.sales || []).map(x => +x || 0);
      const D = sales.reduce((s, x) => s + x, 0), avgM = D / 12;
      let gap = 0, lastMo = 0;
      for (let k = 0; k < 12; k++) { const ci = ((m0 - k) % 12 + 12) % 12; if (sales[ci] > 0) { lastMo = ci + 1; break; } gap++; }
      const monthsNoSale = lastMo === 0 ? 12 : gap;
      const AZ = +r.AZ || 0, nd = /náhradní díly/i.test(r.name || '');
      const cover = AZ <= 0 ? 0 : (avgM > 0 ? AZ / avgM : Infinity);
      const sevR = monthsNoSale >= cfg.dead ? 3 : monthsNoSale >= cfg.aging ? 2 : monthsNoSale >= cfg.slow ? 1 : 0;
      const sevC = cover >= cfg.covdead ? 3 : cover >= cfg.covaging ? 2 : cover >= cfg.covslow ? 1 : 0;
      const sev = Math.max(sevR, sevC);
      const cat = AZ <= 0 ? 'Není skladem' : ['Zdravá obrátka', 'Pomalá obrátka', 'Stárnoucí zásoba', 'Mrtvá zásoba'][sev];
      const disc = (AZ <= 0 || nd) ? 0 : (sev >= 2 ? cfg.d2 : sev >= 1 ? cfg.d1 : 0);
      const unit = (r.BB && r.BA) ? r.BB / r.BA : 0, tied = +r.BB || 0;
      const overBy = sevC > sevR ? 'krytí' : 'obrátka';
      // nákup — sezónní ROP od aktuálního měsíce
      const Lm = cfg.lead / 30, coverM = Math.max(0.5, cfg.cover), windowM = Lm + coverM;
      const leadDem = sd(sales, Lm), windowDem = sd(sales, windowM);
      const rop = Math.round(leadDem + cfg.Z * Math.sqrt(Math.max(0, leadDem)));
      const target = Math.round(windowDem + cfg.Z * Math.sqrt(Math.max(0, windowDem)));
      let rec = 0, status = 'OK';
      if (D <= 0) status = 'Nenakupovat';
      else if (windowDem < 0.5) status = 'Mimo sezónu';
      else if (AZ <= rop) { rec = Math.max(cfg.MOQ, Math.round(target - AZ)); status = 'Objednat teď'; }
      const orderVal = unit > 0 ? unit * rec : 0;
      const siCur = avgM > 0 ? sales[m0] / avgM : 0;
      return { sk: r.sk, ident: r.ident, name: r.name, cat, sev, disc, monthsNoSale, cover, AZ, tied, unit, D, rec, status, orderVal, siCur, overBy };
    });
    return { items, period: data.period || '', periodInfo: data.periodInfo || '', generated: data.generated || '' };
  }

  // ---------- e-mailové sestavy ----------
  const coverTxt = c => !isFinite(c) ? 'bez prodeje' : c >= 24 ? (c / 12).toFixed(c >= 120 ? 0 : 1) + ' let' : Math.round(c) + ' měs.';
  const wrap = (title, intro, bodyHtml, period) =>
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#1c1d1a;line-height:1.55;max-width:860px">' +
    '<h2 style="margin:0 0 4px">' + esc(title) + '</h2>' +
    '<p style="color:#6b736c;margin:0 0 14px;font-size:13px">' + esc(intro) + ' · Data: ' + esc(period) + '</p>' +
    bodyHtml +
    '<hr style="border:0;border-top:1px solid #e6e9e3;margin:20px 0"><div style="font-size:12px;color:#8a938a">Automatický týdenní report · Intranet ELKOPLAST CZ → E-shop → Optimalizace nákupu. Příjemce a zapnutí spravuje správce v aplikaci.</div></div>';
  const th = t => '<th style="text-align:' + (/[⌀%KčksČ]|množ|Sklad|Krytí|Sleva|Hodnota|Doporuč|Obrátka|Prodej/.test(t) ? 'right' : 'left') + ';border-bottom:2px solid #d8dee7;padding:6px 8px;font-size:12px;color:#55605a">' + esc(t) + '</th>';
  const td = (v, r) => '<td style="text-align:' + (r ? 'right' : 'left') + ';border-bottom:1px solid #eef1ec;padding:5px 8px">' + v + '</td>';

  function buildMarkdown(cfg) {
    const a = analyze(cfg);
    let list = a.items.filter(x => x.AZ > 0 && !x.nd && x.sev >= 2 && x.disc > 0);
    list.sort((x, y) => y.tied - x.tied);
    const totTied = list.reduce((s, x) => s + x.tied, 0);
    const top = list.slice(0, cfg.topN);
    const rowsHtml = top.map(x =>
      '<tr>' + td(esc(x.name)) + td('<span style="color:#8a938a">' + esc(x.ident) + '</span>') +
      td(x.cat === 'Mrtvá zásoba' ? '<b style="color:#b23">Mrtvá</b>' : 'Stárnoucí') +
      td(fmt(x.AZ), 1) + td(coverTxt(x.cover) + (x.overBy === 'krytí' ? ' ⚠' : ''), 1) +
      td('<b>' + Math.round(x.disc * 100) + ' %</b>', 1) + td(kc(x.tied), 1) + '</tr>').join('');
    const body =
      '<div style="background:#fbeaea;border:1px solid #f0c9c9;border-radius:10px;padding:12px 14px;margin:0 0 14px">' +
      '<b>' + fmt(list.length) + '</b> položek k zlevnění · vázaný kapitál <b>' + kc(totTied) + '</b>. Doporučená sleva: pomalá ' + Math.round(cfg.d1 * 100) + ' %, stárnoucí/mrtvá ' + Math.round(cfg.d2 * 100) + ' %. „⚠" = přeskladněno (drží se roky zásoby).</div>' +
      '<table style="border-collapse:collapse;width:100%"><thead><tr>' +
      [th('Položka'), th('Identifikátor'), th('Kategorie'), th('Sklad ks'), th('Krytí'), th('Sleva'), th('Hodnota zásoby')].join('') +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      (list.length > top.length ? '<p style="color:#8a938a;font-size:12px">… zobrazeno ' + top.length + ' z ' + list.length + ' (dle vázaného kapitálu). Kompletní přehled v aplikaci.</p>' : '');
    return { subject: 'Týdenní report — co zlevnit (mrtvé/přeskladněné zásoby) · ' + a.period, html: wrap('Co zlevnit — optimalizace mrtvých zásob', 'Stárnoucí, mrtvé a přeskladněné položky seřazené dle vázaného kapitálu', body, a.period), count: list.length, totTied };
  }

  // ---------- objednávkový report (ERP pozice × poptávka z prodejů) ----------
  function fwdCover(position, sales, m0) { // na kolik měsíců pozice pokryje sezónní poptávku dopředu
    if (position <= 0) return 0; if (!sales || sales.reduce((s, v) => s + v, 0) <= 0) return Infinity;
    let rem = position, mo = 0;
    for (let k = 0; k < 48; k++) { const d = sales[(m0 + k) % 12] || 0; if (d <= 0) { mo += 1; continue; } if (rem >= d) { rem -= d; mo += 1; } else { mo += rem / d; return mo; } }
    return 48;
  }
  const covTxt = cv => cv === 0 ? '0' : !isFinite(cv) ? '∞' : cv >= 48 ? '4+ r' : cv >= 24 ? (Math.round(cv / 12 * 10) / 10).toLocaleString('cs-CZ') + ' r' : (Math.round(cv * 10) / 10).toLocaleString('cs-CZ') + ' m';
  function computeOrderRow(x, sales, P, m0) {
    const D = sales ? sales.reduce((s, v) => s + (v || 0), 0) : 0;
    const Lm = (x.lead || 0) / 30, coverM = Math.max(0.5, P.cover || 2), windowM = Lm + coverM;
    const sd = months => { let s = 0; for (let k = 0; k < Math.ceil(months); k++) { const fr = Math.min(1, months - k); s += (sales ? (sales[(m0 + k) % 12] || 0) : 0) * fr; } return s; };
    const windowDem = sd(windowM), leadDem = sd(Lm), Z = P.Z || 1.65;
    const rop = Math.round(leadDem + Z * Math.sqrt(Math.max(0, leadDem)));
    const position = (x.avail || 0) + (x.onOrder || 0);
    let rec = 0, status = 'OK';
    if ((x.avail || 0) < 0) { rec = Math.round(windowDem > 0 ? Math.max(windowDem - position, -(x.avail)) : -(x.avail)); status = 'oversold'; }
    else if (D <= 0) status = 'bez prodeje';
    else if (windowDem < 0.5) status = 'mimo sezónu';
    else if (position <= rop) { rec = Math.max(P.MOQ || 1, Math.round(windowDem - position)); status = 'objednat'; }
    rec = Math.max(0, rec);
    const coverAfter = fwdCover((x.avail || 0) + (x.onOrder || 0) + rec, sales, m0);
    return { D, rec, status, value: (x.unitCost > 0 ? x.unitCost * rec : 0), coverAfter };
  }
  function buildObjednavky(cfg) {
    const obj = loadObj(), sd = loadData(), m0 = new Date().getMonth();
    const smap = {}; (sd.rows || []).forEach(r => { smap[r.sk + '-' + r.reg] = (r.sales || []).map(x => x || 0); });
    const P = { cover: cfg.cover || 2, Z: cfg.Z || 1.65, MOQ: cfg.MOQ || 1 };
    let list = (obj.rows || []).map(x => ({ x, o: computeOrderRow(x, smap[x.sk + '-' + x.reg], P, m0) })).filter(r => r.o.rec > 0 || r.x.avail < 0);
    const totVal = list.reduce((s, r) => s + r.o.value, 0), totKs = list.reduce((s, r) => s + r.o.rec, 0), oversold = list.filter(r => r.x.avail < 0).length;
    // seskupit dle dodavatele, řadit dle hodnoty
    const bySup = {}; list.forEach(r => { const k = r.x.skupina || '—'; (bySup[k] = bySup[k] || []).push(r); });
    const sups = Object.keys(bySup).map(k => ({ sup: k, items: bySup[k].sort((a, b) => b.o.value - a.o.value), val: bySup[k].reduce((s, r) => s + r.o.value, 0) })).sort((a, b) => b.val - a.val);
    const R = t => '<th style="text-align:right;border-bottom:1px solid #d8dee7;padding:4px 7px;font-size:11px;color:#55605a">' + esc(t) + '</th>';
    const cellR = v => '<td style="text-align:right;border-bottom:1px solid #eef1ec;padding:4px 7px">' + v + '</td>';
    let body = '<div style="background:#e7f0fb;border:1px solid #c9dcf0;border-radius:10px;padding:12px 14px;margin:0 0 14px">' +
      '<b>' + fmt(list.length) + '</b> položek k objednání · celkem <b>' + fmt(totKs) + ' ks</b> (~' + kc(totVal) + ') · <b>' + fmt(oversold) + '</b> oversold (nevykryté objednávky > sklad). ' +
      'Objednat = sezónní poptávka za (dodací lhůta + pokrytí) − (K dispo + Objednáno). Data: ' + esc(obj.date || obj.source || '') + '.</div>';
    sups.forEach(g => {
      body += '<h3 style="margin:16px 0 4px;font-size:15px">' + esc(g.sup) + ' <span style="color:#8a938a;font-weight:400;font-size:13px">· ' + g.items.length + ' pol. · ' + kc(g.val) + '</span></h3>' +
        '<table style="border-collapse:collapse;width:100%"><thead><tr>' +
        '<th style="text-align:left;border-bottom:1px solid #d8dee7;padding:4px 7px;font-size:11px;color:#55605a">Kód</th>' +
        '<th style="text-align:left;border-bottom:1px solid #d8dee7;padding:4px 7px;font-size:11px;color:#55605a">Položka</th>' +
        R('Sklad') + R('K dispo') + R('Objednáno') + R('Lhůta') + R('Roč. prodej') + R('Objednat') + R('Krytí po obj.') + R('Hodnota') + '</tr></thead><tbody>' +
        g.items.map(r => '<tr' + (r.x.avail < 0 ? ' style="background:#fbeaea"' : '') + '><td style="padding:4px 7px;border-bottom:1px solid #eef1ec">' + esc(r.x.sk + '-' + r.x.reg) + '</td>' +
          '<td style="padding:4px 7px;border-bottom:1px solid #eef1ec">' + esc(r.x.nazev) + '</td>' +
          cellR(fmt(r.x.stock)) + cellR((r.x.avail < 0 ? '<b style="color:#b23">' : '') + fmt(r.x.avail) + (r.x.avail < 0 ? '</b>' : '')) + cellR(fmt(r.x.onOrder)) + cellR(fmt(r.x.lead)) + cellR(fmt(r.o.D)) +
          cellR('<b>' + fmt(r.o.rec) + '</b>') + cellR(covTxt(r.o.coverAfter)) + cellR(r.o.value ? kc(r.o.value) : '—') + '</tr>').join('') + '</tbody></table>';
    });
    return { subject: 'Objednávkový report (ERP) — co objednat · ' + (obj.date || ''), html: wrap('Co objednat (ERP × prodeje)', 'Položky pod bodem objednání, seskupené dle dodavatele', body, obj.date || obj.source || '—'), count: list.length, totVal };
  }

  // ---------- odeslání ----------
  async function sendReport(kind, toList, cfg) {
    const to = cleanEmails(toList);
    if (!to.length) return { ok: false, error: 'žádný příjemce' };
    const rep = kind === 'objednavky' ? buildObjednavky(cfg) : buildMarkdown(cfg);
    const from = (host.mailFrom && host.mailFrom.user) || '';
    const name = (host.mailFrom && host.mailFrom.name) || 'Intranet ELKOPLAST — nákup';
    try {
      await host.deliver({ to: to.join(', '), fromAddr: from, fromName: name, subject: rep.subject, text: rep.subject, html: rep.html });
      return { ok: true, to, count: rep.count };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ---------- plánovač (týdně, pojistka 1×/ISO-týden) ----------
  function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const wk = 1 + Math.round(((t - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  async function tick() {
    // 1) DENNÍ stažení nejnovějšího souboru z Drive (běží nezávisle na e-mailech)
    try { const s = await syncObjednavky(false); if (s && !s.ok && !s.skipped) console.warn('[nakup-report] Drive sync neproběhl:', s.error); } catch (e) { console.error('[nakup-report] Drive sync:', e.message); }
    // 2) E-mailové reporty dle configu
    try {
      const cfg = loadCfg(); const now = new Date();
      let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
      let changed = false;
      // Objednávkový report — 1× za 14 dní (od zvoleného dne)
      if (cfg.objednavkyEnabled && now.getDay() >= cfg.objednavkyDay) {
        const daysSince = st.objAt ? (now - new Date(st.objAt)) / 86400000 : 999;
        if (daysSince >= 13) { const r = await sendReport('objednavky', cfg.objednavkyTo, cfg); st.objAt = now.toISOString(); st.objednavky = r; changed = true; console.log('[nakup-report] objednávkový report: ' + (r.ok ? r.count + ' pol.' : 'CHYBA ' + r.error)); }
      }
      // Týdenní zlevnění/nákup — volitelné (defaultně vypnuto)
      if (cfg.enabled && now.getDay() >= cfg.weekday) {
        const wk = isoWeek(now);
        if (st.lastWeek !== wk) { const rM = await sendReport('markdown', cfg.markdownTo, cfg); st.lastWeek = wk; st.lastAt = now.toISOString(); st.markdown = rM; changed = true; }
      }
      if (changed) try { fs.writeFileSync(STATE_F, JSON.stringify(st, null, 2)); } catch (_) {}
    } catch (e) { console.error('[nakup-report] tick:', e.message); }
  }

  // ---------- router ----------
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true), p = u.pathname;
    if (!p.startsWith('/api/nakup-report')) return false;
    // ERP objednávková data — čtení pro každého přihlášeného (globální SSO už ověřuje); optimalizace objednávek v appce.
    if (p === '/api/nakup-report/objednavky' && req.method === 'GET') {
      const o = loadObj(), mv = loadMoves();
      const rows = (o.rows || []).map(r => { const e = mv[r.sk + '-' + r.reg]; return Object.assign({}, r, { recentDaily: (e && e.days > 0) ? Math.round(e.sum / e.days * 100) / 100 : null, moveDays: e ? e.days : 0 }); });
      json(res, 200, Object.assign({}, o, { rows, hasMoves: Object.keys(mv).length > 0 }));
      return true;
    }
    if (!host.isAdmin(req)) { json(res, 403, { error: 'Jen pro správce.' }); return true; }

    if (p === '/api/nakup-report/config' && req.method === 'GET') {
      let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
      let sync = {}; try { sync = JSON.parse(fs.readFileSync(SYNC_STATE, 'utf8')) || {}; } catch (_) {}
      const d = loadData(), o = loadObj();
      return json(res, 200, { config: loadCfg(), state: st, sync, driveConfigured: !!(drive && drive.configured()), saEmail: (drive && drive.saEmail) ? drive.saEmail() : '', driveFolder: OBJ_FOLDER, dataPeriod: d.period || '', dataRows: (d.rows || []).length, objDate: o.date || o.source || '', objRows: (o.rows || []).length }), true;
    }
    if (p === '/api/nakup-report/config' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) { json(res, 400, { error: 'Neplatné tělo.' }); return true; }
      const next = Object.assign({}, loadCfg());
      if (b.markdownTo != null) next.markdownTo = cleanEmails(b.markdownTo);
      if (b.enabled != null) next.enabled = !!b.enabled;
      if (b.weekday != null && b.weekday >= 0 && b.weekday <= 6) next.weekday = +b.weekday;
      if (b.objednavkyTo != null) next.objednavkyTo = cleanEmails(b.objednavkyTo);
      if (b.objednavkyEnabled != null) next.objednavkyEnabled = !!b.objednavkyEnabled;
      if (b.objednavkyDay != null && b.objednavkyDay >= 0 && b.objednavkyDay <= 6) next.objednavkyDay = +b.objednavkyDay;
      saveCfg(next);
      return json(res, 200, { ok: true, config: next }), true;
    }
    if (p === '/api/nakup-report/sync' && req.method === 'POST') {
      try { const r = await syncObjednavky(true); return json(res, r.ok ? 200 : 500, r), true; }
      catch (e) { return json(res, 500, { ok: false, error: e.message }), true; }
    }
    if (p === '/api/nakup-report/preview' && req.method === 'GET') {
      const cfg = loadCfg(); const kind = u.query.type === 'objednavky' ? 'objednavky' : 'markdown';
      const rep = kind === 'objednavky' ? buildObjednavky(cfg) : buildMarkdown(cfg);
      return htmlOut(res, 200, rep.html), true;
    }
    if (p === '/api/nakup-report/send' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) {}
      const cfg = loadCfg();
      const kind = b.type === 'objednavky' ? 'objednavky' : 'markdown';
      const def = kind === 'objednavky' ? cfg.objednavkyTo : cfg.markdownTo;
      const to = b.to ? cleanEmails(b.to) : def;
      const r = await sendReport(kind, to, cfg);
      return json(res, r.ok ? 200 : 500, r), true;
    }
    json(res, 404, { error: 'Not found' }); return true;
  }

  return { handle, tick, sync: () => syncObjednavky(false) };
}

module.exports = { mount };

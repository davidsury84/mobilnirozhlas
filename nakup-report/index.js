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
  const OBRAT_FOLDER = process.env.OBRAT_DRIVE_FOLDER || ''; // složka s „obrat plasty" (prodejní historie); prázdné = vypnuto, klient jede z embedu
  const OBRAT_RAW = path.join(host.dataDir || __dirname, 'obrat-plasty.xlsx');        // cache nejnovějšího obrat plasty (raw xlsx, writable)
  const OBRAT_STATE = path.join(host.dataDir || __dirname, 'obrat-plasty-sync.json'); // stav sync (poslední soubor/datum)
  const SUP_F = path.join(host.dataDir || __dirname, 'nakup-dodavatele.json');       // dotazník dodavatelů: termín dodání + náklad na dopravu (writable)
  const loadObj = () => { for (const f of [OBJ_LIVE, OBJ_SEED]) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} } return { rows: [], columns: [], date: '' }; };
  const loadSup = () => { try { return JSON.parse(fs.readFileSync(SUP_F, 'utf8')) || {}; } catch (_) { return {}; } };
  const saveSup = m => { try { fs.writeFileSync(SUP_F, JSON.stringify(m, null, 2)); } catch (_) {} };
  // Odvozený seznam dodavatelů z ERP: název, počet položek, medián dodací lhůty, hodnota zásoby — + uložené hodnoty dotazníku.
  function supplierList() {
    const o = loadObj(), saved = loadSup(), g = {};
    (o.rows || []).forEach(r => { const k = r.skupina || '—'; (g[k] = g[k] || { supplier: k, items: 0, leads: [], stockVal: 0 }); g[k].items++; if (r.lead > 0) g[k].leads.push(r.lead); g[k].stockVal += (r.stock || 0) * (r.unitCost || 0); });
    return Object.values(g).map(x => {
      const ls = x.leads.slice().sort((a, b) => a - b), med = ls.length ? ls[Math.floor(ls.length / 2)] : 0;
      const s = saved[x.supplier] || {};
      return { supplier: x.supplier, items: x.items, erpLead: med, stockVal: Math.round(x.stockVal), lead: (s.lead != null ? s.lead : null), shipCost: (s.shipCost != null ? s.shipCost : null), origin: s.origin || '' };
    }).sort((a, b) => b.stockVal - a.stockVal);
  }

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
      e.sum += v; e.days += dd;
      // Ukládej do historie jen dny se skutečným pohybem — od 20. 8. 2026 chodí v exportu i položky
      // s nulovým stavem (2 500 místo 850 řádků) a nulové záznamy by soubor zbytečně nafukovaly.
      if (v > 0) { e.hist.push({ d: nowDate, v: Math.round(v) }); if (e.hist.length > 90) e.hist.shift(); } });
    try { fs.writeFileSync(MOVE_F, JSON.stringify(mv)); } catch (_) {}
  }
  const dateOfName = nm => { const m = /(\d{4})[-.]?(\d{2})[-.]?(\d{2})/.exec(nm || ''); return m ? (m[1] + '-' + m[2] + '-' + m[3]) : null; };
  // bootstrap: projde až 14 nejnovějších denních souborů chronologicky a spočítá rozdíly (rozjezd historie)
  async function bootstrapMovements(xls, newest, parsedNewest, newestDate) {
    const recent = xls.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(-60);
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

  // ---- DENNÍ BILANCE SKLADU (stav + pohyby, kusově i finančně v landed cenách) ----
  const BAL_F = path.join(host.dataDir || __dirname, 'objednavky-bilance.json'); // denní historie bilance (cap 120 dní)
  // ---- HISTORIE SNÍMKŮ SMI (mrtvé zásoby v čase) — sdílená na serveru, dřív jen localStorage prohlížeče ----
  const HIST_F = path.join(host.dataDir || __dirname, 'smi-historie.json');
  const loadHist = () => { try { const a = JSON.parse(fs.readFileSync(HIST_F, 'utf8')); return Array.isArray(a) ? a : []; } catch (_) { return []; } };
  const histKey = s => (s && s.periodKey) ? String(s.periodKey) : ('d:' + (s && s.date));
  function saveHist(arr) {
    arr = (arr || []).slice().sort((a, b) => ((a.periodKey || 0) - (b.periodKey || 0)) || ((a.ts || 0) - (b.ts || 0)));
    if (arr.length > 60) arr = arr.slice(-60);
    try { fs.writeFileSync(HIST_F, JSON.stringify(arr)); } catch (e) { console.error('[nakup-report] historie zápis:', e.message); }
    return arr;
  }
  function mergeHist(snap) { // re-upload stejného období = přepis, ne duplicita
    const arr = loadHist().filter(s => histKey(s) !== histKey(snap)); arr.push(snap); return saveHist(arr);
  }
  const unitVal = r => (r.unitCost > 0 ? r.unitCost : (r.unitPrice || 0));
  const loadBilance = () => { try { return JSON.parse(fs.readFileSync(BAL_F, 'utf8')) || []; } catch (_) { return []; } };
  function pushBilance(B) {
    const all = loadBilance(), old = all.find(e => e.date === B.date);
    // Pojistka: nikdy nepřepiš už spočítané denní pohyby prázdnými (opakovaný sync téhož dne).
    if (old && old.hasFlow && !B.hasFlow) { B = Object.assign({}, B, { flow: old.flow, hasFlow: true, flowDate: old.flowDate || null, flowDays: old.flowDays || 1 }); }
    const arr = all.filter(e => e.date !== B.date); arr.push(B);
    arr.sort((a, b) => String(a.date).localeCompare(String(b.date))); while (arr.length > 120) arr.shift();
    try { fs.writeFileSync(BAL_F, JSON.stringify(arr)); } catch (_) {} return arr;
  }
  function computeBilance(nowRows, nowDate, prevRows, prevDate) {
    const Z = () => ({ ks: 0, kc: 0 });
    // POZOR: stav (sklad/dispo/…) je k ránu `nowDate`, ale POHYBY se staly PŘEDCHOZÍ den → flowDate.
    const B = { date: nowDate, items: (nowRows || []).length, stock: Z(), dispo: Z(), onOrder: Z(), reserved: Z(),
      flow: { received: Z(), dispatched: Z(), newReserved: Z(), newOnOrder: Z() }, hasFlow: !!(prevRows && prevRows.length),
      flowDate: prevDate || null, flowDays: (prevDate && nowDate) ? daysBetween(prevDate, nowDate) : 1 };
    const pm = {}; (prevRows || []).forEach(r => { pm[r.sk + '-' + r.reg] = { stock: r.stock || 0, onOrder: r.onOrder || 0, reserved: r.reserved || 0 }; });
    (nowRows || []).forEach(r => {
      const v = unitVal(r);
      B.stock.ks += r.stock || 0; B.stock.kc += (r.stock || 0) * v;
      B.dispo.ks += r.avail || 0; B.dispo.kc += (r.avail || 0) * v;
      B.onOrder.ks += r.onOrder || 0; B.onOrder.kc += (r.onOrder || 0) * v;
      B.reserved.ks += r.reserved || 0; B.reserved.kc += (r.reserved || 0) * v;
      const p = pm[r.sk + '-' + r.reg];
      if (p) {
        const recv = Math.max(0, (p.onOrder || 0) - (r.onOrder || 0));
        const disp = Math.max(0, recv - ((r.stock || 0) - (p.stock || 0)));
        const nRes = Math.max(0, (r.reserved || 0) - (p.reserved || 0));
        const nOrd = Math.max(0, (r.onOrder || 0) - (p.onOrder || 0));
        B.flow.received.ks += recv; B.flow.received.kc += recv * v;
        B.flow.dispatched.ks += disp; B.flow.dispatched.kc += disp * v;
        B.flow.newReserved.ks += nRes; B.flow.newReserved.kc += nRes * v;
        B.flow.newOnOrder.ks += nOrd; B.flow.newOnOrder.kc += nOrd * v;
      }
    });
    ['stock', 'dispo', 'onOrder', 'reserved'].forEach(k => { B[k].ks = Math.round(B[k].ks); B[k].kc = Math.round(B[k].kc); });
    Object.keys(B.flow).forEach(k => { B.flow[k].ks = Math.round(B.flow[k].ks); B.flow[k].kc = Math.round(B.flow[k].kc); });
    return B;
  }
  const emptyFlow = () => ({ received: { ks: 0, kc: 0 }, dispatched: { ks: 0, kc: 0 }, newReserved: { ks: 0, kc: 0 }, newOnOrder: { ks: 0, kc: 0 } });
  function sumFlows(entries) { const s = emptyFlow(); (entries || []).forEach(e => { if (!e.flow) return; ['received', 'dispatched', 'newReserved', 'newOnOrder'].forEach(k => { s[k].ks += (e.flow[k] && e.flow[k].ks) || 0; s[k].kc += (e.flow[k] && e.flow[k].kc) || 0; }); }); return s; }
  function dayDeltas(L, P) { const d = {}; ['stock', 'dispo', 'onOrder', 'reserved'].forEach(k => { d[k] = { ks: (L[k].ks || 0) - (P ? (P[k].ks || 0) : (L[k].ks || 0)), kc: (L[k].kc || 0) - (P ? (P[k].kc || 0) : (L[k].kc || 0)) }; }); return d; }
  const hasEshop = req => { if (host.isAdmin(req)) return true; try { const e = host.empSession && host.empSession(req); return !!(e && host.employeeModules && host.employeeModules(e.email).indexOf('eshop') >= 0); } catch (_) { return false; } };
  // bootstrap / přepočet bilance z posledních denních souborů (naskočí hned; forceAll = přepiš i existující dny)
  async function bootstrapBilance(xls, newest, parsedNewest, newestDate, forceAll) {
    const recent = xls.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(-60);
    let prevRows = null, prevDate = null;
    for (const f of recent) {
      let rows, dt;
      if (f.id === newest.id) { rows = parsedNewest.rows; dt = newestDate; }
      else { const dl = await drive.downloadFileBase64(f.id, 20 * 1024 * 1024); rows = parseObjXlsx(Buffer.from(dl.base64, 'base64')).rows; dt = dateOfName(f.name); }
      if (dt) { const B = computeBilance(rows, dt, prevRows, prevDate); if (forceAll) { const arr = loadBilance().filter(e => e.date !== dt); arr.push(B); arr.sort((a, b) => String(a.date).localeCompare(String(b.date))); try { fs.writeFileSync(BAL_F, JSON.stringify(arr)); } catch (_) {} } else pushBilance(B); }
      prevRows = rows; prevDate = dt;
    }
    console.log('[nakup-report] bootstrap bilance z ' + recent.length + ' souborů');
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
      if (loadBilance().length === 0 || !st.bilanceFixV4) {
        try {
          let parsedNow = null; try { parsedNow = JSON.parse(fs.readFileSync(OBJ_LIVE, 'utf8')); } catch (_) {}
          if (parsedNow && parsedNow.rows) {
            const force = loadBilance().length > 0;
            await bootstrapBilance(xls, newest, parsedNow, parsedNow.date || dateOfName(newest.name) || today, force);
            st.bilanceFixV4 = 1;
            console.log('[nakup-report] bilance: ' + (force ? 'jednorázový přepočet historie' : 'bootstrap') + ' z denních souborů');
          }
        } catch (e) { console.warn('[nakup-report] bilance (skip):', e.message); }
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
      // denní bilance skladu (stav + pohyby vs PŘEDCHOZÍ DEN — nikdy ne proti témuž dni, jinak vyjdou nulové pohyby)
      try {
        const prevForFlow = (prev && prev.rows && prev.date && prev.date !== dataDate) ? prev.rows : null;
        if (loadBilance().length === 0) await bootstrapBilance(xls, newest, parsed, dataDate);
        else if (!st.bilanceFixV4) { await bootstrapBilance(xls, newest, parsed, dataDate, true); st.bilanceFixV4 = 1; console.log('[nakup-report] bilance: jednorázový přepočet historie z denních souborů'); }
        else pushBilance(computeBilance(parsed.rows, dataDate, prevForFlow, prevForFlow ? prev.date : null));
      } catch (e) { console.warn('[nakup-report] bilance:', e.message); }
      fs.writeFileSync(PREV_F, JSON.stringify({ date: dataDate, rows: parsed.rows.map(r => ({ sk: r.sk, reg: r.reg, stock: r.stock, onOrder: r.onOrder, reserved: r.reserved })) }));
    } catch (e) { console.warn('[nakup-report] pohyby:', e.message); }
    fs.writeFileSync(OBJ_LIVE, JSON.stringify({ source: newest.name, date: dataDate, columns: parsed.columns, rows: parsed.rows, syncedAt: new Date().toISOString() }));
    st = { lastSyncDate: today, lastFileId: newest.id, lastFileName: newest.name, lastRows: parsed.rows.length, lastAt: new Date().toISOString(), bilanceFixV4: st.bilanceFixV4 || 0 };
    try { fs.writeFileSync(SYNC_STATE, JSON.stringify(st, null, 2)); } catch (_) {}
    console.log('[nakup-report] Drive sync: ' + newest.name + ' → ' + parsed.rows.length + ' položek');
    return { ok: true, file: newest.name, rows: parsed.rows.length };
  }

  // ---- „obrat plasty" (prodejní historie) — denní stažení nejnovějšího souboru ze sdílené složky ----
  const dateOfObrat = nm => { const m = /(\d{4})[-.]?(\d{2})[-.]?(\d{2})/.exec(nm || ''); if (m) return m[1] + '-' + m[2] + '-' + m[3]; const q = /([1-4])Q\s*(\d{4})/i.exec(nm || ''); return q ? (q[2] + '-Q' + q[1]) : ''; };
  async function syncObrat(force) {
    if (!OBRAT_FOLDER) return { ok: false, error: 'OBRAT_DRIVE_FOLDER není nastaven.' };
    if (!drive || !drive.configured()) return { ok: false, error: 'Service account (GOOGLE_SA_*) není nastavený.' };
    let st = {}; try { st = JSON.parse(fs.readFileSync(OBRAT_STATE, 'utf8')) || {}; } catch (_) {}
    const files = await drive.listFolder(OBRAT_FOLDER);
    const xls = (files || []).filter(f => /\.xlsx$/i.test(f.name || '') || /spreadsheetml/.test(f.mimeType || ''));
    if (!xls.length) return { ok: false, error: 'Ve složce obrat plasty nejsou .xlsx soubory (nasdílena SA?).' };
    xls.sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || '')) || String(b.name || '').localeCompare(String(a.name || '')));
    const newest = xls[0];
    if (!force && st.lastFileId === newest.id) return { ok: true, skipped: true, file: newest.name };
    const dl = await drive.downloadFileBase64(newest.id, 30 * 1024 * 1024);
    try { fs.writeFileSync(OBRAT_RAW, Buffer.from(dl.base64, 'base64')); } catch (e) { return { ok: false, error: 'Uložení selhalo: ' + e.message }; }
    st = { lastFileId: newest.id, lastFileName: newest.name, date: dateOfObrat(newest.name), lastAt: new Date().toISOString() };
    try { fs.writeFileSync(OBRAT_STATE, JSON.stringify(st, null, 2)); } catch (_) {}
    console.log('[nakup-report] obrat plasty sync: ' + newest.name);
    return { ok: true, file: newest.name };
  }
  function obratMeta() { let st = {}; try { st = JSON.parse(fs.readFileSync(OBRAT_STATE, 'utf8')) || {}; } catch (_) {} return st; }

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
      markdownEvery: (c.markdownEvery === 1 || c.markdownEvery === 2) ? c.markdownEvery : 2,   // „Co zlevnit" = 1× za 14 dní
      // objednávkový report (ERP, 1× za 14 dní) — příjemci editovatelní správcem
      objednavkyTo: Array.isArray(c.objednavkyTo) ? c.objednavkyTo : ['jan.benicek@elkoplast.cz', 'michaela.lizancova@elkoplast.cz', 'david.sury@elkoplast.cz', 'hana.faltynkova@elkoplast.cz'],
      objednavkyEnabled: c.objednavkyEnabled !== undefined ? !!c.objednavkyEnabled : false, // ZATÍM VYPNUTO (uživatel: „zatím nic neposílej")
      objednavkyDay: (c.objednavkyDay >= 0 && c.objednavkyDay <= 6) ? c.objednavkyDay : 1,
      objednavkyEvery: (c.objednavkyEvery === 1 || c.objednavkyEvery === 2) ? c.objednavkyEvery : 2, // „Co objednat" = 1× za 14 dní
      // ranní bilance skladu (denně) — příjemci editovatelní správcem
      bilanceTo: Array.isArray(c.bilanceTo) ? c.bilanceTo : DEF_PU.slice(),
      bilanceEnabled: c.bilanceEnabled !== undefined ? !!c.bilanceEnabled : false, // VÝCHOZÍ VYPNUTO
      bilanceHour: (c.bilanceHour >= 0 && c.bilanceHour <= 23) ? c.bilanceHour : 8, // odesílá se ráno od této hodiny
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
  // Vysvětlující box „Co to je / Jak číst / Co s tím" na začátek reportu.
  function explainBox(rows) {
    return '<div style="background:#eef4fb;border:1px solid #d3e0f2;border-radius:10px;padding:13px 16px;margin:0 0 16px;font-size:13px;line-height:1.65">' +
      rows.map(r => '<div style="margin:3px 0"><b style="color:#1f4e79">' + esc(r[0]) + ':</b> ' + r[1] + '</div>').join('') + '</div>';
  }
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
      explainBox([
        ['Co to je', 'Přehled položek, které se <b>dlouho neprodaly</b> nebo jich držíme <b>na roky dopředu</b> — leží v nich zbytečně peníze a zabírají sklad. Cílem je je <b>slevou rozhýbat</b> a uvolnit kapitál.'],
        ['Jak číst', '<b>Kategorie</b>: <i>Stárnoucí</i> = ' + cfg.aging + '+ měsíců bez prodeje, <i>Mrtvá</i> = ' + cfg.dead + '+ měsíců. <b>Krytí</b> = na jak dlouho zásoba vydrží při současném tempu prodeje (<b>⚠</b> = přeskladněno, drží se roky). <b>Sleva</b> = doporučená akční sleva. <b>Hodnota zásoby</b> = kolik korun v položce leží.'],
        ['Co s tím', 'Nasadit doporučenou slevu / zařadit do akce, doprodat a hlavně <b>přestat objednávat</b>. Seřazeno podle vázaného kapitálu — <b>nahoře je největší balík peněz</b>.'],
        ['Odkud data', 'Prodeje z „obrat plasty" (klouzavých 12 měsíců). Report je jen návrh — rozhodnutí o slevě je na tobě.']
      ]) +
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
  const MN_RIM = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  function seasonInfo(sales) { // sezónní = nejsilnější souvislé 3měsíční okno ≥55 % ročního prodeje & D≥12
    if (!sales) return { isSeasonal: false, winStart: -1, peak: '' };
    const D = sales.reduce((a, b) => a + (b || 0), 0); if (D <= 0) return { isSeasonal: false, winStart: -1, peak: '' };
    let best = 0, bestS = -1;
    for (let s = 0; s < 12; s++) { const sum = (sales[s % 12] || 0) + (sales[(s + 1) % 12] || 0) + (sales[(s + 2) % 12] || 0); if (sum > bestS) { bestS = sum; best = s; } }
    const isSeasonal = (bestS / D) >= 0.55 && D >= 12;
    return { isSeasonal, winStart: best, peak: MN_RIM[best] + '–' + MN_RIM[(best + 2) % 12] };
  }
  // Robustní poptávka: omez JEDEN dominantní měsíc (jednorázový extrém), aby nenafoukl nákup. D zůstává skutečný.
  function robustSales(sales) {
    if (!sales || !sales.length) return sales || [];
    const arr = sales.map(v => v || 0), D = arr.reduce((s, v) => s + v, 0);
    const sorted = arr.slice().sort((a, b) => b - a), top1 = sorted[0], top2 = sorted[1] || 0;
    const sm = arr.slice().sort((a, b) => a - b), med = arr.length % 2 ? sm[(arr.length - 1) / 2] : (sm[arr.length / 2 - 1] + sm[arr.length / 2]) / 2;
    let r = arr.slice();
    if (top1 >= 15 && top1 >= 4 * Math.max(1, med) && top1 >= 3 * Math.max(1, top2) && top1 >= 0.4 * Math.max(1, D)) { r[arr.indexOf(top1)] = Math.max(top2, Math.round(med * 2)); }
    // Řídce prodávaná položka (<3 měsíce s prodejem a nízký objem) → plochý průměr (sezónnost je jen šum).
    const Dr = r.reduce((s, v) => s + v, 0), monthsWithSales = r.filter(v => v > 0).length;
    if (monthsWithSales < 3 && Dr < 24 && Dr > 0) { const avg = Dr / 12; r = r.map(() => avg); }
    return r;
  }
  function computeOrderRow(x, sales, P, m0) {
    const D = sales ? sales.reduce((s, v) => s + (v || 0), 0) : 0;
    const dem = robustSales(sales);
    const Lm = (x.lead || 0) / 30, coverM = Math.max(0.5, P.cover || 2);
    let windowM = Lm + coverM, ramp = false, rampTo = '';
    // Náběh sezóny: sezónní produkt objednávej s předstihem (lhůta + pokrytí) před špičkou, pokryj do konce špičky.
    const sea = seasonInfo(dem);
    if (sea.isSeasonal && sea.winStart >= 0) {
      const ws = sea.winStart, offset = ((m0 - ws) % 12 + 12) % 12, inPeak = offset <= 2;
      const distStart = ((ws - m0) % 12 + 12) % 12, reachEnd = ((ws + 2 - m0) % 12 + 12) % 12 + 1;
      if ((inPeak || distStart <= Lm + coverM) && reachEnd > windowM) { windowM = reachEnd; ramp = true; rampTo = sea.peak; }
    }
    const sd = months => { let s = 0; for (let k = 0; k < Math.ceil(months); k++) { const fr = Math.min(1, months - k); s += (dem ? (dem[(m0 + k) % 12] || 0) : 0) * fr; } return s; };
    const windowDem = sd(windowM), leadDem = sd(Lm), Z = P.Z || 1.65;
    const rop = Math.round(leadDem + Z * Math.sqrt(Math.max(0, leadDem)));
    const position = (x.avail || 0) + (x.onOrder || 0);
    let rec = 0, status = 'OK';
    if ((x.avail || 0) < 0) { rec = Math.round(windowDem > 0 ? Math.max(windowDem - position, -position) : -position); status = 'oversold'; }
    else if (D <= 0) status = 'bez prodeje';
    else if (ramp) { const need = Math.round(windowDem - position); if (need > 0) { rec = Math.max(P.MOQ || 1, need); status = 'náběh sezóny ' + rampTo; } else status = 'sezóna pokryta'; }
    else if (windowDem < 0.5) status = 'mimo sezónu';
    else if (position <= rop) { const need = Math.round(windowDem - position); if (need > 0) { rec = Math.max(P.MOQ || 1, need); status = 'objednat'; } else status = 'zásoba stačí'; }
    rec = Math.max(0, rec);
    const coverAfter = fwdCover((x.avail || 0) + (x.onOrder || 0) + rec, dem, m0);
    return { D, rec, status, ramp, value: (x.unitCost > 0 ? x.unitCost : (x.unitPrice || 0)) * rec, coverAfter };
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
    let body = explainBox([
      ['Co to je', 'Seznam <b>co objednat u dodavatelů</b>, spočítaný z aktuálního stavu skladu (ERP) a historie prodejů. Seskupeno <b>podle dodavatele</b> a seřazeno podle hodnoty objednávky.'],
      ['Jak počítáme „Objednat"', 'Cílem je mít na skladě zásobu na <b>dodací lhůtu + ' + (cfg.cover || 2) + ' měsíce</b>. Objednat = tato cílová poptávka − (co je <i>k dispozici</i> + co už je <i>objednáno</i>). Poptávka je <b>sezónní</b> (počítá se dopředu od aktuálního měsíce) a <b>robustní</b> — jednorázové výkyvy (velká jednorázová zakázka) se do ní nezapočítávají.'],
      ['Zvláštní případy', '<b style="color:#b23">Oversold</b> (červeně) = zákazníci mají rezervováno víc, než je skladem → objednávka je <b>povinná</b> (vykrytí objednávek). <b>Náběh sezóny</b> = předzásobení na nadcházející špičku s předstihem o dodací lhůtu. Řídce prodávané položky jedou na plochém průměru (ne na falešné špičce).'],
      ['Jak číst sloupce', '<b>K dispo</b> = sklad − rezervace zákazníků. <b>Objednat</b> = doporučený počet ks. <b>Krytí po obj.</b> = na jak dlouho zásoba vydrží po naskladnění (u pomalých/sezónních položek číslo roste, protože se pak dlouho neprodává — není to přeskladnění). <b>Hodnota</b> = objednat × nákupní (landed) cena.'],
      ['Co s tím', 'Podklad pro objednávky u dodavatelů. V aplikaci lze u každého dodavatele <b>předat objednávku nákupčímu</b> (modul Požadavky nákupu) nebo stáhnout Excel.']
    ]) +
      '<div style="background:#e7f0fb;border:1px solid #c9dcf0;border-radius:10px;padding:12px 14px;margin:0 0 14px">' +
      '<b>' + fmt(list.length) + '</b> položek k objednání · celkem <b>' + fmt(totKs) + ' ks</b> (~' + kc(totVal) + ') · <b>' + fmt(oversold) + '</b> oversold (rezervace > sklad). Data ERP: ' + esc(obj.date || obj.source || '') + '.</div>';
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

  // ---------- ranní bilance skladu (e-mail) ----------
  function buildBilance(cfg) {
    const arr = loadBilance(), L = arr[arr.length - 1], P = arr[arr.length - 2];
    if (!L) return { subject: 'Bilance skladu e-shop — zatím bez dat', html: wrap('Bilance skladu e-shop', 'Zatím nejsou data', '<p>Bilance se plní z denních souborů skladu.</p>', '—'), count: 0 };
    const f = L.flow || {};
    const signed = kcv => (kcv > 0 ? '+' : '') + kc(kcv);
    const delColor = kcv => kcv > 0 ? '#2f7d32' : (kcv < 0 ? '#b23' : '#8a938a');
    const card = (label, o, accent, d) => '<td style="padding:0 6px 0 0;width:25%;vertical-align:top">' +
      '<div style="border:1px solid #dbe2d8;border-left:4px solid ' + accent + ';border-radius:9px;padding:10px 12px">' +
      '<div style="font-size:12px;color:#6b736c;text-transform:uppercase;letter-spacing:.03em">' + esc(label) + '</div>' +
      '<div style="font-size:20px;font-weight:700;color:#243">' + kc(o.kc) + '</div>' +
      '<div style="font-size:12px;color:#8a938a">' + fmt(o.ks) + ' ks' + (d && P ? ' · <span style="color:' + delColor(d.kc) + '">' + signed(d.kc) + '</span>' : '') + '</div></div></td>';
    const dd = dayDeltas(L, P);
    let body = explainBox([
      ['Co to je', 'Ranní <b>bilance skladu e-shopu</b> — kolik v něm dnes leží peněz a jak se to za den pohnulo. Vše v <b>nákladových (landed) cenách</b>.'],
      ['Stav (4 karty)', '<b>Sklad</b> = fyzická zásoba. <b>K dispozici</b> = sklad − rezervace zákazníků. <b>Objednáno u dodavatelů</b> = co je na cestě (ještě nedorazilo). <b>Rezervováno zákazníky</b> = co si už zákazníci objednali. „±" u karty = změna hodnoty proti včerejšku.'],
      ['Pohyby', '<b>Výdej ze skladu</b> ≈ prodej (co odešlo zákazníkům). <b>Příjem</b> = dodávky, které fyzicky dorazily (z dřívějších objednávek — <u>ne</u> nový nákup). <b>Nové rezervace</b> = nové objednávky zákazníků. <b>Nově objednáno</b> = nové objednávky u dodavatelů.'],
      ['K čemu je to dobré', 'Denní přehled, jestli sklad roste/klesá, kolik se prodalo (obrat) a co dorazilo — na jednom místě, finančně i kusově.']
    ]) +
      '<table style="border-collapse:separate;width:100%;margin:0 0 8px"><tr>' +
      card('Sklad', L.stock, '#3a7d44', dd.stock) + card('K dispozici', L.dispo, '#2f6f8f', dd.dispo) + card('Objednáno u dodav.', L.onOrder, '#b06f00', dd.onOrder) + card('Rezervováno zákazníky', L.reserved, '#8a4baf', dd.reserved) + '</tr></table>';
    if (P) body += '<p style="margin:0 0 14px;font-size:12px;color:#8a938a">± u karet = změna hodnoty proti předchozímu dni (' + esc(P.date) + ').</p>';
    // Předchozí den (pohyby) — finančně, členěno odbyt / zásobování
    if (L.hasFlow) {
      const fl = (lbl, o) => '<b>' + lbl + ':</b> ' + kc(o.kc) + ' <span style="color:#8a938a">(' + fmt(o.ks) + ' ks)</span>';
      body += '<div style="background:#f2f6ef;border:1px solid #dbe6d6;border-radius:9px;padding:12px 14px;margin:0 0 14px;font-size:13.5px;line-height:1.7">' +
        '📦 <b>Pohyby za ' + esc(L.flowDate || L.date) + '</b>' + ((L.flowDays || 1) > 1 ? (' <span style="color:#8a938a">(' + L.flowDays + ' dny)</span>') : '') + '<br>' +
        '<span style="color:#2f7d32">▸ Odbyt:</span> ' + fl('Výdej ze skladu (≈ prodej)', f.dispatched) + ' &nbsp;·&nbsp; ' + fl('Nové rezervace zákazníků', f.newReserved) + '<br>' +
        '<span style="color:#2f6f8f">▸ Zásobování:</span> ' + fl('Příjem dodávek na sklad', f.received) + ' &nbsp;·&nbsp; ' + fl('Nově objednáno u dodavatelů', f.newOnOrder) + '</div>';
    }
    // Týden — obrat (posledních 7 dní s pohyby)
    const wkEntries = arr.filter(e => e.hasFlow).slice(-7);
    if (wkEntries.length) {
      const W = sumFlows(wkEntries); const nd = wkEntries.length; const avg = W.dispatched.kc / nd;
      const wl = (lbl, o) => '<b>' + lbl + ':</b> ' + kc(o.kc) + ' <span style="color:#8a938a">(' + fmt(o.ks) + ' ks)</span>';
      body += '<div style="background:#eef3fb;border:1px solid #d3e0f2;border-radius:9px;padding:12px 14px;margin:0 0 14px;font-size:13.5px;line-height:1.7">' +
        '📈 <b>Týden — obrat (výdej ze skladu, posledních ' + nd + ' ' + (nd === 1 ? 'den' : (nd < 5 ? 'dny' : 'dní')) + ')</b><br>' +
        '<b>Výdej ze skladu (≈ prodej):</b> <b style="font-size:15px">' + kc(W.dispatched.kc) + '</b> <span style="color:#8a938a">(' + fmt(W.dispatched.ks) + ' ks · ø ' + kc(avg) + '/den)</span><br>' +
        wl('Naskladněno (příjem dodávek)', W.received) + ' &nbsp;·&nbsp; ' + wl('Nové rezervace zákazníků', W.newReserved) + ' &nbsp;·&nbsp; ' + wl('Nově objednáno u dodav.', W.newOnOrder) + '</div>';
    }
    // trend posledních 10 dní (hodnota skladu)
    const last = arr.slice(-10);
    body += '<h3 style="margin:14px 0 4px;font-size:14px">Trend (hodnota skladu, posledních ' + last.length + ' dní)</h3>' +
      '<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>' +
      ['Den', 'Sklad', 'Dispo', 'Objednáno', 'Rezervováno', 'Výdej/den'].map((h, i) => '<th style="text-align:' + (i ? 'right' : 'left') + ';border-bottom:1px solid #d8dee7;padding:4px 7px;font-size:11px;color:#55605a">' + h + '</th>').join('') + '</tr></thead><tbody>' +
      last.slice().reverse().map(e => '<tr><td style="padding:4px 7px;border-bottom:1px solid #eef1ec">' + esc(e.date) + '</td>' +
        ['stock', 'dispo', 'onOrder', 'reserved'].map(k => '<td style="text-align:right;padding:4px 7px;border-bottom:1px solid #eef1ec">' + kc(e[k].kc) + '</td>').join('') +
        '<td style="text-align:right;padding:4px 7px;border-bottom:1px solid #eef1ec;color:#2f6f8f">' + (e.hasFlow ? kc(e.flow.dispatched.kc) : '—') + '</td></tr>').join('') + '</tbody></table>';
    body += '<div style="margin:14px 0 0;padding:10px 12px;background:#fafbf9;border:1px solid #e6e9e3;border-radius:8px;font-size:11.5px;color:#8a938a;line-height:1.6">' +
      '<b>Vysvětlivky:</b> <b>Výdej ze skladu</b> = zboží expedované ze skladu (≈ prodej). <b>Příjem</b> = dodávky od dodavatele, které fyzicky dorazily na sklad (z dříve zadaných objednávek — není to nový nákup). <b>Nové rezervace</b> = nové objednávky od zákazníků. <b>Nově objednáno</b> = nové objednávky u dodavatelů. <b>Dispo</b> = sklad − rezervace zákazníků. Vše v nákladových (landed) cenách.</div>';
    return { subject: 'Ranní bilance skladu e-shop · ' + L.date, html: wrap('Bilance skladu e-shop', 'Stav a denní pohyby skladu (v nákladových cenách)', body, L.date), count: L.items };
  }

  // ---------- odeslání ----------
  async function sendReport(kind, toList, cfg) {
    const to = cleanEmails(toList);
    if (!to.length) return { ok: false, error: 'žádný příjemce' };
    const rep = kind === 'bilance' ? buildBilance(cfg) : kind === 'objednavky' ? buildObjednavky(cfg) : buildMarkdown(cfg);
    const from = (host.mailFrom && host.mailFrom.user) || '';
    const name = (host.mailFrom && host.mailFrom.name) || 'Intranet ELKOPLAST — nákup';
    try {
      await host.deliver({ to: to.join(', '), fromAddr: from, fromName: name, subject: rep.subject, text: rep.subject, html: rep.html });
      return { ok: true, to, count: rep.count };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ---------- plánovač (týdně, pojistka 1×/ISO-týden) ----------
  function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const wk = 1 + Math.round(((t - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  // Pojistka: bilance se nesmí odeslat prázdná. Když historie chybí (nový volume, výpadek zápisu),
  // dopočítá se z denních souborů na Disku ještě před odesláním e-mailu.
  async function ensureBilance() {
    if (loadBilance().length) return false;
    if (!drive || !drive.configured() || !OBJ_FOLDER) return false;
    const files = await drive.listFolder(OBJ_FOLDER);
    const xls = (files || []).filter(f => /\.xlsx$/i.test(f.name || '') || /spreadsheetml/.test(f.mimeType || ''));
    if (!xls.length) return false;
    xls.sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || '')) || String(b.name || '').localeCompare(String(a.name || '')));
    const newest = xls[0];
    let parsedNow = null; try { parsedNow = JSON.parse(fs.readFileSync(OBJ_LIVE, 'utf8')); } catch (_) {}
    if (!(parsedNow && parsedNow.rows && parsedNow.rows.length)) {
      const dl = await drive.downloadFileBase64(newest.id, 20 * 1024 * 1024);
      parsedNow = { rows: parseObjXlsx(Buffer.from(dl.base64, 'base64')).rows, date: dateOfName(newest.name) };
    }
    await bootstrapBilance(xls, newest, parsedNow, parsedNow.date || dateOfName(newest.name) || new Date().toISOString().slice(0, 10), true);
    console.log('[nakup-report] bilance chyběla → dopočítána z Drive (' + loadBilance().length + ' dnů)');
    return true;
  }

  // Jednorázové zapnutí rozesílek (výslovný pokyn správce 2026-08-16). Poté už se řídí nastavením v „Rozesílky".
  function activateReportsOnce(st) {
    if (st.reportsActivatedV1) return false;
    const c = loadCfg(); c.enabled = true; c.objednavkyEnabled = true; c.bilanceEnabled = true; saveCfg(c);
    st.reportsActivatedV1 = 1;
    console.log('[nakup-report] rozesílky jednorázově ZAPNUTY (co objednat, co zlevnit, ranní bilance)');
    return true;
  }
  // Neúspěšné odeslání nesmí den „spotřebovat" — zkusí se znovu, ale nejvýš 3× (pak čeká na další období).
  const MAX_POKUSU = 3;
  function odeslano(st, klic, obdobi, r) {
    st[klic + 'Try'] = st[klic + 'Try'] || {};
    if (r && r.ok) { st[klic + 'Try'] = {}; return true; }
    const n = (st[klic + 'Try'][obdobi] || 0) + 1; st[klic + 'Try'][obdobi] = n;
    if (n >= MAX_POKUSU) { console.warn('[nakup-report] ' + klic + ': ' + n + ' neúspěšné pokusy, období ' + obdobi + ' se přeskakuje'); return true; }
    return false;   // false = ještě zkusíme příště
  }
  async function tick() {
    // 1) DENNÍ stažení nejnovějšího souboru z Drive (běží nezávisle na e-mailech)
    try { const s = await syncObjednavky(false); if (s && !s.ok && !s.skipped) console.warn('[nakup-report] Drive sync neproběhl:', s.error); } catch (e) { console.error('[nakup-report] Drive sync:', e.message); }
    if (OBRAT_FOLDER) { try { const so = await syncObrat(false); if (so && !so.ok && !so.skipped) console.warn('[nakup-report] obrat plasty sync neproběhl:', so.error); } catch (e) { console.error('[nakup-report] obrat sync:', e.message); } }
    // 2) E-mailové reporty dle configu
    try {
      const dis = (k) => host.reportDisabled && host.reportDisabled(k);   // zrušeno v přehledu Rozesílky
      let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
      let changed = activateReportsOnce(st);
      const cfg = loadCfg(); const now = new Date();
      // Objednávkový report — 1× týdně (od zvoleného dne, pojistka 1×/ISO-týden)
      if (cfg.objednavkyEnabled && !dis('objednavky') && now.getDay() >= cfg.objednavkyDay) {
        const wk = isoWeek(now);
        const objGap = st.objAt ? (now - new Date(st.objAt)) / 86400000 : 999;
        if (st.objWeek !== wk && objGap >= ((cfg.objednavkyEvery || 1) > 1 ? 13 : 6)) { const r = await sendReport('objednavky', cfg.objednavkyTo, cfg); st.objednavky = r; changed = true;
          if (odeslano(st, 'objednavky', wk, r)) { st.objWeek = wk; st.objAt = now.toISOString(); }
          console.log('[nakup-report] objednávkový report: ' + (r.ok ? r.count + ' pol. odesláno (' + (r.to || []).join(', ') + ')' : 'CHYBA ' + r.error)); }
      }
      // Ranní bilance skladu — denně (od zvolené hodiny), pojistka 1×/den
      if (cfg.bilanceEnabled && !dis('bilance') && now.getHours() >= (cfg.bilanceHour != null ? cfg.bilanceHour : 8)) {
        const dstr = now.toISOString().slice(0, 10);
        if (st.bilanceDay !== dstr) {
          try { await ensureBilance(); } catch (e) { console.warn('[nakup-report] dopočet bilance:', e.message); }
          const dnu = loadBilance().length;
          if (!dnu) { console.warn('[nakup-report] ranní bilance NEODESLÁNA — chybí denní data (zkusím při dalším běhu).'); }
          else {
            const rB = await sendReport('bilance', cfg.bilanceTo, cfg); st.bilance = rB; changed = true;
            if (odeslano(st, 'bilance', dstr, rB)) st.bilanceDay = dstr;
            console.log('[nakup-report] ranní bilance: ' + (rB.ok ? ('odesláno · ' + dnu + ' dnů historie (' + (rB.to || []).join(', ') + ')') : 'CHYBA ' + rB.error));
          }
        }
      }
      // Týdenní zlevnění/nákup — volitelné (defaultně vypnuto)
      if (cfg.enabled && !dis('markdown') && now.getDay() >= cfg.weekday) {
        const wk = isoWeek(now);
        const mdGap = st.lastAt ? (now - new Date(st.lastAt)) / 86400000 : 999;
        if (st.lastWeek !== wk && mdGap >= ((cfg.markdownEvery || 1) > 1 ? 13 : 6)) { const rM = await sendReport('markdown', cfg.markdownTo, cfg); st.markdown = rM; changed = true;
          if (odeslano(st, 'markdown', wk, rM)) { st.lastWeek = wk; st.lastAt = now.toISOString(); }
          console.log('[nakup-report] report „co zlevnit": ' + (rM.ok ? 'odesláno (' + (rM.to || []).join(', ') + ')' : 'CHYBA ' + rM.error)); }
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
      json(res, 200, Object.assign({}, o, { rows, hasMoves: Object.keys(mv).length > 0, suppliers: loadSup() }));
      return true;
    }
    // „obrat plasty" (prodejní historie) — čerstvý raw xlsx pro klienta (SMI app ho parsuje). Přihlášený.
    if (p === '/api/nakup-report/obrat-plasty' && req.method === 'GET') {
      try { const b64 = fs.readFileSync(OBRAT_RAW).toString('base64'); const m = obratMeta();
        return json(res, 200, { ok: true, name: m.lastFileName || '', date: m.date || '', syncedAt: m.lastAt || '', b64 }), true; }
      catch (_) { return json(res, 200, { ok: false, error: 'Zatím není načten obrat plasty z Drive.' }), true; }
    }
    // Dotazník dodavatelů — čtení pro přihlášené (EOQ v appce potřebuje náklad na dopravu + lhůtu)
    if (p === '/api/nakup-report/suppliers' && req.method === 'GET') {
      return json(res, 200, { suppliers: supplierList() }), true;
    }
    // Denní bilance skladu — pro přístup k modulu e-shop (i home widget)
    if (p === '/api/nakup-report/bilance' && req.method === 'GET') {
      if (!hasEshop(req)) { json(res, 403, { error: 'Bez přístupu k modulu e-shop.' }); return true; }
      const arr = loadBilance(); const latest = arr[arr.length - 1] || null; const prev = arr[arr.length - 2] || null;
      const trend = arr.slice(-30).map(e => ({ date: e.date, flowDate: e.flowDate || null, stockKc: e.stock.kc, onOrderKc: e.onOrder.kc, reservedKc: e.reserved.kc, dispoKc: e.dispo.kc, dispatchedKc: (e.flow && e.flow.dispatched) ? e.flow.dispatched.kc : 0 }));
      const wkEntries = arr.filter(e => e.hasFlow).slice(-7);
      const week = latest ? { days: wkEntries.length, flow: sumFlows(wkEntries) } : null;
      const dayDelta = (latest && prev) ? dayDeltas(latest, prev) : null;
      return json(res, 200, { latest, prev, trend, week, dayDelta, days: arr.length }), true;
    }
    // Vývoj e-shopu — agregace z denních snímků (bilance + per-položkové pohyby)
    if (p === '/api/nakup-report/vyvoj' && req.method === 'GET') {
      if (!hasEshop(req)) { json(res, 403, { error: 'Bez přístupu k modulu e-shop.' }); return true; }
      const bal = loadBilance().filter(e => e.hasFlow && e.flowDate), mv = loadMoves(), o = loadObj();
      const meta = {}; (o.rows || []).forEach(r => { meta[r.sk + '-' + r.reg] = { n: r.nazev, sup: r.skupina, uc: unitVal(r) }; });
      // per-den: kolik položek se hýbalo + agregace top položek
      const itemsPerDay = {}, agg = {};
      Object.keys(mv).forEach(k => { (mv[k].hist || []).forEach(h => { if (!(h.v > 0)) return;
        itemsPerDay[h.d] = (itemsPerDay[h.d] || 0) + 1;
        const t = agg[k] || (agg[k] = { ks: 0, dny: 0 }); t.ks += h.v; t.dny++; }); });
      const days = bal.map(e => ({ date: e.flowDate, souborDate: e.date, dny: e.flowDays || 1, dispKc: e.flow.dispatched.kc, dispKs: e.flow.dispatched.ks,
        recvKc: e.flow.received.kc, resKc: e.flow.newReserved.kc, ordKc: e.flow.newOnOrder.kc,
        stockKc: e.stock.kc, polozek: itemsPerDay[e.date] || 0 }));
      // Mimořádné dny: jednorázové zaúčtování / inventurní úprava, ne prodej. Poznáme je podle
      // násobku mediánu dnů s pohybem (stejný princip jako u jednorázových extrémů v prodejích).
      const nz = days.filter(d => d.dispKc > 0).map(d => d.dispKc).sort((a, b) => a - b);
      const med = nz.length ? (nz.length % 2 ? nz[(nz.length - 1) / 2] : (nz[nz.length / 2 - 1] + nz[nz.length / 2]) / 2) : 0;
      const limit = med > 0 ? med * 5 : Infinity;
      days.forEach(d => { d.mimoradny = d.dispKc > limit; });
      // týdny (ISO) — mimořádné dny se do obratu NEPOČÍTAJÍ, evidují se zvlášť
      const wk = {};
      days.forEach(d => { const dt = new Date(d.date + 'T00:00:00Z'); if (isNaN(dt)) return;
        const w = isoWeek(dt), e = wk[w] || (wk[w] = { week: w, from: d.date, to: d.date, dispKc: 0, dispKs: 0, recvKc: 0, resKc: 0, dni: 0, polozek: 0, mimoradneKc: 0, mimoradnychDnu: 0 });
        if (d.date < e.from) e.from = d.date; if (d.date > e.to) e.to = d.date;
        e.recvKc += d.recvKc; e.resKc += d.resKc; e.dni++; e.polozek += d.polozek;
        if (d.mimoradny) { e.mimoradneKc += d.dispKc; e.mimoradnychDnu++; }
        else { e.dispKc += d.dispKc; e.dispKs += d.dispKs; } });
      const weeks = Object.values(wk).sort((a, b) => String(a.week).localeCompare(String(b.week)));
      const top = Object.keys(agg).map(k => { const m = meta[k] || {};
        return { kod: k, nazev: m.n || k, dodavatel: m.sup || '', ks: agg[k].ks, dny: agg[k].dny, kc: Math.round(agg[k].ks * (m.uc || 0)) }; })
        .sort((a, b) => b.ks - a.ks).slice(0, 30);
      const itemHist = {}; top.forEach(t => { itemHist[t.kod] = (mv[t.kod] || {}).hist || []; });
      return json(res, 200, { ok: true, days, weeks, top, itemHist, dataDate: o.date || '', dniCelkem: days.length, limitMimoradne: isFinite(limit) ? Math.round(limit) : null }), true;
    }
    // Historie snímků SMI (mrtvé zásoby v čase) — sdílená, přístup jako e-shop
    if (p === '/api/nakup-report/historie' && req.method === 'GET') {
      if (!hasEshop(req)) { json(res, 403, { error: 'Bez přístupu k modulu e-shop.' }); return true; }
      return json(res, 200, { ok: true, items: loadHist() }), true;
    }
    if (p === '/api/nakup-report/historie' && req.method === 'POST') {
      if (!hasEshop(req)) { json(res, 403, { error: 'Bez přístupu k modulu e-shop.' }); return true; }
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) { json(res, 400, { error: 'Neplatné tělo.' }); return true; }
      let arr;
      if (b.clear) arr = saveHist([]);
      else if (Array.isArray(b.items)) arr = saveHist(b.items);          // hromadně (migrace z prohlížeče)
      else if (b.snapshot && typeof b.snapshot === 'object') arr = mergeHist(b.snapshot);
      else { json(res, 400, { error: 'Chybí snapshot / items / clear.' }); return true; }
      const who = (host.empSession && host.empSession(req)) || {};
      console.log('[nakup-report] historie: ' + (b.clear ? 'vymazána' : 'uložen snímek') + ' (' + arr.length + ' celkem) · ' + (who.email || 'admin'));
      return json(res, 200, { ok: true, items: arr }), true;
    }
    if (!host.isAdmin(req)) { json(res, 403, { error: 'Jen pro správce.' }); return true; }

    if (p === '/api/nakup-report/suppliers' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) { json(res, 400, { error: 'Neplatné tělo.' }); return true; }
      const cur = loadSup();
      // b.suppliers = { [name]: { lead, shipCost, origin } } — přepíšeme jen zaslané klíče, prázdné hodnoty = smazat
      if (b.suppliers && typeof b.suppliers === 'object') {
        Object.keys(b.suppliers).forEach(k => {
          const v = b.suppliers[k] || {}, e = {};
          if (v.lead !== '' && v.lead != null && isFinite(+v.lead)) e.lead = Math.max(0, Math.round(+v.lead));
          if (v.shipCost !== '' && v.shipCost != null && isFinite(+v.shipCost)) e.shipCost = Math.max(0, Math.round(+v.shipCost));
          if (v.origin) e.origin = String(v.origin).slice(0, 40);
          if (Object.keys(e).length) cur[k] = e; else delete cur[k];
        });
        saveSup(cur);
      }
      return json(res, 200, { ok: true, suppliers: cur }), true;
    }

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
      if (b.bilanceTo != null) next.bilanceTo = cleanEmails(b.bilanceTo);
      if (b.bilanceEnabled != null) next.bilanceEnabled = !!b.bilanceEnabled;
      if (b.bilanceHour != null && b.bilanceHour >= 0 && b.bilanceHour <= 23) next.bilanceHour = +b.bilanceHour;
      saveCfg(next);
      return json(res, 200, { ok: true, config: next }), true;
    }
    if (p === '/api/nakup-report/sync' && req.method === 'POST') {
      try { const r = await syncObjednavky(true); return json(res, r.ok ? 200 : 500, r), true; }
      catch (e) { return json(res, 500, { ok: false, error: e.message }), true; }
    }
    if (p === '/api/nakup-report/preview' && req.method === 'GET') {
      const cfg = loadCfg(); const kind = ['objednavky', 'bilance', 'markdown'].indexOf(u.query.type) >= 0 ? u.query.type : 'markdown';
      const rep = kind === 'bilance' ? buildBilance(cfg) : kind === 'objednavky' ? buildObjednavky(cfg) : buildMarkdown(cfg);
      return htmlOut(res, 200, rep.html), true;
    }
    if (p === '/api/nakup-report/send' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) {}
      const cfg = loadCfg();
      const kind = ['objednavky', 'bilance', 'markdown'].indexOf(b.type) >= 0 ? b.type : 'markdown';
      const def = kind === 'bilance' ? cfg.bilanceTo : kind === 'objednavky' ? cfg.objednavkyTo : cfg.markdownTo;
      const to = b.to ? cleanEmails(b.to) : def;
      const r = await sendReport(kind, to, cfg);
      return json(res, r.ok ? 200 : 500, r), true;
    }
    json(res, 404, { error: 'Not found' }); return true;
  }

  // Descriptor pro centrální přehled rozesílek (správce → „Rozesílky")
  const DNY = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
  // Mapa report → klíče v configu (pro centrální editaci v „Rozesílky")
  const REP_MAP = {
    bilance:    { to: 'bilanceTo',    en: 'bilanceEnabled',    hour: 'bilanceHour' },
    objednavky: { to: 'objednavkyTo', en: 'objednavkyEnabled', day: 'objednavkyDay', every: 'objednavkyEvery' },
    markdown:   { to: 'markdownTo',   en: 'enabled',           day: 'weekday',        every: 'markdownEvery' }
  };
  function reports() {
    const c = loadCfg(); let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
    const base = { module: 'E-shop · Nákup', configHint: 'lze upravit i v E-shop → Optimalizace nákupu → 📧 Reporty' };
    return [
      Object.assign({}, base, { key: 'bilance', name: 'Ranní bilance skladu', to: c.bilanceTo || [], enabled: !!c.bilanceEnabled,
        hour: (c.bilanceHour != null ? c.bilanceHour : 8), schedule: 'denně ráno (' + (c.bilanceHour != null ? c.bilanceHour : 8) + ':00)',
        lastAt: st.bilanceDay || null, preview: '/api/nakup-report/preview?type=bilance', send: { url: '/api/nakup-report/send', body: { type: 'bilance' } } }),
      Object.assign({}, base, { key: 'objednavky', name: 'Objednávkový report (co objednat)', to: c.objednavkyTo || [], enabled: !!c.objednavkyEnabled,
        day: (c.objednavkyDay != null ? c.objednavkyDay : 1), every: c.objednavkyEvery || 1,
        schedule: ((c.objednavkyEvery || 1) > 1 ? '1× za 14 dní' : 'týdně') + ' (' + DNY[c.objednavkyDay != null ? c.objednavkyDay : 1] + ')',
        lastAt: st.objAt || null, preview: '/api/nakup-report/preview?type=objednavky', send: { url: '/api/nakup-report/send', body: { type: 'objednavky' } } }),
      Object.assign({}, base, { key: 'markdown', name: 'Co zlevnit (stárnoucí/mrtvé zásoby)', to: c.markdownTo || [], enabled: !!c.enabled,
        day: (c.weekday != null ? c.weekday : 1), every: c.markdownEvery || 1,
        schedule: ((c.markdownEvery || 1) > 1 ? '1× za 14 dní' : 'týdně') + ' (' + DNY[c.weekday != null ? c.weekday : 1] + ')',
        lastAt: st.lastAt || null, preview: '/api/nakup-report/preview?type=markdown', send: { url: '/api/nakup-report/send', body: { type: 'markdown' } } })
    ];
  }
  // Centrální editace z „Rozesílky" (správce): zapnout/vypnout, příjemci, den, hodina.
  function setReport(key, patch) {
    const m = REP_MAP[key]; if (!m) return null;
    const c = loadCfg();
    if (patch.to != null) c[m.to] = cleanEmails(patch.to);
    if (patch.enabled != null) c[m.en] = !!patch.enabled;
    if (patch.day != null && m.day && +patch.day >= 0 && +patch.day <= 6) c[m.day] = +patch.day;
    if (patch.hour != null && m.hour && +patch.hour >= 0 && +patch.hour <= 23) c[m.hour] = +patch.hour;
    if (patch.every != null && m.every && (+patch.every === 1 || +patch.every === 2)) c[m.every] = +patch.every;
    saveCfg(c);
    return reports().find(r => r.key === key) || null;
  }

  return { handle, tick, sync: () => syncObjednavky(false), syncObrat: () => syncObrat(false), reports, setReport };
}

module.exports = { mount };

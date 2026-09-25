// Modul „Výkonnost středisek" — odvádění výroby z Heliosu pro 4 výrobní závody
// (Chomutov, Bruntál Abroly, Bruntál Popelnice, Supíkovice) + párování na plány výroby.
//
// Zdroj odvádění: sdílená složka na Disku (service account), pro každý závod podsložka,
// v ní exporty `YYYYMMDD.xlsx` — KUMULATIVNÍ od 1. 1. daného roku → bere se vždy nejnovější.
// Export NEMÁ Kč (Mzda/Cena, Doplatek) → měříme řádky, kusy, hodiny režie, dávkovost, terminál.
// Plány výroby: Google Sheets (ČVZ → výrobek, ks, zákazník, termín, fáze) — best effort, hlavička
// se hledá regexem; když plán nejde načíst, modul jede bez něj a ukáže důvod.
const fs = require('fs');
const path = require('path');
const urlLib = require('url');
let drive = null; try { drive = require('../smlouvy/lib/drive'); } catch (_) {}
const { parseAll } = require('./xlsx');

const ZAVODY = [
  { key: 'chomutov', name: 'Chomutov', kratce: 'CHO', folder: process.env.VYKON_FOLDER_CHOMUTOV || '1jhaouHBx-M8WPf0fcuG2JtzM9GP2IvNC', kmen: '40000000',
    plan: { sheetId: process.env.VYKON_PLAN_CHOMUTOV || '1mh8Fhi39uClg0xXvKuWvEDqmFvF5-mWv_8IA1cStBQM', tabRe: /zak[aá]zky/i } },
  { key: 'abroly', name: 'Bruntál Abroly', kratce: 'ABR', folder: process.env.VYKON_FOLDER_ABROLY || '1xxO2ZI3k5kIOf1oD9JEpSsyrxNNZ7sDa', kmen: '20000020',
    plan: { sheetId: process.env.VYKON_PLAN_ABROLY || '1CWoHIcbSR7Z5V1PjKE2QslOZ60JrZUPUD_Hhuexizaw', tabRe: /^zak\.?\s*brunt/i } },
  { key: 'popelnice', name: 'Bruntál Popelnice', kratce: 'POP', folder: process.env.VYKON_FOLDER_POPELNICE || '1YkmqHrRh8lzQ02dfjhebULOvxUsg2cmx', kmen: '20000022',
    plan: { sheetId: process.env.VYKON_PLAN_POPELNICE || '1620BTnSV5qlN25CcSg60CuTOgqiey6ck2eC_JKFOIbE', tabRe: /boxy|contract/i } },
  { key: 'supikovice', name: 'Supíkovice', kratce: 'SUP', folder: process.env.VYKON_FOLDER_SUPIKOVICE || '1ZErOxJkvxy7-TfPcZGD7CjDEv2nKy2Zn', kmen: '60000000',
    plan: { sheetId: process.env.VYKON_PLAN_SUPIKOVICE || '19ZskN-LJssZvGwRuEJ7rjfn19dsQqzZs-2z_sbXi-yY', tabRe: /zak[aá]zk/i } }
];

// Excel serial → ISO datum
const serialToIso = n => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(+n) * 86400000); return isNaN(d) ? '' : d.toISOString().slice(0, 10); };
const parseAnyDate = v => {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToIso(v) : '';
  const s = String(v).trim(); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return s.slice(0, 10);
  if ((m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(s))) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
};
const isoWeekOf = iso => { const d = new Date(iso + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const f = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); const wk = 1 + Math.round(((d - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); return d.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); };
const isRezie = n1 => /re[žz]ij/i.test(String(n1 || ''));
// Kategorie režie/víceprací z textu položky + poznámky mistra
function kategorieRezie(txt) {
  const s = String(txt || '').toLowerCase();
  if (/úklid|uklid|čišt|cist|sanac|mytí|myti/.test(s)) return 'Úklid a čištění';
  if (/poruch|závad|zavad|nešel|nesel|údržb|udrzb|servis/.test(s)) return 'Poruchy a údržba';
  if (/stěhov|stehov|transport|přesun|presun|sklad|naklád|naklad|vyklád|vyklad/.test(s)) return 'Stěhování a manipulace';
  if (/oprav|reklam|rework|podvař|podvar|nahřív|nahriv|rovn|příplat|priplat|vícepr|vicepr|předěl|predel/.test(s)) return 'Vícepráce a opravy';
  return 'Ostatní / bez normy';
}

function mount(host) {
  const dataDir = host.dataDir || __dirname;
  const DATA_F = k => path.join(dataDir, 'vykonnost-' + k + '.json');
  const PLAN_F = k => path.join(dataDir, 'vykonnost-plan-' + k + '.json');
  const STATE_F = path.join(dataDir, 'vykonnost-sync.json');
  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) { return {}; } };
  const saveState = st => { try { fs.writeFileSync(STATE_F, JSON.stringify(st, null, 2)); } catch (_) {} };
  const loadData = k => { try { return JSON.parse(fs.readFileSync(DATA_F(k), 'utf8')); } catch (_) { return null; } };
  const loadPlan = k => { try { return JSON.parse(fs.readFileSync(PLAN_F(k), 'utf8')); } catch (_) { return null; } };
  const zavodOf = k => ZAVODY.find(z => z.key === k);

  // ---------- parser exportu z Heliosu ----------
  // Sloupce: Datum případu (R/M/T/DMR), Řada, Kmenové středisko, Číslo+jméno, Odváděné kusy,
  // Název 1 (díl), Název (zakázka), ČVZ, Název (operace), Poznámka - 255, Autor.
  // Výstup: kompaktní řádky [datum, týden, empId, jméno, ks, díl, zakázka, čvz, operace, poznámka, autor]
  function parseExport(buf) {
    const sheets = parseAll(buf); const first = Object.values(sheets)[0] || [];
    if (!first.length) return { rows: [], warn: 'prázdný list' };
    let hi = first.findIndex(r => (r || []).some(c => /odváděné kusy|odvadene kusy/i.test(String(c || ''))));
    if (hi < 0) hi = 0;
    const H = first[hi].map(x => String(x == null ? '' : x).trim());
    const idx = re => H.findIndex(h => re.test(h));
    const c = {
      dmr: idx(/\(DMR\)/i), emp: idx(/příjmení a jméno|prijmeni a jmeno/i), ks: idx(/odváděné kusy|odvadene kusy/i),
      n1: idx(/^název 1$|^nazev 1$/i), cvz: idx(/^čvz$|^cvz$/i), pozn: idx(/^poznámka|^poznamka/i), aut: idx(/^autor$/i)
    };
    const nazevIdx = H.map((h, i) => (/^název$|^nazev$/i.test(h) ? i : -1)).filter(i => i >= 0);
    c.zak = nazevIdx[0] != null ? nazevIdx[0] : -1; c.op = nazevIdx.length > 1 ? nazevIdx[nazevIdx.length - 1] : -1;
    if (c.dmr < 0 || c.emp < 0 || c.ks < 0) return { rows: [], warn: 'nenalezeny sloupce DMR / jméno / kusy (hlavička: ' + H.slice(0, 8).join(' | ') + ')' };
    const S = v => String(v == null ? '' : v).trim();
    const rows = [];
    for (let r = hi + 1; r < first.length; r++) {
      const row = first[r] || []; if (row.length < 5) continue;
      const date = parseAnyDate(row[c.dmr]); if (!date) continue;
      const empRaw = S(row[c.emp]); const em = /^(\d+)\s+(.+)$/.exec(empRaw);
      const ks = parseFloat(String(row[c.ks]).replace(',', '.'));
      rows.push([date, isoWeekOf(date), em ? em[1] : '', em ? em[2].trim() : empRaw, isFinite(ks) ? ks : 0,
        S(row[c.n1]), c.zak >= 0 ? S(row[c.zak]) : '', c.cvz >= 0 ? S(row[c.cvz]) : '', c.op >= 0 ? S(row[c.op]) : '',
        c.pozn >= 0 ? S(row[c.pozn]) : '', c.aut >= 0 ? S(row[c.aut]) : '']);
    }
    return { rows, header: H };
  }
  const R = { date: 0, week: 1, id: 2, name: 3, ks: 4, dil: 5, zak: 6, cvz: 7, op: 8, pozn: 9, aut: 10 };
  const dateOfName = nm => { const m = /(\d{4})[-.]?(\d{2})[-.]?(\d{2})/.exec(nm || ''); return m ? m[1] + '-' + m[2] + '-' + m[3] : ''; };

  // Nejnovější export závodu ze složky (dle data v názvu, pak createdTime) → data/vykonnost-<key>.json
  async function syncZavod(z, force) {
    const st = loadState(); st.zavody = st.zavody || {}; const zs = st.zavody[z.key] || {};
    const files = (await drive.listFolder(z.folder)).filter(f => /\.xlsx$/i.test(f.name || '') || /spreadsheetml/.test(f.mimeType || ''));
    if (!files.length) { zs.error = 'Ve složce nejsou .xlsx exporty.'; st.zavody[z.key] = zs; saveState(st); return { ok: false, error: zs.error }; }
    files.sort((a, b) => dateOfName(b.name).localeCompare(dateOfName(a.name)) || String(b.createdTime || '').localeCompare(String(a.createdTime || '')));
    const newest = files[0];
    if (!force && zs.fileId === newest.id) { zs.checkedAt = new Date().toISOString(); st.zavody[z.key] = zs; saveState(st); return { ok: true, skipped: true, file: newest.name }; }
    const dl = await drive.downloadFileBase64(newest.id, 40 * 1024 * 1024);
    const p = parseExport(Buffer.from(dl.base64, 'base64'));
    if (!p.rows.length) { zs.error = 'Soubor ' + newest.name + ': ' + (p.warn || 'bez řádků'); st.zavody[z.key] = zs; saveState(st); return { ok: false, error: zs.error }; }
    const snapshot = dateOfName(newest.name) || new Date().toISOString().slice(0, 10);
    fs.writeFileSync(DATA_F(z.key), JSON.stringify({ zavod: z.key, source: newest.name, snapshot, syncedAt: new Date().toISOString(), rows: p.rows }));
    Object.assign(zs, { fileId: newest.id, file: newest.name, snapshot, rows: p.rows.length, syncedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), error: '' });
    st.zavody[z.key] = zs; saveState(st);
    console.log('[vykonnost] ' + z.name + ': ' + newest.name + ' → ' + p.rows.length + ' řádků');
    return { ok: true, file: newest.name, rows: p.rows.length };
  }
  async function sync(force) {
    if (!drive || !drive.configured()) return { ok: false, error: 'Service account (GOOGLE_SA_*) není nastavený.' };
    const out = {};
    for (const z of ZAVODY) { try { out[z.key] = await syncZavod(z, force); } catch (e) { out[z.key] = { ok: false, error: e.message }; const st = loadState(); st.zavody = st.zavody || {}; st.zavody[z.key] = Object.assign(st.zavody[z.key] || {}, { error: e.message }); saveState(st); console.warn('[vykonnost] ' + z.name + ' sync:', e.message); } }
    return { ok: true, zavody: out };
  }

  // ---------- plány výroby (Google Sheets) ----------
  // Hledá list dle regexu, hlavičku (řádek s „ČVZ" nebo „Výrobek") a sloupce regexem. ČVZ rozdělené
  // do dvou sloupců (Abroly: „26B" | „594") se skládá dohromady. Fáze = sloupce Dělírna/Svařovna/… s „x".
  function parsePlanValues(values) {
    // Řádek se skutečnými názvy sloupců = ten s „Výrobek" (Abroly má ČVZ o řádek výš ve skupinové hlavičce); jinak řádek s ČVZ.
    let hi = -1;
    for (let i = 0; i < Math.min(values.length, 8); i++) { const r = values[i] || []; if (r.some(c => /^výrobek$|^vyrobek$/i.test(String(c || '').trim()))) { hi = i; break; } }
    if (hi < 0) for (let i = 0; i < Math.min(values.length, 8); i++) { const r = values[i] || []; if (r.some(c => /čvz|cvz/i.test(String(c || '').trim()))) { hi = i; break; } }
    if (hi < 0) return { items: {}, warn: 'hlavička s ČVZ/Výrobek nenalezena' };
    const H = (values[hi] || []).map(x => String(x == null ? '' : x).trim());
    const H0 = hi > 0 ? (values[hi - 1] || []).map(x => String(x == null ? '' : x).trim()) : [];
    const idx = re => H.findIndex(h => re.test(h));
    const c = { cvz: idx(/čvz|cvz/i), vyr: idx(/^výrobek|^vyrobek|produkt/i), ks: idx(/^ks$|^kusy$|množstv|mnozstv/i), ral: idx(/^ral/i),
      zak: idx(/zákazník|zakaznik|customer|odběratel|odberatel/i), termin: idx(/termín|termin|požadov|pozadov/i), skut: idx(/skutečn|skutecn/i), exp: idx(/^exp\.?$|expedice/i), kontakt: idx(/kontakt|obchodník|obchodnik/i) };
    // Abroly: hlavička 1. řádku má „M" a „ČVZ" nad sloupci A/B, 2. řádek prázdný v A/B
    let cvzPrefixCol = -1;
    if (c.cvz < 0 && H0.length) { const i0 = H0.findIndex(h => /čvz|cvz/i.test(h)); if (i0 >= 0) { c.cvz = i0; if (i0 > 0 && /^m$/i.test(H0[i0 - 1])) cvzPrefixCol = i0 - 1; } }
    if (c.cvz < 0) return { items: {}, warn: 'sloupec ČVZ nenalezen (hlavička: ' + H.filter(Boolean).slice(0, 10).join(' | ') + ')' };
    const faze = []; [H, H0].forEach(HH => HH.forEach((h, i) => { if (/^(dělírna|delirna|svařovna|svarovna|kontrola|lakovna|expedice|příprava|priprava|skládání|skladani|montáž|montaz)/i.test(h) && !faze.some(f => f.i === i)) faze.push({ i, n: h }); }));
    const items = {};
    for (let r = hi + 1; r < values.length; r++) {
      const row = values[r] || []; let cvz = String(row[c.cvz] == null ? '' : row[c.cvz]).trim();
      if (!cvz) continue;
      if (cvzPrefixCol >= 0) { const pre = String(row[cvzPrefixCol] || '').trim(); if (/^\d{2}[A-Z]$/i.test(pre) && /^\d+[A-Z]?$/i.test(cvz)) cvz = pre.toUpperCase() + cvz.padStart(3, '0'); else if (!/^\d{2}[A-Z]/i.test(cvz)) continue; }
      cvz = cvz.toUpperCase().replace(/[\s-]/g, '');
      const S = i => i >= 0 ? String(row[i] == null ? '' : row[i]).trim() : '';
      const ks = parseFloat(String(S(c.ks)).replace(',', '.'));
      items[cvz] = { vyrobek: S(c.vyr), ks: isFinite(ks) ? ks : null, ral: S(c.ral), zakaznik: S(c.zak), termin: S(c.termin), skutecny: S(c.skut), exp: S(c.exp), kontakt: S(c.kontakt),
        faze: faze.map(f => ({ n: f.n, ok: !!String(row[f.i] == null ? '' : row[f.i]).trim() })), row: r + 1 };  // row = číslo řádku v tabulce (1-based)
    }
    // hlavička pro zobrazení celého řádku: kde je 2. řádek prázdný, doplní se skupinový název z 1. řádku
    const labels = H.map((h, i) => h || H0[i] || '');
    return { items, header: H, labels, faze: faze.map(f => f.n) };
  }
  async function syncPlan(z) {
    if (!host.sheetsGet || !z.plan || !z.plan.sheetId) return { ok: false, error: 'plán není nastaven' };
    let tab = '', gid = null;
    try {
      const tabs = host.sheetsTabs ? await host.sheetsTabs(z.plan.sheetId) : (host.sheetsMeta ? (await host.sheetsMeta(z.plan.sheetId) || []).map(t => ({ title: t, gid: null })) : []);
      const hit = (tabs || []).find(t => z.plan.tabRe.test(String(t.title))) || (tabs || [])[0];
      if (hit) { tab = hit.title; gid = hit.gid; }
    } catch (e) { return { ok: false, error: 'listy: ' + e.message }; }
    const range = (tab ? "'" + tab.replace(/'/g, "''") + "'!" : '') + 'A1:AZ5000';
    const r = await host.sheetsGet(z.plan.sheetId, range);
    const p = parsePlanValues((r && r.values) || []);
    const n = Object.keys(p.items).length;
    if (!n) return { ok: false, error: 'list „' + tab + '": ' + (p.warn || 'žádné zakázky') };
    fs.writeFileSync(PLAN_F(z.key), JSON.stringify({ zavod: z.key, sheetId: z.plan.sheetId, tab, gid, syncedAt: new Date().toISOString(), faze: p.faze, header: p.header, labels: p.labels, items: p.items }));
    return { ok: true, tab, items: n };
  }
  async function syncPlans() {
    const st = loadState(); st.plany = st.plany || {};
    for (const z of ZAVODY) { try { const r = await syncPlan(z); st.plany[z.key] = Object.assign({}, r, { at: new Date().toISOString() }); } catch (e) { st.plany[z.key] = { ok: false, error: e.message, at: new Date().toISOString() }; } }
    saveState(st); return st.plany;
  }

  // ---------- statistiky ----------
  function inRange(d, od, do_) { return (!od || d >= od) && (!do_ || d <= do_); }
  const top = (m, n, key) => Object.values(m).sort((a, b) => b[key] - a[key]).slice(0, n);
  function statsZavod(z, od, do_) {
    const D = loadData(z.key); if (!D) return null;
    const snapshot = D.snapshot || '';
    const all = D.rows.filter(r => r[R.date] <= (snapshot || '9999')); // překlepy do budoucna pryč
    const future = D.rows.length - all.length;
    // týdenní řada za celý rok (nezávisle na filtru)
    const weeks = {};
    all.forEach(r => { const w = weeks[r[R.week]] = weeks[r[R.week]] || { week: r[R.week], rows: 0, ks: 0, rezieH: 0, lide: new Set(), cvz: new Set() }; w.rows++; if (isRezie(r[R.dil])) w.rezieH += r[R.ks]; else w.ks += r[R.ks]; w.lide.add(r[R.id] || r[R.name]); if (r[R.cvz]) w.cvz.add(r[R.cvz]); });
    const tydny = Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week)).map(w => ({ week: w.week, rows: w.rows, ks: Math.round(w.ks), rezieH: Math.round(w.rezieH), lide: w.lide.size, cvz: w.cvz.size }));
    const mesice = [...new Set(all.map(r => r[R.date].slice(0, 7)))].sort();
    // filtrované období
    const rows = all.filter(r => inRange(r[R.date], od, do_));
    const lide = {}, ops = {}, cvzs = {}, dny = {}, rezKat = {}, rezPol = {}, autori = {};
    let ks = 0, rezieH = 0, rezRows = 0, term = 0, nulKs = 0, bezCvz = 0, bezJmena = 0;
    rows.forEach(r => {
      const rez = isRezie(r[R.dil]); const day = r[R.date];
      const key = r[R.id] || r[R.name];
      const L = lide[key] = lide[key] || { id: r[R.id], name: r[R.name], rows: 0, ks: 0, rezieH: 0, dnySet: new Set(), opsSet: new Set(), term: 0, last: '', first: '', perDay: {}, opCount: {} };
      L.rows++; L.dnySet.add(day); L.opsSet.add(r[R.op]); L.perDay[day] = (L.perDay[day] || 0) + 1; if (r[R.aut] === 'terminalETH') L.term++;
      if (!L.last || day > L.last) L.last = day; if (!L.first || day < L.first) L.first = day;
      if (rez) { L.rezieH += r[R.ks]; rezieH += r[R.ks]; rezRows++; const kat = kategorieRezie(r[R.dil] + ' ' + r[R.pozn]); rezKat[kat] = rezKat[kat] || { kat, h: 0, rows: 0, lide: new Set() }; rezKat[kat].h += r[R.ks]; rezKat[kat].rows++; rezKat[kat].lide.add(r[R.name]);
        const pk = (r[R.pozn] || r[R.dil]).slice(0, 80); rezPol[pk] = rezPol[pk] || { text: pk, h: 0, rows: 0, lide: new Set() }; rezPol[pk].h += r[R.ks]; rezPol[pk].rows++; rezPol[pk].lide.add(r[R.name]); }
      else { L.ks += r[R.ks]; ks += r[R.ks]; L.opCount[r[R.op]] = (L.opCount[r[R.op]] || 0) + 1; }
      if (r[R.aut] === 'terminalETH') term++; autori[r[R.aut] || '—'] = (autori[r[R.aut] || '—'] || 0) + 1;
      if (!rez && r[R.ks] === 0) nulKs++; if (!r[R.cvz]) bezCvz++; if (!r[R.id]) bezJmena++;
      dny[day] = dny[day] || { date: day, rows: 0, ks: 0, rezieH: 0 }; dny[day].rows++; if (rez) dny[day].rezieH += r[R.ks]; else dny[day].ks += r[R.ks];
      if (!rez) { const O = ops[r[R.op]] = ops[r[R.op]] || { op: r[R.op], rows: 0, ks: 0, lide: new Set() }; O.rows++; O.ks += r[R.ks]; O.lide.add(r[R.name]); }
      if (r[R.cvz]) { const C = cvzs[r[R.cvz]] = cvzs[r[R.cvz]] || { cvz: r[R.cvz], zak: r[R.zak], rows: 0, ks: 0, rezieH: 0, lide: new Set(), ops: new Set(), first: day, last: day }; C.rows++; if (rez) C.rezieH += r[R.ks]; else C.ks += r[R.ks]; C.lide.add(r[R.name]); C.ops.add(r[R.op]); if (day < C.first) C.first = day; if (day > C.last) C.last = day; if (!C.zak && r[R.zak]) C.zak = r[R.zak]; }
    });
    const dnyArr = Object.values(dny).sort((a, b) => a.date.localeCompare(b.date));
    const topDny = dnyArr.slice().sort((a, b) => b.rows - a.rows).slice(0, 3);
    const patek = rows.filter(r => new Date(r[R.date] + 'T00:00:00Z').getUTCDay() === 5).length;
    const lideArr = Object.values(lide).map(L => { const maxDay = Math.max(0, ...Object.values(L.perDay)); const topOp = Object.entries(L.opCount).sort((a, b) => b[1] - a[1])[0];
      return { id: L.id, name: L.name, rows: L.rows, ks: Math.round(L.ks), rezieH: Math.round(L.rezieH), dny: L.dnySet.size, ops: L.opsSet.size, termPct: L.rows ? Math.round(L.term / L.rows * 100) : 0, last: L.last, first: L.first, davkaPct: L.rows ? Math.round(maxDay / L.rows * 100) : 0, reziePct: (L.rows ? Math.round(L.rezieH > 0 ? (L.rezieH / (L.rezieH + Math.max(1, L.ks))) * 100 : 0) : 0), topOp: topOp ? topOp[0] : '' }; })
      .sort((a, b) => b.rows - a.rows);
    // párování na plán
    const plan = loadPlan(z.key); const P = (plan && plan.items) || {};
    const planUrl = row => plan && plan.sheetId ? 'https://docs.google.com/spreadsheets/d/' + plan.sheetId + '/edit#gid=' + (plan.gid != null ? plan.gid : 0) + (row ? '&range=A' + row + ':AZ' + row : '') : '';
    const cvzArr = Object.values(cvzs).map(C => { const p = P[C.cvz]; return { cvz: C.cvz, zak: C.zak, rows: C.rows, ks: Math.round(C.ks), rezieH: Math.round(C.rezieH), lide: C.lide.size, ops: C.ops.size, first: C.first, last: C.last, plan: p ? { vyrobek: p.vyrobek, ks: p.ks, zakaznik: p.zakaznik, termin: p.termin, skutecny: p.skutecny, exp: p.exp, faze: p.faze, row: p.row, url: planUrl(p.row) } : null }; })
      .sort((a, b) => b.rows - a.rows);
    const sparovano = cvzArr.filter(c => c.plan).length;
    return {
      zavod: z.key, name: z.name, snapshot, source: D.source, syncedAt: D.syncedAt, od: od || '', do: do_ || '', mesice, tydny,
      kpi: { rows: rows.length, ks: Math.round(ks), rezieH: Math.round(rezieH), rezRows, reziePodil: rows.length ? Math.round(rezRows / rows.length * 100) : 0, lide: lideArr.length, ops: Object.keys(ops).length, cvz: cvzArr.length,
        termPct: rows.length ? Math.round(term / rows.length * 100) : 0, dnu: dnyArr.length, top3Pct: rows.length ? Math.round(topDny.reduce((s, d) => s + d.rows, 0) / rows.length * 100) : 0, patekPct: rows.length ? Math.round(patek / rows.length * 100) : 0 },
      dny: dnyArr.map(d => ({ date: d.date, rows: d.rows, ks: Math.round(d.ks), rezieH: Math.round(d.rezieH) })),
      lide: lideArr, operace: top(ops, 25, 'rows').map(o => ({ op: o.op, rows: o.rows, ks: Math.round(o.ks), lide: o.lide.size })),
      rezie: { kategorie: Object.values(rezKat).sort((a, b) => b.h - a.h).map(k => ({ kat: k.kat, h: Math.round(k.h), rows: k.rows, lide: k.lide.size })), polozky: Object.values(rezPol).sort((a, b) => b.h - a.h).slice(0, 15).map(p => ({ text: p.text, h: Math.round(p.h), rows: p.rows, lide: [...p.lide].slice(0, 4) })) },
      cvz: cvzArr.slice(0, 200), sparovano, autori: Object.entries(autori).sort((a, b) => b[1] - a[1]).map(([a, n]) => ({ autor: a, rows: n })),
      kvalita: { future, nulKs, bezCvz, bezJmena },
      plan: plan ? { tab: plan.tab, items: Object.keys(P).length, syncedAt: plan.syncedAt, faze: plan.faze || [], url: planUrl(0) } : null
    };
  }
  // Přehled všech závodů (poslední 4 týdny do snímku + celý rok)
  function overview() {
    const st = loadState();
    return ZAVODY.map(z => {
      const D = loadData(z.key); const zs = (st.zavody || {})[z.key] || {}; const pl = (st.plany || {})[z.key] || null;
      if (!D) return { key: z.key, name: z.name, kratce: z.kratce, data: false, error: zs.error || 'zatím nesynchronizováno', plan: pl };
      const snap = D.snapshot; const od = new Date(snap + 'T00:00:00Z'); od.setUTCDate(od.getUTCDate() - 27); const od4 = od.toISOString().slice(0, 10);
      const all = D.rows.filter(r => r[R.date] <= snap); const last4 = all.filter(r => r[R.date] >= od4);
      const agg = rs => { let ks = 0, rez = 0, term = 0; const l = new Set(), c = new Set(); rs.forEach(r => { if (isRezie(r[R.dil])) rez += r[R.ks]; else ks += r[R.ks]; if (r[R.aut] === 'terminalETH') term++; l.add(r[R.id] || r[R.name]); if (r[R.cvz]) c.add(r[R.cvz]); }); return { rows: rs.length, ks: Math.round(ks), rezieH: Math.round(rez), lide: l.size, cvz: c.size, termPct: rs.length ? Math.round(term / rs.length * 100) : 0 }; };
      const tyd = {}; last4.forEach(r => { tyd[r[R.week]] = (tyd[r[R.week]] || 0) + 1; });
      return { key: z.key, name: z.name, kratce: z.kratce, data: true, snapshot: snap, source: D.source, syncedAt: D.syncedAt, error: zs.error || '', rok: agg(all), t4: agg(last4), od4, tydny4: Object.entries(tyd).sort((a, b) => a[0].localeCompare(b[0])).map(([w, n]) => ({ week: w, rows: n })), plan: pl };
    });
  }

  // ---------- plánovač ----------
  let lastPlanAt = 0;
  async function tick() {
    try { const s = await sync(false); if (s && !s.ok) console.warn('[vykonnost] sync:', s.error); } catch (e) { console.error('[vykonnost] sync:', e.message); }
    if (Date.now() - lastPlanAt > 6 * 3600 * 1000) { lastPlanAt = Date.now(); try { await syncPlans(); } catch (e) { console.warn('[vykonnost] plány:', e.message); } }
  }

  // ---------- router ----------
  const hasAccess = req => { if (host.isAdmin(req)) return true; try { const e = host.empSession(req); return !!(e && host.employeeModules(e.email).indexOf('vykonnost') >= 0); } catch (_) { return false; } };
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true), p = u.pathname;
    if (!p.startsWith('/api/vykonnost')) return false;
    if (!hasAccess(req)) { json(res, 403, { error: 'K modulu Výkonnost středisek nemáte přístup.' }); return true; }
    if (p === '/api/vykonnost' && req.method === 'GET') { json(res, 200, { zavody: overview(), admin: !!host.isAdmin(req), driveConfigured: !!(drive && drive.configured()), saEmail: drive && drive.saEmail ? drive.saEmail() : '' }); return true; }
    const m = /^\/api\/vykonnost\/zavod\/([a-z]+)$/.exec(p);
    if (m && req.method === 'GET') {
      const z = zavodOf(m[1]); if (!z) { json(res, 404, { error: 'Neznámý závod.' }); return true; }
      const s = statsZavod(z, parseAnyDate(u.query.od) || '', parseAnyDate(u.query.do) || '');
      if (!s) { json(res, 200, { zavod: z.key, name: z.name, data: false, error: ((loadState().zavody || {})[z.key] || {}).error || 'Zatím nesynchronizováno — server si export stáhne při nejbližší hodinové kontrole.' }); return true; }
      json(res, 200, Object.assign({ data: true }, s)); return true;
    }
    // Živé načtení řádku zakázky z Google tabulky (plán výroby) — čerstvé hodnoty všech sloupců.
    const mp = /^\/api\/vykonnost\/plan\/([a-z]+)\/([A-Za-z0-9]+)$/.exec(p);
    if (mp && req.method === 'GET') {
      const z = zavodOf(mp[1]); const plan = z && loadPlan(z.key); const cvz = String(mp[2]).toUpperCase();
      if (!z || !plan) { json(res, 404, { error: 'Plán výroby pro tento závod není načten.' }); return true; }
      const it = plan.items[cvz]; if (!it) { json(res, 404, { error: 'Zakázka ' + cvz + ' v plánu není.' }); return true; }
      const labels = plan.labels || plan.header || [];
      const url = 'https://docs.google.com/spreadsheets/d/' + plan.sheetId + '/edit#gid=' + (plan.gid != null ? plan.gid : 0) + '&range=A' + it.row + ':AZ' + it.row;
      let values = null, live = false, warn = '';
      try { if (host.sheetsGet && it.row) { const rg = "'" + String(plan.tab).replace(/'/g, "''") + "'!A" + it.row + ':AZ' + it.row; const r = await host.sheetsGet(plan.sheetId, rg); values = ((r && r.values) || [])[0] || null; live = !!values; } }
      catch (e) { warn = 'Živé načtení selhalo (' + e.message + ') — zobrazeny hodnoty z posledního syncu.'; }
      const pole = labels.map((l, i) => ({ label: l, value: values ? String(values[i] == null ? '' : values[i]) : '' })).filter(x => x.label || x.value);
      json(res, 200, { cvz, zavod: z.key, tab: plan.tab, row: it.row, url, live, warn, syncedAt: plan.syncedAt, pole: live ? pole : null, item: it });
      return true;
    }
    if (!host.isAdmin(req)) { json(res, 403, { error: 'Jen pro správce.' }); return true; }
    if (p === '/api/vykonnost/sync' && req.method === 'POST') {
      try { const r = await sync(true); let pl = null; try { pl = await syncPlans(); } catch (e) { pl = { error: e.message }; } return json(res, r.ok ? 200 : 500, Object.assign(r, { plany: pl })), true; }
      catch (e) { return json(res, 500, { ok: false, error: e.message }), true; }
    }
    if (p === '/api/vykonnost/stav' && req.method === 'GET') { return json(res, 200, { state: loadState(), zavody: ZAVODY.map(z => ({ key: z.key, name: z.name, folder: z.folder, plan: z.plan && z.plan.sheetId })) }), true; }
    json(res, 404, { error: 'Not found' }); return true;
  }

  return { handle, tick, sync: () => sync(false), syncPlans, parseExport, parsePlanValues, ZAVODY };
}

module.exports = { mount };

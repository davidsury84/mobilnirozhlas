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

  // ---------- automatická analýza (vzor: ruční analýza Chomutov 08/2026) ----------
  // Bez Kč: měříme řádky, kusy, hodiny režie, dávkovost, terminál. Každé zjištění má štítek
  // crit / warn / good / info a je podložené číslem z dat; doporučení jen tam, kde má smysl.
  const fmt0 = n => Math.round(+n || 0).toLocaleString('cs-CZ');
  const jm = (arr, n) => arr.slice(0, n || 4).join(', ') + (arr.length > (n || 4) ? ' a další' : '');
  const lidi = n => n === 1 ? '1 člověk' : (n >= 2 && n <= 4 ? n + ' lidé' : n + ' lidí');
  const ma = n => (n >= 2 && n <= 4) ? 'mají' : 'má';            // 1 člověk má · 3 lidé mají · 7 lidí má
  const odvadeli = n => n === 1 ? 'odváděl' : ((n >= 2 && n <= 4) ? 'odváděli' : 'odvádělo');
  // Zjištění, která vyžadují data mimo export (časová mzda, Kč úkolu) — z ruční analýzy, zobrazují se jako označená reference,
  // dokud nebude v exportu Mzda/Cena a k dispozici hrubé mzdy (pak se přepočítají automaticky).
  const REFERENCE = {
    chomutov: { obdobi: 'srpen 2026', zdroj: 'ruční analýza s mzdovým přehledem (Chomutov 08-2026.xlsx, list CH 08-26)',
      titul: 'Režie funguje jako dorovnání časové mzdy, ne jako evidence víceprací.',
      text: 'U 13 dělníků, kteří mají obě čísla (bez Salazara), chybí mezi časovou mzdou a skutečným úkolem 254 tis. Kč. Režijní hodiny (210 Kč/h, zapisuje mistr Archman jednou týdně, typicky v pátek) tuto díru vyplňují téměř přesně: korelace 0,87. Čím méně někdo odvede v úkolu, tím více má režie (korelace −0,70). Odpípaný úkol tedy neměří výkon, ale zpětně kopíruje výplatu.' }
  };
  const pearson = (xs, ys) => { const n = xs.length; if (n < 5) return null; const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; } return sxx && syy ? Math.round(sxy / Math.sqrt(sxx * syy) * 100) / 100 : null; };
  function buildAnalyza(X) {
    const Z = [], U = [], V = [], D = [];
    const kap = X.pracDnu * 8; // hodiny jednoho úvazku v období
    const uvazky = kap ? X.rezieH / kap : 0;
    const rezPct = X.rows ? Math.round(X.rezRows / X.rows * 100) : 0;
    const termPct = X.rows ? Math.round(X.term / X.rows * 100) : 0;
    const top3 = X.rows ? Math.round(X.topDny.reduce((s, d) => s + d.rows, 0) / X.rows * 100) : 0;
    const patekPct = X.rows ? Math.round(X.patek / X.rows * 100) : 0;
    const bezNormy = X.rezKat.find(k => k.kat === 'Ostatní / bez normy'), poruchy = X.rezKat.find(k => k.kat === 'Poruchy a údržba'), stehov = X.rezKat.find(k => k.kat === 'Stěhování a manipulace'), viceprace = X.rezKat.find(k => k.kat === 'Vícepráce a opravy'), uklid = X.rezKat.find(k => k.kat === 'Úklid a čištění');
    const topPol = X.rezPol[0];
    if (!X.rows) return { zjisteni: [{ tag: 'info', titul: 'V období nejsou žádné odvedené operace.', text: 'Zvolte jiné období nebo počkejte na další snímek exportu.' }], uzka: [], vycnivaji: [], doporuceni: [], shrnuti: '' };
    // --- zjištění ---
    if (X.rezieH > 0) Z.push({ tag: uvazky >= 3 ? 'crit' : (uvazky >= 1 || rezPct >= 10 ? 'warn' : 'info'), titul: 'Režie: ' + fmt0(X.rezieH) + ' h zapsaných jako úkol, to je zhruba ' + (uvazky >= 1 ? uvazky.toFixed(1).replace('.', ',') + ' plných úvazků' : Math.round(uvazky * 100) + ' % úvazku') + ' za období.',
      text: 'Režijní položky tvoří ' + rezPct + ' % řádků. Největší příčina: ' + (X.rezKat[0] ? X.rezKat[0].kat.toLowerCase() + ' (' + fmt0(X.rezKat[0].h) + ' h)' : '—') + (topPol ? '; nejdražší jednotlivá položka „' + topPol.text + '" ' + fmt0(topPol.h) + ' h (' + jm([...topPol.lide], 3) + ')' : '') + '. Režie neměří výkon — dorovnává čas, který se nevešel do normy.' });
    else Z.push({ tag: 'good', titul: 'V období není zapsaná žádná režie.', text: 'Všechny řádky jsou skutečné operace.' });
    // Úkol vs. režie po lidech (bez koncentrátora odvádění): záporná korelace = režie doplňuje chybějící úkol.
    let korelace = null;
    if (X.rezieH > 0) {
      const lid = X.lideArr.filter(L => X.rows < 50 || L.rows / X.rows < 0.25); const sRez = lid.filter(L => L.rezieH > 0);
      const r = pearson(lid.map(L => L.prodRows), lid.map(L => L.rezieH)), r2 = pearson(sRez.map(L => L.prodRows), sRez.map(L => L.rezieH));
      const zap = X.rezZapis || { autori: [], dny: [] }; const a0 = zap.autori[0], d0 = zap.dny[0];
      korelace = { r, r2, n: lid.length, nRez: sRez.length, autor: a0 ? a0.autor : '', autorPct: a0 ? a0.pct : 0, den: d0 ? d0.den : '', denPct: d0 ? d0.pct : 0 };
      const rr = r2 != null ? r2 : r; const silna = rr != null && rr <= -0.5, kladna = rr != null && rr >= 0.5; const rs = rr == null ? '' : (rr > 0 ? '+' : '') + String(rr).replace('.', ',');
      Z.push({ tag: silna ? 'crit' : 'info', titul: rr == null ? 'Vztah úkol ↔ režie po lidech nejde z období spočítat (málo lidí s oběma čísly).' : (silna ? 'Režie doplňuje chybějící úkol: čím méně kdo odvede, tím víc má režie (korelace ' + rs + ').' : (kladna ? 'Režie roste s výkonem (korelace ' + rs + ') — režijní položky jsou tu součást běžné práce, ne dorovnání.' : 'Vztah úkol ↔ režie po lidech je v tomto období slabý (korelace ' + rs + ').')),
        text: (a0 ? 'Režii zapisuje ' + (a0.autor === 'terminál' ? 'terminál' : a0.autor) + ' (' + a0.pct + ' % řádků)' + (d0 ? ', nejčastěji ' + d0.den + ' (' + d0.pct + ' %)' : '') + '. ' : '') + 'Počítáno z odvedených operací u ' + sRez.length + ' lidí s režií' + (r != null ? ' (všech ' + lid.length + ' lidí: ' + String(r).replace('.', ',') + ')' : '') + '. Skutečný test — zda režie dorovnává rozdíl mezi časovou mzdou a úkolem v Kč — vyžaduje cenu operací a mzdový přehled, které v exportu nejsou.', korelace: true });
    }
    const refZ = REFERENCE[X.key]; if (refZ) Z.push({ tag: 'crit', titul: refZ.titul, text: refZ.text, ref: true, zdroj: refZ.zdroj + ' · ' + refZ.obdobi + ' · přepočítá se automaticky, až budou v exportu Mzda/Cena a k dispozici hrubé mzdy' });
    if (top3 >= 35 || patekPct >= 30) Z.push({ tag: top3 >= 45 ? 'crit' : 'warn', titul: 'Odvádí se po dávkách, ne průběžně: ' + top3 + ' % řádků vzniklo ve 3 dnech' + (patekPct >= 25 ? ', ' + patekPct + ' % v pátek' : '') + '.',
      text: 'Špičky: ' + X.topDny.map(d => d.date.split('-').reverse().join('. ') + ' (' + d.rows + ')').join(', ') + '. Z dat pak nejde zjistit, kdy se co skutečně dělalo ani jak dlouho to trvalo.' + (X.dvojice.length ? ' Dvojice se zápisy identické do řádku: ' + X.dvojice.map(p => p[0] + ' – ' + p[1]).join('; ') + ' — odvádí se sdíleně.' : '') });
    else Z.push({ tag: 'good', titul: 'Odvádění je rozložené v čase (3 nejsilnější dny = ' + top3 + ' % řádků).', text: 'Odvedené operace zhruba kopírují rytmus výroby.' });
    const rucni = X.autori.filter(a => a[0] !== 'terminalETH' && a[0] !== '—');
    if (termPct < 80) Z.push({ tag: termPct < 50 ? 'crit' : 'warn', titul: (100 - termPct) + ' % řádků zapsal mistr ručně, ne terminál.', text: 'Ručně zadávají: ' + rucni.slice(0, 4).map(a => a[0] + ' (' + fmt0(a[1]) + ')').join(', ') + '. Ruční zápis = odvádění po dávkách a bez skutečného času; typicky pracoviště bez terminálu.' });
    else Z.push({ tag: 'good', titul: termPct + ' % řádků jde z terminálu.', text: rucni.length ? 'Ručně jen ' + rucni.slice(0, 3).map(a => a[0] + ' (' + fmt0(a[1]) + ')').join(', ') + '.' : 'Vše z terminálu.' });
    const konc = X.lideArr[0]; if (konc && X.rows >= 50 && konc.rows / X.rows >= 0.25) Z.push({ tag: 'warn', titul: konc.name + ' má na sobě ' + Math.round(konc.rows / X.rows * 100) + ' % všech řádků (' + fmt0(konc.rows) + ', ' + konc.ops + ' různých operací).', text: 'Pravděpodobně odvádí kolektivně za celé pracoviště. Číslo nevypovídá o něm, ale o tom, že ostatní jsou v datech neviditelní.' });
    if (X.bezOdvadeni.length) Z.push({ tag: X.bezOdvadeni.length >= 0.3 * (X.bezOdvadeni.length + X.lideArr.length) ? 'crit' : 'warn', titul: lidi(X.bezOdvadeni.length) + ' v roce ' + odvadeli(X.bezOdvadeni.length) + ', v tomto období nic.', text: jm(X.bezOdvadeni.map(b => b.name + ' (naposledy ' + b.last.split('-').reverse().join('. ') + ')'), 6) + '. Buď mimo (dovolená, nemoc, odchod), nebo pracují bez odvádění — v obou případech u nich chybí vazba na výstup.' });
    const rezLide = X.lideArr.filter(L => L.reziePct >= 50 && L.rezieH >= 16); if (rezLide.length) Z.push({ tag: rezLide.length >= 3 ? 'crit' : 'warn', titul: lidi(rezLide.length) + ' ' + ma(rezLide.length) + ' výkon z poloviny a více v režii.', text: jm(rezLide.map(L => L.name + ' (' + fmt0(L.rezieH) + ' h)'), 5) + '. Buď dělají práci bez normy, nebo režie dorovnává časovou mzdu.' });
    if (bezNormy && bezNormy.h >= 40) Z.push({ tag: 'warn', titul: 'Výroba bez normy: ' + fmt0(bezNormy.h) + ' h běžné práce končí v režii.', text: jm(X.rezPol.filter(p => kategorieRezie(p.text) === 'Ostatní / bez normy').map(p => p.text + ' (' + fmt0(p.h) + ' h, ' + jm([...p.lide], 2) + ')'), 3) + '. Operace, které by měly mít úkolovou cenu.' });
    if (X.nulKs >= 20) Z.push({ tag: 'warn', titul: fmt0(X.nulKs) + ' výrobních řádků s nulou kusů.', text: 'Nejčastěji: ' + X.nulTop.map(o => o.op + ' (' + o.n + ')').join(', ') + '. Práce je zapsaná, ale bez množství — pro normu i pro výkon neviditelná.' });
    if (X.jediny.length) Z.push({ tag: 'info', titul: 'Operace, které odvádí jediný člověk: ' + X.jediny.length + '.', text: X.jediny.slice(0, 3).map(j => j.op + ' — ' + j.name + ' (' + j.rows + ' ř., ' + fmt0(j.ks) + ' ks)').join('; ') + '. Pokud vypadne, zastaví se navazující pracoviště.' });
    const bezCvzPct = X.rows ? Math.round(X.bezCvz / X.rows * 100) : 0; if (bezCvzPct >= 5) Z.push({ tag: 'info', titul: bezCvzPct + ' % řádků bez ČVZ.', text: fmt0(X.bezCvz) + ' řádků nejde přiřadit k zakázce — párování s plánem výroby je o to slabší.' });
    if (X.future) Z.push({ tag: 'info', titul: fmt0(X.future) + ' řádků má datum po datu snímku.', text: 'Překlepy v datu při ručním zápisu; v přehledu jsou vynechané.' });
    // --- úzká hrdla (režie podle položky) ---
    const signal = kat => ({ 'Vícepráce a opravy': 'Opakovaná vada nebo chybějící norma — pokud se opakuje každý týden, je to procesní problém, ne jednorázová oprava.', 'Úklid a čištění': 'Čas placený z výkonu lidí místo plánované údržby mimo směnu.', 'Poruchy a údržba': 'Zařízení bere kapacitu — preventivní údržba místo hašení; úzké hrdlo pro navazující pracoviště.', 'Stěhování a manipulace': 'Problém toku a layoutu (mezisklad, jeřáb, doprava), ne lidí.', 'Ostatní / bez normy': 'Běžná výrobní operace bez ceníku — patří do normy, ne do režie.' }[kat] || '');
    X.rezPol.slice(0, 10).forEach(p => { const kat = kategorieRezie(p.text); U.push({ text: p.text, kat, h: Math.round(p.h), rows: p.rows, lide: [...p.lide].slice(0, 4), naOsobu: p.lide.size ? Math.round(p.h / p.lide.size) : 0, signal: signal(kat) }); });
    // --- kdo vyčnívá ---
    const byKs = X.lideArr.filter(L => L.rows >= 10).slice().sort((a, b) => b.ks - a.ks);
    const ref = X.lideArr.filter(L => L.rows >= 15 && L.reziePct === 0 && L.termPct >= 90 && L.dny >= 5 && L.davkaPct < 50 && L.rows / X.rows < 0.2 && L.ops <= 40).sort((a, b) => b.rows - a.rows)[0];
    if (ref) V.push({ name: ref.name, tag: 'good', text: 'referenční profil — ' + fmt0(ref.rows) + ' operací v ' + ref.dny + ' dnech, bez hodiny režie, vše z terminálu. Nejčastěji ' + ref.topOp + '.' });
    if (byKs[0]) V.push({ name: byKs[0].name, tag: 'info', text: 'nejvíc kusů (' + fmt0(byKs[0].ks) + ') — ' + fmt0(byKs[0].rows) + ' operací, ' + byKs[0].ops + ' různých; těžiště ' + byKs[0].topOp + '.' });
    if (konc && konc.rows / X.rows >= 0.2 && (!byKs[0] || byKs[0].name !== konc.name)) V.push({ name: konc.name, tag: 'warn', text: fmt0(konc.rows) + ' řádků, ' + konc.ops + ' různých operací v ' + konc.dny + ' dnech — fakticky administrátor odvádění pracoviště.' });
    X.lideArr.filter(L => L.rezieH >= 40).sort((a, b) => b.rezieH - a.rezieH).slice(0, 3).forEach(L => V.push({ name: L.name, tag: L.reziePct >= 50 ? 'crit' : 'warn', text: fmt0(L.rezieH) + ' h režie (' + L.reziePct + ' % výkonu)' + (L.ks ? ', vedle toho ' + fmt0(L.ks) + ' ks v ' + fmt0(L.rows - 0) + ' řádcích' : ', v úkolu nic') + '. Čím delší režie, tím méně o jeho výkonu víme.' }));
    X.lideArr.filter(L => L.rows >= 30 && L.dny <= 3).slice(0, 3).forEach(L => V.push({ name: L.name, tag: 'warn', text: fmt0(L.rows) + ' operací zapsaných jen ve ' + L.dny + ' ' + (L.dny === 1 ? 'dni' : 'dnech') + ' (' + L.davkaPct + ' % v jediném dni) — dávkové odvádění.' }));
    X.jediny.slice(0, 2).forEach(j => { if (!V.some(v => v.name === j.name)) V.push({ name: j.name, tag: 'info', text: 'jediný, kdo odvádí „' + j.op + '" (' + j.rows + ' ř.). Bez zastupitelnosti.' }); });
    // --- co s tím ---
    let n = 0; const rec = (titul, text, efekt) => D.push({ no: String.fromCharCode(65 + n++), titul, text, efekt });
    if (X.rezieH >= 40) rec('Oddělit režii od úkolu a vyžadovat důvod z číselníku.', 'Režijní hodiny nechat zapisovat dál, ale u každé položky konkrétní důvod (porucha stroje, reklamace, chybí norma, úklid, stěhování) a nesčítat je do odvedeného úkolu. Týdenní report: kolik hodin šlo na kterou příčinu.', 'efekt: okamžitá viditelnost ' + fmt0(X.rezieH) + ' h za období · náročnost: nulová, jen rozhodnutí');
    if (bezNormy && bezNormy.h >= 40) rec('Dodělat normy na operace, které dnes končí v režii.', jm(X.rezPol.filter(p => kategorieRezie(p.text) === 'Ostatní / bez normy').map(p => p.text), 5) + (X.nulTop.length ? '. Zároveň nacenit operace s nulou kusů (' + X.nulTop.slice(0, 3).map(o => o.op).join(', ') + ').' : '.'), 'efekt: +' + fmt0(bezNormy.h) + ' h měřitelného úkolu · náročnost: technolog, ~2 týdny');
    if (viceprace && viceprace.h >= 40 && topPol && kategorieRezie(topPol.text) === 'Vícepráce a opravy') rec('Řešit „' + topPol.text + '" jako procesní vadu, ne příplatek.', fmt0(topPol.h) + ' h u ' + jm([...topPol.lide], 3) + ' — největší jednotlivá položka. Zjistit příčinu (deformace po svařování, tolerance dílů, přípravky, parametry). Pokud je to nutná součást operace, patří do normy; pokud ne, je to nejdražší symptom kvality v datech.', 'efekt: až ' + fmt0(topPol.h) + ' h za období · náročnost: technolog + mistr, týden analýzy');
    if (poruchy && poruchy.h >= 30) rec('Poruchy a údržba: preventivně místo hašení.', fmt0(poruchy.h) + ' h zapsaných na poruchy a údržbu (' + jm(X.rezPol.filter(p => kategorieRezie(p.text) === 'Poruchy a údržba').map(p => p.text), 3) + '). Plán preventivní údržby a čištění mimo směnu.', 'efekt: ' + fmt0(poruchy.h) + ' h/období + průchodnost · náročnost: údržba');
    if (uklid && uklid.h >= 60) rec('Úklid a čištění mimo výkon.', fmt0(uklid.h) + ' h úklidu placených z výkonu lidí. Plánované čištění na konci směny / mimo směnu, ne jako režijní položka výrobních dělníků.', 'efekt: ' + fmt0(uklid.h) + ' h/období · náročnost: organizace směn');
    if (stehov && stehov.h >= 30) rec('Stěhování: mezisklad a tok místo přesouvání.', fmt0(stehov.h) + ' h manipulace (' + jm(X.rezPol.filter(p => kategorieRezie(p.text) === 'Stěhování a manipulace').map(p => p.text), 3) + '). Ověřit, kde se díly skladují mezi operacemi a kdo je přesouvá — jde o layout, ne o lidi.', 'efekt: ' + fmt0(stehov.h) + ' h/období · náročnost: layout');
    if (top3 >= 35 || X.lideArr.some(L => L.rows >= 30 && L.dny <= 3) || X.dvojice.length) rec('Odvádět průběžně, po jednotlivcích.', 'Pravidlo „odvádí se týž den" a odvádění na jméno i u dvojic (nebo párové operace explicitně označit). Bez toho nikdy nepůjde spočítat skutečnou dobu operace a porovnat ji s normou.' + (konc && konc.rows / X.rows >= 0.25 ? ' Na pracovišti, kde odvádí ' + konc.name + ' za ostatní, odvádět po lidech.' : ''), 'efekt: poprvé měřitelná produktivita · náročnost: disciplína mistrů' + (termPct < 80 ? ', další terminál' : ''));
    if (termPct < 80) rec('Terminál tam, kde mistr zapisuje ručně.', rucni.slice(0, 3).map(a => a[0] + ' zadal ' + fmt0(a[1]) + ' řádků').join(', ') + '. Ruční přepis bere mistrovi čas na řízení výroby a zpožďuje data.', 'efekt: ' + fmt0(rucni.reduce((s, a) => s + a[1], 0)) + ' řádků/období bez přepisování · náročnost: terminál');
    if (X.bezOdvadeni.length || rezLide.length) rec('Vyjasnit lidi bez dat.', (X.bezOdvadeni.length ? jm(X.bezOdvadeni.map(b => b.name), 5) + ' v období neodvedli nic. ' : '') + (rezLide.length ? jm(rezLide.map(L => L.name), 4) + ' mají výkon převážně v režii. ' : '') + 'U každého: na jaké pozici skutečně pracuje a proč není v odvádění.', 'efekt: vazba mzdy na výstup u ' + (X.bezOdvadeni.length + rezLide.length) + ' lidí · náročnost: mistr, 1 den');
    if (X.jediny.length) rec('Zastupitelnost klíčových operací.', X.jediny.slice(0, 3).map(j => j.op + ' — jen ' + j.name).join('; ') + '. Zaučit druhého člověka.', 'efekt: bez výpadku při nemoci/dovolené · náročnost: zaučení');
    const shrnuti = fmt0(X.rows) + ' odvedených operací, ' + fmt0(X.ks) + ' ks, ' + fmt0(X.rezieH) + ' h režie, ' + X.lideArr.length + ' lidí' + (X.pracDnu ? ' · ' + X.pracDnu + ' pracovních dnů' : '') + '. ' + (Z.filter(z => z.tag === 'crit').length ? Z.filter(z => z.tag === 'crit').length + ' kritická zjištění.' : 'Bez kritických zjištění.');
    return { zjisteni: Z, uzka: U, vycnivaji: V.slice(0, 10), doporuceni: D, shrnuti, uvazky: Math.round(uvazky * 10) / 10, korelace };
  }

  // ---------- měsíční indikátory (legenda = jediný zdroj pravdy pro app i e-mail) ----------
  // smer: 'down' = nižší lepší, 'up' = vyšší lepší, 'watch' = jen sledovat. prah: [zelená do, žlutá do] (pro 'up' obráceně).
  // klic: true = jeden ze 6 klíčových indikátorů se semaforem v e-mailu.
  const LEGENDA = [
    { skup: 'A', nazev: 'Efektivita — kolik výkonu polyká režie', items: [
      { k: 'A1', klic: true, label: 'Režie jako % fondu pracovní doby', jedn: '%', smer: 'down', prah: [10, 20], vzorec: 'režijní hodiny ÷ (lidé s odváděním × pracovní dny × 8 h)', proc: 'Nejbližší náhrada „režie vs. mzda“ bez mzdových dat. Kolik procent odpracovaného času se zapsalo jako režie místo úkolu.' },
      { k: 'A2', label: 'Režie h na 1 000 vyrobených ks', jedn: 'h', smer: 'down', vzorec: 'režijní hodiny ÷ kusy × 1000', proc: 'Režie vztažená k výstupu. Srovnávat jen v čase v rámci závodu (kusy nejsou mezi závody stejné).' },
      { k: 'A3', label: 'Režie h na produkční operaci', jedn: 'h', smer: 'down', vzorec: 'režijní hodiny ÷ počet produkčních řádků', proc: 'Kolik režie připadá na jednu odvedenou výrobní operaci.' },
      { k: 'A4', label: 'Kusů na osobu a měsíc', jedn: 'ks', smer: 'up', vzorec: 'vyrobené kusy ÷ lidé s odváděním', proc: 'Hrubá produktivita. Pokles víc měsíců v řadě = méně výstupu na hlavu, nebo méně odvádění.' }
    ] },
    { skup: 'B', nazev: 'Struktura režie — co se v ní schovává', items: [
      { k: 'B1', klic: true, label: '% režie, která je výroba bez normy', jedn: '%', smer: 'down', prah: [25, 50], vzorec: 'hodiny v režijních operacích výrobního typu (úprava/příprava materiálu, spojování vrat, polepování, přehazování nástrojů, montáž po laku, výměna filtrů…) ÷ režijní hodiny', proc: 'Práce, která by měla mít úkolovou cenu. Každá dodělaná norma toto číslo sníží — přímé měřítko postupu.' },
      { k: 'B2', klic: true, label: '% režie nepopsané', jedn: '%', smer: 'down', prah: [20, 40], vzorec: 'hodiny v operaci „Ostatní“ nebo bez poznámky mistra ÷ režijní hodiny', proc: 'Bez důvodu se nedá nic řídit. Jediný indikátor, který se dá srazit pouhou disciplínou zápisu.' },
      { k: 'B3', label: 'Rework h na 1 000 ks', jedn: 'h', smer: 'down', prah: [0.5, 2], vzorec: 'hodiny v operacích „Reklamace / oprava kontejnerů“ ÷ kusy × 1000', proc: 'Jediný signál kvality v datech. Opakující se hodnota = opakující se vada.' },
      { k: 'B4', label: '% režie = zaučení a školení', jedn: '%', smer: 'watch', vzorec: 'hodiny v operacích zaučení/zapracování/školení ÷ režijní hodiny', proc: 'Náklad náboru, ne výroby. Sledovat, ne trestat — ale vysvětluje skoky v A1.' }
    ] },
    { skup: 'C', nazev: 'Disciplína odvádění — jestli datům věřit', items: [
      { k: 'C1', klic: true, label: '% řádků z terminálu', jedn: '%', smer: 'up', prah: [90, 70], vzorec: 'řádky s autorem terminalETH ÷ všechny řádky', proc: 'Zbytek zapsal mistr ručně — zpětně, po dávkách, bez skutečného času.' },
      { k: 'C2', klic: true, label: '% řádků ve 3 nejsilnějších dnech', jedn: '%', smer: 'down', prah: [25, 35], vzorec: 'řádky zapsané ve 3 dnech s nejvíce zápisy ÷ všechny řádky', proc: 'Dávkovost. Rovnoměrné odvádění je ~15 %. Nad 35 % nejde z dat určit, kdy se co dělalo.' },
      { k: 'C3', label: '% lidí odvádějících ≥ 8 dní v měsíci', jedn: '%', smer: 'up', prah: [80, 60], vzorec: 'lidé s odváděním v ≥ 8 různých dnech ÷ lidé s odváděním', proc: 'Pravidlo „odvádí se týž den“ v praxi.' },
      { k: 'C4', label: '% produkčních řádků bez ČVZ', jedn: '%', smer: 'down', prah: [3, 8], vzorec: 'produkční řádky bez ČVZ ÷ produkční řádky', proc: 'Bez ČVZ nejde operaci přiřadit k zakázce ani k plánu výroby.' },
      { k: 'C5', label: 'Produkční řádky s 0 ks', jedn: 'ř.', smer: 'down', prah: [0, 5], vzorec: 'počet výrobních řádků s nulovým množstvím', proc: 'Práce zapsaná bez množství — pro normu i výkon neviditelná.' }
    ] },
    { skup: 'D', nazev: 'Lidé a kapacita', items: [
      { k: 'D1', label: 'Lidí s odváděním', jedn: '', smer: 'watch', vzorec: 'počet různých osobních čísel v měsíci', proc: 'Základ pro A1 a A4.' },
      { k: 'D2', klic: true, label: 'Lidí z roku bez odvádění v měsíci', jedn: '', smer: 'down', prah: [15, 30], vzorec: 'lidé, kteří odváděli dřív v roce, ale v měsíci nic; semafor podle podílu z (D1 + D2)', proc: 'Buď mimo (dovolená, nemoc, odchod), nebo pracují neviditelně. Párovat s docházkou.' }
    ] }
  ];
  const LEG_FLAT = LEGENDA.flatMap(g => g.items);
  const RE_PROD = /úklid|uklid|zaučen|zaucen|zapracov|školen|skolen|transport|manipul|stěhov|stehov|prostoj|čekán|cekan|poruch|údržb|udrzb|likvidac|inventur|sníh|snih|zeleň|zelen|sečen|secen|ostatní|ostatni/i;
  const RE_REKL = /reklam|oprava kontejner/i, RE_ZAUC = /zaučen|zaucen|zapracov|školen|skolen/i, RE_OST = /^ostatní|^ostatni/i;
  const pracDnyMesice = ym => { const [y, m] = ym.split('-').map(Number); let n = 0; for (let d = 1; d <= 31; d++) { const t = new Date(Date.UTC(y, m - 1, d)); if (t.getUTCMonth() !== m - 1) break; const w = t.getUTCDay(); if (w && w < 6) n++; } return n; };
  // semafor: 'g' | 'y' | 'r' | '' (bez semaforu)
  function semafor(def, v, ctx) {
    if (!def.prah || v == null) return '';
    let x = v; if (def.k === 'D2') { const tot = (ctx && ctx.D1 || 0) + v; x = tot ? v / tot * 100 : 0; }
    if (def.smer === 'up') return x >= def.prah[0] ? 'g' : (x >= def.prah[1] ? 'y' : 'r');
    return x <= def.prah[0] ? 'g' : (x <= def.prah[1] ? 'y' : 'r');
  }
  function indikatoryMesice(rows, ym, rokRows) {
    const pd = pracDnyMesice(ym); const rez = rows.filter(r => isRezie(r[R.dil])), prod = rows.filter(r => !isRezie(r[R.dil]));
    const rezH = rez.reduce((s, r) => s + r[R.ks], 0), ks = prod.reduce((s, r) => s + r[R.ks], 0);
    const lide = new Set(rows.map(r => r[R.id] || r[R.name])); const fond = lide.size * pd * 8;
    const sum = (arr, f) => arr.filter(f).reduce((s, r) => s + r[R.ks], 0);
    const rezProd = sum(rez, r => !RE_PROD.test(r[R.op])), rezOst = sum(rez, r => RE_OST.test(r[R.op]) || !r[R.pozn]), rekH = sum(rez, r => RE_REKL.test(r[R.op])), zaH = sum(rez, r => RE_ZAUC.test(r[R.op]));
    const term = rows.filter(r => r[R.aut] === 'terminalETH').length;
    const byD = {}; rows.forEach(r => byD[r[R.date]] = (byD[r[R.date]] || 0) + 1); const top3 = Object.values(byD).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    const perL = {}; rows.forEach(r => { const k = r[R.id] || r[R.name]; (perL[k] = perL[k] || new Set()).add(r[R.date]); }); const prub = Object.values(perL).filter(s => s.size >= 8).length;
    const drive = new Set(rokRows.filter(r => r[R.date] < ym).map(r => r[R.id] || r[R.name])); const bez = [...drive].filter(k => !lide.has(k)).length;
    const p = (a, b) => b ? Math.round(a / b * 100) : 0, r1 = x => Math.round(x * 10) / 10;
    return { m: ym, rows: rows.length, ks: Math.round(ks), rezH: Math.round(rezH), pracDny: pd,
      A1: p(rezH, fond), A2: ks ? Math.round(rezH / ks * 1000) : 0, A3: prod.length ? Math.round(rezH / prod.length * 100) / 100 : 0, A4: lide.size ? Math.round(ks / lide.size) : 0,
      B1: p(rezProd, rezH), B2: p(rezOst, rezH), B3: ks ? r1(rekH / ks * 1000) : 0, B4: p(zaH, rezH),
      C1: p(term, rows.length), C2: p(top3, rows.length), C3: p(prub, lide.size), C4: p(prod.filter(r => !r[R.cvz]).length, prod.length), C5: prod.filter(r => r[R.ks] === 0).length,
      D1: lide.size, D2: bez };
  }
  // Všechny měsíce roku pro závod + semafory, trend vs. předchozí měsíc a vs. medián předchozích 6.
  function indikatory(z) {
    const D = loadData(z.key); if (!D) return null;
    const all = D.rows.filter(r => r[R.date] <= D.snapshot);
    const mesice = [...new Set(all.map(r => r[R.date].slice(0, 7)))].sort();
    const out = mesice.map(ym => indikatoryMesice(all.filter(r => r[R.date].startsWith(ym)), ym, all));
    const snapM = D.snapshot.slice(0, 7);
    out.forEach((M, i) => {
      M.neuplny = M.m === snapM && !/-(2[89]|3[01])$/.test(D.snapshot);
      M.sem = {}; M.trend = {}; M.med = {};
      LEG_FLAT.forEach(def => {
        M.sem[def.k] = semafor(def, M[def.k], M);
        const prev = out[i - 1]; if (prev && prev[def.k] != null) { const d = M[def.k] - prev[def.k]; M.trend[def.k] = d === 0 ? 0 : (d > 0 ? 1 : -1); }
        const hist = out.slice(Math.max(0, i - 6), i).map(x => x[def.k]).filter(v => v != null).sort((a, b) => a - b);
        if (hist.length >= 3) M.med[def.k] = hist.length % 2 ? hist[(hist.length - 1) / 2] : (hist[hist.length / 2 - 1] + hist[hist.length / 2]) / 2;
      });
    });
    return { zavod: z.key, name: z.name, snapshot: D.snapshot, mesice: out };
  }
  // Text pro trend: zlepšení/zhoršení podle směru indikátoru
  const lepsi = (def, d) => def.smer === 'watch' ? null : (def.smer === 'up' ? d > 0 : d < 0);

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
      L.rows++; L.dnySet.add(day); L.opsSet.add(r[R.op]); L.perDay[day] = (L.perDay[day] || 0) + 1; if (r[R.aut] === 'terminalETH') L.term++; if (rez) L.rezRows = (L.rezRows || 0) + 1;
      if (!L.last || day > L.last) L.last = day; if (!L.first || day < L.first) L.first = day;
      if (rez) { L.rezieH += r[R.ks]; rezieH += r[R.ks]; rezRows++; const kat = kategorieRezie(r[R.dil] + ' ' + r[R.pozn]); rezKat[kat] = rezKat[kat] || { kat, h: 0, rows: 0, lide: new Set() }; rezKat[kat].h += r[R.ks]; rezKat[kat].rows++; rezKat[kat].lide.add(r[R.name]);
        const pk = (r[R.pozn] || (r[R.dil] + ' (bez poznámky)')).slice(0, 80); rezPol[pk] = rezPol[pk] || { text: pk, h: 0, rows: 0, lide: new Set() }; rezPol[pk].h += r[R.ks]; rezPol[pk].rows++; rezPol[pk].lide.add(r[R.name]); }
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
      return { id: L.id, name: L.name, rows: L.rows, prodRows: L.rows - (L.rezRows || 0), ks: Math.round(L.ks), rezieH: Math.round(L.rezieH), dny: L.dnySet.size, ops: L.opsSet.size, termPct: L.rows ? Math.round(L.term / L.rows * 100) : 0, last: L.last, first: L.first, davkaPct: L.rows ? Math.round(maxDay / L.rows * 100) : 0, reziePct: (L.rows ? Math.round(L.rezieH > 0 ? (L.rezieH / (L.rezieH + Math.max(1, L.ks))) * 100 : 0) : 0), topOp: topOp ? topOp[0] : '' }; })
      .sort((a, b) => b.rows - a.rows);
    // párování na plán
    const plan = loadPlan(z.key); const P = (plan && plan.items) || {};
    const planUrl = row => plan && plan.sheetId ? 'https://docs.google.com/spreadsheets/d/' + plan.sheetId + '/edit#gid=' + (plan.gid != null ? plan.gid : 0) + (row ? '&range=A' + row + ':AZ' + row : '') : '';
    const cvzArr = Object.values(cvzs).map(C => { const p = P[C.cvz]; return { cvz: C.cvz, zak: C.zak, rows: C.rows, ks: Math.round(C.ks), rezieH: Math.round(C.rezieH), lide: C.lide.size, ops: C.ops.size, first: C.first, last: C.last, plan: p ? { vyrobek: p.vyrobek, ks: p.ks, zakaznik: p.zakaznik, termin: p.termin, skutecny: p.skutecny, exp: p.exp, faze: p.faze, row: p.row, url: planUrl(p.row) } : null }; })
      .sort((a, b) => b.rows - a.rows);
    const sparovano = cvzArr.filter(c => c.plan).length;
    // --- vstupy pro analýzu ---
    // úsek podle názvu operace (heuristika): dělírna / svařovna / lakovna / ostatní
    const usekOf = op => { const o = String(op || '').toLowerCase(); if (/lak|trysk|odmaš|odmas|základ|zaklad|barv|polep|lepen/.test(o)) return 'Lakovna a příprava'; if (/nůžk|nuzk|pila|pálen|palen|ohraň|ohran|děl|del[ií]rna|řez|rez[aá]n|vrt|lis|ohyb|stříh|strih/.test(o)) return 'Dělírna'; if (/svař|svar|navař|navar|dovař|dovar|skl[aá]d|osaz|mont|stehov|bodov|trámec|tramec|podlah|bočnic|bocnic|vrat|střech|strech/.test(o)) return 'Svařovna'; return 'Ostatní'; };
    const usekLide = {};
    rows.forEach(r => { if (isRezie(r[R.dil])) return; const k = r[R.id] || r[R.name]; const u = usekOf(r[R.op]); (usekLide[k] = usekLide[k] || {})[u] = (usekLide[k][u] || 0) + 1; });
    lideArr.forEach(L => { const m = usekLide[L.id || L.name]; L.usek = m ? Object.entries(m).sort((a, b) => b[1] - a[1])[0][0] : (L.rezieH ? 'Ostatní' : 'Ostatní'); });
    const useky = {}; lideArr.forEach(L => { const U = useky[L.usek] = useky[L.usek] || { usek: L.usek, lide: 0, rows: 0, ks: 0, rezieH: 0, term: 0 }; U.lide++; U.rows += L.rows; U.ks += L.ks; U.rezieH += L.rezieH; U.term += L.termPct * L.rows; });
    const usekyArr = Object.values(useky).map(U => ({ usek: U.usek, lide: U.lide, rows: U.rows, ks: U.ks, rezieH: U.rezieH, termPct: U.rows ? Math.round(U.term / U.rows) : 0, rezieNaOsobu: U.lide ? Math.round(U.rezieH / U.lide) : 0 })).sort((a, b) => b.rows - a.rows);
    // dvojice s identickými zápisy (stejný počet řádků, kusů i dnů) — odvádění sdíleně
    const dvojice = []; for (let i = 0; i < lideArr.length; i++) for (let j = i + 1; j < lideArr.length; j++) { const a = lideArr[i], b = lideArr[j]; if (a.rows >= 12 && a.rows === b.rows && a.ks === b.ks && a.dny === b.dny) dvojice.push([a.name, b.name, a.rows]); }
    // lidé, kteří v roce odváděli, ale v období nic (jen když je období užší než rok)
    const rokLide = {}; all.forEach(r => { const k = r[R.id] || r[R.name]; rokLide[k] = rokLide[k] || { name: r[R.name], last: '' }; if (r[R.date] > rokLide[k].last) rokLide[k].last = r[R.date]; });
    const vObdobi = new Set(lideArr.map(L => L.id || L.name));
    const bezOdvadeni = (od || do_) ? Object.entries(rokLide).filter(([k, v]) => !vObdobi.has(k) && v.last < (od || '0')).map(([k, v]) => ({ name: v.name, last: v.last })).sort((a, b) => b.last.localeCompare(a.last)) : [];
    // operace, které odvádí jediný člověk (klíčové know-how)
    const jediny = Object.values(ops).filter(o => o.rows >= 10 && o.lide.size === 1).sort((a, b) => b.rows - a.rows).slice(0, 5).map(o => ({ op: o.op, rows: o.rows, ks: Math.round(o.ks), name: [...o.lide][0] }));
    const nulOps = {}; rows.forEach(r => { if (!isRezie(r[R.dil]) && r[R.ks] === 0) nulOps[r[R.op]] = (nulOps[r[R.op]] || 0) + 1; });
    const nulTop = Object.entries(nulOps).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([op, n]) => ({ op, n }));
    const pracDnu = (() => { if (!od || !do_) return dnyArr.length; let n = 0; for (const d = new Date(od + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= do_; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } return n; })();
    const DNY_CZ = ['v neděli', 'v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu'];
    const rezAut = {}, rezDen = {}; let rezN = 0;
    rows.forEach(r => { if (!isRezie(r[R.dil])) return; rezN++; const a = r[R.aut] === 'terminalETH' ? 'terminál' : (r[R.aut] || '—'); rezAut[a] = (rezAut[a] || 0) + 1; const d = DNY_CZ[new Date(r[R.date] + 'T00:00:00Z').getUTCDay()]; rezDen[d] = (rezDen[d] || 0) + 1; });
    const rezZapis = { n: rezN, autori: Object.entries(rezAut).sort((a, b) => b[1] - a[1]).map(([a, n]) => ({ autor: a, pct: Math.round(n / Math.max(1, rezN) * 100) })), dny: Object.entries(rezDen).sort((a, b) => b[1] - a[1]).map(([d, n]) => ({ den: d, pct: Math.round(n / Math.max(1, rezN) * 100) })) };
    const ana = buildAnalyza({ name: z.name, key: z.key, rezZapis, rows: rows.length, ks, rezieH, rezRows, term, lideArr, usekyArr, dvojice, bezOdvadeni, jediny, nulTop, nulKs, bezCvz, future, topDny, patek, dnyArr, pracDnu, rezKat: Object.values(rezKat).sort((a, b) => b.h - a.h), rezPol: Object.values(rezPol).sort((a, b) => b.h - a.h), autori: Object.entries(autori).sort((a, b) => b[1] - a[1]), snapshot, od, do_ });
    return {
      analyza: ana, useky: usekyArr,
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

  // ---------- měsíční e-mail „Indikátory výkonnosti středisek“ ----------
  const CFG_F = path.join(dataDir, 'vykonnost-report.json'), RSTATE_F = path.join(dataDir, 'vykonnost-report-state.json');
  const DEF_TO = ['david.sury@elkoplast.cz', 'tomas.krajca@elkoplast.cz'];
  const cleanEmails = a => (Array.isArray(a) ? a : String(a || '').split(/[;,\n]/)).map(x => String(x).trim().toLowerCase()).filter(x => /@/.test(x));
  function loadCfg() { let c = {}; try { c = JSON.parse(fs.readFileSync(CFG_F, 'utf8')) || {}; } catch (_) {} return { to: Array.isArray(c.to) ? c.to : DEF_TO.slice(), enabled: c.enabled !== undefined ? !!c.enabled : true, hour: (c.hour >= 0 && c.hour <= 23) ? c.hour : 7 }; }
  const saveCfg = c => { try { fs.writeFileSync(CFG_F, JSON.stringify(c, null, 2)); } catch (e) { console.error('[vykonnost] zápis config:', e.message); } };
  const loadRState = () => { try { return JSON.parse(fs.readFileSync(RSTATE_F, 'utf8')) || {}; } catch (_) { return {}; } };
  const esc = x => String(x == null ? '' : x).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const MES = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
  const mesLabel = ym => { const [y, m] = ym.split('-'); return MES[+m - 1] + ' ' + y; };
  const fmtV = (def, v) => v == null ? '—' : (def.k === 'A3' || def.k === 'B3' ? String(v).replace('.', ',') : fmt0(v)) + (def.jedn === '%' ? ' %' : (def.jedn ? ' ' + def.jedn : ''));
  const SEM_BG = { g: '#e6f3e4', y: '#fbf1dc', r: '#fbe9e8', '': 'transparent' }, SEM_FG = { g: '#0a7a0a', y: '#b57400', r: '#c93a39', '': '#1c1d1a' };
  // Report za poslední UZAVŘENÝ měsíc (ym); když není zadán, vezme měsíc před měsícem snímku.
  function buildReport(ymArg) {
    const zav = ZAVODY.map(z => indikatory(z)).filter(Boolean);
    if (!zav.length) return { subject: 'Indikátory výkonnosti středisek — zatím bez dat', html: '<p>Zatím nejsou načtené exporty.</p>', ym: '' };
    let ym = ymArg; if (!ym) { const snap = zav[0].snapshot; const d = new Date(snap.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); ym = d.toISOString().slice(0, 7); }
    const th = (t, r) => '<th style="text-align:' + (r ? 'right' : 'left') + ';border-bottom:2px solid #d8dee7;padding:6px 8px;font-size:11.5px;color:#55605a;white-space:nowrap">' + esc(t) + '</th>';
    const klic = LEG_FLAT.filter(d => d.klic);
    let body = '';
    const zmeny = [];
    zav.forEach(Z => {
      const i = Z.mesice.findIndex(M => M.m === ym); const M = Z.mesice[i], P = i > 0 ? Z.mesice[i - 1] : null;
      body += '<h3 style="margin:18px 0 6px;font-size:15px">' + esc(Z.name) + (M ? ' <span style="color:#8a938a;font-weight:400;font-size:12.5px">· ' + fmt0(M.rows) + ' operací · ' + fmt0(M.ks) + ' ks · ' + fmt0(M.rezH) + ' h režie · ' + M.D1 + ' lidí</span>' : '') + '</h3>';
      if (!M) { body += '<p style="color:#8a938a">Za ' + mesLabel(ym) + ' nejsou data.</p>'; return; }
      body += '<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>' + th('Indikátor') + th(mesLabel(ym), 1) + th(P ? mesLabel(P.m) : 'předchozí', 1) + th('Trend', 1) + '</tr></thead><tbody>' +
        klic.map(def => { const v = M[def.k], pv = P ? P[def.k] : null, sm = M.sem[def.k] || ''; const d = pv != null ? v - pv : null; const ok = d == null || d === 0 ? null : lepsi(def, d);
          if (d != null && d !== 0 && pv) zmeny.push({ zavod: Z.name, def, v, pv, rel: Math.abs(d) / Math.max(1, Math.abs(pv)), ok });
          return '<tr><td style="padding:6px 8px;border-bottom:1px solid #eef1ec"><b>' + def.k + '</b> ' + esc(def.label) + '</td>' +
            '<td style="padding:6px 8px;border-bottom:1px solid #eef1ec;text-align:right;background:' + SEM_BG[sm] + ';color:' + SEM_FG[sm] + ';font-weight:700;white-space:nowrap">' + fmtV(def, v) + '</td>' +
            '<td style="padding:6px 8px;border-bottom:1px solid #eef1ec;text-align:right;color:#8a938a;white-space:nowrap">' + fmtV(def, pv) + '</td>' +
            '<td style="padding:6px 8px;border-bottom:1px solid #eef1ec;text-align:right;white-space:nowrap;color:' + (ok == null ? '#8a938a' : (ok ? '#0a7a0a' : '#c93a39')) + '">' + (d == null ? '—' : (d === 0 ? '=' : (d > 0 ? '▲ +' : '▼ ') + fmtV(def, d).replace(/^-/, '−'))) + '</td></tr>'; }).join('') + '</tbody></table>';
    });
    zmeny.sort((a, b) => b.rel - a.rel);
    const topZ = zmeny.slice(0, 3);
    const zmenyHtml = topZ.length ? '<div style="background:#eef4fb;border:1px solid #d3e0f2;border-radius:10px;padding:12px 16px;margin:0 0 6px;font-size:13.5px;line-height:1.6"><b>Tři největší změny proti předchozímu měsíci</b>' +
      topZ.map(c => '<div style="margin-top:4px">' + (c.ok ? '<span style="color:#0a7a0a">▲ zlepšení</span>' : '<span style="color:#c93a39">▼ zhoršení</span>') + ' · <b>' + esc(c.zavod) + '</b> — ' + esc(c.def.label) + ': ' + fmtV(c.def, c.pv) + ' → <b>' + fmtV(c.def, c.v) + '</b></div>').join('') + '</div>' : '';
    const legHtml = '<hr style="border:0;border-top:1px solid #e6e9e3;margin:20px 0"><div style="font-size:12px;color:#55605a;line-height:1.55"><b>Legenda</b> — semafor: <span style="background:#e6f3e4;color:#0a7a0a;padding:1px 6px;border-radius:3px">zelená</span> v cíli · <span style="background:#fbf1dc;color:#b57400;padding:1px 6px;border-radius:3px">žlutá</span> sledovat · <span style="background:#fbe9e8;color:#c93a39;padding:1px 6px;border-radius:3px">červená</span> mimo. Hodnoty srovnávejte v čase v rámci závodu, ne mezi závody.<br>' +
      klic.map(d => '<b>' + d.k + '</b> ' + esc(d.label) + ' = ' + esc(d.vzorec) + (d.prah ? ' (cíl ' + (d.smer === 'up' ? '≥ ' + d.prah[0] : '≤ ' + d.prah[0]) + (d.jedn === '%' ? ' %' : '') + ')' : '')).join('<br>') + '</div>';
    const url = (host.mailFrom && host.mailFrom.publicUrl || '') + '/#modul=vykonnost';
    const html = '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#1c1d1a;line-height:1.5;max-width:900px">' +
      '<h2 style="margin:0 0 4px">Indikátory výkonnosti středisek — ' + esc(mesLabel(ym)) + '</h2>' +
      '<p style="color:#6b736c;margin:0 0 14px;font-size:13px">Šest klíčových ukazatelů ze skutečně odvedených operací v Heliosu (bez Kč — export neobsahuje cenu operací). Podrobnosti, všech 15 indikátorů a vývoj po měsících: <a href="' + esc(url) + '" style="color:#1f4e79">Intranet → Výkonnost středisek → Měsíční indikátory</a>.</p>' +
      zmenyHtml + body + legHtml +
      '<div style="font-size:12px;color:#8a938a;margin-top:12px">Automatický měsíční report · odesílá se první pracovní den měsíce. Příjemce a zapnutí spravuje správce v modulu nebo v přehledu Rozesílky.</div></div>';
    return { subject: 'Výkonnost středisek — indikátory za ' + mesLabel(ym) + (topZ.length ? ' · ' + topZ.filter(c => !c.ok).length + '× zhoršení, ' + topZ.filter(c => c.ok).length + '× zlepšení v top 3' : ''), html, ym };
  }
  async function sendReport(toList, ym) {
    const to = cleanEmails(toList); if (!to.length) return { ok: false, error: 'žádný příjemce' };
    if (!host.deliver) return { ok: false, error: 'odesílání pošty není k dispozici' };
    const rep = buildReport(ym);
    try { await host.deliver({ to: to.join(', '), fromAddr: (host.mailFrom && host.mailFrom.user) || '', fromName: (host.mailFrom && host.mailFrom.name) || 'Intranet ELKOPLAST — Výkonnost', subject: rep.subject, text: rep.subject, html: rep.html }); return { ok: true, to, ym: rep.ym }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  // První pracovní den v měsíci (po–pá; státní svátky neřešíme), od zvolené hodiny; pojistka 1×/měsíc, při chybě max 3 pokusy.
  function prvniPracovniDen(d) { for (let i = 1; i <= 7; i++) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), i)); const w = t.getUTCDay(); if (w && w < 6) return i; } return 1; }
  async function tickReport() {
    try {
      const cfg = loadCfg(); const now = new Date();
      if (!cfg.enabled) return;
      if (host.reportDisabled && host.reportDisabled('vykonnost-mesicni')) return;
      if (now.getDate() !== prvniPracovniDen(now) || now.getHours() < cfg.hour) return;
      const st = loadRState(); const cur = now.toISOString().slice(0, 7);
      if (st.lastMonth === cur) return;
      if (st.failMonth === cur && (st.failCount || 0) >= 3) return;
      const r = await sendReport(cfg.to);
      if (r.ok) { st.lastMonth = cur; st.lastAt = now.toISOString(); st.lastError = ''; delete st.failMonth; delete st.failCount; }
      else { st.failCount = (st.failMonth === cur ? (st.failCount || 0) : 0) + 1; st.failMonth = cur; st.lastError = r.error || 'odeslání selhalo'; }
      st.lastResult = r; try { fs.writeFileSync(RSTATE_F, JSON.stringify(st, null, 2)); } catch (_) {}
      console.log('[vykonnost] měsíční report: ' + (r.ok ? 'odesláno (' + r.to.join(', ') + ')' : 'CHYBA (pokus ' + st.failCount + '/3) ' + st.lastError));
    } catch (e) { console.error('[vykonnost] report tick:', e.message); }
  }
  function reportDescriptor() {
    const c = loadCfg(), st = loadRState();
    return { key: 'vykonnost-mesicni', module: 'Výkonnost středisek', name: 'Měsíční indikátory výkonnosti (4 závody)', to: c.to || [], enabled: !!c.enabled, schedule: 'měsíčně, 1. pracovní den od ' + c.hour + ':00', lastAt: st.lastAt || null, lastError: st.lastError || '', preview: '/api/vykonnost/preview', send: { url: '/api/vykonnost/send', body: {} }, configHint: 'Modul Výkonnost středisek → Měsíční indikátory → 📧' };
  }
  function reports() { return [reportDescriptor()]; }
  function setReport(key, b) { if (key !== 'vykonnost-mesicni') return null; const next = Object.assign({}, loadCfg()); if (b.to != null) next.to = cleanEmails(b.to); if (b.enabled != null) next.enabled = !!b.enabled; if (b.hour != null && b.hour >= 0 && b.hour <= 23) next.hour = +b.hour; saveCfg(next); return reportDescriptor(); }

  // ---------- plánovač ----------
  let lastPlanAt = 0;
  async function tick() {
    try { const s = await sync(false); if (s && !s.ok) console.warn('[vykonnost] sync:', s.error); } catch (e) { console.error('[vykonnost] sync:', e.message); }
    if (Date.now() - lastPlanAt > 6 * 3600 * 1000) { lastPlanAt = Date.now(); try { await syncPlans(); } catch (e) { console.warn('[vykonnost] plány:', e.message); } }
    await tickReport();
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
    const mi = /^\/api\/vykonnost\/indikatory\/([a-z]+)$/.exec(p);
    if (mi && req.method === 'GET') {
      const z = zavodOf(mi[1]); if (!z) { json(res, 404, { error: 'Neznámý závod.' }); return true; }
      const I = indikatory(z); if (!I) { json(res, 200, { data: false, zavod: z.key, name: z.name, legenda: LEGENDA }); return true; }
      json(res, 200, Object.assign({ data: true, legenda: LEGENDA, config: host.isAdmin(req) ? loadCfg() : undefined, reportState: host.isAdmin(req) ? loadRState() : undefined }, I)); return true;
    }
    if (!host.isAdmin(req)) { json(res, 403, { error: 'Jen pro správce.' }); return true; }
    if (p === '/api/vykonnost/preview' && req.method === 'GET') { const rep = buildReport(/^\d{4}-\d{2}$/.test(u.query.m || '') ? u.query.m : ''); return host.send(res, 200, rep.html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }), true; }
    if (p === '/api/vykonnost/send' && req.method === 'POST') { let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) {} const r = await sendReport(b.to ? b.to : loadCfg().to, /^\d{4}-\d{2}$/.test(b.m || '') ? b.m : ''); return json(res, r.ok ? 200 : 500, r), true; }
    if (p === '/api/vykonnost/config' && req.method === 'POST') { let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) { json(res, 400, { error: 'Neplatné tělo.' }); return true; } return json(res, 200, { ok: true, report: setReport('vykonnost-mesicni', b) }), true; }
    if (p === '/api/vykonnost/sync' && req.method === 'POST') {
      try { const r = await sync(true); let pl = null; try { pl = await syncPlans(); } catch (e) { pl = { error: e.message }; } return json(res, r.ok ? 200 : 500, Object.assign(r, { plany: pl })), true; }
      catch (e) { return json(res, 500, { ok: false, error: e.message }), true; }
    }
    if (p === '/api/vykonnost/stav' && req.method === 'GET') { return json(res, 200, { state: loadState(), zavody: ZAVODY.map(z => ({ key: z.key, name: z.name, folder: z.folder, plan: z.plan && z.plan.sheetId })) }), true; }
    json(res, 404, { error: 'Not found' }); return true;
  }

  return { handle, tick, sync: () => sync(false), syncPlans, parseExport, parsePlanValues, indikatory, buildReport, reports, setReport, ZAVODY, LEGENDA };
}

module.exports = { mount };

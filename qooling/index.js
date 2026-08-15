// Modul „Qooling" — stav závad kvality z platformy Qooling.
// Data: sdílená složka na Google Drive (service account) s exporty „issues_export …xlsx";
// bere se vždy NEJNOVĚJŠÍ soubor (export je kumulativní — obsahuje celou historii).
// Zobrazení: interaktivní přehled v intranetu (modul „qooling" v Přístupech, admin vždy).
// Report: každé pondělí e-mail se stavem závad (příjemci editovatelní, pojistka 1×/ISO-týden,
// centrální vypínač v Rozesílkách pod klíčem „qooling-tydenni").
const fs = require('fs');
const path = require('path');
const urlLib = require('url');
let drive = null; try { drive = require('../smlouvy/lib/drive'); } catch (_) {}   // Google Drive přes service account (reuse)
const xlsxMini = require('../nakup-report/xlsx-mini');                            // pure-Node čtečka .xlsx

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = n => Math.round(+n || 0).toLocaleString('cs-CZ');

// „24 Oct 2025" / „2026-03-11" / „11.3.2026" → ISO YYYY-MM-DD (Qooling exportuje anglicky)
const MON_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(v) {
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return s.slice(0, 10);
  m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/.exec(s);
  if (m && MON_EN[m[2].toLowerCase()]) return m[3] + '-' + String(MON_EN[m[2].toLowerCase()]).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(s);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  // xlsx serial date (číslo dní od 1900)
  const n = +s; if (isFinite(n) && n > 20000 && n < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return d.toISOString().slice(0, 10); }
  return '';
}
// Titulek v exportu obsahuje počty kusů, občas s překlepem („O" místo 0, „2.0") — číslo, jinak null.
function parseKs(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^[oO]$/.test(s)) return 0;
  const n = parseFloat(s.replace(',', '.'));
  return isFinite(n) ? n : null;
}
const isClosed = st => /clos|done|resolv|uzav|hotov|vyříz|vyriz/i.test(String(st || ''));

function mount(host) {
  const CFG_F = path.join(host.dataDir || __dirname, 'qooling-report.json');   // config rozesílky (writable)
  const STATE_F = path.join(host.dataDir || __dirname, 'qooling-state.json');  // stav odeslání (writable)
  const DATA_F = path.join(host.dataDir || __dirname, 'qooling-data.json');    // živá data z Drive (writable)
  const SEED_F = path.join(__dirname, 'seed.json');                            // commitnutý snapshot (než se rozjede sync)
  const FOLDER = process.env.QOOLING_DRIVE_FOLDER || '1mbsDoU8YUmHAF1OCpy8gfoWgOyjr5hRp'; // podsložka „Qooling" sdílené složky

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  const cleanEmails = a => (Array.isArray(a) ? a : String(a || '').split(/[;,\n]/)).map(x => String(x).trim().toLowerCase()).filter(x => /@/.test(x));

  // ---------- data ----------
  const loadData = () => { for (const f of [DATA_F, SEED_F]) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} } return { rows: [], source: '', syncedAt: '' }; };

  // Export Qooling: hlavička [issues Mobile, #, Status, Date, Title, Creator, Kdo chybu způsobil?, Doba trvání opravy (minuty)]
  function parseXlsx(buf) {
    const rows = xlsxMini.parse(buf); if (!rows.length) return [];
    // hlavička = první řádek obsahující „status" (názvy sloupců hledáme robustně, ne podle pozice)
    let hi = rows.findIndex(r => (r || []).some(c => /status/i.test(String(c || ''))));
    if (hi < 0) hi = 0;
    const hdr = (rows[hi] || []).map(x => String(x == null ? '' : x).trim().toLowerCase());
    const find = re => hdr.findIndex(h => re.test(h));
    const ci = {
      num: find(/^#$|^č\.?$|number/), status: find(/status|stav/), date: find(/date|datum/),
      ks: find(/title|titulek/), creator: find(/creator|autor|vytvořil/),
      culprit: find(/způsobil|zpusobil|viník|vinik/), minutes: find(/minut|doba/)
    };
    const out = [];
    for (let r = hi + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const num = String(row[ci.num] == null ? '' : row[ci.num]).trim();
      const status = String(row[ci.status] == null ? '' : row[ci.status]).trim();
      if (!num && !status) continue;
      const min = parseFloat(String(row[ci.minutes] == null ? '' : row[ci.minutes]).replace(',', '.'));
      out.push({
        num, status,
        date: parseDate(row[ci.date]),
        ks: parseKs(row[ci.ks]), ksRaw: String(row[ci.ks] == null ? '' : row[ci.ks]).trim(),
        creator: String(row[ci.creator] == null ? '' : row[ci.creator]).trim(),
        culprit: String(row[ci.culprit] == null ? '' : row[ci.culprit]).trim().replace(/\s+/g, ' '),
        minutes: isFinite(min) ? min : 0
      });
    }
    return out;
  }

  // Stažení nejnovějšího exportu ze sdílené složky (export je kumulativní → stačí nejnovější).
  async function sync(force) {
    if (!drive || !drive.configured()) return { ok: false, error: 'Service account (GOOGLE_SA_*) není nastavený.' };
    let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
    const files = await drive.listFolder(FOLDER);
    const xls = (files || []).filter(f => /\.xlsx?$/i.test(f.name || '') || /spreadsheetml/.test(f.mimeType || ''));
    if (!xls.length) return { ok: false, error: 'Ve složce Qooling nejsou .xlsx exporty (nasdílena service accountu?).' };
    xls.sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || '')) || String(b.name || '').localeCompare(String(a.name || '')));
    const newest = xls[0];
    if (!force && st.lastFileId === newest.id) return { ok: true, skipped: true, file: newest.name };
    const dl = await drive.downloadFileBase64(newest.id, 20 * 1024 * 1024);
    const rows = parseXlsx(Buffer.from(dl.base64, 'base64'));
    if (!rows.length) return { ok: false, error: 'Soubor ' + newest.name + ' se nepodařilo rozparsovat.' };
    fs.writeFileSync(DATA_F, JSON.stringify({ source: newest.name, rows, syncedAt: new Date().toISOString() }));
    st.lastFileId = newest.id; st.lastFileName = newest.name; st.lastSyncAt = new Date().toISOString();
    try { fs.writeFileSync(STATE_F, JSON.stringify(st, null, 2)); } catch (_) {}
    console.log('[qooling] Drive sync: ' + newest.name + ' → ' + rows.length + ' řádků');
    return { ok: true, file: newest.name, rows: rows.length };
  }

  // ---------- středisko zadavatele ----------
  // Export Qoolingu středisko nemá — dohledáme ho podle jména zadavatele v databázi zaměstnanců.
  // Jména se liší v drobnostech („Naďa" vs „Naděžda", „Natalia" vs „Nataliia") → porovnáváme
  // příjmení přesně a křestní jen podle prvních 3 znaků (bez diakritiky).
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  function strediskoMap() {
    const map = {};
    let emps = []; try { emps = (host.getState && host.getState().employees) || []; } catch (_) {}
    return creator => {
      const key = norm(creator); if (!key) return '— nezařazeno —';
      if (map[key] !== undefined) return map[key];
      const parts = key.split(' '), last = parts[parts.length - 1], first3 = (parts[0] || '').slice(0, 3);
      let hit = emps.filter(e => { const p = norm(e.name).split(' '); return p[p.length - 1] === last; });
      if (hit.length > 1) { const h2 = hit.filter(e => norm(e.name).slice(0, 3) === first3); if (h2.length) hit = h2; }
      map[key] = (hit.length === 1 && hit[0].stredisko) ? hit[0].stredisko : '— nezařazeno —';
      return map[key];
    };
  }

  // ---------- statistika (společná pro e-mail i API) ----------
  function stats() {
    const d = loadData(), rows = d.rows || [];
    const today = new Date(); const iso = dt => dt.toISOString().slice(0, 10);
    const daysAgo = n => iso(new Date(today.getTime() - n * 86400000));
    const seen = new Set(); const issues = [];   // unikátní závady dle # (duplicitní řádky exportu nechceme počítat dvakrát)
    rows.forEach(r => { const k = r.num || (r.date + '|' + r.culprit); if (seen.has(k)) { const p = issues.find(x => (x.num || '') === r.num); if (p) { p.ks = Math.max(p.ks || 0, r.ks || 0); p.minutes = Math.max(p.minutes, r.minutes); } return; } seen.add(k); issues.push(Object.assign({}, r)); });
    issues.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.num).localeCompare(String(a.num), 'cs', { numeric: true }));
    const open = issues.filter(x => !isClosed(x.status));
    const inProgress = issues.filter(x => /progress|řeš|res/i.test(x.status) && !isClosed(x.status));
    const new7 = issues.filter(x => x.date && x.date >= daysAgo(7));
    const new30 = issues.filter(x => x.date && x.date >= daysAgo(30));
    const minutesOpen = open.reduce((s, x) => s + (x.minutes || 0), 0);
    const age = x => x.date ? Math.max(0, Math.round((today - new Date(x.date + 'T00:00:00')) / 86400000)) : null;
    // viníci (celé období) — počet závad + minuty oprav
    const culp = {};
    issues.forEach(x => { const k = x.culprit || '— neuvedeno —'; (culp[k] = culp[k] || { culprit: k, count: 0, ks: 0, minutes: 0 }); culp[k].count++; culp[k].ks += x.ks || 0; culp[k].minutes += x.minutes || 0; });
    const culprits = Object.values(culp).sort((a, b) => b.count - a.count || b.minutes - a.minutes);
    // měsíční histogram (posledních 13 měsíců)
    const months = {};
    issues.forEach(x => { if (x.date) { const m = x.date.slice(0, 7); months[m] = (months[m] || 0) + 1; } });
    // minuty oprav podle střediska zadavatele × měsíce (středisko z databáze zaměstnanců)
    const stred = strediskoMap();
    issues.forEach(x => { x.stredisko = stred(x.creator); });
    const minutesMatrix = {};   // { středisko: { 'YYYY-MM': minuty } }
    issues.forEach(x => { if (!x.date) return; const m = x.date.slice(0, 7); const row = (minutesMatrix[x.stredisko] = minutesMatrix[x.stredisko] || {}); row[m] = (row[m] || 0) + (x.minutes || 0); });
    return { issues, open, inProgress, new7, new30, minutesOpen, culprits, months, minutesMatrix, age, source: d.source || '', syncedAt: d.syncedAt || '' };
  }

  // ---------- config rozesílky ----------
  const DEF_TO = ['lukas.pospisil@elkoplast.cz', 'tomas.krajca@elkoplast.cz', 'david.sury@elkoplast.cz'];
  function loadCfg() {
    let c = {}; try { c = JSON.parse(fs.readFileSync(CFG_F, 'utf8')) || {}; } catch (_) {}
    return {
      to: Array.isArray(c.to) ? c.to : DEF_TO.slice(),
      enabled: c.enabled !== undefined ? !!c.enabled : true,        // uživatel report výslovně chtěl → zapnuto
      weekday: (c.weekday >= 0 && c.weekday <= 6) ? c.weekday : 1,  // 1 = pondělí
      hour: (c.hour >= 0 && c.hour <= 23) ? c.hour : 7              // odesílá se ráno od této hodiny
    };
  }
  const saveCfg = c => { try { fs.writeFileSync(CFG_F, JSON.stringify(c, null, 2)); } catch (e) { console.error('[qooling] zápis config:', e.message); } };

  // ---------- e-mail (zrcadlí stránku modulu: KPI → graf po měsících → matice středisek → tabulka závad) ----------
  const th = t => '<th style="text-align:' + (/Ks|Minut|Stáří/.test(t) ? 'right' : 'left') + ';border-bottom:2px solid #d8dee7;padding:8px 10px;font-size:12px;color:#55605a;white-space:nowrap">' + esc(t) + '</th>';
  const td = (v, r) => '<td style="text-align:' + (r ? 'right' : 'left') + ';border-bottom:1px solid #eef1ec;padding:6px 10px">' + v + '</td>';
  const stBadge = st => isClosed(st) ? '<span style="background:#e7f5e9;color:#1f5e22;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap">✔ ' + esc(st) + '</span>'
    : /progress/i.test(st) ? '<span style="background:#fbf0dc;color:#a86a00;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap">' + esc(st) + '</span>'
      : '<span style="background:#fbecea;color:#a03a2c;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap">' + esc(st) + '</span>';
  const czDate = d => d ? d.split('-').reverse().join('. ') : '—';

  // KPI karty jako na stránce (bílá karta, zelený proužek vlevo, velké číslo).
  function kpiRowHtml(S) {
    const kpi = (val, label) => '<td style="width:25%;padding:0 8px 0 0;vertical-align:top">' +
      '<div style="background:#fff;border:1px solid #e2e6df;border-left:4px solid #3a7d44;border-radius:10px;padding:14px 16px">' +
      '<div style="font-size:26px;font-weight:700;color:#1f3d6b;font-family:Consolas,Menlo,monospace">' + val + '</div>' +
      '<div style="font-size:11px;color:#6b736c;text-transform:uppercase;letter-spacing:.04em;margin-top:2px">' + esc(label) + '</div></div></td>';
    return '<table style="border-collapse:separate;width:100%;margin:0 0 16px"><tr>' +
      kpi(fmt(S.open.length), 'Otevřené závady') + kpi(fmt(S.inProgress.length), 'V řešení') +
      kpi(fmt(S.new30.length), 'Nové za 30 dní') + kpi(fmt(S.minutesOpen), 'Minut oprav (otevřené)') + '</tr></table>';
  }

  // Sloupcový graf „Závady po měsících" — čisté HTML (divy s výškou), bez skriptů.
  function monthsChartHtml(S) {
    const keys = Object.keys(S.months || {}).sort().slice(-13); if (!keys.length) return '';
    const max = Math.max.apply(null, keys.map(k => S.months[k]));
    return '<div style="background:#fff;border:1px solid #e2e6df;border-radius:10px;padding:14px 16px;margin:0 0 16px">' +
      '<b style="font-size:14px">Závady po měsících</b>' +
      '<table style="border-collapse:collapse;width:100%;margin-top:10px"><tr>' +
      keys.map(k => { const v = S.months[k], h = Math.max(6, Math.round(v / max * 80));
        return '<td style="vertical-align:bottom;text-align:center;padding:0 3px">' +
          '<div style="font-size:11px;color:#8a938a;margin-bottom:3px">' + v + '</div>' +
          '<div style="height:' + h + 'px;background:#7b96e0;border-radius:4px 4px 0 0;font-size:0;line-height:0">&nbsp;</div></td>'; }).join('') +
      '</tr><tr>' +
      keys.map(k => '<td style="text-align:center;font-size:10px;color:#8a938a;padding-top:4px;border-top:2px solid #eef1ec;white-space:nowrap">' + k.slice(5) + '/' + k.slice(2, 4) + '</td>').join('') +
      '</tr></table></div>';
  }

  // Matice „minuty oprav podle střediska × měsíc" s heatmapou jako na stránce.
  function minutesMatrixHtml(S) {
    const rows = Object.keys(S.minutesMatrix || {}); if (!rows.length) return '';
    const monthsAll = [...new Set(rows.flatMap(k => Object.keys(S.minutesMatrix[k])))].sort();
    const months = monthsAll.slice(-13);
    const total = k => monthsAll.reduce((s, m) => s + (S.minutesMatrix[k][m] || 0), 0);
    const colTotal = m => rows.reduce((s, k) => s + (S.minutesMatrix[k][m] || 0), 0);
    const sorted = rows.slice().sort((a, b) => total(b) - total(a));
    const maxCell = Math.max.apply(null, sorted.flatMap(k => months.map(m => S.minutesMatrix[k][m] || 0)));
    const heat = v => v ? ';background:rgba(244,180,0,' + (0.08 + 0.32 * (v / maxCell)).toFixed(2) + ')' : '';
    const thR = t => '<th style="text-align:right;border-bottom:2px solid #d8dee7;padding:8px 8px;font-size:12px;color:#55605a;white-space:nowrap">' + esc(t) + '</th>';
    const cell = (v, extra, b) => '<td style="text-align:right;border-bottom:1px solid #eef1ec;padding:6px 8px;white-space:nowrap' + (extra || '') + '">' + (b ? '<b>' + v + '</b>' : v) + '</td>';
    return '<div style="background:#fff;border:1px solid #e2e6df;border-radius:10px;padding:14px 16px;margin:0 0 16px">' +
      '<b style="font-size:14px">Minuty oprav podle střediska a měsíce</b>' +
      '<div style="font-size:12px;color:#8a938a;margin:4px 0 8px">Středisko dle zadavatele závady (z databáze zaměstnanců). Celkem = celé období.</div>' +
      '<table style="border-collapse:collapse;width:100%"><thead><tr>' + th('Středisko') + months.map(m => thR(m.slice(5) + '/' + m.slice(2, 4))).join('') + thR('Celkem') + '</tr></thead><tbody>' +
      sorted.map(k => '<tr>' + td(esc(k)) + months.map(m => { const v = S.minutesMatrix[k][m] || 0; return cell(v ? fmt(v) : '<span style="color:#c6ccc4">—</span>', heat(v)); }).join('') + cell(fmt(total(k)), '', 1) + '</tr>').join('') +
      '<tr>' + td('<b>Celkem</b>') + months.map(m => cell(fmt(colTotal(m)), '', 1)).join('') + cell(fmt(sorted.reduce((s, k) => s + total(k), 0)), '', 1) + '</tr>' +
      '</tbody></table></div>';
  }

  // Tabulka závad jako na stránce (řazeno od nejnovější, se střediskem, stáří >60 dní červeně).
  function issuesTableHtml(S) {
    const CAP = 60;
    const list = S.issues.slice(0, CAP);
    return '<div style="background:#fff;border:1px solid #e2e6df;border-radius:10px;padding:14px 16px;margin:0 0 16px">' +
      '<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>' +
      [th('Závada'), th('Datum'), th('Stav'), th('Kdo chybu způsobil'), th('Zadal(a)'), th('Středisko'), th('Ks'), th('Minut oprava'), th('Stáří')].join('') + '</tr></thead><tbody>' +
      list.map(x => { const a = S.age(x); const oldOpen = a != null && a > 60 && !isClosed(x.status);
        return '<tr>' + td('<b>#' + esc(x.num) + '</b>') + td('<span style="white-space:nowrap">' + esc(czDate(x.date)) + '</span>') + td(stBadge(x.status)) +
        td(esc(x.culprit || '—')) + td(esc(x.creator || '—')) + td('<span style="font-size:12px;color:#6b736c">' + esc(x.stredisko || '—') + '</span>') +
        td(x.ks != null ? fmt(x.ks) : esc(x.ksRaw || '—'), 1) + td(fmt(x.minutes), 1) +
        td(a != null ? '<span style="white-space:nowrap;color:' + (oldOpen ? '#a03a2c' : '#8a938a') + '">' + fmt(a) + ' d</span>' : '—', 1) + '</tr>'; }).join('') +
      '</tbody></table>' +
      (S.issues.length > CAP ? '<p style="color:#8a938a;font-size:12px;margin:8px 0 0">… zobrazeno ' + CAP + ' nejnovějších z ' + S.issues.length + ' závad — kompletní seznam v intranetu.</p>' : '') +
      '<p style="color:#8a938a;font-size:12px;margin:8px 0 0">Ks = počet kusů z pole Title v Qoolingu · Stáří červeně = otevřená závada starší 60 dní.</p></div>';
  }

  function buildReport() {
    const S = stats();
    const period = S.source || (S.issues[0] && S.issues[0].date) || '';
    const html = '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#1c1d1a;line-height:1.55;max-width:960px;background:#f6f7f5;padding:18px">' +
      '<h2 style="margin:0 0 4px">Qooling — kvalita</h2>' +
      '<p style="color:#6b736c;margin:0 0 16px;font-size:13px">Stav závad hlášených v Qoolingu — co je otevřené, kdo chyby způsobuje a kolik stojí opravy času. ' +
      'Celkem ' + fmt(S.issues.length) + ' evidovaných závad · Zdroj: ' + esc(period) + '</p>' +
      kpiRowHtml(S) + monthsChartHtml(S) + minutesMatrixHtml(S) + issuesTableHtml(S) +
      '<p style="margin:0;font-size:13px"><a href="' + esc((host.mailFrom && host.mailFrom.publicUrl || '')) + '/#modul=qooling" style="color:#1f4e79">→ Otevřít interaktivní přehled v intranetu (filtry, hledání)</a></p>' +
      '<hr style="border:0;border-top:1px solid #e6e9e3;margin:18px 0"><div style="font-size:12px;color:#8a938a">Automatický pondělní report · Intranet ELKOPLAST CZ → Qooling. Příjemce a zapnutí spravuje správce v modulu / v přehledu Rozesílky.</div></div>';
    return { subject: 'Qooling — týdenní stav závad · otevřených ' + S.open.length + ', nových za 30 dní ' + S.new30.length, html, count: S.open.length };
  }

  async function sendReport(toList) {
    const to = cleanEmails(toList);
    if (!to.length) return { ok: false, error: 'žádný příjemce' };
    const rep = buildReport();
    try {
      await host.deliver({ to: to.join(', '), fromAddr: (host.mailFrom && host.mailFrom.user) || '', fromName: (host.mailFrom && host.mailFrom.name) || 'Intranet ELKOPLAST — Qooling', subject: rep.subject, text: rep.subject, html: rep.html });
      return { ok: true, to, count: rep.count };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ---------- plánovač (pondělí, pojistka 1×/ISO-týden) ----------
  function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const wk = 1 + Math.round(((t - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  async function tick() {
    try { const s = await sync(false); if (s && !s.ok && !s.skipped) console.warn('[qooling] Drive sync neproběhl:', s.error); } catch (e) { console.error('[qooling] Drive sync:', e.message); }
    try {
      const cfg = loadCfg(); const now = new Date();
      if (!cfg.enabled) return;
      if (host.reportDisabled && host.reportDisabled('qooling-tydenni')) return;  // zrušeno v přehledu Rozesílky
      // POUZE ve zvolený den (výchozí pondělí) a od zvolené hodiny. Když ten den server neběží,
      // report se ten týden nepošle — radši vynechat, než ho poslat v sobotu večer.
      if (now.getDay() !== cfg.weekday || now.getHours() < cfg.hour) return;
      let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
      const wk = isoWeek(now);
      if (st.lastWeek === wk) return;
      // Při chybě pošty zkusíme znovu při další hodinové kontrole, ale nejvýš 3× za týden
      // (jinak by se log Rozesílek zaplnil desítkami chybových pokusů).
      if (st.failWeek === wk && (st.failCount || 0) >= 3) return;
      const r = await sendReport(cfg.to);
      if (r.ok) { st.lastWeek = wk; st.lastAt = now.toISOString(); st.lastError = ''; delete st.failWeek; delete st.failCount; }
      else { st.failCount = (st.failWeek === wk ? (st.failCount || 0) : 0) + 1; st.failWeek = wk; st.lastError = r.error || 'odeslání selhalo'; st.lastErrorAt = now.toISOString(); }
      st.lastResult = r;
      try { fs.writeFileSync(STATE_F, JSON.stringify(st, null, 2)); } catch (_) {}
      console.log('[qooling] týdenní report: ' + (r.ok ? 'odesláno (' + r.to.join(', ') + ')' : 'CHYBA (pokus ' + st.failCount + '/3) ' + st.lastError));
    } catch (e) { console.error('[qooling] tick:', e.message); }
  }

  // ---------- router ----------
  const hasAccess = req => { if (host.isAdmin(req)) return true; try { const e = host.empSession(req); return !!(e && host.employeeModules(e.email).indexOf('qooling') >= 0); } catch (_) { return false; } };
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true), p = u.pathname;
    if (!p.startsWith('/api/qooling')) return false;

    if (p === '/api/qooling' && req.method === 'GET') {
      if (!hasAccess(req)) { json(res, 403, { error: 'K modulu Qooling nemáte přístup.' }); return true; }
      const S = stats();
      json(res, 200, {
        issues: S.issues.map(x => Object.assign({}, x, { ageDays: S.age(x) })),
        open: S.open.length, inProgress: S.inProgress.length, new7: S.new7.length, new30: S.new30.length,
        minutesOpen: S.minutesOpen, culprits: S.culprits, months: S.months, minutesMatrix: S.minutesMatrix,
        source: S.source, syncedAt: S.syncedAt, admin: !!host.isAdmin(req),
        config: host.isAdmin(req) ? loadCfg() : undefined
      });
      return true;
    }
    if (!host.isAdmin(req)) { json(res, 403, { error: 'Jen pro správce.' }); return true; }

    if (p === '/api/qooling/sync' && req.method === 'POST') {
      try { const r = await sync(true); return json(res, r.ok ? 200 : 500, r), true; }
      catch (e) { return json(res, 500, { ok: false, error: e.message }), true; }
    }
    if (p === '/api/qooling/config' && req.method === 'GET') {
      let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
      return json(res, 200, { config: loadCfg(), state: st, driveConfigured: !!(drive && drive.configured()), saEmail: (drive && drive.saEmail) ? drive.saEmail() : '', driveFolder: FOLDER }), true;
    }
    if (p === '/api/qooling/config' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) { json(res, 400, { error: 'Neplatné tělo.' }); return true; }
      const next = Object.assign({}, loadCfg());
      if (b.to != null) next.to = cleanEmails(b.to);
      if (b.enabled != null) next.enabled = !!b.enabled;
      if (b.weekday != null && b.weekday >= 0 && b.weekday <= 6) next.weekday = +b.weekday;
      saveCfg(next);
      return json(res, 200, { ok: true, config: next }), true;
    }
    if (p === '/api/qooling/preview' && req.method === 'GET') { return htmlOut(res, 200, buildReport().html), true; }
    if (p === '/api/qooling/send' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) {}
      const r = await sendReport(b.to ? b.to : loadCfg().to);
      return json(res, r.ok ? 200 : 500, r), true;
    }
    json(res, 404, { error: 'Not found' }); return true;
  }

  // Descriptor pro centrální přehled rozesílek (správce → „Rozesílky")
  const DNY = ['v neděli', 'v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu'];
  function reportDescriptor() {
    const c = loadCfg(); let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
    return {
      key: 'qooling-tydenni', module: 'Qooling', name: 'Týdenní stav závad kvality',
      to: c.to || [], enabled: !!c.enabled, day: c.weekday,
      schedule: 'týdně ' + (DNY[c.weekday] || 'v pondělí') + ' od ' + c.hour + ':00',
      lastAt: st.lastAt || null, lastError: st.lastError || '',
      preview: '/api/qooling/preview', send: { url: '/api/qooling/send', body: {} },
      configHint: 'Modul Qooling → 📧 Pondělní report'
    };
  }
  function reports() { return [reportDescriptor()]; }
  // Úprava z centrálního přehledu Rozesílky (příjemci / zapnutí / den v týdnu).
  function setReport(key, b) {
    if (key !== 'qooling-tydenni') return null;
    const next = Object.assign({}, loadCfg());
    if (b.to != null) next.to = cleanEmails(b.to);
    if (b.enabled != null) next.enabled = !!b.enabled;
    if (b.day != null && b.day >= 0 && b.day <= 6) next.weekday = +b.day;
    if (b.hour != null && b.hour >= 0 && b.hour <= 23) next.hour = +b.hour;
    saveCfg(next);
    return reportDescriptor();
  }

  return { handle, tick, reports, setReport };
}

module.exports = { mount };

'use strict';
// ============================================================================
//  Obousměrná synchronizace modulu Výroba Popelnice s Google tabulkou
//  „ZAKÁZKY POPELNICE (intranet)" — jedna přehledná tabulka místo PLÁN VÝROBY + CONTRACT Bestellung.xlsx.
//
//  Listy: Objednávky · Položky · Katalog · Zákazníci · Přehled (vzorce) · _info
//  Směr intranet → tabulka: po každé změně (debounce) a každých N minut se listy přepíšou celé.
//  Směr tabulka → intranet: před každým zápisem se listy načtou; řádek, jehož editovatelné buňky se liší
//  od toho, co intranet naposledy zapsal (otisk v d.sheetSync.otisky[id]), se převezme do intranetu
//  (jen povolené sloupce). Nový řádek v Položkách bez ID (s BE číslem, kódem a ks) založí položku.
//  Poslední zápis vyhrává; každá změna z tabulky se zapíše do historie položky jako „úprava z tabulky".
// ----------------------------------------------------------------------------
const https = require('https');
const crypto = require('crypto');

const SCOPE_RW = 'https://www.googleapis.com/auth/spreadsheets';

function api(token, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ method, hostname: 'sheets.googleapis.com', path, headers: Object.assign({ Authorization: 'Bearer ' + token }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, resp => {
      resp.setEncoding('utf8'); let s = ''; resp.on('data', c => s += c); resp.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(j || {}); else reject(new Error('Sheets ' + resp.statusCode + ': ' + ((j && j.error && j.error.message) || s.slice(0, 200)))); });
    });
    req.on('error', e => reject(new Error('Spojení se Sheets: ' + e.message)));
    req.setTimeout(30000, () => { try { req.destroy(new Error('Sheets: časový limit.')); } catch (_) {} });
    if (data) req.write(data); req.end();
  });
}
const enc = s => encodeURIComponent(s);
const q = (title, rng) => enc("'" + title.replace(/'/g, "''") + "'!" + rng);

// ---- definice listů ---------------------------------------------------------
// Každý sloupec: { k: klíč v datech, h: hlavička, w: šířka px, edit: smí se měnit v tabulce, typ: 'n' číslo | 'd' datum | 'b' ano/ne | 'sel' výběr }
const OBJ_COLS = [
  { k: 'cislo', h: 'Bestellung', w: 95, edit: true },
  { k: 'cisloAU', h: 'Auftrag', w: 90, edit: true },
  { k: 'helios', h: 'Helios zakázka', w: 95, edit: true },
  { k: 'datum', h: 'Datum obj.', w: 90, edit: true, typ: 'd' },
  { k: 'zakaznik', h: 'Zákazník', w: 200 },
  { k: 'prijemce', h: 'Příjemce', w: 200 },
  { k: 'prijemceAdresa', h: 'Adresa dodání', w: 220 },
  { k: 'kwDodani', h: 'KW dodání', w: 70, edit: true, typ: 'n' },
  { k: 'terminDodani', h: 'Termín dodání', w: 95, edit: true, typ: 'd' },
  { k: 'stav', h: 'Stav', w: 130 },
  { k: 'potvrzena', h: 'Potvrzena', w: 75, edit: true, typ: 'b' },
  { k: 'polozek', h: 'Položek', w: 60, typ: 'n' },
  { k: 'ks', h: 'Ks', w: 55, typ: 'n' },
  { k: 'kg', h: 'Kg', w: 65, typ: 'n' },
  { k: 'kamiony', h: 'Kamion', w: 90 },
  { k: 'loznyplan', h: 'Ložný plán', w: 95 },
  { k: 'doprava', h: 'Doprava', w: 110, edit: true },
  { k: 'poznamka', h: 'Poznámka', w: 260, edit: true },
  { k: 'driveUrl', h: 'Složka na Disku', w: 120, edit: true },
  { k: 'id', h: 'ID', w: 110 },
];
const POL_COLS = [
  { k: 'cvz', h: 'ČVZ', w: 70 },
  { k: 'cislo', h: 'Bestellung', w: 90 },
  { k: 'helios', h: 'Helios zakázka', w: 90 },
  { k: 'prijemce', h: 'Příjemce', w: 190 },
  { k: 'kod', h: 'Výrobek (kód)', w: 190, edit: true },
  { k: 'nazev', h: 'Název / popis', w: 170, edit: true },
  { k: 'ks', h: 'Ks', w: 50, edit: true, typ: 'n' },
  { k: 'rozmer', h: 'Rozměr', w: 130, edit: true },
  { k: 'tloustka', h: 'mm', w: 45, edit: true, typ: 'n' },
  { k: 'objem', h: 'm³', w: 50, typ: 'n' },
  { k: 'kgKs', h: 'kg/ks', w: 55, edit: true, typ: 'n' },
  { k: 'kgCelkem', h: 'kg celkem', w: 70, typ: 'n' },
  { k: 'povrch', h: 'Povrch', w: 85, edit: true, typ: 'sel', vals: ['lak', 'zinek', 'zaklad', 'bez'] },
  { k: 'ral', h: 'RAL', w: 80, edit: true },
  { k: 'lem', h: 'Lem RAL', w: 75, edit: true },
  { k: 'razeni', h: 'Ražení názvu', w: 200, edit: true },
  { k: 'polepy', h: 'Polepy', w: 150, edit: true },
  { k: 'heliosPolozka', h: 'Helios pol.', w: 70, edit: true },
  { k: 'cena', h: 'Cena €/ks', w: 70, edit: true, typ: 'n' },
  { k: 'vykresStav', h: 'Výkres', w: 110, edit: true, typ: 'sel', vals: ['neni', 'poslan', 'schvalen', 'vydan'] },
  { k: 'zadanoDne', h: 'Zadáno', w: 85, typ: 'd' },
  { k: 'terminVyroby', h: 'Termín výroby', w: 95, edit: true, typ: 'd' },
  { k: 'kwDodani', h: 'KW dodání', w: 65, typ: 'n' },
  { k: 'stav', h: 'Stav', w: 130, edit: true, typ: 'sel' },
  { k: 'hotovoKs', h: 'Hotovo ks', w: 65, edit: true, typ: 'n' },
  { k: 'kamion', h: 'Kamion', w: 75, edit: true },
  { k: 'expedovanoDne', h: 'Expedováno', w: 90, edit: true, typ: 'd' },
  { k: 'dorucenoDne', h: 'Doručeno', w: 90, edit: true, typ: 'd' },
  { k: 'poznamka', h: 'Poznámka', w: 240, edit: true },
  { k: 'id', h: 'ID', w: 110 },
];
const KAT_COLS = [
  { k: 'kod', h: 'Kód', w: 200, edit: true }, { k: 'nazev', h: 'Název', w: 200, edit: true }, { k: 'rada', h: 'Řada', w: 60 },
  { k: 'objem', h: 'm³', w: 55, edit: true, typ: 'n' }, { k: 'rozmer', h: 'Rozměr', w: 140, edit: true }, { k: 'tloustka', h: 'mm', w: 45, edit: true, typ: 'n' },
  { k: 'kg', h: 'kg/ks', w: 60, edit: true, typ: 'n' }, { k: 'povrch', h: 'Povrch', w: 80, edit: true, typ: 'sel', vals: ['lak', 'zinek', 'zaklad', 'bez'] },
  { k: 'stoh', h: 'Stoh (ks)', w: 65, edit: true, typ: 'n' }, { k: 'aktivni', h: 'Aktivní', w: 60, edit: true, typ: 'b' }, { k: 'id', h: 'ID', w: 110 },
];
const ZAK_COLS = [
  { k: 'nazev', h: 'Název', w: 220, edit: true }, { k: 'ulice', h: 'Ulice', w: 170, edit: true }, { k: 'psc', h: 'PSČ', w: 60, edit: true }, { k: 'mesto', h: 'Město', w: 130, edit: true },
  { k: 'zeme', h: 'Země', w: 50, edit: true }, { k: 'partner', h: 'Partner', w: 80, edit: true, typ: 'sel', vals: ['contract', 'primy'] },
  { k: 'kontakt', h: 'Kontakt', w: 140, edit: true }, { k: 'email', h: 'E-mail', w: 160, edit: true }, { k: 'telefon', h: 'Telefon', w: 110, edit: true },
  { k: 'jazyk', h: 'Jazyk', w: 50, edit: true }, { k: 'poznamka', h: 'Poznámka', w: 200, edit: true }, { k: 'id', h: 'ID', w: 110 },
];
const LISTY = { objednavky: 'Objednávky', polozky: 'Položky', katalog: 'Katalog', zakaznici: 'Zákazníci', prehled: 'Přehled', info: '_info' };

const colLetter = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// osamocené UTF-16 surrogáty (vzniklé oříznutím textu z PDF) Sheets nepřijme shodně → odstranit před zápisem i porovnáním
const cistyText = s => String(s).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').replace(/\ufffd+/g, '');
const fmtCell = (v, typ) => { if (v == null || v === '') return ''; if (typ === 'b') return v ? 'ano' : 'ne'; if (typ === 'd') return String(v).slice(0, 10); return typeof v === 'string' ? cistyText(v) : v; };
const otisk = vals => crypto.createHash('sha1').update(JSON.stringify(vals)).digest('hex').slice(0, 16);

function mount(host, ctx) {
  // ctx: { load, save, STAVY, stavLabel(k), stavKey(label), obohat(d) → {objednavky:[...obohacené]}, aplikujZTabulky(d, list, radek, r) }
  const log = (...a) => console.log('[vyroba/sheet]', ...a);
  let bezi = false; let pushTimer = null; let posledni = { at: null, chyba: null, pull: null, push: null };

  async function token() { return host.sheets.token(SCOPE_RW); }
  function sheetId(d) { return (d.nastaveni.syncSheetId || '').trim(); }

  // ---- struktura tabulky (jednorázově / při chybějících listech) ---------------------
  async function ensureStructure(tok, sid, d) {
    const meta = await api(tok, 'GET', '/v4/spreadsheets/' + enc(sid) + '?fields=sheets.properties(sheetId,title,index,gridProperties.columnCount)');
    const sheets = (meta.sheets || []).map(s => s.properties);
    const byTitle = {}; sheets.forEach(s => { byTitle[s.title] = s; });
    const reqs = [];
    const want = [LISTY.prehled, LISTY.objednavky, LISTY.polozky, LISTY.katalog, LISTY.zakaznici, LISTY.info];
    want.forEach((t, i) => { if (!byTitle[t]) reqs.push({ addSheet: { properties: { title: t, index: i, gridProperties: { frozenRowCount: 1, columnCount: 40 } } } }); });
    // výchozí „List 1" přejmenovat na Přehled, pokud existuje jen on
    if (!byTitle[LISTY.prehled] && sheets.length === 1 && /^(List|Sheet)\s?1$/i.test(sheets[0].title)) { reqs.length = 0; reqs.push({ updateSheetProperties: { properties: { sheetId: sheets[0].sheetId, title: LISTY.prehled }, fields: 'title' } }); want.slice(1).forEach((t, i) => reqs.push({ addSheet: { properties: { title: t, index: i + 1, gridProperties: { frozenRowCount: 1 } } } })); }
    if (reqs.length) await api(tok, 'POST', '/v4/spreadsheets/' + enc(sid) + ':batchUpdate', { requests: reqs });
    const meta2 = reqs.length ? await api(tok, 'GET', '/v4/spreadsheets/' + enc(sid) + '?fields=sheets.properties(sheetId,title,gridProperties.columnCount)') : meta;
    const ids = {}, cols = {}; (meta2.sheets || []).forEach(s => { ids[s.properties.title] = s.properties.sheetId; cols[s.properties.title] = (s.properties.gridProperties || {}).columnCount || 26; });
    // listy musí mít dost sloupců (nový list má jen 26)
    const need = { [LISTY.objednavky]: OBJ_COLS.length, [LISTY.polozky]: POL_COLS.length, [LISTY.katalog]: KAT_COLS.length, [LISTY.zakaznici]: ZAK_COLS.length };
    const ext = Object.keys(need).filter(t => ids[t] != null && cols[t] < need[t] + 2).map(t => ({ appendDimension: { sheetId: ids[t], dimension: 'COLUMNS', length: need[t] + 2 - cols[t] } }));
    if (ext.length) await api(tok, 'POST', '/v4/spreadsheets/' + enc(sid) + ':batchUpdate', { requests: ext });
    return ids;
  }
  function formatRequests(gid, cols, d) {
    const n = cols.length; const reqs = [];
    reqs.push({ updateSheetProperties: { properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    reqs.push({ repeatCell: { range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: n }, cell: { userEnteredFormat: { backgroundColor: { red: 0.055, green: 0.54, blue: 0.263 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, wrapStrategy: 'CLIP', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)' } });
    cols.forEach((c, i) => reqs.push({ updateDimensionProperties: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: c.w || 100 }, fields: 'pixelSize' } }));
    // needitovatelné sloupce šedě (počítá je intranet)
    cols.forEach((c, i) => { if (!c.edit) reqs.push({ repeatCell: { range: { sheetId: gid, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.96, green: 0.97, blue: 0.96 }, textFormat: { foregroundColor: { red: 0.36, green: 0.39, blue: 0.36 } } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } }); });
    // rozbalovací seznamy
    cols.forEach((c, i) => {
      if (c.typ === 'sel') {
        const vals = c.k === 'stav' ? ctx.STAVY.map(s => s[1]) : c.vals;
        reqs.push({ setDataValidation: { range: { sheetId: gid, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 }, rule: { condition: { type: 'ONE_OF_LIST', values: vals.map(v => ({ userEnteredValue: v })) }, strict: false, showCustomUi: true } } });
      }
      if (c.typ === 'b') reqs.push({ setDataValidation: { range: { sheetId: gid, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 }, rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'ano' }, { userEnteredValue: 'ne' }] }, strict: false, showCustomUi: true } } });
      if (c.typ === 'd') reqs.push({ repeatCell: { range: { sheetId: gid, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'd.m.yyyy' } } }, fields: 'userEnteredFormat.numberFormat' } });
    });
    // barvy stavů
    const si = cols.findIndex(c => c.k === 'stav');
    if (si >= 0) {
      const barvy = { 'Objednávka přijata': [0.93, 0.93, 0.93], 'Zadáno do výroby': [0.85, 0.91, 0.97], 'Svařovna': [0.85, 0.91, 0.97], 'Lakovna': [1, 0.95, 0.8], 'Zinkovna': [1, 0.95, 0.8], 'Hotovo na skladě': [0.85, 0.95, 0.87], 'Naplánováno na LKW': [0.91, 0.87, 0.96], 'Expedováno': [0.8, 0.93, 0.83], 'Doručeno': [0.8, 0.93, 0.83], 'Pozastaveno': [1, 0.9, 0.8], 'Storno': [0.98, 0.85, 0.85] };
      Object.keys(barvy).forEach(lbl => { const c = barvy[lbl]; reqs.push({ addConditionalFormatRule: { rule: { ranges: [{ sheetId: gid, startRowIndex: 1, startColumnIndex: si, endColumnIndex: si + 1 }], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: lbl }] }, format: { backgroundColor: { red: c[0], green: c[1], blue: c[2] } } } }, index: 0 } }); });
    }
    return reqs;
  }
  async function formatAll(tok, sid, ids, d) {
    // smazat staré podmíněné formáty (aby se nehromadily) → jednodušší je list vyčistit formátem jen 1× (příznak)
    const reqs = [].concat(formatRequests(ids[LISTY.objednavky], OBJ_COLS, d), formatRequests(ids[LISTY.polozky], POL_COLS, d), formatRequests(ids[LISTY.katalog], KAT_COLS, d), formatRequests(ids[LISTY.zakaznici], ZAK_COLS, d));
    await api(tok, 'POST', '/v4/spreadsheets/' + enc(sid) + ':batchUpdate', { requests: reqs });
  }

  // ---- řádky pro tabulku ----------------------------------------------------------
  function radkyObjednavek(ob) {
    return ob.map(o => OBJ_COLS.map(c => {
      if (c.k === 'stav') return ctx.stavLabel(o.stav);
      if (c.k === 'polozek') return o.polozky.filter(p => p.stav !== 'storno').length;
      if (c.k === 'kamiony') return Array.from(new Set(o.polozky.map(p => p.kamion).filter(Boolean))).join(', ');
      if (c.k === 'loznyplan') return o.loznyplan ? (o.loznyplan.orderNo + ' · ' + String(o.loznyplan.sentAt).slice(0, 10)) : '';
      return fmtCell(o[c.k], c.typ);
    }));
  }
  function radkyPolozek(ob) {
    const out = [];
    ob.forEach(o => o.polozky.forEach(p => out.push(POL_COLS.map(c => {
      if (c.k === 'cislo') return o.cislo; if (c.k === 'helios') return o.helios; if (c.k === 'prijemce') return o.prijemce || o.zakaznik; if (c.k === 'kwDodani') return o.kwDodani || '';
      if (c.k === 'stav') return ctx.stavLabel(p.stav); if (c.k === 'vykresStav') return (p.vykres && p.vykres.stav) || 'neni';
      return fmtCell(p[c.k], c.typ);
    }))));
    return out;
  }
  const radkyKatalog = d => d.katalog.map(k => KAT_COLS.map(c => fmtCell(k[c.k], c.typ)));
  const radkyZak = d => d.zakaznici.map(z => ZAK_COLS.map(c => fmtCell(z[c.k], c.typ)));

  function prehledRows() {
    const O = LISTY.objednavky, P = LISTY.polozky; const pc = k => colLetter(POL_COLS.findIndex(c => c.k === k)); const oc = k => colLetter(OBJ_COLS.findIndex(c => c.k === k));
    const st = pc('stav'), ks = pc('ks'), kg = pc('kgCelkem'), tv = pc('terminVyroby');
    const rows = [['ZAKÁZKY POPELNICE — přehled (počítá se ze záložky Položky)', '', '', ''], ['Aktualizováno', "=INDEX('_info'!B:B;2)", '', ''], ['', '', '', ''], ['Stav položky', 'Položek', 'Ks', 'Kg']];
    ctx.STAVY.forEach(s => rows.push([s[1], `=COUNTIF('${P}'!${st}:${st};A${rows.length + 1})`, `=SUMIF('${P}'!${st}:${st};A${rows.length + 1};'${P}'!${ks}:${ks})`, `=SUMIF('${P}'!${st}:${st};A${rows.length + 1};'${P}'!${kg}:${kg})`]));
    rows.push(['', '', '', '']);
    rows.push(['Ve skluzu (termín výroby < dnes, nehotové)', `=COUNTIFS('${P}'!${tv}:${tv};"<"&TODAY();'${P}'!${st}:${st};"Zadáno do výroby")+COUNTIFS('${P}'!${tv}:${tv};"<"&TODAY();'${P}'!${st}:${st};"Svařovna")+COUNTIFS('${P}'!${tv}:${tv};"<"&TODAY();'${P}'!${st}:${st};"Lakovna")+COUNTIFS('${P}'!${tv}:${tv};"<"&TODAY();'${P}'!${st}:${st};"Zinkovna")`, '', '']);
    rows.push(['Objednávek celkem', `=COUNTA('${O}'!${oc('id')}:${oc('id')})-1`, '', '']);
    rows.push(['Objednávek nepotvrzených', `=COUNTIF('${O}'!${oc('potvrzena')}:${oc('potvrzena')};"ne")`, '', '']);
    rows.push(['', '', '', '']);
    rows.push(['Jak tabulka funguje', '', '', '']);
    rows.push(['• Tabulku plní intranet (modul Výroba Popelnice). Šedé sloupce počítá intranet, neupravujte je.', '', '', '']);
    rows.push(['• Bílé sloupce můžete upravit tady: intranet si změnu převezme do několika minut a zapíše ji do historie položky.', '', '', '']);
    rows.push(['• Nová položka: v listu Položky vyplňte řádek dole (Bestellung, kód výrobku, ks, RAL, ražení…) a nechte ID prázdné. Intranet ji založí a doplní ČVZ po zadání do výroby.', '', '', '']);
    rows.push(['• Nemažte řádky – stornujte položku stavem „Storno" (v intranetu nebo tady).', '', '', '']);
    return rows;
  }

  // ---- načtení z tabulky a převzetí změn ----------------------------------------------
  async function readTab(tok, sid, title) {
    const r = await api(tok, 'GET', '/v4/spreadsheets/' + enc(sid) + '/values/' + q(title, 'A1:AZ5000') + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING');
    return r.values || [];
  }
  const normD = v => { if (v == null || v === '') return ''; const s = String(v).trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0]; m = s.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); if (/^\d{4,6}(\.\d+)?$/.test(s)) { const n = Number(s); if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10); } return s; };
  const normB = v => /^(ano|true|1|x|yes)$/i.test(String(v == null ? '' : v).trim());
  const normN = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.').replace(/\s/g, '')); return Number.isFinite(n) ? n : null; };
  function rowToObj(cols, hdr, row) {
    const idx = {}; hdr.forEach((h, i) => { const c = cols.find(c => c.h === String(h).trim()); if (c) idx[c.k] = i; });
    const o = {}; cols.forEach(c => { if (idx[c.k] == null) return; let v = row[idx[c.k]]; if (v == null) v = ''; if (c.typ === 'd') v = normD(v); else if (c.typ === 'b') v = normB(v); else if (c.typ === 'n') v = normN(v); else v = String(v).trim(); o[c.k] = v; });
    return o;
  }
  // porovnání: hodnota v tabulce vs. to, co jsme tam naposledy zapsali (otisk celého řádku editovatelných sloupců)
  // (Sheets ořezává mezery na krajích buňky a čísla vrací jako number → normalizovat, aby se neobjevily falešné změny)
  function editVals(cols, obj) { return cols.filter(c => c.edit).map(c => { const v = obj[c.k]; if (c.typ === 'b') return v ? 'ano' : 'ne'; if (c.typ === 'n') { const n = Number(String(v == null ? '' : v).replace(',', '.')); return v == null || v === '' || !Number.isFinite(n) ? '' : Math.round(n * 10000) / 10000; } return v == null ? '' : cistyText(String(v)).replace(/\s+/g, ' ').trim(); }); }

  async function pull(tok, sid, d) {
    const stat = { objednavky: 0, polozky: 0, katalog: 0, zakaznici: 0, novePolozky: 0, chyby: [] };
    const ot = d.sheetSync.otisky || {};
    const tabs = { objednavky: [LISTY.objednavky, OBJ_COLS], polozky: [LISTY.polozky, POL_COLS], katalog: [LISTY.katalog, KAT_COLS], zakaznici: [LISTY.zakaznici, ZAK_COLS] };
    for (const key of Object.keys(tabs)) {
      const [title, cols] = tabs[key];
      let rows; try { rows = await readTab(tok, sid, title); } catch (e) { stat.chyby.push(title + ': ' + e.message); continue; }
      if (rows.length < 2) continue;
      const hdr = rows[0];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]; if (!row || !row.some(v => v !== '' && v != null)) continue;
        const obj = rowToObj(cols, hdr, row);
        const id = obj.id || '';
        if (!id) {
          if (key === 'polozky' && obj.kod && obj.ks) { try { if (ctx.novaZTabulky(d, obj)) { stat.novePolozky++; } } catch (e) { stat.chyby.push(title + ' ř.' + (i + 1) + ': ' + e.message); } }
          continue;
        }
        const h = otisk(editVals(cols, obj));
        if (ot[id] && ot[id] === h) continue;          // beze změny od posledního zápisu
        if (!ot[id]) continue;                          // řádek, který jsme ještě nezapsali (např. po přesunu) → nejdřív push
        try { if (ctx.aplikujZTabulky(d, key, obj)) stat[key]++; } catch (e) { stat.chyby.push(title + ' ř.' + (i + 1) + ': ' + e.message); }
      }
    }
    return stat;
  }

  async function push(tok, sid, d, ids) {
    const ob = ctx.obohat(d);
    const data = [
      { range: "'" + LISTY.objednavky + "'!A1", values: [OBJ_COLS.map(c => c.h)].concat(radkyObjednavek(ob)) },
      { range: "'" + LISTY.polozky + "'!A1", values: [POL_COLS.map(c => c.h)].concat(radkyPolozek(ob)) },
      { range: "'" + LISTY.katalog + "'!A1", values: [KAT_COLS.map(c => c.h)].concat(radkyKatalog(d)) },
      { range: "'" + LISTY.zakaznici + "'!A1", values: [ZAK_COLS.map(c => c.h)].concat(radkyZak(d)) },
      { range: "'" + LISTY.prehled + "'!A1", values: prehledRows() },
      { range: "'" + LISTY.info + "'!A1", values: [['Aktualizováno', new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' })], ['Zdroj', 'intranet.elkoplast.cz → Výroba Popelnice'], ['Objednávek', ob.length], ['Položek', ob.reduce((s, o) => s + o.polozky.length, 0)], ['', ''], ['Sloupce, které intranet přebírá z tabulky', ''], ['Objednávky', OBJ_COLS.filter(c => c.edit).map(c => c.h).join(', ')], ['Položky', POL_COLS.filter(c => c.edit).map(c => c.h).join(', ')], ['Katalog', KAT_COLS.filter(c => c.edit).map(c => c.h).join(', ')], ['Zákazníci', ZAK_COLS.filter(c => c.edit).map(c => c.h).join(', ')]] },
    ];
    // vyčistit listy (řádky, které zmizely) a zapsat
    await api(tok, 'POST', '/v4/spreadsheets/' + enc(sid) + '/values:batchClear', { ranges: [LISTY.objednavky, LISTY.polozky, LISTY.katalog, LISTY.zakaznici, LISTY.prehled, LISTY.info].map(t => "'" + t + "'!A1:AZ5000") });
    await api(tok, 'POST', '/v4/spreadsheets/' + enc(sid) + '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data });
    // otisky editovatelných sloupců – podle nich se pozná změna v tabulce
    const ot = {};
    ob.forEach(o => { const obj = {}; OBJ_COLS.forEach((c, i) => { obj[c.k] = radkyObjednavek([o])[0][i]; }); ot[o.id] = otisk(editVals(OBJ_COLS, Object.assign(obj, { potvrzena: !!o.potvrzena }))); });
    ob.forEach(o => o.polozky.forEach(p => { const row = radkyPolozek([Object.assign({}, o, { polozky: [p] })])[0]; const obj = {}; POL_COLS.forEach((c, i) => { obj[c.k] = row[i]; }); ot[p.id] = otisk(editVals(POL_COLS, obj)); }));
    d.katalog.forEach(k => { const row = radkyKatalog({ katalog: [k] })[0]; const obj = {}; KAT_COLS.forEach((c, i) => { obj[c.k] = row[i]; }); ot[k.id] = otisk(editVals(KAT_COLS, Object.assign(obj, { aktivni: k.aktivni !== false }))); });
    d.zakaznici.forEach(z => { const row = radkyZak({ zakaznici: [z] })[0]; const obj = {}; ZAK_COLS.forEach((c, i) => { obj[c.k] = row[i]; }); ot[z.id] = otisk(editVals(ZAK_COLS, obj)); });
    d.sheetSync.otisky = ot;
    return { objednavky: ob.length, polozky: ob.reduce((s, o) => s + o.polozky.length, 0) };
  }

  // ---- hlavní cyklus: pull → push ------------------------------------------------------
  async function sync(duvod) {
    if (bezi) return posledni;
    const d0 = ctx.load(); const sid = sheetId(d0);
    if (!sid || !(host.sheets && host.sheets.available && host.sheets.token)) return posledni;
    bezi = true;
    try {
      const tok = await token();
      const d = ctx.load(); d.sheetSync = d.sheetSync || {};
      const ids = await ensureStructure(tok, sid, d);
      if (!d.sheetSync.formatovano || d.sheetSync.formatovano !== sid) { try { await formatAll(tok, sid, ids, d); d.sheetSync.formatovano = sid; } catch (e) { log('formát:', e.message); } }
      const pl = await pull(tok, sid, d);
      const ps = await push(tok, sid, d, ids);
      d.sheetSync.at = new Date().toISOString(); d.sheetSync.pull = pl; d.sheetSync.push = ps; d.sheetSync.chyba = null;
      ctx.save(d);
      posledni = { at: d.sheetSync.at, chyba: null, pull: pl, push: ps, duvod };
      if (pl.objednavky || pl.polozky || pl.katalog || pl.zakaznici || pl.novePolozky) log('převzato z tabulky:', JSON.stringify(pl));
    } catch (e) {
      log('chyba synchronizace:', e.message);
      try { const d = ctx.load(); d.sheetSync = d.sheetSync || {}; d.sheetSync.chyba = e.message; d.sheetSync.chybaAt = new Date().toISOString(); ctx.save(d); } catch (_) {}
      posledni = { at: posledni.at, chyba: e.message, duvod };
    } finally { bezi = false; }
    return posledni;
  }
  // po změně v intranetu: zapsat do tabulky s malým zpožděním (sloučí rychlé změny za sebou)
  function naplanuj() { clearTimeout(pushTimer); pushTimer = setTimeout(() => { sync('změna v intranetu').catch(() => {}); }, 4000); }
  function tick() { sync('pravidelně').catch(() => {}); }
  function stav() { return Object.assign({}, posledni, { bezi }); }

  return { sync, naplanuj, tick, stav, LISTY, OBJ_COLS, POL_COLS };
}

module.exports = { mount };

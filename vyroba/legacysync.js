'use strict';
// ============================================================================
//  Obousměrné napojení na stávající plán výroby dílny:
//  Google Sheet „PLÁN VÝROBY BRUNTÁL POPELNICE", listy „Boxy contract 2026" a „Ostatní výrobky".
//
//  Dílna (Ladislav Mathé) a Renata v něm pracují dnes, proto ho intranet udržuje v jejich rozložení sloupců:
//   0 prefix (26B) · 1 pořadí · 2 Zadáno · 3 Výrobek · 4 Rozměr/Provedení · 5 Tloušťka · 6 Ks · 7 RAL (text) ·
//   8 Objem · 9 Číslo položky Helios · 10 Název (ražení, polepy) / Skladem · 11 stav / Hot. · 12 Číslo objednávky Helios ·
//   13 (název zákazníka / Kontakt) · 14 Místo dodání / Zákazník · 15 Požadovaný termín · 16 Poznámka / Exp. · 17 Expedice / Auto
//  Řádek = položka s ČVZ (prefix + pořadí). Intranet:
//   - přečte list, řádky změněné od posledního zápisu (otisk) převezme do intranetu (ks, RAL, ražení, poznámka, termín, expedice, stav),
//   - řádky bez známého ČVZ založí jako nové položky (stejná logika jako import),
//   - zapíše řádky, které se liší od stavu v intranetu (jen mapované sloupce; ostatní buňky řádku nechá),
//   - položky s ČVZ, které v listu chybí, přidá na konec,
//   - podbarví řádek podle stavu (zelená = hotovo, žlutá = lakovna/zinkovna, červená = storno; bílá = ve výrobě).
//  Zápis do listů je vypnutý (nastavení legacyZapis, výchozí NE): intranet plán výroby jen čte, dílna v něm pracuje dál po svém.
// ----------------------------------------------------------------------------
const sheetsync = require('./sheetsync'); const api = (...a) => sheetsync.api(...a); const { otisk } = sheetsync;
const enc = s => encodeURIComponent(s);
const q = (title, rng) => enc("'" + title.replace(/'/g, "''") + "'!" + rng);

const CZ = { boxy: { rozmer: 4, nazev: 10, stav: 11, poznamka: 16, expedice: 17, misto: 14, kontakt: 13 }, ostatni: { rozmer: 4, nazev: 10, stav: 11, poznamka: 16, expedice: 16, misto: 14, kontakt: 13, auto: 17 } };

const dmy2 = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '.' + m[2] + '.' + m[1].slice(2) : ''; };
const isoZ = s => { const t = String(s == null ? '' : s).trim(); let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0]; m = t.match(/(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{2,4})/); if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); } return ''; };
const cl = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const num = v => { const n = Number(String(v == null ? '' : v).replace(',', '.').replace(/\s/g, '')); return Number.isFinite(n) ? n : null; };

function mount(host, ctx) {
  // ctx: { load, save, stavLabel, stavKey, STAV_PORADI, importRows(d, rows, r, list), aplikujPole(d, p, pole) → bool, SYS }
  const log = (...a) => console.log('[vyroba/plan-vyroby]', ...a);
  let bezi = false; let posledni = { at: null, chyba: null, zapis: null };

  // ---- text sloupců v jejich formátu -------------------------------------------------
  function ralText(p) {
    if (p.povrch === 'zinek') return 'pozink';
    const ral = cl(p.ral); const lem = cl(p.lem).replace(/^RAL\s*/i, '');
    if (p.povrch === 'zaklad') return ral ? 'základ ' + ral : 'základ';
    if (!ral) return '';
    return (/^RAL/i.test(ral) ? 'lakování ' + ral : ral) + (lem ? ', horní lem ' + lem : '');
  }
  function nazevText(p) { return [p.razeni ? 'ražení názvu: ' + cl(p.razeni) : '', cl(p.polepy)].filter(Boolean).join(' '); }
  // ---- z jejich řádku do polí intranetu ------------------------------------------------
  function radekNaPole(row, list) {
    const c = CZ[list]; const ralT = cl(row[7]); const ralM = ralT.match(/RAL\s?(\d{4})/i); const lemM = ralT.match(/lem\s*(?:RAL\s?)?(\d{4})/i);
    const nazev = cl(row[c.nazev]); const razM = nazev.match(/ražení\s*názvu\s*[:\-]?\s*(.*?)(?:\s+polep.*)?$/i); const polM = nazev.match(/(polep[^\n]*)/i);
    return {
      kod: cl(row[3]), rozmer: cl(row[c.rozmer]), tloustka: num(row[5]), ks: num(row[6]),
      povrch: /pozink|zin/i.test(ralT) ? 'zinek' : (/zákl/i.test(ralT) ? 'zaklad' : (ralM ? 'lak' : '')),
      ral: ralM ? 'RAL ' + ralM[1] : (/pozink|zin|zákl/i.test(ralT) || !ralT ? '' : ralT), lem: lemM ? 'RAL ' + lemM[1] : '',
      razeni: razM ? cl(razM[1]) : (nazev && !/polep/i.test(nazev) && !/^komplet|víko|viko|hrazd/i.test(nazev) ? nazev : ''), polepy: polM ? cl(polM[1]) : '',
      heliosPolozka: cl(row[9]).replace(/\.0$/, ''), helios: cl(row[12]).replace(/\.0$/, ''),
      stavText: cl(row[c.stav]), terminVyroby: isoZ(row[15]), poznamka: cl(row[c.poznamka]), expedovanoDne: isoZ(row[c.expedice]),
      kamion: c.auto != null ? cl(row[c.auto]) : '',
    };
  }
  // otisk mapovaných buněk řádku (co porovnáváme se stavem po našem posledním zápisu)
  function otiskRadku(row, list) { const c = CZ[list]; const idx = [3, c.rozmer, 5, 6, 7, 9, c.nazev, c.stav, 12, 15, c.poznamka, c.expedice].concat(c.auto != null ? [c.auto] : []); return otisk(idx.map(i => cl(row[i]))); }
  // ---- z položky intranetu do jejich řádku ------------------------------------------------
  function poleNaRadek(p, o, list, row) {
    const c = CZ[list]; const r = (row || []).slice(); while (r.length < 18) r.push('');
    r[0] = p.cvz.slice(0, 3); r[1] = String(p.poradi).padStart(3, '0');
    r[2] = dmy2(p.zadanoDne) || r[2]; r[3] = p.kod; r[c.rozmer] = p.rozmer || ''; r[5] = p.tloustka == null ? '' : p.tloustka; r[6] = p.ks;
    r[7] = ralText(p); r[8] = p.objem == null ? '' : p.objem; r[9] = p.heliosPolozka || ''; r[c.nazev] = nazevText(p) || (list === 'ostatni' ? r[c.nazev] : '');
    r[c.stav] = ctx.stavLabel(p.stav); r[12] = o.helios || ''; r[c.misto] = o.prijemce || o.zakaznik || '';
    if (list === 'ostatni') r[c.kontakt] = r[c.kontakt] || ''; else r[13] = r[13] || '';
    r[15] = dmy2(o.terminDodani || p.terminVyroby) || ''; r[c.poznamka] = p.poznamka || ''; r[c.expedice] = dmy2(p.expedovanoDne) || (list === 'ostatni' ? r[c.expedice] : '');
    if (c.auto != null) r[c.auto] = p.kamion || '';
    return r.map(v => (v == null ? '' : v));
  }
  function barva(stav) {
    const P = ctx.STAV_PORADI;
    if (stav === 'storno') return { red: 0.98, green: 0.85, blue: 0.85 };
    if (stav === 'pozastaveno') return { red: 1, green: 0.9, blue: 0.8 };
    if (stav === 'lakovna' || stav === 'zinkovna') return { red: 1, green: 0.95, blue: 0.75 };
    if (P[stav] >= P.hotovo) return { red: 0.8, green: 0.93, blue: 0.8 };
    return { red: 1, green: 1, blue: 1 };
  }

  async function syncList(tokR, tok, sid, _d, list, title, gidMap, r) {
    const stat = { list: title, prevzato: 0, novych: 0, zapsano: 0, pridano: 0, chyby: [] };
    const resp = await api(tokR, 'GET', '/v4/spreadsheets/' + enc(sid) + '/values/' + q(title, 'A1:R3000') + '?valueRenderOption=FORMATTED_VALUE');
    const rows = resp.values || []; if (!rows.length) return stat;
    // barvy buněk (sloupec A = ČVZ, C = Zadáno): dílna jimi značí svařeno / lakováno / zinkováno
    let barvy = [];
    try {
      const g = await api(tokR, 'GET', '/v4/spreadsheets/' + enc(sid) + '?ranges=' + q(title, 'A1:C' + rows.length) + '&includeGridData=true&fields=' + enc('sheets.data.rowData.values.effectiveFormat.backgroundColor'));
      const rd = (((g.sheets || [])[0] || {}).data || [])[0] || {}; barvy = rd.rowData || [];
    } catch (e) { stat.chyby.push('barvy: ' + e.message); }
    const hexOf = (rowIdx, col) => { const v = ((barvy[rowIdx] || {}).values || [])[col]; const c = v && v.effectiveFormat && v.effectiveFormat.backgroundColor; if (!c) return ''; return ['red', 'green', 'blue'].map(k => Math.round((c[k] || 0) * 255)).join(','); };
    const jeZelena = h => h === '0,255,0' || h === '0,255,0'; const jeZluta = h => h === '255,255,0';
    // od teď bez čekání na síť: čerstvá data, změny z listu, výpočet zápisu, uložení
    let d = ctx.load(); d.legacySync = d.legacySync || {}; d.legacySync.otisky = d.legacySync.otisky || {};
    const ot = Object.assign({}, d.legacySync.otisky); let zmena = false;
    const byCvz = {}; d.polozky.forEach(p => { if (p.cvz) byCvz[p.cvz] = p; });
    const rowOf = {}; const nove = []; const otiskyZListu = {};
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || []; const prefix = cl(row[0]).replace(/\s/g, ''); const por = Math.round(num(row[1]) || 0);
      if (!/^\d{2}B$/i.test(prefix) || !por || !cl(row[3])) continue;
      const cvz = prefix.slice(0, 2) + 'B-' + String(por).padStart(3, '0');
      if (otiskyZListu[cvz] != null) { stat.duplicity = (stat.duplicity || 0) + 1; continue; }   // stejné ČVZ podruhé v listu → bere se první výskyt
      const p = byCvz[cvz];
      if (!p) { nove.push(row); continue; }
      rowOf[cvz] = i + 1;
      const h = otiskRadku(row, list); otiskyZListu[cvz] = h;
      // barvy → stav (jen dopředu, jen když se barva od minula změnila nebo je to první čtení)
      const bA = hexOf(i, 0), bC = hexOf(i, 2); const bh = bA + '|' + bC; const bk = 'barva:' + cvz;
      if (ot[bk] !== bh) { ot[bk] = bh; otiskyZListu[bk] = bh; try { if (ctx.aplikujBarvu(d, p, { svareno: jeZelena(bA), lakovano: jeZelena(bC), zinkovano: jeZluta(bC), expedice: isoZ(row[CZ[list].expedice]) })) { stat.podleBarvy = (stat.podleBarvy || 0) + 1; zmena = true; } } catch (e) { stat.chyby.push(cvz + ' barva: ' + e.message); } }
      if (ot[cvz] && ot[cvz] !== h) { try { if (ctx.aplikujPole(d, p, radekNaPole(row, list))) { stat.prevzato++; zmena = true; } } catch (e) { stat.chyby.push(cvz + ': ' + e.message); } }
    }
    if (nove.length) { try { const s = ctx.importRows(d, nove, r, list); stat.novych = s.polozek; if (s.polozek || s.aktualizovano || s.objednavek) zmena = true; } catch (e) { stat.chyby.push('nové řádky: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); } }
    // ---- zápis: řádky, které se liší od intranetu (jen naše položky roku listu) ------
    const rokList = 2000 + Number((rows.find((rw, i) => i > 0 && /^\d{2}B$/i.test(cl(rw[0]))) || ['26B'])[0].slice(0, 2)) || new Date().getFullYear();
    const objById = {}; d.objednavky.forEach(o => { objById[o.id] = o; });
    const ob = ctx.obohat(d); const obById = {}; ob.forEach(o => { obById[o.id] = o; });
    const data = []; const appendRows = []; const fmt = [];
    const gid = gidMap[title];
    const patri = p => p.cvz && p.rok === rokList && !p.mimoBruntal && ctx.listPolozky(d, p) === list;
    d.polozky.filter(patri).forEach(p => {
      const o = obById[p.objId] || objById[p.objId] || {};
      const rn = rowOf[p.cvz];
      if (rn) {
        const cur = rows[rn - 1] || []; const novy = poleNaRadek(p, o, list, cur);
        const stejny = novy.every((v, i) => cl(v) === cl(cur[i]));
        if (!stejny) { data.push({ range: "'" + title + "'!A" + rn + ':R' + rn, values: [novy] }); stat.zapsano++; }
        const nh = otiskRadku(novy, list); if (ot[p.cvz] !== nh) { data.push({ _cvz: p.cvz, _h: nh, range: null }); if (gid != null) fmt.push({ repeatCell: { range: { sheetId: gid, startRowIndex: rn - 1, endRowIndex: rn, startColumnIndex: 0, endColumnIndex: 18 }, cell: { userEnteredFormat: { backgroundColor: barva(p.stav) } }, fields: 'userEnteredFormat.backgroundColor' } }); }
      } else {
        const novy = poleNaRadek(p, o, list, null); appendRows.push({ p, novy }); ot[p.cvz] = otiskRadku(novy, list);
      }
    });
    // zápis (potřebuje roli Editor u tabulky; bez ní se změny z intranetu jen počítají a čekají)
    stat.kZapsani = data.filter(x => x.range).length + appendRows.length;
    if (zmena) ctx.save(d);
    // Rozhodnutí 19. 9. 2026 (David Surý): do plánu výroby dílny intranet NEZAPISUJE — jen čte. Otisky si uložíme,
    // aby se příště poznalo, co se v listu změnilo; rozdíly proti intranetu jen počítáme (stat.kZapsani).
    if (!ctx.zapisPovolen || !ctx.zapisPovolen()) { const d2 = ctx.load(); d2.legacySync = d2.legacySync || {}; d2.legacySync.otisky = Object.assign({}, d2.legacySync.otisky || {}, otiskyZListu); ctx.save(d2); stat.jenCteni = true; stat.zapsano = 0; stat.pridano = 0; return stat; }
    const ulozOtisky = () => { const d2 = ctx.load(); d2.legacySync = d2.legacySync || {}; d2.legacySync.otisky = ot; ctx.save(d2); };
    try {
      const realData = data.filter(x => x.range);
      if (realData.length) await api(tok, 'POST', '/v4/spreadsheets/' + enc(sid) + '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data: realData });
      data.filter(x => x._cvz).forEach(x => { ot[x._cvz] = x._h; });
      if (appendRows.length) {
        const first = rows.length + 1;
        await api(tok, 'POST', '/v4/spreadsheets/' + enc(sid) + '/values/' + q(title, 'A' + first) + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', { values: appendRows.map(x => x.novy) });
        stat.pridano = appendRows.length;
        if (gid != null) appendRows.forEach((x, i) => fmt.push({ repeatCell: { range: { sheetId: gid, startRowIndex: first - 1 + i, endRowIndex: first + i, startColumnIndex: 0, endColumnIndex: 18 }, cell: { userEnteredFormat: { backgroundColor: barva(x.p.stav) } }, fields: 'userEnteredFormat.backgroundColor' } }));
      }
      ulozOtisky();
      if (fmt.length) { try { await api(tok, 'POST', '/v4/spreadsheets/' + enc(sid) + ':batchUpdate', { requests: fmt.slice(0, 400) }); } catch (e) { stat.chyby.push('barvy: ' + e.message); } }
    } catch (e) {
      if (/403|permission/i.test(e.message)) { stat.jenCteni = true; stat.zapsano = 0; stat.pridano = 0; return stat; }
      else throw e;
    }
    return stat;
  }

  // ---- Plán skládání (den × pracovník) z originálu: řádek = datum, sloupce = pracovníci (hlavička), poslední sloupec den v týdnu ----
  async function syncPlanSkladani(tokR, sid, d0) {
    const stat = { list: 'Plán skládání', prevzato: 0, chyby: [] };
    const resp = await api(tokR, 'GET', '/v4/spreadsheets/' + enc(sid) + '/values/' + q('Plán skládání', 'A1:Z3000') + '?valueRenderOption=FORMATTED_VALUE');
    const rows = resp.values || []; if (rows.length < 2) return stat;
    const hdr = rows[0]; const prac = []; hdr.forEach((h, i) => { if (i > 0 && cl(h) && !/^(den|pondělí|úterý|středa|čtvrtek|pátek|sobota|neděle)$/i.test(cl(h))) prac.push({ i, jm: cl(h) }); });
    const d = ctx.load(); const ps = d.planSkladani; d.legacySync = d.legacySync || {}; const ot = d.legacySync.otiskyPlan = d.legacySync.otiskyPlan || {};
    prac.forEach(p => { if (!ps.pracovnici.includes(p.jm)) ps.pracovnici.push(p.jm); });
    let zmena = false;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || []; const iso = isoZ(row[0]); if (!iso) continue;
      const bunky = {}; prac.forEach(p => { const t = cl(row[p.i]); if (t) bunky[p.jm] = t; });
      const h = otisk(prac.map(p => cl(row[p.i])));
      if (ot[iso] === h) continue;                      // originál se od minula nezměnil
      const prvni = !(iso in ot); ot[iso] = h;
      // originál je pracovní plocha dílny → jeho změna vyhrává; při prvním čtení jen doplní, co v intranetu není
      const cur = ps.dny[iso] || {};
      if (prvni) { const merged = Object.assign({}, bunky, cur); if (Object.keys(merged).length) ps.dny[iso] = merged; else delete ps.dny[iso]; if (JSON.stringify(merged) !== JSON.stringify(cur)) { zmena = true; stat.prevzato++; } }
      else { if (Object.keys(bunky).length) ps.dny[iso] = bunky; else delete ps.dny[iso]; ps.upravy[iso] = Date.now(); zmena = true; stat.prevzato++; }
    }
    if (zmena || prac.length) ctx.save(d);
    return stat;
  }
  // ---- archivní listy originálu (jednou; znovu jen s force) ----
  const ARCHIV_LISTY = ['Boxy Contracts', 'Boxy Contract 2025', 'ostatní do roku 2024', 'Boxy Contracts 2024', 'Boxy Contracts 2023', 'Expedované zakázky 2020-2021', 'Expedované zakázky 2019', 'Expedované zakázky 2016-2018'];
  async function syncArchiv(tokR, sid, gidMap, force) {
    const d0 = ctx.load(); if (d0.archivImport.planAt && !force) return null;
    const stat = { list: 'archiv', pridano: 0, listy: [], chyby: [] };
    const nacteno = [];
    for (const t of ARCHIV_LISTY) { if (gidMap[t] == null) continue; try { const r = await api(tokR, 'GET', '/v4/spreadsheets/' + enc(sid) + '/values/' + q(t, 'A1:Z3000') + '?valueRenderOption=FORMATTED_VALUE'); nacteno.push([t, r.values || []]); } catch (e) { stat.chyby.push(t + ': ' + e.message); } }
    const d = ctx.load();
    nacteno.forEach(([t, rows]) => { try { const n = ctx.importArchivZePlanu(d, rows, 'PLÁN VÝROBY / ' + t); stat.pridano += n; stat.listy.push(t + ' (' + n + ')'); } catch (e) { stat.chyby.push(t + ': ' + e.message); } });
    d.archivImport.planAt = new Date().toISOString(); d.archivImport.planStat = stat; ctx.save(d);
    return stat;
  }
  let _running = null;
  async function sync(duvod, opts) {
    if (bezi && _running) { try { await _running; } catch (_) {} return posledni; }
    if (bezi) return posledni;
    const d0 = ctx.load(); const n = d0.nastaveni; const sid = (n.sheetId || '').trim();
    if (!sid || n.legacySync === false || !(host.sheets && host.sheets.available && host.sheets.token)) return posledni;
    bezi = true;
    try { _running = ctx.serial(async () => {
      const tokR = await host.sheets.token('https://www.googleapis.com/auth/spreadsheets.readonly');
      let gidMap = {}; try { const meta = await api(tokR, 'GET', '/v4/spreadsheets/' + enc(sid) + '?fields=sheets.properties(sheetId,title)'); (meta.sheets || []).forEach(s => { gidMap[s.properties.title] = s.properties.sheetId; }); } catch (_) {}
      const tok = await host.sheets.token('https://www.googleapis.com/auth/spreadsheets');
      const r = ctx.SYS; const out = [];
      try { out.push(await syncPlanSkladani(tokR, sid, d0)); } catch (e) { out.push({ list: 'Plán skládání', chyba: e.message }); }
      try { const a = await syncArchiv(tokR, sid, gidMap, !!(opts && opts.archiv)); if (a) out.push(a); } catch (e) { out.push({ list: 'archiv', chyba: e.message }); }
      for (const [list, title] of [['boxy', n.sheetList], ['ostatni', n.sheetListOstatni]]) {
        if (!title || gidMap[title] == null) continue;
        try { out.push(await syncList(tokR, tok, sid, null, list, title, gidMap, r)); }
        catch (e) {
          const zapis = /403|PERMISSION|permission/i.test(e.message);
          out.push({ list: title, chyba: e.message, jenCteni: zapis });
        }
      }
      const d = ctx.load(); d.legacySync = d.legacySync || {};
      d.legacySync.jenCteni = out.some(x => x.jenCteni);
      d.legacySync.at = new Date().toISOString(); d.legacySync.vysledek = out; d.legacySync.chyba = null;
      ctx.save(d);
      posledni = { at: d.legacySync.at, chyba: null, vysledek: out, duvod };
      const zm = out.reduce((s, x) => s + (x.prevzato || 0) + (x.novych || 0) + (x.zapsano || 0) + (x.pridano || 0), 0);
      if (zm) log(JSON.stringify(out));
    }); await _running; } catch (e) {
      log('chyba:', e.message);
      try { const d = ctx.load(); d.legacySync = d.legacySync || {}; d.legacySync.chyba = e.message; d.legacySync.chybaAt = new Date().toISOString(); ctx.save(d); } catch (_) {}
      posledni = { at: posledni.at, chyba: e.message, duvod };
    } finally { bezi = false; }
    return posledni;
  }
  function tick() { sync('pravidelně').catch(() => {}); }
  function stav() { return Object.assign({}, posledni, { bezi }); }
  return { sync, tick, stav };
}

module.exports = { mount };

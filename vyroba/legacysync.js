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
//  Bez práva zápisu (servisní účet jen čtenář) běží jen směr list → intranet a v nastavení svítí upozornění.
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
    // od teď bez čekání na síť: čerstvá data, změny z listu, výpočet zápisu, uložení
    let d = ctx.load(); d.legacySync = d.legacySync || {}; d.legacySync.otisky = d.legacySync.otisky || {};
    const ot = Object.assign({}, d.legacySync.otisky); let zmena = false;
    const byCvz = {}; d.polozky.forEach(p => { if (p.cvz) byCvz[p.cvz] = p; });
    const rowOf = {}; const nove = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || []; const prefix = cl(row[0]).replace(/\s/g, ''); const por = Math.round(num(row[1]) || 0);
      if (!/^\d{2}B$/i.test(prefix) || !por || !cl(row[3])) continue;
      const cvz = prefix.slice(0, 2) + 'B-' + String(por).padStart(3, '0');
      const p = byCvz[cvz];
      if (!p) { nove.push(row); continue; }
      rowOf[cvz] = i + 1;
      const h = otiskRadku(row, list);
      if (ot[cvz] && ot[cvz] !== h) { try { if (ctx.aplikujPole(d, p, radekNaPole(row, list))) { stat.prevzato++; zmena = true; } } catch (e) { stat.chyby.push(cvz + ': ' + e.message); } }
    }
    if (nove.length) { try { const s = ctx.importRows(d, nove, r, list); stat.novych = s.polozek; if (s.polozek || s.aktualizovano || s.objednavek) zmena = true; } catch (e) { stat.chyby.push('nové řádky: ' + e.message); } }
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

  async function sync(duvod) {
    if (bezi) return posledni;
    const d0 = ctx.load(); const n = d0.nastaveni; const sid = (n.sheetId || '').trim();
    if (!sid || n.legacySync === false || !(host.sheets && host.sheets.available && host.sheets.token)) return posledni;
    bezi = true;
    try { await ctx.serial(async () => {
      const tokR = await host.sheets.token('https://www.googleapis.com/auth/spreadsheets.readonly');
      let gidMap = {}; try { const meta = await api(tokR, 'GET', '/v4/spreadsheets/' + enc(sid) + '?fields=sheets.properties(sheetId,title)'); (meta.sheets || []).forEach(s => { gidMap[s.properties.title] = s.properties.sheetId; }); } catch (_) {}
      const tok = await host.sheets.token('https://www.googleapis.com/auth/spreadsheets');
      const r = ctx.SYS; const out = [];
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
    }); } catch (e) {
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

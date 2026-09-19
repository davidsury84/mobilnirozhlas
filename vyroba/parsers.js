'use strict';
// ============================================================================
//  Parsery dokumentů k objednávce:
//   - Bestellung od Contract Container (PDF, německy)  → hlavička + pozice
//   - Vydaná objednávka z Heliosu (PDF „VydObj 457 26xxxx POPELNICE_B26xxxx") → Helios čísla + 1..n řádků
//   - kniha objednávek Renaty (CONTRACT Bestellung.xlsx, listy Metalboxy / MULDY / ABROLY)
//  Všechny vrací jednotný tvar: { objednavka: {...}, polozky: [...] } s poli, která zná modul.
// ----------------------------------------------------------------------------

const str = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 300);
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const isoDMY = (d, m, y) => { y = String(y); if (y.length === 2) y = '20' + y; if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return ''; return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); };

// „CPRDÖ04.00LacNamDecÖlaTho" → { kod: 'CPRDÖ 04.00 LacNamDecÖla', tho: true }
function normKod(raw) {
  let s = str(raw, 80).replace(/\s+/g, '');
  const m = s.match(/^([A-ZÖ]{2,8})(\d{1,2}[.,]\d{2})(.*)$/i);
  if (!m) return { kod: str(raw, 80), tho: false };
  let rest = m[3] || '';
  const tho = /(Tho|THOMM\w*)$/i.test(rest);
  rest = rest.replace(/(Tho|THOMM\w*)$/i, '').replace(/-?(SPEC|S)$/, m0 => m0);
  return { kod: (m[1].toUpperCase() + ' ' + m[2].replace(',', '.') + (rest ? ' ' + rest : '')).trim(), tho };
}
function ralZ(text) { const m = String(text || '').match(/RAL\s?(\d{4})/i); return m ? 'RAL ' + m[1] : ''; }
// „T H O M M E N" → „THOMMEN"; ponechá normální slova
function slozitRazeni(s) {
  s = str(s, 120).replace(/^\s*[:\-]\s*/, '');
  if (/^(?:\S\s){3,}\S$/.test(s)) return s.replace(/\s/g, '');
  return s;
}

// ---------------------------------------------------------------- Bestellung (Contract)
function parseBestellung(text) {
  const t = String(text || '');
  const lines0 = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // „2 40 Stück" na samostatném řádku (zlom stránky) → spojit s řádkem kódu
  const lines = [];
  for (let i = 0; i < lines0.length; i++) {
    let l = lines0[i].replace(/^Pos\.\s*Menge\s+Einheit\s+Artikel\s+E-Preis\s+(?:%\s+)?G-Preis\s+(?=\d)/i, '');
    if (/^\d{1,2}$/.test(l) && lines0[i + 1] && /^\d+\s+(?:Stück|Stk\.?)$/i.test(lines0[i + 1])) { l = l + ' ' + lines0[i + 1]; i++; }
    if (/^\d{1,2}\s+\d+\s+(?:Stück|Stk\.?)$/i.test(l) && lines0[i + 1] && /€/.test(lines0[i + 1]) && !/^\\?-?\d+,\d{2}\s*€$/.test(lines0[i + 1])) { l = l + ' ' + lines0[i + 1]; i++; }
    lines.push(l);
  }
  const o = { cislo: '', cisloAU: '', datum: '', kwDodani: null, kwRok: null, prijemce: { nazev: '', ulice: '', psc: '', mesto: '', zeme: '' }, zakaznikNazev: 'ConTracT Container Vertriebsgesellschaft mbH', mena: 'EUR', celkem: null };
  let m;
  if ((m = t.match(/Nummer:\s*(BE\s?\d{6})/i))) o.cislo = m[1].replace(/\s/g, '').toUpperCase();
  if ((m = t.match(/Unser Auftrag:\s*(AU\s?\d{6})/i))) o.cisloAU = m[1].replace(/\s/g, '').toUpperCase();
  if ((m = t.match(/Datum:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/))) o.datum = isoDMY(m[1], m[2], m[3]);
  if ((m = t.match(/Lieferung\s+(?:in|bis)\s+KW\s*(\d{1,2})\s*\/\s*(\d{4})/i))) { o.kwDodani = +m[1]; o.kwRok = +m[2]; }
  else if ((m = t.match(/KW\s*(\d{1,2})\s*\/\s*(\d{4})/))) { o.kwDodani = +m[1]; o.kwRok = +m[2]; }
  if ((m = t.match(/(?:Betrag netto|Gesamtbetrag)\s*([\d.]+,\d{2})\s*€/))) o.celkem = num(m[1].replace(/\./g, ''));
  // Příjemce: řádek „CH-2504 Biel-Bienne" (PSČ + město), nad ním ulice, nad ní název.
  const zipIdx = lines.findIndex((l, i) => i > 0 && /^[A-Z]{1,2}\s?-\s?\d{4,5}\s+\S/.test(l) && !/Wolfenbüttel|ZLIN|Zlín/i.test(l));
  const oneLine = lines.find((l, i) => i > 0 && i < 12 && /\s(?:[A-Z]{1,2}-)?\d{4,5}\s+[A-Za-zÀ-ž][A-Za-zÀ-ž.\-/ ]*$/.test(l) && !/Wolfenbüttel|ZLIN|Zlín|Steuer-Nr|USt-IdNr|Nummer:|Lieferanten-Nr/i.test(l) && /\d/.test(l));
  if (zipIdx <= 1 && oneLine) {
    const m2 = oneLine.match(/^(.*?)\s+(?:([A-Z]{1,2})-)?(\d{4,5})\s+([A-Za-zÀ-ž][A-Za-zÀ-ž.\-/ ]*)$/);
    if (m2) {
      const toks = m2[1].split(/\s+/); let ni = toks.findIndex(t => /^\d+[a-zA-Z]?(?:\/\d+[a-z]?)?$/.test(t) || /^\d+-\d+$/.test(t));
      if (ni > 0) {
        let si = ni - 1;
        if (si > 0 && /^(Weg|Strasse|Straße|Str\.|Gasse|Platz|Allee|Ring|Zone|Route|Rue|Via|Chemin|Industriestrasse|Industriestraße|Strada)$/i.test(toks[si])) si--;
        o.prijemce = { nazev: str(toks.slice(0, si).join(' '), 160), ulice: str(toks.slice(si).join(' '), 120), zeme: m2[2] || (m2[3].length === 5 ? 'DE' : 'CH'), psc: m2[3], mesto: str(m2[4], 80) };
      } else o.prijemce = { nazev: str(m2[1], 160), ulice: '', zeme: m2[2] || (m2[3].length === 5 ? 'DE' : 'CH'), psc: m2[3], mesto: str(m2[4], 80) };
    }
  }
  if (zipIdx > 1) {
    const zm = lines[zipIdx].match(/^([A-Z]{1,2})\s?-\s?(\d{4,5})\s+(.+)$/);
    o.prijemce = { zeme: zm[1], psc: zm[2], mesto: str(zm[3], 80), ulice: str(lines[zipIdx - 1], 120), nazev: str(lines[zipIdx - 2], 160) };
    // někdy je název rozdělen na 2 řádky (delší firmy): pokud předchozí řádek nevypadá jako hlavička, přidej
    const prev = lines[zipIdx - 3] || '';
    if (prev && !/Steuer|USt|Datum|Nummer|Bestellung|Lieferanten|REPUBLIK|ZLIN|Zlín|Stefánikova|ELKOPLAST/i.test(prev) && prev.length < 60 && !/^\d/.test(prev)) o.prijemce.nazev = str(prev + ' ' + o.prijemce.nazev, 160);
  }
  // Pozice: „1 40 Stück CPRDÖ04.00LacNamDecÖlaTho 305,00 € 12.200,00 €" + popis až po další pozici / Übertrag / Betrag
  const polozky = [];
  const posRe = /^(\d{1,2})\s+(\d+)\s+(?:Stück|Stk\.?|St\.)\s+(\S+(?:\s+\S+){0,3}?)\s+([\d.]+,\d{2})\s*€\s+(?:\d+\s*%\s+)?([\d.]+,\d{2})\s*€\s*(.*)$/i;
  let cur = null;
  for (const l of lines) {
    const pm = l.match(posRe);
    if (pm) {
      const k = normKod(pm[3].split(/\s+/).length > 1 && /^[A-Z]{1,2}\s+\d/.test(pm[3]) ? pm[3] : pm[3].split(/\s+/)[0]);
      if (pm[3].split(/\s+/).length > 1 && !/^[A-Z]{1,2}\s+\d/.test(pm[3])) k.kod = normKod(pm[3].split(/\s+/)[0]).kod;
      cur = { pozice: +pm[1], ks: +pm[2], kod: k.kod, kodOrig: pm[3], tho: k.tho, cena: num(pm[4].replace(/\./g, '')), popis: [pm[6] || ''], ral: '', lem: '', razeni: '', polepy: '', rozmer: '', tloustka: null, povrch: '' };
      polozky.push(cur); continue;
    }
    if (!cur) continue;
    if (/^(Übertrag|Betrag netto|Gesamtbetrag|Tel\.:|Geschäftsführer|Bankverbindung|Die Ware bleibt|ConTracT Container|CONTRACT$|Bestellung Nr\.|Pos\. Menge)/i.test(l)) { if (/^(Betrag netto|Gesamtbetrag)/i.test(l)) cur = null; continue; }
    cur.popis.push(l);
  }
  // Textová extrakce z Disku občas odtrhne „1 2 Stück" od řádku s kódem: kód s cenami bez prefixu pozice → ks = G-Preis / E-Preis
  // kód (+ max 3 slova názvu typu) a hned za ním E-Preis € [rabat %] G-Preis €
  const loose = /(?:^|\s)([A-Z][A-Za-zÖÄÜ0-9.,\-]{2,}(?:\s+(?!\d)[A-Za-zÖÄÜ0-9.,\-]+){0,3}?)\s+([\d.]+,\d{2})\s*€\s+(?:(\d+)\s*%\s+)?([\d.]+,\d{2})\s*€/g;
  const known = new Set(polozky.map(p => p.kodOrig));
  for (const l of lines) {
    if (posRe.test(l) || /^(Übertrag|Betrag netto|Gesamtbetrag)/i.test(l)) continue;
    let lm; loose.lastIndex = 0;
    while ((lm = loose.exec(l))) {
      let kodRaw = lm[1].trim();
      for (let g = 0; g < 6; g++) kodRaw = kodRaw.replace(/^(?:Artikel|G-Preis|E-Preis|Gesamtpreis|Einheit|Menge|Pos\.|%)\s+/i, '');
      if (!kodRaw || known.has(kodRaw) || /^(Übertrag|Betrag|Gesamtbetrag|MwSt|aus)$/i.test(kodRaw)) continue;
      const e = num(lm[2].replace(/\./g, '')), rab = lm[3] ? num(lm[3]) : 0, g = num(lm[4].replace(/\./g, ''));
      const ks = e > 0 ? Math.round(g / (e * (1 - rab / 100))) : 0; if (!ks || ks > 1000) continue;   // >1000 ks = špatně zachycená čísla, ne pozice
      if (/,\s/.test(kodRaw)) continue;                                                            // věta s čárkami není kód výrobku
      const k = normKod(kodRaw.split(/\s+/)[0]);
      polozky.push({ pozice: polozky.length + 1, ks, kod: k.kod, kodOrig: kodRaw, tho: k.tho, cena: e, popis: [l.slice(lm.index + lm[0].length)], ral: '', lem: '', razeni: '', polepy: '', rozmer: '', tloustka: null, povrch: '' });
      known.add(kodRaw);
    }
  }
  polozky.sort((a, b) => a.pozice - b.pozice).forEach((p, i) => { p.pozice = i + 1; });
  polozky.forEach(p => {
    const d = p.popis.join('\n');
    let mm;
    if ((mm = d.match(/\bTyp\s+([A-Z]{2,5}-[A-Z0-9][A-Z0-9,.\-]+)/))) { p.kodTyp = mm[1]; if (!/^(CP|HES|USB|SB)/.test(p.kod)) p.kod = mm[1]; }
    if ((mm = d.match(/Lackierung\s+RAL\s?(\d{4})/i))) p.ral = 'RAL ' + mm[1];
    if ((mm = d.match(/oberer Rand\s+(?:Höhe\s+\d+\s*mm\s+in\s+)?RAL\s?(\d{4})/i))) p.lem = 'RAL ' + mm[1];
    if (/feuerverzinkt|verzinkt/i.test(d) && !p.ral) p.povrch = 'zinek';
    else if (/grundiert|Grundierung/i.test(d) && !p.ral) p.povrch = 'zaklad';
    else if (p.ral) p.povrch = 'lak';
    if ((mm = d.match(/Masse\s+([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*\/\s*([\d.]+)\s*mm/i))) p.rozmer = [mm[1], mm[2], mm[3]].map(x => x.replace(/\./g, '')).join('x') + '/' + mm[4].replace(/\./g, '');
    else if ((mm = d.match(/Masse\s+([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*mm/i))) p.rozmer = [mm[1], mm[2], mm[3]].map(x => x.replace(/\./g, '')).join('x');
    else if ((mm = d.match(/(\d\.?\d{3})\s*x\s*(\d\.?\d{3}(?:\/\d\.?\d{3})?)\s*x\s*(\d\.?\d{3})\s*mm/i))) p.rozmer = [mm[1], mm[2], mm[3]].map(x => x.replace(/\./g, '')).join('x');
    if ((mm = d.match(/(\d(?:[.,]\d)?)\s*mm\s+Stärke/i))) p.tloustka = num(mm[1]);
    {
      const ls = p.popis; const ni = ls.findIndex(l => /Namensprägung/i.test(l));
      if (ni >= 0) {
        let first = ls[ni].replace(/^.*?Namensprägung\s*:?\s*/i, '').replace(/^\d\.\s*Feld\s*(\([^)]*\))?\s*:?\s*/i, '').replace(/\s*Lackierung.*$/i, '').trim();
        const parts = [first];
        for (let j = ni + 1; j < ls.length && j <= ni + 3; j++) { if (/^(?:[^\s]\s+){2,}[^\s]$/.test(ls[j]) && !/€/.test(ls[j])) parts.push(ls[j]); else break; }
        const collapse = l => { const tk = l.split(/\s+/); return tk.filter(t => t.length === 1).length >= tk.length * 0.6 ? tk.join('') : l; };
        p.razeni = str(parts.map(collapse).filter(Boolean).join(' '), 120);
      }
    }
    if ((mm = d.match(/([^\n]*Aufkleber[^\n]*)/i))) p.polepy = str(mm[1], 200);
    if (/Deckel/i.test(p.kod) && !/\d/.test(p.kod) && (mm = d.match(/Metallbox\s+([\d,.]+(?:\/[\d,.]+)?)\s*m³/i))) p.kod = p.kod + ' ' + mm[1];   // velikost víka z popisu → párování s CZ názvy
    p.nazev = str((p.popis[0] || '').replace(/^Metallbox\s*/i, 'Metallbox '), 160);
    delete p.popis;
  });
  return { objednavka: o, polozky, typ: 'bestellung' };
}

// ---------------------------------------------------------------- Vydaná objednávka (Helios)
function parseHelios(text) {
  const t = String(text || '');
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const o = { helios: '', doklad: '', cislo: '', datum: '', terminDodani: '', prijemce: { nazev: '', ulice: '', psc: '', mesto: '', zeme: '' }, doprava: '' };
  let m;
  if ((m = t.match(/Zakázka\s*:\s*(\d{6})/))) o.helios = m[1];
  else if ((m = t.match(/(\d{6})\s+Č\.?\s*obj\.?\s*zákazníka/i))) o.helios = m[1];   // textová extrakce z Disku má číslo před „Č.obj. zákazníka"
  if ((m = t.match(/Číslo dokladu\s*:\s*(\d{3}\s?\d{6})/))) o.doklad = m[1].replace(/\s/g, '');
  if ((m = t.match(/obj\.?\s*zákazníka\s*:\s*(B\s?E?\s?\d{6})/i))) { const c = m[1].replace(/\s/g, '').toUpperCase(); o.cislo = c.startsWith('BE') ? c : 'BE' + c.slice(1); }
  if ((m = t.match(/Datum pořízení\s*:\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/))) o.datum = isoDMY(m[1], m[2], m[3]);
  if ((m = t.match(/Požadované datum dodání\s*:\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/))) o.terminDodani = isoDMY(m[1], m[2], m[3]);
  if ((m = t.match(/Způsob dopravy\s*:\s*([^\n]+?)(?:\s{2,}|$)/m))) o.doprava = str(m[1], 60);
  // Příjemce: „Místo určení : Název" a následující 2 řádky (ulice, „CH - 8412 Riet"), na stejných řádcích je i adresa dodavatele → odstranit.
  const mi = lines.findIndex(l => /Místo určení\s*:/.test(l));
  if (mi >= 0) {
    o.prijemce.nazev = str(lines[mi].replace(/.*Místo určení\s*:\s*/, ''), 160);
    const clean = s => str(s.replace(/Vrchlického\s*10/i, '').replace(/792\s?01\s+Bruntál\s*1?/i, '').replace(/ELKOPLAST\s*-?\s*VÝROBA\s*BRUNTÁL/i, ''), 120);
    for (let i = mi + 1; i < Math.min(lines.length, mi + 6); i++) {
      const l = lines[i];
      const zm = clean(l).match(/^(?:([A-Z]{1,2})\s*-\s*)?(\d{4,5})\s+(.+)$/);
      if (zm) { o.prijemce.zeme = zm[1] || (zm[2].length === 5 ? 'DE' : 'CH'); o.prijemce.psc = zm[2]; o.prijemce.mesto = str(zm[3], 80); break; }
      const c = clean(l);
      if (c && !/^(Datum|IČ|DIČ|Požadované|-|řádek)/.test(c) && !o.prijemce.ulice) o.prijemce.ulice = c;
    }
    if (!o.prijemce.nazev) {
      const ei = lines.findIndex(l => /ELKOPLAST\s*-\s*VÝROBA\s*BRUNTÁL/i.test(l));
      const cand = ei > 0 ? lines[ei - 1] : '';
      if (cand && !/^[:\-\s]*$/.test(cand) && !/DIČ|IČO|CZ25347942|Bruntál|Vrchlického/.test(cand)) o.prijemce.nazev = str(cand.replace(/^:\s*/, ''), 160);
    }
    if (/Wolfenbüttel/i.test(o.prijemce.mesto)) o.prijemce = { nazev: '', ulice: '', psc: '', mesto: '', zeme: '' };   // adresa Contractu, ne koncového příjemce
  }
  // Řádky položek: „1 286 00002 CPR 08.00 LacNam 2,0 20,00 ks 5 030,00 100 600,00 0 100 600,00"
  const polozky = [];
  const itemRe = /(?:^|\s)(\d{1,3})\s+(\d{3})\s+(\d{4,6})\s+(.+?)\s+(\d[\d\s]*,\d{2})\s+ks\s+(\d[\d\s]*,\d{2})\s+(\d[\d\s]*,\d{2})/;
  for (const l of lines) {
    const im = l.match(itemRe);
    if (!im) continue;
    let popis = str(im[4], 120); let tloustka = null; let kodRaw = popis;
    const tm = popis.match(/\s(\d(?:[.,]\d)?)\s*(?:-|$)/); // „… LacNam 2,0" nebo „… 2,0-THOMMEN"
    if (tm) { tloustka = num(tm[1]); kodRaw = popis.slice(0, tm.index); }
    const k = normKod(kodRaw);
    polozky.push({ pozice: +im[1], heliosPolozka: String(+im[3]), kod: k.kod, kodOrig: popis, tho: k.tho || /THOMM/i.test(popis), tloustka, ks: Math.round(num(im[5])), cena: num(im[6]), ral: '', lem: '', razeni: '', polepy: '', povrch: '', nazev: '' });
  }
  // Popis (ražení, RAL, lem, polepy) — v PDF je jen u jedné položky; přiřadit všem řádkům dokladu
  const ral = (t.match(/-\s*lakov[áa]n[íi]\s+RAL\s?(\d{4})/i) || [])[1];
  const lem = (t.match(/horn[íi](?:ho)?\s+(?:lem|okraj)\w*[^\n]*?RAL\s?(\d{4})/i) || [])[1];
  const raz = (t.match(/ra[žz]en[íi]\s+n[áa]zvu\s*:?\s*(?:\d\.\s*pole\s*:?\s*)?([^\n]+)/i) || [])[1];
  const pol = (t.match(/^\s*-\s*([^\n]*polep[^\n]*)/im) || [])[1];   // jen odrážka s polepy, ne řádek položky
  const zin = /pozink|žárov|zinek/i.test(t) && !ral;
  const nazev = (lines[0] && /box|bedna|mulda|kontejner|víko|viko/i.test(lines[0])) ? str(lines[0], 160) : '';
  polozky.forEach(p => {
    p.ral = ral ? 'RAL ' + ral : ''; p.lem = lem ? 'RAL ' + lem : '';
    p.razeni = raz ? slozitRazeni(raz.replace(/\s*-\s*polepy.*$/i, '')) : '';
    p.polepy = pol ? str(pol.replace(/^-\s*/, ''), 200) : '';
    p.povrch = zin ? 'zinek' : (ral ? 'lak' : '');
    p.nazev = nazev;
  });
  return { objednavka: o, polozky, typ: 'helios' };
}

// ---------------------------------------------------------------- kniha CONTRACT Bestellung.xlsx
// Sloupce (Metalboxy/MULDY/ABROLY): 1 Kommision · 2 KW · 3 Stk · 4 Bestell Nr · 5 Produkt · 6 Fertigung Nr (ČVZ pořadí) ·
// 7 Helios · 8 Stk · 9 Masse · 10 Kg · 11 RAL · 12 Transport (LKWnn) · 13 Posl. · 14 OK · 15 Notiz · 16 název · 29 město · 40 ulice · 53 PSČ
function parseContractRows(rows, list) {
  const out = []; let cur = null;
  const s = (v) => str(v, 200);
  const isPlaceholder = (v) => /^(B260|Bxxxxxx|ddddd|Firma…|název firmy)$/i.test(s(v)) || /^x+$/i.test(s(v));
  for (const r0 of rows) {
    const r = Array.isArray(r0) ? r0 : [];
    const komm = s(r[1]);
    if (komm && (s(r[4]) || s(r[16]))) {
      cur = { komm, kw: num(r[2]) || null, best: s(r[4]).replace(/\s/g, ''), nazev: s(r[16]) || komm, mesto: s(r[29]), ulice: s(r[40]), psc: s(r[53]) };
      if (isPlaceholder(cur.best) || isPlaceholder(cur.komm)) cur = null;
    }
    const prod = s(r[5]);
    if (!cur || !prod || /^(CPR|Víko .* ROTO|zbytek celkem)$/.test(prod)) continue;
    const fert = s(r[6]); const ks = Math.round(num(r[8]) || num(r[3]));
    if (!ks) continue;
    const k = normKod(prod);
    const ralTxt = s(r[11]); const ralM = ralTxt.match(/(\d{4})/); const lemM = ralTxt.match(/(?:rand|lem)\s*(\d{4})/i);
    const helios = s(r[7]).replace(/\.0$/, '');
    out.push({
      list: list || 'Metalboxy', komm: cur.komm, kwDodani: cur.kw, cislo: /^B\d{6}$/i.test(cur.best) ? 'BE' + cur.best.slice(1) : (/^BE\d{6}$/i.test(cur.best) ? cur.best.toUpperCase() : ''),
      prijemce: { nazev: cur.nazev, mesto: cur.mesto, ulice: cur.ulice, psc: cur.psc.replace(/^[A-Z]{1,2}\s?-\s?/, ''), zeme: (cur.psc.match(/^([A-Z]{1,2})\s?-/) || [])[1] || 'CH' },
      kod: k.kod, kodOrig: prod, tho: k.tho, fert, cvzPoradi: /^\d{1,3}$/.test(fert) ? +fert : null, cvzText: /^(\d{2}[A-Z]-?\d+|[SC]-\d+)/i.test(fert) ? fert : '',
      helios: /^\d{6}$/.test(helios) ? helios : '', ks, rozmer: s(r[9]).replace(/\./g, '').replace(/\s/g, ''), kgKs: num(r[10]) || null,
      ral: ralM ? 'RAL ' + ralM[1] : '', lem: lemM ? 'RAL ' + lemM[1] : '', povrch: /zin/i.test(ralTxt) ? 'zinek' : (/gru/i.test(ralTxt) ? 'zaklad' : (ralM ? 'lak' : '')),
      kamion: s(r[12]), vykresPoslan: s(r[13]), vykresOk: s(r[14]), poznamka: s(r[15]),
    });
  }
  return out;
}

module.exports = { parseBestellung, parseHelios, parseContractRows, normKod };

'use strict';
// Ceny motorové nafty pro modul Doprava — port projektu nafta-report (bez závislostí).
// Zdroje (každý selhává nezávisle):
//   ČSÚ (týdenní šetření)            celostátní průměr + změna proti minulému týdnu
//   cenaphm.cz (přebírá ČSÚ)         průměry po krajích
//   EU Weekly Oil Bulletin + ČNB     nafta vč. daní v okolních zemích (EUR/l → Kč/l)
//   Tankovací karty                  ruční ceník z FUELCARD_PRICES_JSON (API adaptéry až budou přístupy)

const zlib = require('zlib');

const UA = 'elkoplast-intranet/1.0 (interni prehled cen paliv)';   // jen ASCII — fetch hlavicky nesnesou diakritiku
const CSU_URL = 'https://data.csu.gov.cz/api/dotaz/v1/data/vybery/CENPHMTT01?format=CSV';
const CENAPHM_URL = 'https://cenaphm.cz/data.json';
const WOB_PAGE = 'https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en';
const CNB_URL = 'https://api.cnb.cz/cnbapi/exrates/daily?lang=EN';

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs || 30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.text();
}
async function fetchJson(url, timeoutMs) { return JSON.parse(await fetchText(url, timeoutMs)); }
async function fetchBuffer(url, timeoutMs) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs || 60000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return Buffer.from(await res.arrayBuffer());
}

/* ---------- CSV (ČSÚ) ---------- */
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, '').trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] != null ? r[i] : '').trim()])));
}

function parseCsuCsv(text) {
  const rows = parseCsv(text);
  const diesel = rows.filter((r) => /nafta/i.test(r['Druh PHM'] || '') && /Průměrná cena/i.test(r['Ukazatel'] || '') && /^Česko$/i.test((r['Území'] || '').trim()));
  if (!diesel.length) throw new Error('ČSÚ: v datech nejsou řádky pro motorovou naftu');
  const keyed = diesel.map((r) => {
    let key = r['CASTPHM'];
    if (!key) { const m = /(\d{1,2})\.\s*týden\s*(\d{4})/.exec(r['Týdny'] || ''); if (m) key = m[2] + '-W' + m[1].padStart(2, '0'); }
    return { key, label: (r['Týdny'] || '').trim(), value: Number(String(r['Hodnota']).replace(',', '.')) };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const last = keyed[keyed.length - 1], prev = keyed[keyed.length - 2];
  return { price: last.value, previous: prev ? prev.value : null, change: prev ? +(last.value - prev.value).toFixed(2) : null, week: last.key, weekLabel: last.label };
}

/* ---------- kraje (cenaphm.cz) ---------- */
function parseCenaphm(json, wanted) {
  const kraje = Array.isArray(json && json.kraje) ? json.kraje : [];
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*kraj$/, '').trim();
  const regions = [];
  for (const w of wanted) {
    const hit = kraje.find((k) => norm(k.nazev) === norm(w));
    if (!hit) continue;
    const price = Number(hit.nafta);
    if (!price || price < 20 || price > 90) continue;
    regions.push({ name: hit.nazev, price, change: hit.zmena != null ? Number(hit.zmena) : null });
  }
  return { updated: (json && json.meta && json.meta.aktualizace) || null, regions };
}

/* ---------- minimální čtečka XLSX (ZIP + sheet XML), jen pro EU bulletin ---------- */
function unzip(buf, chtene) {
  // End of central directory (0x06054b50) hledáme od konce
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('XLSX: neplatný ZIP (EOCD nenalezen)');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const total = buf.readUInt16LE(eocd + 10);
  const out = new Map();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!chtene(name)) continue;
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const data = buf.slice(start, start + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
  }
  return out;
}
function xmlText(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d));
}
function colIndex(ref) { let n = 0; for (const ch of ref) { if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64); else break; } return n - 1; }
// Vrátí listy XLSX jako pole polí (jen hodnoty; sdílené řetězce rozbalené).
function xlsxRows(buf) {
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    const xml = ss.toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(xml))) shared.push(xmlText(m[1]));
  }
  const sheets = [];
  const names = [...files.keys()].filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const name of names) {
    const xml = files.get(name).toString('utf8');
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cellRe = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1] || ''; const body = cm[2] || '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrs);
        const typ = /t="([^"]+)"/.exec(attrs);
        const idx = ref ? colIndex(ref[1]) : cells.length;
        let val = null;
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const is = /<is>([\s\S]*?)<\/is>/.exec(body);
        if (typ && typ[1] === 's' && v) val = shared[Number(v[1])] != null ? shared[Number(v[1])] : null;
        else if (typ && typ[1] === 'inlineStr' && is) val = xmlText(is[1]);
        else if (typ && typ[1] === 'str' && v) val = xmlText(v[1]);
        else if (v) { const n = Number(v[1]); val = Number.isFinite(n) ? n : xmlText(v[1]); }
        cells[idx] = val;
      }
      rows.push(cells);
    }
    sheets.push(rows);
  }
  return sheets;
}

/* ---------- EU Weekly Oil Bulletin ---------- */
const COUNTRY_NAMES = { AT: 'Rakousko', BE: 'Belgie', BG: 'Bulharsko', HR: 'Chorvatsko', CZ: 'Česko', DE: 'Německo', DK: 'Dánsko', ES: 'Španělsko', FR: 'Francie', GR: 'Řecko', HU: 'Maďarsko', IT: 'Itálie', LT: 'Litva', LU: 'Lucembursko', LV: 'Lotyšsko', NL: 'Nizozemsko', PL: 'Polsko', PT: 'Portugalsko', RO: 'Rumunsko', SE: 'Švédsko', SI: 'Slovinsko', SK: 'Slovensko' };
const EN_NAMES = { austria: 'AT', belgium: 'BE', bulgaria: 'BG', croatia: 'HR', czechia: 'CZ', 'czech republic': 'CZ', denmark: 'DK', france: 'FR', germany: 'DE', greece: 'GR', hungary: 'HU', italy: 'IT', latvia: 'LV', lithuania: 'LT', luxembourg: 'LU', netherlands: 'NL', poland: 'PL', portugal: 'PT', romania: 'RO', slovakia: 'SK', slovenia: 'SI', spain: 'ES', sweden: 'SE' };

function findLatestXlsxUrl(html) {
  const re = /href="([^"]*document\/download\/[^"]*?)"/gi;
  const candidates = []; let m;
  while ((m = re.exec(html))) {
    const url = m[1].replace(/&amp;/g, '&');
    const fn = decodeURIComponent(url.split('filename=')[1] || '');
    if (/with\s*taxes/i.test(fn) && /\.xlsx?$/i.test(fn) && !/without/i.test(fn)) {
      const d = /(\d{4}-\d{2}-\d{2})/.exec(fn);
      candidates.push({ url: url.startsWith('http') ? url : 'https://energy.ec.europa.eu' + url, date: d ? d[1] : '' });
    }
  }
  if (!candidates.length) throw new Error('WOB: odkaz na XLSX „prices with taxes" nenalezen');
  candidates.sort((a, b) => (a.date < b.date ? 1 : -1));
  return candidates[0];
}
function toCode(cell) {
  const s = String(cell == null ? '' : cell).trim();
  if (/^[A-Z]{2}$/.test(s)) return s === 'EL' ? 'GR' : s;
  return EN_NAMES[s.toLowerCase()] || null;
}
function parseWob(sheets, wanted) {
  const out = new Map();
  for (const rows of sheets) {
    let dieselCol = -1;
    for (let r = 0; r < Math.min(rows.length, 60) && dieselCol < 0; r++) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c] == null ? '' : row[c]).toLowerCase();
        if ((/gas\s*oil/.test(v) && /(auto|diesel)/.test(v)) || /^diesel/.test(v)) { dieselCol = c; break; }
      }
    }
    if (dieselCol < 0) continue;
    for (const row of rows) {
      if (!row) continue;
      const firstIdx = row.findIndex((v) => v !== null && v !== undefined && v !== '');
      if (firstIdx < 0) continue;
      const code = toCode(row[firstIdx]);
      if (!code || !wanted.includes(code) || out.has(code)) continue;
      const raw = Number(row[dieselCol]);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const eurPerL = raw > 20 ? raw / 1000 : raw;   // bulletin uvádí EUR/1000 l
      out.set(code, { code, name: COUNTRY_NAMES[code] || code, eurPerL: +eurPerL.toFixed(3) });
    }
    if (out.size) break;
  }
  if (!out.size) throw new Error('WOB: ceny nafty pro vybrané země nenalezeny');
  return wanted.filter((c) => out.has(c)).map((c) => out.get(c));
}

/* ---------- tankovací karty (ruční ceník) ---------- */
function parseKarty(jsonText) {
  if (!jsonText || !jsonText.trim()) return [];
  let arr; try { arr = JSON.parse(jsonText); } catch (e) { throw new Error('FUELCARD_PRICES_JSON není platný JSON: ' + e.message); }
  if (!Array.isArray(arr)) throw new Error('FUELCARD_PRICES_JSON musí být pole');
  const byCard = new Map();
  for (const it of arr) {
    if (!it || !it.card || !Number.isFinite(Number(it.price))) continue;
    const list = byCard.get(it.card) || [];
    list.push({ station: it.station || '', country: (it.country || 'CZ').toUpperCase(), price: Number(it.price), currency: (it.currency || 'CZK').toUpperCase(), note: it.note || '' });
    byCard.set(it.card, list);
  }
  return [...byCard.entries()].map(([card, prices]) => ({ card, prices }));
}

/* ---------- agregace ---------- */
// Stáhne všechny zdroje; každý selhává nezávisle (chybějící zdroj skončí v poli `chyby`).
async function fetchNafta({ kraje, zeme, kartyJson } = {}) {
  const wantedKraje = kraje && kraje.length ? kraje : ['Zlínský', 'Moravskoslezský', 'Olomoucký'];
  const wantedZeme = zeme && zeme.length ? zeme : ['SK', 'PL', 'DE', 'AT', 'HU', 'RO'];
  const out = { ts: Date.now(), csu: null, kraje: null, eu: null, karty: [], chyby: [] };

  const [csu, kr, wobHtml, kurz] = await Promise.allSettled([
    fetchText(CSU_URL).then(parseCsuCsv),
    fetchJson(CENAPHM_URL).then((j) => parseCenaphm(j, wantedKraje)),
    fetchText(WOB_PAGE),
    fetchJson(CNB_URL).then((j) => {
      const eur = (j.rates || []).find((r) => r.currencyCode === 'EUR');
      if (!eur) throw new Error('kurz EUR nenalezen');
      return Number(eur.rate) / Number(eur.amount || 1);
    }),
  ]);
  if (csu.status === 'fulfilled') out.csu = csu.value; else out.chyby.push('ČSÚ: ' + csu.reason.message);
  if (kr.status === 'fulfilled') out.kraje = kr.value; else out.chyby.push('kraje: ' + kr.reason.message);

  if (wobHtml.status === 'fulfilled') {
    try {
      const latest = findLatestXlsxUrl(wobHtml.value);
      const buf = await fetchBuffer(latest.url);
      const countries = parseWob(xlsxRows(buf), wantedZeme);
      const rate = kurz.status === 'fulfilled' ? kurz.value : null;
      for (const c of countries) c.czkPerL = rate ? +(c.eurPerL * rate).toFixed(2) : null;
      out.eu = { date: latest.date, rate, countries };
    } catch (e) { out.chyby.push('EU bulletin: ' + e.message); }
  } else out.chyby.push('EU bulletin: ' + wobHtml.reason.message);
  if (kurz.status === 'rejected') out.chyby.push('ČNB: ' + kurz.reason.message);
  if (out.eu && kurz.status === 'fulfilled') out.eu.rate = kurz.value;

  try { out.karty = parseKarty(kartyJson || process.env.FUELCARD_PRICES_JSON || ''); }
  catch (e) { out.chyby.push('karty: ' + e.message); }

  return out;
}

module.exports = { fetchNafta, parseCsuCsv, parseCenaphm, parseWob, parseKarty, xlsxRows, findLatestXlsxUrl };

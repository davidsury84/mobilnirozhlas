'use strict';
// Ceny motorové nafty pro modul Doprava — port projektu nafta-report (bez závislostí).
// Zdroje (každý selhává nezávisle):
//   ČSÚ (týdenní šetření)            celostátní průměr + změna proti minulému týdnu
//   cenaphm.cz (přebírá ČSÚ)         průměry po krajích
//   EU Weekly Oil Bulletin + ČNB     nafta vč. daní v okolních zemích (EUR/l → Kč/l)
//   Tankerkönig (DE, MTS-K)          nejlevnější pumpy u hranic — nutný bezplatný klíč TANKERKOENIG_API_KEY
//   E-Control (AT)                   nejlevnější pumpy u hranic — veřejné API bez klíče
//   Orlen (PL)                       denní velkoobchodní cena ON Ekodiesel (od ní se odvíjejí karetní ceny)
//   Tankovací karty                  ruční ceník z modulu / FUELCARD_PRICES_JSON

const zlib = require('zlib');

const UA = 'elkoplast-intranet/1.0 (interni prehled cen paliv)';   // jen ASCII — fetch hlavicky nesnesou diakritiku
const CSU_URL = 'https://data.csu.gov.cz/api/dotaz/v1/data/vybery/CENPHMTT01?format=CSV';
const CENAPHM_URL = 'https://cenaphm.cz/data.json';
const WOB_PAGE = 'https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en';
const CNB_URL = 'https://api.cnb.cz/cnbapi/exrates/daily?lang=EN';
const TK_URL = 'https://creativecommons.tankerkoenig.de/json/list.php';
const EC_URL = 'https://api.e-control.at/sprit/1.0/search/gas-stations/by-address';
const ORLEN_URL = 'https://tool.orlen.pl/api/wholesalefuelprices';

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

/* ---------- nejlevnější pumpy u hranic: Tankerkönig (DE) + E-Control (AT) ---------- */
// Body zájmu (hraniční přechody / trasy): [{ name, lat, lon }]
async function fetchTankerkoenig(points, klic) {
  // AGB: rate limit na klíč, doporučené šetrné tempo — body sekvenčně s rozestupem,
  // chyba jednoho bodu (např. rate limit) neshodí ostatní; zkusí se při další obnově.
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const b = points[i];
    if (i) await new Promise((r) => setTimeout(r, 3000));
    try {
      const u = TK_URL + '?lat=' + b.lat + '&lng=' + b.lon + '&rad=25&sort=price&type=diesel&apikey=' + encodeURIComponent(klic);
      const j = await fetchJson(u);
      if (!j.ok) throw new Error(j.message || 'odpověď není ok');
      const stanice = (j.stations || []).filter((s) => s.isOpen !== false && Number.isFinite(Number(s.price)) && Number(s.price) > 0)
        .slice(0, 5).map((s) => ({ name: [s.brand, s.name].filter(Boolean).join(' — ').slice(0, 60) || 'pumpa', place: s.place || '', dist: s.dist != null ? Number(s.dist) : null, eurPerL: Number(s.price) }));
      out.push({ bod: b.name, stanice });
    } catch (e) { out.push({ bod: b.name, stanice: [], chyba: e.message }); }
  }
  if (out.length && out.every((p) => p.chyba)) throw new Error(out[0].chyba);
  return out;
}
async function fetchEcontrol(points) {
  const out = [];
  for (const b of points) {
    const u = EC_URL + '?latitude=' + b.lat + '&longitude=' + b.lon + '&fuelType=DIE&includeClosed=false';
    const arr = await fetchJson(u);
    if (!Array.isArray(arr)) throw new Error('E-Control: neočekávaná odpověď');
    // ceny smí ze zákona zobrazit jen 5 nejlevnějších — ostatní přijdou bez prices
    const stanice = arr.map((s) => {
      const p = (s.prices || []).find((x) => (x.fuelType || '').toUpperCase() === 'DIE');
      if (!p || !Number.isFinite(Number(p.amount))) return null;
      const loc = s.location || {};
      return { name: String(s.name || loc.name || 'pumpa').slice(0, 60), place: [loc.postalCode, loc.city].filter(Boolean).join(' '), dist: s.distance != null ? Number(s.distance) : null, eurPerL: Number(p.amount) };
    }).filter(Boolean).sort((a, c) => a.eurPerL - c.eurPerL).slice(0, 5);
    out.push({ bod: b.name, stanice });
  }
  return out;
}

/* ---------- Orlen (PL): denní velkoobchodní cena — základ karetních cen v Polsku ---------- */
function parseOrlen(arr) {
  if (!Array.isArray(arr)) throw new Error('Orlen: neočekávaná odpověď');
  const on = arr.find((p) => /ekodiesel/i.test(p.productName || ''));
  if (!on || !Number.isFinite(Number(on.value))) throw new Error('Orlen: ON Ekodiesel v datech není');
  return { plnM3: Number(on.value), date: String(on.effectiveDate || '').slice(0, 10) };
}
async function fetchOrlen() {
  // WAF pouští jen prohlížečové hlavičky (obyčejný fetch vrací „Request Rejected")
  const res = await fetch(ORLEN_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'pl,en;q=0.9',
      'Referer': 'https://www.orlen.pl/', 'Origin': 'https://www.orlen.pl',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + ORLEN_URL);
  return parseOrlen(await res.json());
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
async function fetchNafta({ kraje, zeme, kartyJson, bodyDe, bodyAt, tkKlic } = {}) {
  const wantedKraje = kraje && kraje.length ? kraje : ['Zlínský', 'Moravskoslezský', 'Olomoucký'];
  const wantedZeme = zeme && zeme.length ? zeme : ['SK', 'PL', 'DE', 'AT', 'HU', 'RO'];
  const out = { ts: Date.now(), csu: null, kraje: null, eu: null, de: null, at: null, plHurt: null, karty: [], chyby: [] };

  const [csu, kr, wobHtml, kurzy, de, at, pl] = await Promise.allSettled([
    fetchText(CSU_URL).then(parseCsuCsv),
    fetchJson(CENAPHM_URL).then((j) => parseCenaphm(j, wantedKraje)),
    fetchText(WOB_PAGE),
    fetchJson(CNB_URL).then((j) => {
      const najdi = (kod) => { const r = (j.rates || []).find((x) => x.currencyCode === kod); return r ? Number(r.rate) / Number(r.amount || 1) : null; };
      const eur = najdi('EUR');
      if (!eur) throw new Error('kurz EUR nenalezen');
      return { EUR: eur, PLN: najdi('PLN') };
    }),
    tkKlic && bodyDe && bodyDe.length ? fetchTankerkoenig(bodyDe, tkKlic) : Promise.resolve(null),
    bodyAt && bodyAt.length ? fetchEcontrol(bodyAt) : Promise.resolve(null),
    fetchOrlen(),
  ]);
  if (csu.status === 'fulfilled') out.csu = csu.value; else out.chyby.push('ČSÚ: ' + csu.reason.message);
  if (kr.status === 'fulfilled') out.kraje = kr.value; else out.chyby.push('kraje: ' + kr.reason.message);
  const kurzEur = kurzy.status === 'fulfilled' ? kurzy.value.EUR : null;
  const kurzPln = kurzy.status === 'fulfilled' ? kurzy.value.PLN : null;

  if (wobHtml.status === 'fulfilled') {
    try {
      const latest = findLatestXlsxUrl(wobHtml.value);
      const buf = await fetchBuffer(latest.url);
      const countries = parseWob(xlsxRows(buf), wantedZeme);
      for (const c of countries) c.czkPerL = kurzEur ? +(c.eurPerL * kurzEur).toFixed(2) : null;
      out.eu = { date: latest.date, rate: kurzEur, countries };
    } catch (e) { out.chyby.push('EU bulletin: ' + e.message); }
  } else out.chyby.push('EU bulletin: ' + wobHtml.reason.message);
  if (kurzy.status === 'rejected') out.chyby.push('ČNB: ' + kurzy.reason.message);

  const prevodBodu = (v) => v ? { points: v.map((p) => ({ bod: p.bod, chyba: p.chyba || undefined, stanice: p.stanice.map((s) => ({ ...s, czkPerL: kurzEur ? +(s.eurPerL * kurzEur).toFixed(2) : null })) })) } : null;
  if (de.status === 'fulfilled') out.de = prevodBodu(de.value); else out.chyby.push('Tankerkönig (DE): ' + de.reason.message);
  if (!tkKlic) out.de = { chybiKlic: true, points: [] };   // klíč není → není to chyba, jen nenastavený zdroj
  if (at.status === 'fulfilled') out.at = prevodBodu(at.value); else out.chyby.push('E-Control (AT): ' + at.reason.message);
  if (pl.status === 'fulfilled') {
    out.plHurt = { ...pl.value, kurzPln, czkPerL: kurzPln ? +(pl.value.plnM3 / 1000 * kurzPln).toFixed(2) : null };   // bez DPH
  } else out.chyby.push('Orlen (PL): ' + pl.reason.message);

  try { out.karty = parseKarty(kartyJson || process.env.FUELCARD_PRICES_JSON || ''); }
  catch (e) { out.chyby.push('karty: ' + e.message); }

  return out;
}

module.exports = { fetchNafta, parseCsuCsv, parseCenaphm, parseWob, parseKarty, parseOrlen, fetchOrlen, fetchEcontrol, fetchTankerkoenig, xlsxRows, findLatestXlsxUrl };

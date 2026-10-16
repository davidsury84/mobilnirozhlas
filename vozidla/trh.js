'use strict';
/* Porovnání s inzercí ojetých vozidel — za kolik se srovnatelný vůz (stejná značka, model,
   rok výroby a podobný nájezd) reálně nabízí. Zdroj: veřejné JSON API Sauto.cz (největší český
   inzertní server; robots.txt přístup k /api výslovně povoluje). TipCars i AutoBazar sedí za
   Cloudflare a server k nim nepustí.

   Co z toho leze (u každého vozu uložené v `v.trh`):
     n, median, q1, q3   — kolik inzerátů a jak jsou rozložené ceny
     odhad               — doporučená prodejní cena: medián posunutý na náš nájezd (regrese cena ~ km
                           uvnitř vzorku), zaokrouhlená na tisíce
     rychly              — cena pro rychlý prodej (dolní kvartil, nejvýš odhad − 8 %)
     vzorek              — 10 nejbližších inzerátů s odkazy, aby se dalo kliknout a ověřit
   Vzorek se hledá nejdřív přesně (stejný rok, nájezd ±30 %) a okno se rozšiřuje jen když je
   inzerátů málo — rozšíření je v `dotaz` přiznané. Neplatný model Sauto tiše ignoruje a vrátí
   celou značku, proto se model VŽDY ověřuje proti číselníku, než se hledá. */
const https = require('https');

const API = 'https://www.sauto.cz/api/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 ELKOPLAST-intranet';
const MIN_INZERATU = 8;          // kolik inzerátů chceme, než přestaneme rozšiřovat okno
const MIN_PRO_ODHAD = 3;         // pod tolika inzeráty se tržní cena z inzerce nebere
const PRODLEVA_MS = 1200;        // mezi požadavky — nejsme jediní, kdo to API používá
const LIMIT = 200;

// Kategorie Sauto v pořadí, ve kterém se zkouší podle typu vozu v evidenci. Typ bývá v evidenci
// zapsaný volně (Fabia jako „nákladní" = N1), proto se nezkouší jen jedna.
const KATEGORIE = {
  osobni: [838, 839], uzitkove: [839, 838, 840], nakladni: [839, 840, 838],
  tahac: [840], privees: [843], stroj: [845],
};
const KAT_NAZEV = { 838: 'osobní', 839: 'užitková', 840: 'nákladní', 843: 'přívěsy a návěsy', 845: 'pracovní stroje' };
const KAT_SEO = { 838: 'osobni', 839: 'uzitkova', 840: 'nakladni', 843: 'privesy-navesy', 845: 'pracovni-stroje' };

// Slova, která o modelu nic neříkají (karoserie, výbava, pohon, generace).
const SUM = new Set(['kombi', 'combi', 'sedan', 'liftback', 'hatchback', 'hb', 'van', 'nova', 'novy', 'nove', 'ac', 'at', 'mt',
  '4matic', 'quattro', '4x4', 'awd', 'xdrive', '4motion', 'dsg', 'tdi', 'tsi', 'tfsi', 'cdi', 'hdi', 'dci', 'tdci', 'facelift', 'fl',
  'ii', 'iii', 'iv', 'gen', 'generace', 'style', 'ambition', 'active', 'elegance', 'l1', 'l2', 'l3', 'h1', 'h2', 'h3']);
const ALIAS_ZNACKY = { vw: 'volkswagen', mercedes: 'mercedes-benz', 'mercedes benz': 'mercedes-benz', 'land rover': 'land-rover',
  'alfa romeo': 'alfa-romeo', 'aston martin': 'aston-martin', 'rolls royce': 'rolls-royce', 'ds': 'ds', 'seat': 'seat' };

const spi = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const zaokr = (v, na) => v == null ? null : Math.round(v / na) * na;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: 15000 }, (resp) => {
      let b = ''; resp.on('data', (c) => b += c);
      resp.on('end', () => {
        if (resp.statusCode !== 200) return reject(new Error('Sauto odpovědělo ' + resp.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('Sauto vrátilo nečitelnou odpověď')); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('Sauto neodpovědělo do 15 s')));
    r.on('error', (e) => reject(new Error('Spojení na Sauto selhalo: ' + (e.code || e.message))));
  });
}

// ---- číselníky (kešované 24 h v paměti; pár požadavků denně) --------------------------
const CACHE = { ts: 0, kategorie: {} };
async function ciselniky(cat) {
  if (Date.now() - CACHE.ts > 24 * 3600e3) { CACHE.kategorie = {}; CACHE.ts = Date.now(); }
  if (CACHE.kategorie[cat]) return CACHE.kategorie[cat];
  const cb = await getJson(API + '/codebooks?category_id=' + cat + '&limit=100');
  const ids = {}; (cb.results || []).forEach((r) => { ids[r.name_id] = r.id; });
  if (!ids.manufacturer_cb || !ids.model_cb) throw new Error('Sauto: kategorie ' + cat + ' nemá číselník výrobců');
  await spi(300);
  const vyr = await getJson(API + '/codebooks/values?codebook_id=' + ids.manufacturer_cb + '&category_id=' + cat + '&limit=500');
  const k = { ids, vyrobci: (vyr.results || []).map((x) => ({ id: x.id, value: x.value, seo: x.seo_name, nazev: x.name })), modely: {} };
  CACHE.kategorie[cat] = k;
  return k;
}
async function modelyVyrobce(cat, vyrobce) {
  const k = await ciselniky(cat);
  if (k.modely[vyrobce.id]) return k.modely[vyrobce.id];
  await spi(300);
  const m = await getJson(API + '/codebooks/values?codebook_id=' + k.ids.model_cb + '&category_id=' + cat + '&parent_id=' + vyrobce.id + '&limit=500');
  k.modely[vyrobce.id] = (m.results || []).map((x) => x.seo_name).filter(Boolean);
  return k.modely[vyrobce.id];
}

// ---- párování značky a modelu z volného textu evidence na číselník Sauto ---------------
function seoZnacky(znacka) {
  const n = norm(znacka);
  return (ALIAS_ZNACKY[n] || n).replace(/\s+/g, '-');
}
function tokenyModelu(model) {
  return norm(model).split(' ').filter((t) => t && !SUM.has(t) && !/^\d+[a-z]+$/.test(t));   // 5j, 4g, 3t = generace, pryč
}
async function najdiVyrobce(cat, znacka) {
  const k = await ciselniky(cat);
  const seo = seoZnacky(znacka);
  return k.vyrobci.find((v) => v.seo === seo) || k.vyrobci.find((v) => norm(v.nazev) === norm(znacka)) || null;
}
async function najdiModel(cat, vyrobce, model) {
  const modely = new Set(await modelyVyrobce(cat, vyrobce));
  const tok = tokenyModelu(model);
  for (let i = tok.length; i >= 1; i--) {           // nejdelší shoda vyhrává: „a6-avant" před „a6", „transit-custom" před „transit"
    const c = tok.slice(0, i).join('-');
    if (modely.has(c)) return c;
  }
  if (vyrobce.seo === 'mercedes-benz' && tok[0] && tok[0].length === 1 && modely.has('tridy-' + tok[0])) return 'tridy-' + tok[0];   // „S 400 d" → třídy S
  return null;
}

// ---- hledání inzerátů ---------------------------------------------------------------------
function rokInzeratu(r) {
  const d = r.manufacturing_date || r.in_operation_date;
  const m = /^(\d{4})/.exec(String(d || ''));
  return m ? Number(m[1]) : null;
}
function prevedInzerat(r) {
  const kat = (r.category && r.category.seo_name) || 'osobni';
  const man = (r.manufacturer_cb && r.manufacturer_cb.seo_name) || 'x', mod = (r.model_cb && r.model_cb.seo_name) || 'x';
  return {
    id: r.id, nazev: String(r.name || '').slice(0, 80), rok: rokInzeratu(r), km: Number(r.tachometer) || null,
    cena: Number(r.price) || null, dohodou: !!r.price_by_agreement,
    kraj: (r.locality && r.locality.region) || '', url: 'https://www.sauto.cz/' + kat + '/detail/' + man + '/' + mod + '/' + r.id,
  };
}
async function hledej(cat, q) {
  const p = ['category_id=' + cat, 'limit=' + LIMIT, 'offset=0'];
  if (q.seo) p.push('manufacturer_model_seo=' + encodeURIComponent(q.seo));
  if (q.phrase) p.push('phrase=' + encodeURIComponent(q.phrase));
  if (q.rokOd) p.push('vehicle_age_from=' + q.rokOd);
  if (q.rokDo) p.push('vehicle_age_to=' + q.rokDo);
  if (q.kmOd != null) p.push('tachometer_from=' + q.kmOd);
  if (q.kmDo != null) p.push('tachometer_to=' + q.kmDo);
  const d = await getJson(API + '/items/search?' + p.join('&'));
  return { celkem: (d.pagination && d.pagination.total) || 0, inzeraty: (d.results || []).map(prevedInzerat) };
}
// Odkaz na výpis pro lidi (stejné filtry, ať se dá kliknout a projít si to).
function odkazVypis(cat, vyrobceSeo, modelSeo, q) {
  const base = 'https://www.sauto.cz/' + (KAT_SEO[cat] || 'osobni') + '/' + vyrobceSeo + (modelSeo ? '/' + modelSeo : '');
  const f = [];
  if (q.rokOd) f.push('rok-od=' + q.rokOd); if (q.rokDo) f.push('rok-do=' + q.rokDo);
  if (q.kmOd != null) f.push('tachometr-od=' + q.kmOd); if (q.kmDo != null) f.push('tachometr-do=' + q.kmDo);
  return base + (f.length ? '?' + f.join('&') : '');
}

// ---- statistika vzorku ----------------------------------------------------------------------
function kvantil(serazene, p) {
  if (!serazene.length) return null;
  const i = (serazene.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return serazene[lo] + (serazene[hi] - serazene[lo]) * (i - lo);
}
function statistika(inzeraty, km, rok) {
  let s = inzeraty.filter((x) => !x.dohodou && x.cena >= 20000);
  if (!s.length) return { n: 0 };
  let ceny = s.map((x) => x.cena).sort((a, b) => a - b);
  const med0 = kvantil(ceny, 0.5);
  s = s.filter((x) => x.cena >= med0 * 0.4 && x.cena <= med0 * 2.5);   // ulítlé inzeráty (rozbité vozy, překlepy) pryč
  ceny = s.map((x) => x.cena).sort((a, b) => a - b);
  const out = { n: s.length, median: Math.round(kvantil(ceny, 0.5)), q1: Math.round(kvantil(ceny, 0.25)), q3: Math.round(kvantil(ceny, 0.75)), min: ceny[0], max: ceny[ceny.length - 1] };
  const sKm = s.filter((x) => x.km > 0);
  out.kmMedian = sKm.length ? Math.round(kvantil(sKm.map((x) => x.km).sort((a, b) => a - b), 0.5)) : null;
  // Posun mediánu na náš nájezd: sklon ceny podle km uvnitř vzorku (jen když je z čeho a dává smysl).
  out.odhad = out.median; out.sklon10k = null;
  if (km > 0 && sKm.length >= 6) {
    const kmy = sKm.map((x) => x.km), rozpeti = Math.max(...kmy) - Math.min(...kmy);
    if (rozpeti >= 30000) {
      const mx = kmy.reduce((a, b) => a + b, 0) / kmy.length, my = sKm.reduce((a, x) => a + x.cena, 0) / sKm.length;
      let sxy = 0, sxx = 0; sKm.forEach((x) => { sxy += (x.km - mx) * (x.cena - my); sxx += (x.km - mx) * (x.km - mx); });
      let sklon = sxx ? sxy / sxx : 0;
      if (sklon > 0) sklon = 0;                                              // s nájezdem cena neroste
      const posun = sklon * (km - out.kmMedian);
      out.odhad = Math.min(out.q3 * 1.2, Math.max(out.q1 * 0.8, out.median + posun));
      out.sklon10k = Math.round(sklon * 10000);
    }
  }
  out.odhad = zaokr(out.odhad, 1000);
  out.rychly = zaokr(Math.min(out.q1, out.odhad * 0.92), 1000);
  // nejbližší inzeráty: podle nájezdu a roku
  const skore = (x) => (km > 0 && x.km ? Math.abs(x.km - km) / 10000 : 3) + (rok && x.rok ? Math.abs(x.rok - rok) * 2 : 1);
  out.vzorek = s.slice().sort((a, b) => skore(a) - skore(b)).slice(0, 10);
  return out;
}

// ---- hlavní vstup: ohodnoť jedno vozidlo -------------------------------------------------------
// vuz: { znacka, model, typ, rok, km }   → { ts, zdroj, stav, zprava, dotaz, odkaz, n, median, q1, q3, odhad, rychly, vzorek }
async function ohodnot(vuz) {
  const ts = Date.now();
  const rok = Number(vuz.rok) || null, km = Number(vuz.km) || null;
  if (!rok) return { ts, zdroj: 'sauto', stav: 'bez-roku', zprava: 'Bez roku výroby není s čím srovnávat — doplňte rok výroby u vozidla.' };
  if (!norm(vuz.znacka)) return { ts, zdroj: 'sauto', stav: 'chyba', zprava: 'Vozidlo nemá vyplněnou značku.' };
  const kategorie = KATEGORIE[vuz.typ] || KATEGORIE.osobni;
  try {
    // 1) kde model existuje — první kategorie, jejíž číselník ho zná
    let volba = null, jenZnacka = null;
    for (const cat of kategorie) {
      const vyrobce = await najdiVyrobce(cat, vuz.znacka);
      if (!vyrobce) continue;
      const model = await najdiModel(cat, vyrobce, vuz.model);
      if (model) { volba = { cat, vyrobce, model }; break; }
      if (!jenZnacka) jenZnacka = { cat, vyrobce, model: null };
    }
    if (!volba) {
      // Model pod značkou není — třeba je v evidenci „TOYOTA LEXUS": když je model sám o sobě
      // značkou, srovnává se s ní (jen značka, model neznáme). Jinak zůstane jen značka z evidence.
      for (const cat of kategorie) {
        const vyrobce = await najdiVyrobce(cat, (tokenyModelu(vuz.model)[0] || ''));
        if (vyrobce) { jenZnacka = { cat, vyrobce, model: null }; break; }
      }
    }
    if (!volba && !jenZnacka) return { ts, zdroj: 'sauto', stav: 'nenalezeno', zprava: 'Značku „' + vuz.znacka + '" Sauto nezná.' };
    const v = volba || jenZnacka;
    const seo = v.vyrobce.seo + (v.model ? ':' + v.model : '');
    const shoda = v.model ? 'model' : 'značka';

    // 2) okno hledání: přesně, pak širší — dokud není dost inzerátů
    const okna = km
      ? [{ r: 0, k: 0.3 }, { r: 1, k: 0.3 }, { r: 1, k: 0.5 }, { r: 2, k: 0.5 }, { r: 2, k: null }]
      : [{ r: 0, k: null }, { r: 1, k: null }, { r: 2, k: null }];
    let nej = null;
    for (const o of okna) {
      const q = { seo, rokOd: rok - o.r, rokDo: rok + o.r };
      if (o.k != null) { const span = Math.max(40000, km * o.k); q.kmOd = Math.max(0, Math.round(km - span)); q.kmDo = Math.round(km + span); }
      await spi(PRODLEVA_MS);
      const r = await hledej(v.cat, q);
      const st = statistika(r.inzeraty, km, rok);
      if (!nej || st.n > nej.st.n) nej = { q, r, st, okno: o };
      if (st.n >= MIN_INZERATU) break;
    }
    const st = nej.st, q = nej.q;
    const dotaz = { kategorie: v.cat, kategorieNazev: KAT_NAZEV[v.cat] || v.cat, znacka: v.vyrobce.nazev, model: v.model, shoda,
      rokOd: q.rokOd, rokDo: q.rokDo, kmOd: q.kmOd != null ? q.kmOd : null, kmDo: q.kmDo != null ? q.kmDo : null, nasKm: km, nasRok: rok,
      rozsireno: nej.okno.r > 0 || nej.okno.k == null || nej.okno.k > 0.3 };
    const odkaz = odkazVypis(v.cat, v.vyrobce.seo, v.model, q);
    if (st.n < MIN_PRO_ODHAD) {
      return { ts, zdroj: 'sauto', stav: 'malo', zprava: 'Srovnatelných inzerátů je jen ' + st.n + ' — cena z inzerce se nebere, platí odhad z modelu.', dotaz, odkaz, n: st.n, vzorek: st.vzorek || [] };
    }
    return Object.assign({ ts, zdroj: 'sauto', stav: 'ok', zprava: '', dotaz, odkaz }, st);
  } catch (e) {
    return { ts, zdroj: 'sauto', stav: 'chyba', zprava: e.message };
  }
}

module.exports = { ohodnot, statistika, tokenyModelu, seoZnacky, KAT_NAZEV, MIN_PRO_ODHAD };

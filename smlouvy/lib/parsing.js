'use strict';
// Heuristické parsery volného textu z registru (§7, §12). Cíl: co nejvíc
// předvyplnit pro náhled importu; nikdy ne „tiše". Vše nejisté zůstává i v
// originále (hodnota_popis / platnost_podminka / stav_popis) k ruční kontrole.

const { parseCzDate } = require('./datum');

function bezDiakritiky(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** 'KS-2026', 'KS-2025' apod. = souhrnný balík, ne jedna smlouva (§7). */
function jeSouhrnnyBalik(id) {
  return /^ks-\d/i.test(String(id || '').trim());
}

/**
 * "ODBĚRATELSKÁ – nájem (příjem)" -> { kategorie, smer, podtyp }
 * Explicitní "(příjem)"/"(výdaj)" má přednost; jinak směr z kategorie.
 */
function parseKategorie(text) {
  const raw = String(text || '');
  const norm = bezDiakritiky(raw).toLowerCase();

  let kategorie = null;
  if (/odberatelsk/.test(norm)) kategorie = 'odberatelska';
  else if (/dodavatelsk/.test(norm)) kategorie = 'dodavatelska';
  else if (/zavazek/.test(norm)) kategorie = 'zavazek';
  else if (/plnen/.test(norm)) kategorie = 'plneni';

  let smer = null;
  if (/prijem/.test(norm)) smer = 'prijem';
  else if (/vydaj/.test(norm)) smer = 'vydaj';
  else if (kategorie === 'odberatelska') smer = 'prijem';
  else if (kategorie === 'dodavatelska') smer = 'vydaj';
  else if (kategorie === 'zavazek') smer = 'vydaj';

  // podtyp = text za pomlčkou nebo v závorce, bez marketu (příjem/výdaj)
  let podtyp = null;
  const poPomlcce = raw.split(/[–-]/).slice(1).join('-').trim();
  const vZavorce = (raw.match(/\(([^)]+)\)/) || [])[1];
  let kandidat = poPomlcce || vZavorce || '';
  kandidat = kandidat.replace(/\(?\b(příjem|výdaj)\b\)?/gi, '').replace(/[()]/g, '').trim();
  if (kandidat && !/^(ks|souhrn)/i.test(kandidat)) podtyp = kandidat;

  return { kategorie, smer, podtyp };
}

/**
 * "expozice 150 000 EUR", "min. 348 tis. Kč/rok", "3 900 Kč/měs",
 * "11 licencí/rok", "150 Kč/ks/den", "dle objednávek"
 *  -> { hodnota, hodnota_typ, mena, hodnota_popis }
 * Číslo se nastaví jen když je jistá měna a hodnota není „za jednotku".
 */
function parseHodnota(text) {
  const popis = String(text || '').trim() || null;
  const out = { hodnota: null, hodnota_typ: null, mena: 'CZK', hodnota_popis: popis };
  if (!popis) return out;
  const norm = bezDiakritiky(popis).toLowerCase();

  // měna
  if (/\beur\b|€/.test(norm)) out.mena = 'EUR';
  else if (/\busd\b|\$/.test(norm)) out.mena = 'USD';
  else if (/tenge|kzt/.test(norm)) out.mena = 'KZT';

  const maMenu = /kc|kč|eur|€|usd|\$|tenge/.test(norm);
  const perJednotku = /\/\s*(ks|den|hod|h|km|vyvoz)\b/.test(norm) && !/\/\s*(rok|mes)/.test(norm);

  // typ plnění
  if (/\/\s*mes|měs/.test(norm)) out.hodnota_typ = 'mesicni';
  else if (/\/\s*rok|\brocn|ročn/.test(norm)) out.hodnota_typ = 'rocni';
  else out.hodnota_typ = 'jednorazova';

  if (maMenu && !perJednotku) {
    let mult = 1;
    if (/mil\./.test(norm)) mult = 1e6;
    else if (/tis\./.test(norm)) mult = 1e3;
    // první číselný token (mezery/nbsp jako oddělovač tisíců, čárka = desetinná)
    const m = norm.replace(/ /g, ' ').match(/(\d[\d\s]*(?:,\d+)?)/);
    if (m) {
      const num = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
      if (!Number.isNaN(num)) out.hodnota = Math.round(num * mult * 100) / 100;
    }
  }
  return out;
}

/**
 * "auto-prodloužení...; výpověď 6 měs.", "3 měsíce", "1 měsíc po min. době",
 * "automatická roční", "kdykoli", "nové jednání"
 *  -> { vypovedni_lhuta_mesice, prolongace }
 */
function parseVypoved(text) {
  const norm = bezDiakritiky(String(text || '')).toLowerCase();
  let lhuta = null;
  if (!/doba urcita/.test(norm)) {
    const m = norm.match(/(\d+)\s*mes/); // „6 měs", „1 měsíc"
    if (m) lhuta = Number(m[1]);
  }
  let prolongace = 'zadna';
  if (/auto/.test(norm)) prolongace = 'auto';
  else if (/jednani|renegoci|nove jednani/.test(norm)) prolongace = 'jednani';
  return { vypovedni_lhuta_mesice: lhuta, prolongace };
}

/**
 * "31.12.2026", "neurčitá, min. do 28.2.2029", "30.6.2027 nebo 710 000 km",
 * "konec certifikátu (~2028)", "dle jednotlivých zadání"
 *  -> { platnost_typ, platnost_do (iso|null), platnost_podminka (text|null) }
 * Nedatové/smíšené konce se zachovají do platnost_podminka.
 */
function parsePlatnost(text) {
  const raw = String(text || '').trim();
  const norm = bezDiakritiky(raw).toLowerCase();
  const typ = /neurcit/.test(norm) ? 'neurcita' : 'urcita';

  const date = parseCzDate(raw);
  const platnost_do = date ? date.iso : null;

  // „čistý" případ = jen datum (± „UPLYNULO"), jinak zachovej originál
  const zbytek = raw
    .replace(/\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/g, '')
    .replace(/uplynulo/gi, '')
    .replace(/[–\-\s.]/g, '')
    .trim();
  const platnost_podminka = zbytek.length > 0 ? raw : null;

  return { platnost_typ: typ, platnost_do, platnost_podminka };
}

/** Provozní štítek -> enum stav (originál se drží ve stav_popis). */
function mapStav(text) {
  const norm = bezDiakritiky(String(text || '')).toLowerCase();
  if (/archiv/.test(norm)) return 'archivovana';
  if (/vypovez/.test(norm)) return 'vypovezena';
  if (/ukonc/.test(norm)) return 'ukoncena';
  return 'aktivni';
}

module.exports = {
  bezDiakritiky, jeSouhrnnyBalik, parseKategorie, parseHodnota,
  parseVypoved, parsePlatnost, mapStav,
};

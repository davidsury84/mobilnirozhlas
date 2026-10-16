'use strict';
/* Termín vyřazení a ocenění svěřeného vozidla — čistý výpočet bez závislostí (volá ho index.js).

   Termín vyřazení: dřívější z (pořízení + maxLet) a (dosažení maxKm při současném ročním nájezdu).
   Ocenění ve třech cenách vedle sebe, aby šly srovnat:
     účetní zůstatková  = pořizovací × (1 − stáří/odpisLet), rovnoměrný odpis (vozidla = 2. odpisová skupina, 5 let)
     tržní srovnatelná  = pořizovací × zbytek hodnoty dle stáří (křivka ojetin) × korekce na nájezd proti očekávanému
     prodejní           = tržní − rezerva pro rychlý prodej, nebo ručně zadaná
   Cena pro zaměstnance = cena obvyklá (tržní): prodej pod ní je u zaměstnance nepeněžním příjmem (§ 6 odst. 3 ZDP). */

// Zbytek tržní hodnoty podle stáří (podíl z pořizovací ceny). Osobní a užitkové vozy ztrácejí
// nejvíc v prvních letech; nákladní a tahače klesají pozvolněji, ale níž.
const KRIVKA_OSOBNI = [[0, 1], [1, 0.75], [2, 0.63], [3, 0.53], [4, 0.45], [5, 0.38], [6, 0.32], [7, 0.27], [8, 0.23], [9, 0.20], [10, 0.17], [12, 0.13], [15, 0.09]];
const KRIVKA_NAKLADNI = [[0, 1], [1, 0.72], [2, 0.60], [3, 0.50], [4, 0.42], [5, 0.35], [6, 0.29], [7, 0.24], [8, 0.20], [9, 0.17], [10, 0.14], [12, 0.11], [15, 0.08]];
const TYPY_NAKLADNI = ['nakladni', 'tahac', 'privees', 'stroj'];

function zbytek(stari, krivka) {
  if (stari == null || !isFinite(stari)) return null;
  if (stari <= 0) return 1;
  for (let i = 1; i < krivka.length; i++) {
    const [x0, y0] = krivka[i - 1], [x1, y1] = krivka[i];
    if (stari <= x1) return y0 + (y1 - y0) * (stari - x0) / (x1 - x0);
  }
  return 0.06;
}
const idx = (d) => (d && isFinite(d.y) && isFinite(d.m)) ? d.y * 12 + (d.m - 1) : null;   // {y,m} → pořadí měsíce
const zIdx = (i) => ({ y: Math.floor(i / 12), m: (i % 12) + 1 });
const fmtMesic = (d) => d ? (d.m + '/' + d.y) : '—';
const zaokr = (v, na) => v == null ? null : Math.round(v / na) * na;

/* v:   { reg:{m,y}|null, regZdroj, tachometr, tachometrRok, tachometrMesicu (měsíce od odečtu), kmMes,
          porizovaciCena, prodejniCena, typ }
   cfg: { maxLet, maxKm, rocniKm, rezervaProdej, odpisLet } */
function spocitej(v, cfg, now) {
  const c = Object.assign({ maxLet: 8, maxKm: 250000, rocniKm: 25000, rezervaProdej: 8, odpisLet: 5 }, cfg || {});
  now = now || new Date();
  const ted = { y: now.getFullYear(), m: now.getMonth() + 1 }, tedI = idx(ted);
  const out = { upozorneni: [], chybi: [] };

  // --- stáří ---
  out.reg = v.reg || null; out.regZdroj = v.reg ? (v.regZdroj || 'zadáno') : null;
  if (!v.reg) out.chybi.push('rok výroby / datum pořízení');
  const stariMes = v.reg ? Math.max(0, tedI - idx(v.reg)) : null;
  out.stariLet = stariMes != null ? +(stariMes / 12).toFixed(1) : null;

  // --- nájezd: poslední zápis tachometru + dopočet při současném ročním nájezdu ---
  const kmMes = v.kmMes > 0 ? v.kmMes : 0;
  out.kmRok = Math.round(kmMes * 12);
  let najezd = null, najezdZdroj = null;
  if (v.tachometr > 0) {
    const odMes = Math.round(v.tachometrMesicu || 0);
    najezd = v.tachometr + odMes * kmMes;
    najezdZdroj = odMes ? ('tachometr ' + (v.tachometrRok || '') + ' + ' + odMes + ' měs. provozu') : 'tachometr ' + (v.tachometrRok || '');
  } else out.chybi.push('stav tachometru');
  out.najezd = najezd != null ? Math.round(najezd) : null; out.najezdZdroj = najezdZdroj;

  // --- termíny vyřazení ---
  out.terminStari = v.reg ? zIdx(idx(v.reg) + c.maxLet * 12) : null;
  if (najezd != null) out.terminNajezd = (kmMes > 0) ? zIdx(tedI + Math.max(0, Math.ceil((c.maxKm - najezd) / kmMes))) : (najezd >= c.maxKm ? ted : null);
  else out.terminNajezd = null;
  if (najezd != null && kmMes <= 0 && najezd < c.maxKm) out.chybi.push('roční nájezd (druhý zápis tachometru)');
  const kand = [];
  if (out.terminStari) kand.push({ i: idx(out.terminStari), d: 'stáří ' + c.maxLet + ' let' });
  if (out.terminNajezd) kand.push({ i: idx(out.terminNajezd), d: 'nájezd ' + Math.round(c.maxKm / 1000) + ' tis. km' });
  kand.sort((a, b) => a.i - b.i);
  out.termin = kand.length ? zIdx(kand[0].i) : null;
  out.duvod = kand.length ? kand.filter((k) => k.i === kand[0].i).map((k) => k.d).join(' i ') : '';
  out.terminNyni = kand.length ? kand[0].i <= tedI : false;
  out.mesicuDoTerminu = kand.length ? Math.max(0, kand[0].i - tedI) : null;

  // --- ocenění ---
  const poriz = v.porizovaciCena > 0 ? v.porizovaciCena : null;
  out.porizovaci = poriz;
  if (!poriz) out.chybi.push('pořizovací cena');
  if (poriz && out.stariLet != null) {
    out.zustatkova = Math.round(poriz * Math.max(0, 1 - out.stariLet / c.odpisLet));
    const krivka = TYPY_NAKLADNI.includes(v.typ) ? KRIVKA_NAKLADNI : KRIVKA_OSOBNI;
    const ocek = out.stariLet * c.rocniKm;
    out.kmFaktor = najezd != null ? Math.min(1.15, Math.max(0.75, 1 - 0.04 * (najezd - ocek) / 25000)) : 1;   // ±4 % za každých 25 tis. km odchylky
    out.trzni = zaokr(poriz * zbytek(out.stariLet, krivka) * out.kmFaktor, 1000);
    out.prodejniNavrh = zaokr(out.trzni * (1 - c.rezervaProdej / 100), 1000);
  } else { out.zustatkova = null; out.kmFaktor = null; out.trzni = null; out.prodejniNavrh = null; }
  if (v.prodejniCena > 0) { out.prodejni = v.prodejniCena; out.prodejniZdroj = 'zadáno'; }
  else { out.prodejni = out.prodejniNavrh; out.prodejniZdroj = out.prodejniNavrh != null ? 'návrh' : null; }
  out.rozdilProc = (out.prodejni != null && out.trzni) ? +((out.prodejni - out.trzni) / out.trzni * 100).toFixed(1) : null;
  out.cenaZamestnanec = out.trzni;
  if (out.prodejni != null && out.zustatkova != null && out.prodejni < out.zustatkova) out.upozorneni.push('prodejní cena je pod účetní zůstatkovou — vznikne účetní ztráta ' + Math.round(out.zustatkova - out.prodejni).toLocaleString('cs-CZ') + ' Kč');
  if (out.prodejni != null && out.trzni && out.prodejni < out.trzni * 0.9) out.upozorneni.push('prodejní cena je pod cenou obvyklou — u prodeje zaměstnanci je rozdíl nepeněžním příjmem (daň + odvody)');
  return out;
}

module.exports = { spocitej, zbytek, fmtMesic, idx, KRIVKA_OSOBNI, KRIVKA_NAKLADNI };

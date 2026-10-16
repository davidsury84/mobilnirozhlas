/* Vyřazení a ocenění vozidel — sdílený výpočet pro server (node) i prohlížeč (global Oceneni).
   Vstupy jsou buď zadané správcem (přesné), nebo dopočtené z účetnictví/evidence (odhad);
   každá hodnota nese zdroj, aby bylo v UI vidět, čemu se dá věřit.

   Termín vyřazení: dřívější z (1. registrace + maxLet) a (dosažení maxKm při současném
   měsíčním nájezdu), ne dřív než konec běžícího leasingu.
   Ocenění: účetní zůstatková (rovnoměrný odpis odpisLet) × tržní srovnatelná cena
   (pořizovací × zbytek hodnoty dle stáří × korekce na nájezd) × navržená prodejní
   (tržní − rezerva pro rychlý prodej). Cena pro zaměstnance = cena obvyklá (tržní):
   prodej pod ní je u zaměstnance nepeněžní příjem (§ 6 odst. 3 ZDP). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Oceneni = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VYCHOZI = {
    maxLet: 8,            // obvyklá životnost tahače v MKD
    maxKm: 900000,        // nájezd, po kterém rostou opravy a klesá spolehlivost
    rocniKm: 110000,      // očekávaný roční nájezd (pro korekci tržní ceny)
    rezervaProdej: 8,     // % pod tržní cenou pro rychlý prodej
    odpisLet: 5,          // účetní odpis rovnoměrně (nákladní vozy = 2. odpisová skupina)
    opravyLimit: 3,       // Kč/km oprav, nad kterým doporučit dřívější vyřazení
    odkupEmail: '',       // kam hlásit nové nabídky odkupu (prázdné = neposílat)
  };
  // Zbytek tržní hodnoty tahače podle stáří (podíl z pořizovací ceny) — typická křivka
  // použitých tahačů v EU; mezi body lineárně, pod 15 let dno 6 %.
  const KRIVKA = [[0, 1], [1, 0.72], [2, 0.60], [3, 0.50], [4, 0.42], [5, 0.35], [6, 0.29], [7, 0.24], [8, 0.20], [9, 0.17], [10, 0.14], [12, 0.11], [15, 0.08]];

  function zbytek(stari) {
    if (stari == null || !isFinite(stari)) return null;
    if (stari <= 0) return 1;
    for (let i = 1; i < KRIVKA.length; i++) {
      const [x0, y0] = KRIVKA[i - 1], [x1, y1] = KRIVKA[i];
      if (stari <= x1) return y0 + (y1 - y0) * (stari - x0) / (x1 - x0);
    }
    return 0.06;
  }
  const idx = (d) => (d && isFinite(d.y) && isFinite(d.m)) ? d.y * 12 + (d.m - 1) : null;   // {y,m} → pořadí měsíce
  const zIdx = (i) => ({ y: Math.floor(i / 12), m: (i % 12) + 1 });
  const fmtMesic = (d) => d ? (d.m + '/' + d.y) : '—';
  // "MM/RRRR" | "RRRR-MM" | "RRRR" → {m,y}
  function parseMesic(s) {
    const t = String(s == null ? '' : s).trim();
    let m = /^(\d{1,2})\s*[\/.]\s*(\d{4})$/.exec(t); if (m) return { m: +m[1], y: +m[2] };
    m = /^(\d{4})-(\d{1,2})/.exec(t); if (m) return { m: +m[2], y: +m[1] };
    m = /^(\d{4})$/.exec(t); if (m) return { m: 6, y: +m[1] };
    return null;
  }
  const zaokr = (v, na) => v == null ? null : Math.round(v / na) * na;

  /* v: { reg:{m,y}|null, tachometr, tachometrDatum:'YYYY-MM-DD', kmMes, porizovaciCena, prodejniCena,
          odpisyMes (účetní měsíční odpis; 0 = odepsáno), opravyKm, smlouvaDo:{m,y}|null, stav }
     cfg: VYCHOZI přepsané nastavením; now: Date */
  function spocitej(v, cfg, now) {
    const c = Object.assign({}, VYCHOZI, cfg || {});
    now = now || new Date();
    const ted = { y: now.getFullYear(), m: now.getMonth() + 1 };
    const tedI = idx(ted);
    const out = { upozorneni: [], chybi: [] };

    // --- stáří: zadaná 1. registrace > odhad z konce leasingu (5letý leasing) ---
    let reg = v.reg || null, regZdroj = 'zadáno';
    if (!reg && v.smlouvaDo) { reg = { m: v.smlouvaDo.m, y: v.smlouvaDo.y - 5 }; regZdroj = 'odhad: konec leasingu − 5 let'; }
    if (!reg) { regZdroj = null; out.chybi.push('1. registrace'); }
    out.reg = reg; out.regZdroj = regZdroj;
    const stariMes = reg ? Math.max(0, tedI - idx(reg)) : null;
    out.stariLet = stariMes != null ? +(stariMes / 12).toFixed(1) : null;

    // --- nájezd: tachometr + dopočet od data odečtu > odhad ze stáří × měsíční nájezd ---
    const kmMes = v.kmMes > 0 ? v.kmMes : 0;
    out.kmMes = Math.round(kmMes);
    let najezd = null, najezdZdroj = null;
    if (v.tachometr > 0) {
      let odMes = 0;
      if (v.tachometrDatum) { const d = parseMesic(v.tachometrDatum); if (d) odMes = Math.max(0, tedI - idx(d)); }
      najezd = v.tachometr + odMes * kmMes;
      najezdZdroj = odMes ? ('tachometr ' + fmtMesic(parseMesic(v.tachometrDatum)) + ' + ' + odMes + ' měs. provozu') : 'tachometr';
    } else if (stariMes != null && kmMes > 0) {
      najezd = stariMes * kmMes; najezdZdroj = 'odhad: stáří × průměrný nájezd';
    } else out.chybi.push('stav tachometru');
    out.najezd = najezd != null ? Math.round(najezd) : null; out.najezdZdroj = najezdZdroj;

    // --- termíny vyřazení ---
    out.terminStari = reg ? zIdx(idx(reg) + c.maxLet * 12) : null;
    if (najezd != null) out.terminNajezd = (kmMes > 0) ? zIdx(tedI + Math.max(0, Math.ceil((c.maxKm - najezd) / kmMes))) : (najezd >= c.maxKm ? ted : null);
    else out.terminNajezd = null;
    const kand = [];
    if (out.terminStari) kand.push({ i: idx(out.terminStari), d: 'stáří ' + c.maxLet + ' let' });
    if (out.terminNajezd) kand.push({ i: idx(out.terminNajezd), d: 'nájezd ' + Math.round(c.maxKm / 1000) + ' tis. km' });
    kand.sort((a, b) => a.i - b.i);
    let termin = null, duvod = '';
    if (kand.length) {
      termin = kand[0].i; duvod = kand.filter((k) => k.i === kand[0].i).map((k) => k.d).join(' i ');
      const leas = v.smlouvaDo ? idx(v.smlouvaDo) : null;
      if (leas != null && leas >= tedI && termin < leas) { termin = leas; duvod += ' → až po konci leasingu'; }
    }
    out.termin = termin != null ? zIdx(termin) : null;
    out.terminNyni = termin != null && termin <= tedI;
    out.mesicuDoTerminu = termin != null ? Math.max(0, termin - tedI) : null;
    out.duvod = duvod;
    if (v.opravyKm != null && v.opravyKm > c.opravyLimit) out.upozorneni.push('opravy ' + v.opravyKm.toFixed(2) + ' Kč/km (limit ' + c.opravyLimit + ') — zvážit dřívější vyřazení');

    // --- ocenění ---
    let poriz = v.porizovaciCena > 0 ? v.porizovaciCena : null, porizZdroj = 'zadáno';
    if (!poriz && v.odpisyMes > 0) { poriz = v.odpisyMes * 12 * c.odpisLet; porizZdroj = 'odhad: měsíční odpis × ' + (c.odpisLet * 12); }
    if (!poriz) { porizZdroj = null; out.chybi.push('pořizovací cena'); }
    out.porizovaci = poriz != null ? Math.round(poriz) : null; out.porizovaciZdroj = porizZdroj;

    if (poriz && out.stariLet != null) {
      out.zustatkova = (v.odpisyMes === 0) ? 0 : Math.round(poriz * Math.max(0, 1 - out.stariLet / c.odpisLet));
      out.zustatkovaZdroj = (v.odpisyMes === 0) ? 'účetně odepsáno' : ('rovnoměrně ' + c.odpisLet + ' let');
      const ocek = out.stariLet * c.rocniKm;
      out.kmFaktor = najezd != null ? Math.min(1.15, Math.max(0.75, 1 - 0.04 * (najezd - ocek) / 100000)) : 1;
      out.trzni = zaokr(poriz * zbytek(out.stariLet) * out.kmFaktor, 1000);
      out.prodejniNavrh = zaokr(out.trzni * (1 - c.rezervaProdej / 100), 1000);
    } else { out.zustatkova = null; out.zustatkovaZdroj = null; out.kmFaktor = null; out.trzni = null; out.prodejniNavrh = null; }
    if (v.prodejniCena > 0) { out.prodejni = v.prodejniCena; out.prodejniZdroj = 'zadáno'; }
    else { out.prodejni = out.prodejniNavrh; out.prodejniZdroj = out.prodejniNavrh != null ? 'návrh' : null; }
    out.rozdilProc = (out.prodejni != null && out.trzni) ? +((out.prodejni - out.trzni) / out.trzni * 100).toFixed(1) : null;
    out.cenaZamestnanec = out.trzni;   // cena obvyklá — pod ní vzniká zaměstnanci nepeněžní příjem
    if (out.prodejni != null && out.zustatkova != null && out.prodejni < out.zustatkova) out.upozorneni.push('prodejní cena je pod účetní zůstatkovou — vznikne účetní ztráta ' + Math.round(out.zustatkova - out.prodejni).toLocaleString('cs-CZ') + ' Kč');
    if (out.prodejni != null && out.trzni && out.prodejni < out.trzni * 0.9) out.upozorneni.push('prodejní cena je pod cenou obvyklou — u prodeje zaměstnanci je rozdíl nepeněžním příjmem (daň + odvody)');
    return out;
  }

  return { VYCHOZI, KRIVKA, zbytek, spocitej, parseMesic, fmtMesic, idx, zIdx };
});

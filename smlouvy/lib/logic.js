'use strict';
// Čisté rozhodovací funkce modulu Smlouvy (bez DB, bez frameworku).
// Portováno 1:1 z otestované verze (elkoplast-smlouvy) — kryje akceptační
// kritéria §10 (idempotence milníků, catch-up, odvozené/opakující termíny,
// finanční expozice).

const { addMonths, addByOpakovani } = require('./datum');

// ---- Termíny --------------------------------------------------------
function odvozenyDeadlineVypovedi({ platnost_do, vypovedni_lhuta_mesice }) {
  if (!platnost_do || !vypovedni_lhuta_mesice) return null;
  return addMonths(platnost_do, -Number(vypovedni_lhuta_mesice));
}
function dalsiVyskyt(termin) {
  return addByOpakovani(termin.datum, termin.opakovani);
}

// ---- Notifikační milníky -------------------------------------------
const PORADI = ['d90', 'd60', 'd30', 'd14', 'po_terminu'];

function decideMilnik(dny) {
  if (dny < 0) return 'po_terminu';
  if (dny <= 14) return 'd14';
  if (dny <= 30) return 'd30';
  if (dny <= 60) return 'd60';
  if (dny <= 90) return 'd90';
  return null;
}

// Co poslat teď (§4.1 + catch-up §4.5). jizOdeslane = Set milníků.
function planNotifikace(dny, jizOdeslane = new Set()) {
  const cil = decideMilnik(dny);
  if (!cil) return null;
  if (cil === 'po_terminu') return { milnik: 'po_terminu', resend: true };
  if (jizOdeslane.has(cil)) return null;
  return { milnik: cil, resend: false };
}

// Příjemci milníku (e-maily). d14 → eskalace na admina; po termínu → všem.
function prijemci(milnik, { garant, spravce, admin }) {
  let list;
  if (milnik === 'd14') list = [admin];
  else if (milnik === 'po_terminu') list = [garant, spravce, admin];
  else list = [garant, spravce];
  return list.filter(Boolean);
}

// ---- Finanční expozice ---------------------------------------------
function rocniEkvivalent({ hodnota, hodnota_typ }) {
  if (hodnota == null) return null;
  const h = Number(hodnota);
  if (hodnota_typ === 'mesicni') return h * 12;
  return h;
}
function expoziceZavazku(smlouvy) {
  const podleMeny = {};
  for (const s of smlouvy) {
    if (s.kategorie !== 'zavazek') continue;
    const rok = rocniEkvivalent(s);
    if (rok == null) continue;
    podleMeny[s.mena] = (podleMeny[s.mena] || 0) + rok;
  }
  return podleMeny;
}

// Roční toky = jen opakované závazky (měsíční ×12, roční). Ostatní typy
// (jednorázová, expozice/ručení, majetek) nejsou roční tok.
function jeRocniTok(typ) { return typ === 'mesicni' || typ === 'rocni'; }

/**
 * Auditovatelný rozpad závazků (§6). NEmíchá roční toky s jednorázovými /
 * podmíněnými. Vrací dva součty po měnách + položkový seznam + nevyčíslené.
 * smlouvy = aktivní závazky (i s hodnota=null).
 */
function rozpadZavazku(smlouvy) {
  const rocni = {};       // opakované roční toky (kvóty, paušály)
  const podmineno = {};   // jednorázové + ručení/expozice + majetek
  const polozky = [];
  const nevycisleno = [];
  for (const s of smlouvy) {
    if (s.kategorie !== 'zavazek') continue;
    if (s.hodnota == null) {
      nevycisleno.push({ cislo_smlouvy: s.cislo_smlouvy, protistrana_nazev: s.protistrana_nazev, hodnota_popis: s.hodnota_popis });
      continue;
    }
    const tok = jeRocniTok(s.hodnota_typ);
    const castka = s.hodnota_typ === 'mesicni' ? Number(s.hodnota) * 12 : Number(s.hodnota);
    const cil = tok ? rocni : podmineno;
    cil[s.mena] = (cil[s.mena] || 0) + castka;
    polozky.push({
      cislo_smlouvy: s.cislo_smlouvy, protistrana_nazev: s.protistrana_nazev,
      castka, mena: s.mena, hodnota_typ: s.hodnota_typ, skupina: tok ? 'rocni' : 'podmineno',
    });
  }
  return { rocni, podmineno, polozky, nevycisleno };
}

module.exports = {
  odvozenyDeadlineVypovedi, dalsiVyskyt,
  PORADI, decideMilnik, planNotifikace, prijemci,
  rocniEkvivalent, expoziceZavazku, rozpadZavazku, jeRocniTok,
};

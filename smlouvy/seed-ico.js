'use strict';
// Doplnění IČO protistran vytažených z PDF smluv (registr je neměl).
// Jen ověřená IČO z přečtených smluv; doplní se jen tam, kde ještě chybí.
// Cizí protistrany (PL/FR/KZ/CN) české IČO nemají. Guard 1×.

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_ico_v1';

const ICO = {
  '2025-004': '27906931', // ČD Cargo Logistics a.s.
  '2026-014': '26273365', // FILMFEST, s.r.o.
  '2026-006': '27373231', // ASEKOL a.s.
  '2026-001': '42194920', // Marius Pedersen a.s.
  '2026-002': '25788001', // Vodafone Czech Republic a.s.
  '2026-009': '61251186', // Scania Czech Republic s.r.o.
  '2025-008': '61251186', // Scania Czech Republic s.r.o.
  '2025-009': '61251186', // Scania Czech Republic s.r.o.
  '2026-010': '61251186', // Scania Czech Republic s.r.o.
  '2026-003': '25322478', // AVONET, s.r.o.
};

function seedIco(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  let n = 0;
  for (const [cislo, ico] of Object.entries(ICO)) {
    const s = M.smlouva.getByCislo(cislo);
    if (s && !s.protistrana_ico) { M.smlouva.update(s.id, { protistrana_ico: ico }, 'seed-ico'); n++; }
  }
  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed IČO: doplněno ${n} smluv`);
  return { doplneno: n };
}

module.exports = { seedIco, ICO, SEED_KEY };

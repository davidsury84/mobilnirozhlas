'use strict';
// Jednorázová reklasifikace typu hodnoty u již naimportovaných podmíněných
// závazků, aby se nemíchaly s ročními toky ve finančním rozpadu (§6).
//  - 2026-017 Contenur = ručení / expozice (strop, ne roční tok)
//  - 2025-010 Zhejiang = majetek (formy u výrobce v zahraničí)
// Nové importy klasifikuje parser/import už samy; tohle opraví starší data.

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_hodnota_typ_v1';
const RECLASS = {
  '2026-017': 'expozice',
  '2025-010': 'majetek',
};

function seedHodnotaTyp(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  let n = 0;
  for (const [cislo, typ] of Object.entries(RECLASS)) {
    const s = M.smlouva.getByCislo(cislo);
    if (s) { M.smlouva.update(s.id, { hodnota_typ: typ }, 'seed-htyp'); n++; }
  }
  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed hodnota_typ: reklasifikováno ${n} závazků`);
  return { reklasifikovano: n };
}

module.exports = { seedHodnotaTyp, RECLASS, SEED_KEY };

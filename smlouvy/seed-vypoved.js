'use strict';
// Jednorázové doplnění „jak/komu podat výpověď" u smluv, kde to plyne z textu PDF
// (registr to neobsahuje). Zdroj: plný text smluv/dodatků na Disku. Meta guard.

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_vypoved_v1';

const VYPOVED = {
  // ČD Cargo — nájemní smlouva č. 001/2025, dodatek č. 2, čl. 4.
  '2025-004': 'Výpověď (i bez udání důvodu) musí být oznámena e-mailem na jan.sonsky@elkoplast.cz a radim.prochazka@cdcl.cz. Výpovědní lhůta 2 měsíce začíná běžet prvním dnem měsíce následujícího po měsíci, ve kterém byla výpověď oznámena. (dodatek č. 2)',
};

function seedVypoved(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  let n = 0;
  for (const [cislo, text] of Object.entries(VYPOVED)) {
    const s = M.smlouva.getByCislo(cislo);
    if (!s || s.vypoved_zpusob) continue;   // jen když existuje a ještě není vyplněno
    M.smlouva.update(s.id, { vypoved_zpusob: text }, 'seed-vypoved');
    n++;
  }
  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed výpověď: doplněno u ${n} smluv`);
  return { doplneno: n };
}

module.exports = { seedVypoved, SEED_KEY, VYPOVED };

'use strict';
// Doplnění VŠECH hlídaných termínů z registru — i těch, které se při prvním
// importu jen navrhly a nezaložily (indexace, dohledové audity, roční review,
// konce záruk, opakované termíny z „Notifikace"). Dedup podle data u smlouvy;
// zakládají se jen budoucí (minulé volně parsované = šum). Guard 1×.

const { todayPrague } = require('./lib/datum');
const { RADKY } = require('./seed-registr');
const imp = require('./import');

const SEED_KEY = 'seed_terminy_navic_v1';

function seedTerminy(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  const dnes = todayPrague();
  let n = 0;
  for (const radek of RADKY) {
    const z = imp.zpracujRadek(radek);
    if (!z || z.typ !== 'smlouva') continue;
    const s = M.smlouva.getByCislo(z.draft.cislo_smlouvy);
    if (!s) continue;
    const existujici = M.termin.listBySmlouva(s.id);
    const dataSet = new Set(existujici.map((e) => e.datum));
    for (const t of z.navrhyTerminu) {
      if (dataSet.has(t.datum)) continue;      // stejné datum už evidováno
      if (t.datum < dnes) continue;            // minulé (často yearless parse) = přeskočit
      M.termin.create({ smlouva_id: s.id, ...t });
      dataSet.add(t.datum);
      n++;
    }
  }
  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed termínů navíc: založeno ${n}`);
  return { zalozeno: n };
}

module.exports = { seedTerminy, SEED_KEY };

'use strict';
// Jednorázové doplnění dodatků, které jsou na Disku, ale v registru nebyly
// jako záznam (jen zmínka v textu / vůbec). Obsah a odkazy vytaženy z Disku.
// Spouští se 1× (meta guard); idempotentní i podle (smlouva, číslo dodatku).

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_dodatky_v1';

const DODATKY = [
  { cislo_smlouvy: '2025-004', cislo: '1', datum: '2026-03-16',
    co_meni: 'Změna čl. 3 (dodání nejpozději 20.3.2026, předání kontejnerů 17.4.2026) a čl. 4 (doba nájmu od 17.4.2026 na 2 měsíce).',
    drive_url: 'https://drive.google.com/file/d/12pKPdV68rmZ7aJ5fb-uk-t2djE6sBUtG/view' },
  { cislo_smlouvy: '2025-004', cislo: '2', datum: '2026-07-08',
    co_meni: 'Změna čl. 2 – poplatek 120 Kč/kontejner ACTS/den, 2 kontejnery = 240 Kč/den. Změna čl. 4 – doba nájmu na dobu NEURČITOU, výpověď i bez důvodu s výpovědní lhůtou 2 měsíce.',
    drive_url: 'https://drive.google.com/file/d/1OCE54sz9VFt8Pz_UrXw_Yx5-riiW7dxH/view' },
];

function seedDodatky(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  let n = 0;
  for (const d of DODATKY) {
    const s = M.smlouva.getByCislo(d.cislo_smlouvy);
    if (!s) continue;
    const uz = M.dodatek.listBySmlouva(s.id).some((x) => String(x.cislo) === String(d.cislo));
    if (uz) continue;
    M.dodatek.create({ smlouva_id: s.id, cislo: d.cislo, datum: d.datum, co_meni: d.co_meni, drive_url: d.drive_url });
    n++;
  }
  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed dodatky: založeno ${n}`);
  return { zalozeno: n };
}

// Úprava smlouvy 2025-004 podle dodatku č. 2 (doba neurčitá, výpověď 2 měs.,
// cena 240 Kč/den) + zneaktivnění propadlého termínu konce platnosti.
const OPRAVA_KEY = 'seed_oprava_2025004_v1';
function seedOpravaCdCargo(M) {
  if (M.meta.get(OPRAVA_KEY)) return { skipped: true };
  const s = M.smlouva.getByCislo('2025-004');
  if (!s) { M.meta.set(OPRAVA_KEY, todayPrague()); return { skipped: true }; }
  M.smlouva.update(s.id, {
    platnost_typ: 'neurcita', platnost_do: null, platnost_podminka: null,
    vypovedni_lhuta_mesice: 2, prolongace: 'zadna',
    hodnota_popis: '240 Kč/den (2 kontejnery ACTS à 120 Kč/den)',
    stav: 'aktivni', stav_popis: 'doba neurčitá (dodatek č. 2)',
  }, 'seed-cdcargo');
  // propadlý termín konce platnosti (15.4.2026) už neplatí → neaktivní
  M.db.prepare(`UPDATE termin SET stav='neaktivni', updated_at=datetime('now')
    WHERE smlouva_id=? AND typ='konec_platnosti'`).run(s.id);
  M.meta.set(OPRAVA_KEY, todayPrague());
  console.log('[smlouvy] oprava 2025-004 dle dodatku č. 2 provedena');
  return { upraveno: true };
}

module.exports = { seedDodatky, seedOpravaCdCargo, DODATKY, SEED_KEY };

'use strict';
// Rozpad souhrnných řádků KS-2026 / KS-2025 na JEDNOTLIVÉ profily smluv —
// jeden na každou protistranu. Registr u nich uvádí jen názvy protistran
// (detaily „k extrakci samostatným během"), takže podmínky (dodání, záruka,
// SLA, hodnota) zůstávají k ručnímu doplnění. Odkaz = sdílená složka dávky.
// Spouští se 1× (meta guard); odstraní původní dva souhrnné bloky.

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_ks_rozpad_v1';

const LISTY = {
  'KS-2026': 'TS Zlín; SAKO Brno; Pražský plast. koš; Železný Brod; SMO Vých. Moravy 4×; Olomouc; Jasenná; Vysokomýtsko; Dolní Cerekev; Regia Autosalubritate MD 2×; Kroměříž; Nové Heřminovy; Nedašov; Pro-Doma; Mělník; Val. Meziříčí; DEK; Min. obrany 2×; KTS Ekologie; Werner Weber; Buzau RO; složky Hanácký venkov / HOLUBICE / SUTCO / Mírov / Loučka',
  'KS-2025': 'OKK Koksovny; ČD Cargo KS; Rychvald; Vítkovice Steel; TS Krnov; Muzeum Prahy; EKOPACK BG; Jablůnka; Holčovice; Louka; Čechy p. Kosířem; Bílé Karpaty; Sever Znojemska; Frýdecká skládka; Luhačovské Zálesí; Moravský kras; HZS Hlučín; Mezihoří 2×; Stř. Vsetínsko; VTýnec; Větrník; SAKO Brno; Svitávka; Moravská cesta; Darkovice; Gradinarium; V. Bíteš; Rančířov; Holešovsko; Bystřička; TS Olomouc; ŘSD; Brumov-Bylnice; Holešov; V. Karlovice; Bludov; SOMPO; Skanska SoD; Dolní Bečva; BIKRAN',
};

// Rozbalí seznam protistran: „N×" → N kopií, „složky A / B / C" → jednotlivé.
function rozbal(list) {
  const out = [];
  for (const raw of list.split(';')) {
    const item = raw.trim();
    if (!item) continue;
    if (/^složky/i.test(item)) {
      item.replace(/^složky\s*/i, '').split('/').forEach((n) => { const t = n.trim(); if (t) out.push(t); });
      continue;
    }
    const m = item.match(/^(.+?)\s*(\d+)\s*×\s*$/);
    if (m) { const name = m[1].trim(); const n = Number(m[2]); for (let i = 1; i <= n; i++) out.push(`${name} (${i}/${n})`); }
    else out.push(item);
  }
  return out;
}

function seedKsRozpad(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  let total = 0;
  for (const [cislo, list] of Object.entries(LISTY)) {
    const parent = M.smlouva.getByCislo(cislo);
    const folder = parent ? parent.drive_url : null;
    rozbal(list).forEach((name, i) => {
      M.smlouva.upsertDleCisla({
        cislo_smlouvy: `${cislo}-${String(i + 1).padStart(2, '0')}`,
        kategorie: 'odberatelska', smer: 'prijem', podtyp: 'kupní smlouva',
        protistrana_nazev: name,
        predmet: 'Kupní smlouva – kontejnery. Detail k doplnění (dodání, záruka 24–30 měs., SLA, hodnota).',
        stav: 'aktivni', stav_popis: 'plnění', drive_url: folder, je_placeholder: 0,
      }, 'seed-ks');
      total++;
    });
    if (parent) M.db.prepare('DELETE FROM smlouva WHERE cislo_smlouvy=?').run(cislo);
  }
  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed KS rozpad: založeno ${total} jednotlivých smluv, odstraněny 2 souhrnné bloky`);
  return { zalozeno: total };
}

module.exports = { seedKsRozpad, rozbal, LISTY, SEED_KEY };

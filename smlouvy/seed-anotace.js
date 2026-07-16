'use strict';
// Jednorázové doplnění čitelné anotace „o čem smlouva je" ke smlouvám.
// Vychází z předmětu v registru + detailů z nasdílených PDF (přečten vzorek).
// Spouští se 1× (meta guard); needituje smlouvy, které už anotaci mají ručně.

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_anotace_v1';

const ANOTACE = {
  '2026-017': 'Trojstranná dohoda: ELKOPLAST CZ ručí za platby Elkoplast Ukraine dodavateli Contenur Polska (max. 150 000 EUR, do 31.12.2026). Elkoplast UA je oficiální distributor Contenur na Ukrajině s min. odběrem 300 000 EUR za rok 2026. Polské právo, soud Rzeszów, výslovně bez odvolání na force majeure (válka).',
  '2025-004': 'Nájem kontejnerů ACTS pro ČD Cargo Logistics. Po dodatku č. 2 je smlouva na dobu neurčitou, cena 240 Kč/den za 2 kontejnery, výpovědní lhůta 2 měsíce.',
  '2026-014': 'Partnerská (sponzoringová) smlouva k 66. Zlín Film Festivalu (28.5.–3.6.2026): ELKOPLAST je partnerem za 150 000 Kč + DPH a dodá 1 000 ks kelímků NickNack; za to reklamní plnění (loga online, katalog, indoor/outdoor). Obě strany předloží vyhodnocení spolupráce (ELKOPLAST do 30.9., Filmfest do 31.10.2026).',
  '2026-006': 'ELKOPLAST propaguje ASEKOL na 66. ZFF; za propagaci inkasuje odměnu 100 000 Kč bez DPH, fakturovanou po akci.',
  '2026-001': 'Rámcová kupní smlouva 2026045 na kontejnery pro Marius Pedersen. Roční inflační indexace cen k 1.1. (nutno oznámit 30 dní předem), mimořádná úprava při růstu oceli o +10 %; povinná pojistka odpovědnosti min. 2 mil. Kč; sankce 500 Kč za kontejner a den.',
  '2026-008': 'Exkluzivní distribuce produktu HYDROCITY (Baroclean) pro ČR a SK na 3 roky. Roční kvóty odběru 400/450/500 tis. EUR, rabat 15 %, non-compete s pokutou 20 %, open account 200 000 EUR; spory přes ICC arbitráž v Paříži.',
  '2026-002': 'Rámcová smlouva OneNet (Vodafone) + dodatek 1 na firemní mobilní a hlasové služby. Min. plnění 29 000 Kč/měs, sleva 270 000 Kč, doba určitá 24 měsíců do 31.1.2028, inflační doložka od 1.1.2027 max +10 %.',
  '2026-003': 'Internetové připojení Fibre Premium 100/100 (AVONET) za 3 900 Kč/měs, minimálně do 28.2.2029. Předčasné ukončení = doplatek zbývajících paušálů.',
  '2026-004': 'Předplatné CRM Pipedrive Premium (11 licencí, přes Dáváme s.r.o.), roční plán od 20.1.2026 s automatickou obnovou. Změny počtu licencí je nutné provést min. 24 h před obnovou.',
  '2026-009': 'Telematika DARIS Control 1 (Scania) pro 4 vozy, 460 Kč/měs za vůz. Doba do 30.6.2027, výpovědní lhůta 3 měsíce.',
  '2025-008': 'Telematika DARIS Control 1 (Scania) pro 2 vozy (1TN 2905, 2906), 460 Kč/měs za vůz. Doba do 31.8.2027, výpovědní lhůta 3 měsíce.',
  '2025-009': 'Servisní smlouva Scania Services 360 Core Classic pro vůz 1TN 2905: 4 555 Kč/měs + 0,5466 Kč/km, limit 710 000 km nebo 31.8.2027. Sankce za nepřistavení vozu, inflační úprava k 1.1.',
  '2026-010': 'Servisní smlouva Scania Services 360 Classic Core pro vůz 1TN 2072: 3 352 Kč/měs + 0,6704 Kč/km, limit 564 000 km nebo 30.4.2028; servis Vizovice.',
  '2025-001': 'Certifikace systému bezpečnosti práce dle ISO 45001 (SGS), tříletý cyklus s dohledovými audity (2026, 2027) a recertifikací 2028; indexace inflace.',
  '2026-007': 'Podlicence a systémová podpora ERP HELIOS iNuvio (HCV group), dodatek 2: roční podpora 248 181 Kč bez DPH; doba neurčitá.',
  '2026-005': 'Právní služby advokátní kanceláře Solkind, 2 600 Kč/hod. Klient může vypovědět kdykoli okamžitě, advokát s výpovědní lhůtou 1 měsíc.',
  '2026-013': 'Právní služby v Kazachstánu (TOO West East Legal, Astana) dle jednotlivých technických zadání; 100% předplatba do 5 bankovních dnů, měna tenge.',
  '2025-010': 'Pronájem 3 lisovacích forem (hodnota ~50 000 USD) u čínského výrobce Zhejiang Elec Barrel. Pokuta 200 000 EUR za zneužití, prodlení s vrácením 5 000 EUR/den; nájemce povinen formy pojistit na plnou hodnotu.',
  '2026-016': 'Memorandum o spolupráci s Univerzitou Tomáše Bati ve Zlíně (projekt POCEK, OP JAK) do 31.12.2028; odstoupení možné po 30denní lhůtě k nápravě.',
  '2026-011': 'Dodávka elektřiny (innogy) pro odběrné místo Tichov s fixací ceny; navazující smlouva pro rok 2026 ve složce. Prodloužení jen novým jednáním o ceně.',
  '2026-012': 'Výkup elektřiny z FVE Supíkovice a druhé výrobny (innogy) + navazující smlouvy 2027 a zemní plyn 2027; exkluzivita výkupu, rozhodčí doložka RS HK ČR.',
  '2026-015': 'Dodatek 1 ke smlouvě 158 – svoz směsného a tříděného odpadu (Valašskokloboucké služby) pro Ploštinu a Tichov: 3× 1100 l čtrnáctidenně za 18 000 Kč/rok + 740 Kč za mimořádný vývoz; ceník od 1.1.2026.',
  '2025-005': 'Rámcová smlouva (HYCA, SK): pronájem prostor a práce pro výrobu kontejnerů ve Zlíně 15.6.–30.9.2025, max. 1,9 mil. Kč; záruka 2 roky (do ~9/2027).',
  '2025-011': 'Kupní smlouva na 5 muld 7 m³ pro OZO Ostrava, 308 000 Kč bez DPH. Záruka 30 měsíců od předání; SLA: nástup na opravu do 72 h, odstranění do 3 dnů, jinak sankce 500 Kč/den.',
};

function seedAnotace(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  let n = 0;
  for (const [cislo, text] of Object.entries(ANOTACE)) {
    const s = M.smlouva.getByCislo(cislo);
    if (s && !s.anotace) { M.smlouva.update(s.id, { anotace: text }, 'seed-anotace'); n++; }
  }
  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed anotace: doplněno ${n} smluv`);
  return { doplneno: n };
}

module.exports = { seedAnotace, ANOTACE, SEED_KEY };

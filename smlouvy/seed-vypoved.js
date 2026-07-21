'use strict';
// Doplnění „jak/komu podat výpověď" u smluv, kde to plyne z PLNÉHO TEXTU PDF
// (registr to neobsahuje). Extrahováno ze smluv/dodatků na Disku; jednorázové
// kupní smlouvy bez výpovědní klauzule zde nejsou (mají jen odstoupení).
// Spouští se 1× (meta guard); vyplní jen tam, kde pole ještě není.

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_vypoved_v2';

const VYPOVED = {
  "2025-001": "Smlouva je na dobu určitou (certifikační cyklus); běžná výpověď zde není. Ukončit lze písemnou dohodou stran nebo písemným odstoupením při podstatném porušení (např. prodlení objednatele s platbou nad 30 dnů) či při insolvenci; odstoupení je účinné dnem doručení druhé straně. Komunikace o ukončení vyžaduje zaručený el. podpis, e-mail poskytovatele: cz.certification@sgs.com.",
  "2025-004": "Výpověď (i bez udání důvodu) musí být oznámena e-mailem na jan.sonsky@elkoplast.cz a radim.prochazka@cdcl.cz. Výpovědní lhůta 2 měsíce začíná běžet prvním dnem měsíce následujícího po měsíci, ve kterém byla výpověď oznámena. (dodatek č. 2)",
  "2025-008": "Smlouva na dobu určitou (1.9.2025–31.8.2027) lze ukončit výpovědí kterékoli strany. Výpovědní doba činí 3 měsíce a počíná běžet prvního dne kalendářního měsíce následujícího po doručení výpovědi druhé straně. Kontakt Zhotovitele (Scania): pavel.chromek@scania.com.",
  "2025-009": "Smlouvu Scania Services 360 může kterákoli strana vypovědět bez uvedení důvodu s výpovědní dobou 3 měsíce (čl. IX VSP). Smlouva navíc automaticky zaniká, skončí-li operativní leasing, nebo dosažením konečného stavu km. Kontakt Scania: pavel.chromek@scania.com.",
  "2025-010": "Nájem nástrojů na dobu neurčitou (§2). Končí automaticky bez výpovědi dnem, kdy skončí dodavatelský vztah mezi stranami, nebo na žádost pronajímatele (Elkoplast) o vrácení nástrojů dle §8. Výpovědní lhůta ani způsob podání nejsou stanoveny.",
  "2026-001": "Rámcová smlouva na dobu určitou do 31.12.2027. Lze vypovědět písemně bez udání důvodů s výpovědní lhůtou 2 měsíce, která běží od prvního dne měsíce následujícího po doručení výpovědi dodavateli; při podstatném porušení výpovědní lhůta 15 kalendářních dnů. Kontakt objednatele: kamila.hosova@mariuspedersen.cz.",
  "2026-002": "Rámcová smlouva Vodafone OneNet č. 002696 na dobu určitou 24 měsíců do 31.1.2028. Dodatek neuvádí výpovědní lhůtu; okamžité ukončení bez sankcí jen při porušení sankčních/exportních předpisů. Od 1.1.2027 automatické roční navýšení ceny o inflaci (max 10 %).",
  "2026-003": "Smlouva na dobu neurčitou s minimální dobou trvání 36 měsíců. Výpovědní doba činí 1 měsíc a začíná běžet dnem doručení výpovědi. Podává se písemně na Zákaznické centrum AVONET, Kvítková 4323, 760 01 Zlín, e-mail info@avonet.cz nebo firemni@avonet.cz. Po automatickém prodloužení lze vypovědět kdykoli bezplatně.",
  "2026-004": "Roční předplatné Pipedrive se automaticky obnovuje. Klasická výpovědní lhůta není sjednána; změny či zrušení počtu licencí/tarifu koordinuje zákazník se svou kontaktní osobou v Dáváme, resp. písemně přes portál https://support.davame.cz. U uzavřeného režimu je nutné žádost podat více než 24 hodin před datem obnovy.",
  "2026-005": "Klient (Elkoplast) může smlouvu vypovědět kdykoli bez udání důvodu písemnou výpovědí; není-li stanoveno jinak, výpověď je účinná doručením advokátovi (Solkind s.r.o., kontakt jan.sury@solkind.cz). Advokát může vypovědět rovněž bez důvodu s výpovědní dobou 1 měsíc od doručení klientovi. Při předčasném ukončení klient hradí poměrnou část odměny a hotové výdaje.",
  "2026-008": "Distribuční smlouva na dobu 3 let od podpisu (bez řádné výpovědní lhůty). Lze ji ukončit kdykoli písemnou dohodou stran; jinak zaniká s okamžitou účinností oznámením doporučeným dopisem jen v taxativních případech (porušení exkluzivity/dodávek/plateb, žádný prodej v 1. roce, insolvence apod.).",
  "2026-009": "Výpovědní doba činí 3 měsíce a počíná běžet prvního dne kalendářního měsíce následujícího po doručení písemné výpovědi druhé straně (čl. V odst. 3). Výpověď může podat kterákoli strana; smlouva je na dobu určitou (01.07.2026–30.06.2027).",
  "2026-010": "Kteroukoli ze smluvních stran lze smlouvu vypovědět bez uvedení důvodu s výpovědní dobou 3 měsíce. Scania může navíc smlouvu (celou i její část ke konkrétním vozidlům) ukončit výpovědí s okamžitou platností písemným oznámením zákazníkovi při prodlení s platbou či jiném porušení. Ukončení má účinky ex nunc.",
  "2026-011": "Smlouva o dodávce elektřiny na dobu určitou do 31.12.2025 (výpověď dle OP se týká smluv na dobu neurčitou: písemně, 3 měsíce od 1. dne měsíce po doručení). Předčasné ukončení zákazníkem zakládá smluvní pokutu dle čl. 10 OP. Obchodník: innogy Energie, s.r.o.",
  "2026-012": "Smlouva o výkupu elektřiny na dobu určitou 1.5.2026–31.12.2026, bez výpovědní lhůty. Lze ukončit odstoupením při opakovaném podstatném porušení (bezdůvodné přerušení dodávky/odběru, insolvence). Při předčasném ukončení z důvodů na straně Výrobce hrozí kompenzační platba a náhrada škody.",
  "2026-014": "Smlouva je na dobu určitou do 30.9.2026. Lze ji ukončit písemnou dohodou obou stran nebo odstoupením jen z důvodu podstatného porušení či ze zákonných důvodů. Odstoupení musí být písemné s uvedením důvodu, účinné dnem doručení druhé straně. Výpovědní lhůta sjednána není.",
  "2026-017": "Smlouva (garance) platí do konce roku 2026 s automatickým prodloužením na rok 2027, pokud se strany nerozhodnou ji neukončit. Výpovědní doba činí 6 měsíců. Změna či ukončení vyžaduje písemný dodatek podepsaný oběma stranami. Při neplnění podmínek lze ukončit okamžitě poškozenou stranou s pokutou dle §11.",
  "KS-2025-07": "Rámcovou smlouvu lze vypovědět s 30denní písemnou výpovědní lhůtou (čl. VII odst. 3). Oznámení se zasílá na adresy stran a e-maily: prodávající radoslav.rojko@elkoplast.cz a velin.dimitrov@elkoplast.eu, kupující khristova@ecopack.bg. Smlouva jinak platí do 31.1.2027, popř. do dodání celého množství.",
  "KS-2025-15": "Rámcová kupní smlouva na dodávku 500 ks košů (etapy 2025–2027), bez výpovědní lhůty. Lze ukončit dohodou, okamžitým zrušením ze strany kupujícího při opětovném závažném porušení prodávajícím, nebo okamžitým zrušením prodávajícím při opětovném nedodržení splatnosti kupujícím.",
  "KS-2025-28": "Rámcová smlouva je platná 12 měsíců od podpisu a lze ji obnovit písemnou dohodou. Kterákoli strana ji může ukončit s výpovědní lhůtou 30 dní. Výpověď se podává druhé straně (Elkoplast, resp. Gradinariu Import Export SRL) písemně; konkrétní e-mail/adresa pro výpověď ve smlouvě uvedena není.",
  "KS-2026-09": "Rámcová smlouva na dobu 12 měsíců, bez řádné výpovědní lhůty. Kupující ji může okamžitě ukončit oznámením při podstatném porušení (prodlení s dodávkou nad 30 dní, neodstranění porušení, vyšší moc, nepravdivé údaje). Účinnost ukončení nastává doručením oznámení druhé straně.",
  "KS-2026-13": "Rámcová kupní smlouva PRO-DOMA na dobu určitou do 28.2.2027. Lze písemně vypovědět i bez uvedení důvodu; výpovědní lhůta 1 měsíc běží od prvního dne následujícího po doručení výpovědi. Strany se mohou též kdykoli písemně dohodnout na zániku smlouvy.",
  "KS-2026-17": "Smlouvu lze ukončit výpovědí s jednoměsíční výpovědní lhůtou; výpovědní doba běží prvním dnem následujícím po doručení výpovědi druhé smluvní straně. Písemná komunikace se vede přes Národní elektronický nástroj (NEN), při nedostupnosti datovou schránkou ID hjyaavk.",
  "KS-2026-22": "Smlouva o dodávce plynu na dobu určitou (dodávky 1.1.2028–31.12.2029). Výpověď v OP se týká smluv na dobu neurčitou. Ukončení dohodou nebo odstoupením při podstatném porušení (písemně, účinné doručením). Předčasné ukončení zákazníkem zakládá smluvní pokutu dle čl. 10 OP. Obchodník: innogy Energie, s.r.o.",
  "KS-2026-23": "Distribuční smlouva (RS TeamTech). Každá strana může vypovědět s 6měsíční písemnou výpovědní lhůtou ke konci kalendářního měsíce (§14). Během výpovědní lhůty smlouva plně platí a distributor nesmí konkurovat; zákaz konkurence a mlčenlivost trvají 2 roky po ukončení. Výrobce může vypovědět s okamžitou účinností při porušení mlčenlivosti, exkluzivity či duševního vlastnictví.",
  "KS-2026-28": "Rámcová smlouva o dílo (bez výpovědní lhůty), ukončení pouze odstoupením do konce záruční doby (§14). Odstoupení musí být písemné s uvedením důvodu. Zhotovitel může odstoupit při neplacení delším než 30 dní i přes písemnou výzvu, nebo při odmítnutí akceptace či insolvenci Contractora.",
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

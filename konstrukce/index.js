'use strict';
// ============================================================================
//  Modul „Konstrukce" — workflow zadání a schválení standardního výkresu
//  Od požadavku obchodníka přes zkreslení na konstrukci až po schválení
//  klientem přes zabezpečený veřejný náhled. Vzorový výrobek: ABROLL kontejner.
//
//  Montuje se ze server.js:
//    const konstrukce = require('./konstrukce').mount({
//      send, readBody, deliver, empSession, isAdmin, baseUrl,
//      employeeModules, getState, dataDir, mailFrom
//    });
//  a v routingu: if (konstrukceMod && await konstrukceMod.handle(req, res)) return;
//  Veřejné cesty (/konstrukce/nahled/*, /api/konstrukce/nahled/*) musí být
//  propuštěny mimo SSO závoru v server.js.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const urlLib = require('url');
const https = require('https');

const HTML_FILE = path.join(__dirname, 'konstrukce.html');

// Katalog standardních výrobků (ART NO.) z ceníku PRICE LIST ABR-XXX — 6 řad ABROLL.
let KATALOG_ABR = [];
try { KATALOG_ABR = (JSON.parse(fs.readFileSync(path.join(__dirname, 'katalog-abr.json'), 'utf8')).polozky) || []; } catch (_) {}

// ---- Dotazník provedení kontejneru ABROLL (ABR-DSD) ------------------------
// Zdroj: sdílený Google Sheet „Dotazník provedení kontejneru Abroll".
// Pole typu 'volba' mají standard/opci; obchodník volí standard, opci, nebo
// zapíše vlastní „požadavek zákazníka". Jeden informační tok Obchod → Konstrukce.
const DOTAZNIK_ABROLL = [
  { title: 'Základní údaje', fields: [
    { k: 'rozmery', label: 'Vnitřní rozměry (délka × šířka × výška)', type: 'text' },
    { k: 'pocet', label: 'Počet ks', type: 'number' },
    { k: 'adresaDodani', label: 'Adresa dodání / určení', type: 'adresa' },
  ] },
  { title: 'Provedení', fields: [
    { k: 'provedeni', label: 'Provedení', std: '5/3', opce: '4/3 nebo jiné' },
    { k: 'natahovani', label: 'Natahování', std: 'NA 1570/50 — typ A (DIN, hák 50)', opce: 'NH 1570/50·60 (typ H) / NS 1570 (sklopné) / NV 1570/60 (vyměnitelné) / NAT·NHT (tunelové) / AFNOR: NA 1425/50 · NA 1450/50 · NT · NTA / NHNL (NL) / NL (lanové) / NR·NRS (řetězové)' },
    { k: 'prumerHaku', label: 'Průměr háku h 1570 (mm) — součást kódu natahování', std: '50 (…/50)', opce: '60 (…/60)' },
    { k: 'napojeniPodlaha', label: 'Napojení podlaha × bočnice', std: 'VP250 — vytažená podlaha ~250 mm (45×45°)', opce: 'VP000 (nevytažená) / K90 (kolmé 2300·2420) / R150 · R200 (kulaté) / +R = s podlahovým roštem (VP250R·VP000R·K90R)' },
    { k: 'vrchniLem', label: 'Vrchní lem', std: 'JE100 — jekl 100×80×4 S355', opce: 'TR114 — trubka 114×6 S355 / TR89 — trubka 89×6 S355' },
    { k: 'roztecVyztuhBocnice', label: 'Rozteč výztuh bočnice', std: '750 mm (průběžně)', opce: 'SV500 — rozteč 500 mm' },
    { k: 'profilVyztuhBocnice', label: 'Profil výztuh bočnice', std: 'VU100 — U100×60 (standard ELKOPLAST)', opce: 'VU80 (U80×60) / VU120 (U120×60) / VU100x50·VU80x50·VU120x50 (special výška)' },
    { k: 'roztecVyztuhPodlahy', label: 'Rozteč výztuh podlahy', std: '750 mm', opce: '500 mm' },
    { k: 'profilVyztuhPodlahy', label: 'Profil výztuh podlahy', std: 'VU100 — U100×60', opce: 'ZPN100 — zhuštěná podlaha U100×60×4' },
    { k: 'mezivyztuhaIPN', label: 'Mezivýztuha IPN × podlaha', std: 'ne', opce: 'MZVL — mezivýztuhy lyžina×podlaha / ZPN100 — zhuštěná podlaha' },
    { k: 'jisteniC', label: 'Jištění C v lyžině (C-doraz)', std: 'D1 — C-doraz ano', opce: 'D0 — C-doraz ne' },
    { k: 'zadniTramec', label: 'Zadní trámec', std: 'UPN 180', opce: 'UPN 200 + sloupky (kolmé napojení / šířka 2420)' },
    { k: 'rolny', label: 'Rolny 2 ks délka 300 mm', std: 'ROL159-300 — tr159, délka 300 (STD)', opce: 'ROL159-250·200 / …P (polyamid) / …S (šroubovací) / ROL203-200·ROL220-200 (AFS)' },
    { k: 'cepRolen', label: 'Čep rolen mazaný / průměr', std: 'CR300/40 (40 mm)', opce: 'CR300/50 / CR200/40 / CR200/50' },
    { k: 'provedeniVrat', label: 'Provedení vrat', std: '2křídlá — VRJEKL (jeklový lem)', opce: '1křídlá / VRVU (vyztužená U) / VRJT (těsněná) · klapky: KLS·KLST, KLZ (zvýšená), KLP (přejezdová), KLF (fr.), KH·KHT (hydraulická)' },
    { k: 'zaviraniVrat', label: 'Zavírání vrat', std: 'VSH — S hák', opce: 'VNL (holandské) / VDO (ala Domat) / VHD (kryté heavy duty) / VHM1·VHM2 (ala Hamo) / VDC (dvojité)' },
    { k: 'strecha', label: 'Střecha (směr ovládání je v kódu: …P vpravo / …L vlevo)', std: 'ne', opce: 'SMP·SML (mechanická vpravo·vlevo) / SHP·SHL (hydraulická) / SPP·SPL (posuvná) / SFX (fixní) / SDH (2dílná hydr.) · plachty: PRT (rolovací), PDP·PDL (dvoudílná)' },
    { k: 'hackyNaPlachtu', label: 'Háčky na plachtu', std: 'HPV500 — háčky zvrchu ~500 mm', opce: 'HPS500 (zespodu) / HP0 (bez háčků)' },
    { k: 'zebrik', label: 'Žebřík (výška kont. min 1500 mm)', std: 'ZC — protiskluz nášlapy (ČR), vlevo', opce: 'ZD (perfor nášlapy) / ZF (pásovina 40/8) / ZU (zapuštěný) / ZR (roxor boční) / Z0 (bez žebříku)' },
    { k: 'centralniJisteni', label: 'Centrální jištění vrat', std: 'CE — centrál vně trámce', opce: 'CA (automat s pružinou) / CS (Veolia BE·TVH) / CG (gravitační) / C0 (bez) · vlajka CV · klapka CD·CK' },
  ] },
  { title: 'Doplňky', fields: [
    { k: 'dvojiteZavirani', label: 'Dvojité zavírání', std: 'ne', opce: 'ano' },
    { k: 'zhustkeNosniky', label: 'Zhuštěné nosníky podlahy', std: 'ne', opce: 'ano 60×60×4' },
    { k: 'horizontalniVyztuha', label: 'Horizontální výztuha', std: 'ne', opce: 'ano', opceVstup: { placeholder: 'počet výztuh', unit: 'ks', num: true } },
    { k: 'poznamky', label: 'Jiné poznámky vč. barevného odstínu (RAL)', type: 'text', ral: true },
  ] },
];

// ---- Dotazník CITY — uzavřené městské abroll kontejnery (hákový nosič) ------
// Vychází z produktové knihovny (řada CITY: CSD/DSD/POP/WDG/WDC/RAM/WFR).
const DOTAZNIK_CITY = [
  { title: 'Základní údaje', fields: [
    { k: 'rada', label: 'Řada / provedení CITY', std: 'CSD (české uzavřené)', opce: 'DSD (dle DIN) / POP (popelničák) / WDG / WDC / RAM / WFR' },
    { k: 'rozmery', label: 'Vnitřní rozměry (délka × šířka × výška)', type: 'text' },
    { k: 'objem', label: 'Objem (m³)', std: '10,8 (CSD 3600×2000×1500)', opce: 'jiný dle rozměru (10–20 m³)' },
    { k: 'pocet', label: 'Počet ks', type: 'number' },
    { k: 'adresaDodani', label: 'Adresa dodání / určení', type: 'adresa' },
  ] },
  { title: 'Provedení', fields: [
    { k: 'natahovani', label: 'Natahování (hákový nosič)', std: 'NA 900/35/UPN140 — typ A (DIN, hák 35, lyžina UPN140)', opce: 'NA 1000/40 (do ČR, hák 40) / lyžina IPN120·IPN100·UPN100 / NRS (řetězové sklopné)' },
    { k: 'prumerHaku', label: 'Průměr háku (mm)', std: '35 (DIN, h900)', opce: '40 (ČR, h1000)' },
    { k: 'material', label: 'Materiál / tloušťky plechů (poměr dno/bočnice)', std: '3/2', opce: '4/3 / 5/3' },
    { k: 'napojeniPodlaha', label: 'Napojení podlaha × bočnice', std: '45/45 (vytažená)', opce: 'K90 — kolmé (šířky 2300·2420)' },
    { k: 'typLyziny', label: 'Typ lyžiny', std: 'IPN 120', opce: 'UPN 140 (nad 6 t) / IPN 100 / UPN 100' },
    { k: 'vrchniLem', label: 'Vrchní lem', std: '50×50×3', opce: '' },
    { k: 'roztecVyztuhBocnice', label: 'Výztuha bočnice', std: '1 středová výztuha (délka/2)', opce: 'sklopná bočnice (typ SB)' },
    { k: 'profilVyztuhBocnice', label: 'Profil výztuh bočnice', std: 'jekl 80×50×3', opce: '' },
    { k: 'zadniTramec', label: 'Zadní trámec', std: 'UPN 100', opce: '' },
    { k: 'rolny', label: 'Rolny 2 ks (délka 180 mm)', std: 'tr 133×6', opce: 'bez rolen' },
    { k: 'provedeniVrat', label: 'Provedení zadních vrat', std: '2křídlá', opce: 'nájezd klapka 500 / oboustr. klapka 500 / 1křídlá / V800 (snížená 800)' },
    { k: 'zaviraniVrat', label: 'Zavírání vrat', std: 'VSH2 — S hák/2', opce: 'VNL (holandské) / VDC (dvojité)' },
    { k: 'strecha', label: 'Zakrytí / střecha', std: 'ne (dle typu)', opce: 'SMP·SML (mechanická) / SFX (pevná sedlová) / PRT (rolovací plachta) / víko (POP popelničák)' },
    { k: 'zebrik', label: 'Žebřík (výška kont. min 1500 mm)', std: 'ano / vlevo ve směru jízdy', opce: 'ZD (perfor nášlapy) / ZF (pásovina 40/8) / Z0 (bez žebříku)' },
    { k: 'centralniJisteni', label: 'Centrální jištění vrat', std: 'ano / 1křídlo (CA/CE)', opce: 'C0 (bez)' },
  ] },
  { title: 'Doplňky', fields: [
    { k: 'dvojiteZavirani', label: 'Dvojité zavírání', std: 'ne', opce: 'ano' },
    { k: 'spodniVysyp', label: 'Spodní výsyp / výpust', std: 'ne', opce: 'ano' },
    { k: 'poznamky', label: 'Jiné poznámky vč. barevného odstínu (RAL)', type: 'text', ral: true },
  ] },
];

// ---- Dotazník MULDA — skipy / Absetzmulden (řetězová/lanová ramena) ---------
// Vychází z produktové knihovny (řada skips-muldy: AM/AMK/DMC/DMS/SMR/ASM; objemy 2,2–12 m³).
const DOTAZNIK_MULDA = [
  { title: 'Základní údaje', fields: [
    { k: 'objem', label: 'Objem (m³)', std: '5,5', opce: '2,2 / 3,5 / 7,0 / 10,0 / 12,0' },
    { k: 'rozmery', label: 'Vnitřní rozměry (délka × šířka × výška)', type: 'text' },
    { k: 'pocet', label: 'Počet ks', type: 'number' },
    { k: 'adresaDodani', label: 'Adresa dodání / určení', type: 'adresa' },
  ] },
  { title: 'Provedení', fields: [
    { k: 'typMuldy', label: 'Typ muldy', std: 'AM — otevřená (Absetzmulde)', opce: 'AMK / DMC / DMS / DMP (s víkem) / SMR / ASM' },
    { k: 'uchyceni', label: 'Systém uchycení (nosič)', std: 'řetězová / lanová ramena (Absetz)', opce: 'jeřábová (CRAN-MULDE) / jiné' },
    { k: 'norma', label: 'Národní provedení / norma', std: 'CZ', opce: 'DIN / CH / NL / FR / PreZero' },
    { k: 'plechy', label: 'Tloušťky plechů (dno/bočnice/čela)', std: '5/3/4 (534)', opce: '4/3/3 (433) / 6/4/4 (644) / 6/5/5 (655)' },
    { k: 'material', label: 'Materiál', std: 'ocel S235', opce: 'Hardox 450 (otěruvzdorný)' },
    { k: 'vyskaBocnic', label: 'Výška bočnic', std: 'dle objemu', opce: '890 mm (S_890mm)' },
    { k: 'ramNosniky', label: 'Rám / nosníky', std: 'U / UPN profily', opce: 'zesílený rám' },
    { k: 'zadniCelo', label: 'Zadní čelo', std: 'sklopná klapka', opce: 'dvoukřídlá vrata / pevné' },
    { k: 'viko', label: 'Víko / zakrytí', std: 'bez (otevřená)', opce: 'ocelové víko (DMC/DMS) / plachta / síť' },
    { k: 'vidliceKapsy', label: 'Vidlicové kapsy (pro VZV)', std: 'ne', opce: 'ano' },
    { k: 'spodniVysyp', label: 'Spodní výsyp / výpust', std: 'ne', opce: 'ano' },
  ] },
  { title: 'Doplňky', fields: [
    { k: 'vyztuhy', label: 'Přídavné vyztužení', std: 'ne', opce: 'ano (typ S1)' },
    { k: 'poznamky', label: 'Jiné poznámky vč. barevného odstínu (RAL)', type: 'text', ral: true },
  ] },
];

// ---- Dotazník SLD — kontejnery na separovaný sběr (papír/plast/sklo) --------
// Vychází z produktové knihovny (řada SLD-SM/PM, 2,0–4,0 m³, Duo/Triglo, odhlučnění).
const DOTAZNIK_SLD = [
  { title: 'Základní údaje', fields: [
    { k: 'objem', label: 'Objem (m³)', std: '3,0', opce: '2,0 / 2,5 / 3,5 / 4,0' },
    { k: 'rada', label: 'Typ / řada', std: 'SM', opce: 'PM / SM-NOR' },
    { k: 'rozmery', label: 'Rozměry (dle typu / výkresu)', type: 'text' },
    { k: 'pocet', label: 'Počet ks', type: 'number' },
    { k: 'adresaDodani', label: 'Adresa dodání / určení', type: 'adresa' },
  ] },
  { title: 'Provedení', fields: [
    { k: 'frakce', label: 'Sbíraná frakce', std: 'papír', opce: 'plast / sklo / papír + plast' },
    { k: 'komory', label: 'Komorové provedení', std: 'jednokomorové', opce: 'Duo (2 frakce) / Triglo (3 frakce)' },
    { k: 'material', label: 'Materiál / plechy', std: 'ocel S235; plechy 2/3 mm', opce: 'silnější dle zadání' },
    { k: 'vhoz', label: 'Vhozové otvory', std: 'dle frakce (standardní)', opce: 'atypické / počet dle zadání' },
    { k: 'vyprazdneni', label: 'Vyprazdňování', std: 'spodní výsyp (dvířka)', opce: 'jeřábové / jiné' },
    { k: 'uprava', label: 'Povrchová úprava', std: 'žárový zinek / základ', opce: 'lakované (RAL) — příplatek' },
    { k: 'odhlucneni', label: 'Odhlučnění', std: 'ne', opce: 'ano (příplatek)' },
  ] },
  { title: 'Doplňky', fields: [
    { k: 'zamek', label: 'Zámek / bezpečnostní vhoz', std: 'ne', opce: 'ano' },
    { k: 'polep', label: 'Polep / grafika', std: 'ne', opce: 'ano' },
    { k: 'poznamky', label: 'Jiné poznámky vč. barevného odstínu (RAL)', type: 'text', ral: true },
  ] },
];

// ---- Dotazník ZÁCHYTNÉ VANY — sump pallets (sudy / IBC) ---------------------
// Vychází z produktové knihovny (řada dle záchytného objemu 217/224/420/450/858 l).
const DOTAZNIK_VANY = [
  { title: 'Základní údaje', fields: [
    { k: 'zachytnyObjem', label: 'Záchytný objem (l)', std: '217', opce: '224 / 420 / 450 / 858' },
    { k: 'kapacita', label: 'Kapacita (sudy / IBC)', std: 'dle typu vany', opce: '1× IBC / 2–4 sudy / dle zadání' },
    { k: 'rozmery', label: 'Půdorysné rozměry (délka × šířka)', type: 'text' },
    { k: 'pocet', label: 'Počet ks', type: 'number' },
    { k: 'adresaDodani', label: 'Adresa dodání / určení', type: 'adresa' },
  ] },
  { title: 'Provedení', fields: [
    { k: 'material', label: 'Materiál', std: 'ocel (svařovaná vana)', opce: 'pozinkovaná / nerez' },
    { k: 'rost', label: 'Pochozí rošt', std: 'ano (pozinkovaný rošt)', opce: 'bez roštu' },
    { k: 'uprava', label: 'Povrchová úprava', std: 'žárový zinek', opce: 'lakované (RAL) / základ' },
    { k: 'vidliceKapsy', label: 'Vidlicové kapsy (pro VZV)', std: 'ano', opce: 'ne' },
    { k: 'norma', label: 'Provedení dle předpisů', std: 'pro nebezpečné / vodu znečišťující látky', opce: 'jiné' },
  ] },
  { title: 'Doplňky', fields: [
    { k: 'vypust', label: 'Výpustný kohout', std: 'ne', opce: 'ano' },
    { k: 'rampa', label: 'Nájezdová rampa', std: 'ne', opce: 'ano' },
    { k: 'poznamky', label: 'Jiné poznámky vč. barevného odstínu (RAL)', type: 'text', ral: true },
  ] },
];

// ---- Dotazník USB/LSB — skladovací stohovací boxy --------------------------
// Vychází z produktové knihovny (USB 0,5–2 m³ robustní; LSB 0,24–0,5 m³ lehké).
const DOTAZNIK_BOXY = [
  { title: 'Základní údaje', fields: [
    { k: 'rada', label: 'Řada / typ boxu', std: 'USB (univerzální stohovací)', opce: 'LSB (lehký skladovací)' },
    { k: 'velikost', label: 'Velikost / objem', std: 'USB 1 (1200×1200×850 ≈ 1 m³)', opce: '0,5 / 1,5 / 2 m³ · LSB 0,24–0,5 m³' },
    { k: 'rozmery', label: 'Rozměry (délka × šířka × výška)', type: 'text' },
    { k: 'pocet', label: 'Počet ks', type: 'number' },
    { k: 'adresaDodani', label: 'Adresa dodání / určení', type: 'adresa' },
  ] },
  { title: 'Provedení', fields: [
    { k: 'material', label: 'Materiál / plechy', std: 'ocel S235; stěny 2 mm', opce: 'silnější dle zadání' },
    { k: 'vyztuhy', label: 'Výztuhy / rám', std: 'rohové výztuhy 5 mm', opce: 'rám z úhelníku L 60×60×3 (LSB)' },
    { k: 'stohovani', label: 'Stohovatelnost', std: 'ano (stohovací prvky)', opce: 'ne' },
    { k: 'vidliceKapsy', label: 'Vidlicové kapsy (pro VZV)', std: 'ano', opce: 'ne' },
    { k: 'viko', label: 'Víko / zakrytí', std: 'bez (otevřený)', opce: 'víko / plachta' },
    { k: 'dno', label: 'Dno / vyprazdňování', std: 'pevné dno', opce: 'sklopné dno / spodní výsyp' },
    { k: 'uprava', label: 'Povrchová úprava', std: 'žárový zinek / základ', opce: 'lakované (RAL) — příplatek' },
  ] },
  { title: 'Doplňky', fields: [
    { k: 'stitek', label: 'Štítek / číslování', std: 'ne', opce: 'ano' },
    { k: 'poznamky', label: 'Jiné poznámky vč. barevného odstínu (RAL)', type: 'text', ral: true },
  ] },
];

// ---- Dotazník SU — kontejnery na separovaný sběr (PA/DR/GL, velikosti S/M/L) -
// Vychází z produktové knihovny (řada SU 3,0 a 5,0 m³; frakce papír/kartony/sklo).
const DOTAZNIK_SU = [
  { title: 'Základní údaje', fields: [
    { k: 'objem', label: 'Objem (m³)', std: '3,0', opce: '5,0' },
    { k: 'velikost', label: 'Velikost', std: 'M', opce: 'S / L' },
    { k: 'frakce', label: 'Frakce / provedení', std: 'PA — papír', opce: 'DR — nápojové kartony/plast / GL — sklo' },
    { k: 'pocet', label: 'Počet ks', type: 'number' },
    { k: 'adresaDodani', label: 'Adresa dodání / určení', type: 'adresa' },
  ] },
  { title: 'Provedení', fields: [
    { k: 'hrdlo', label: 'Vhozové hrdlo', std: 'jednohrdlové', opce: 'dvouhrdlové (2H)' },
    { k: 'vhoz', label: 'Velikost vhozu', std: 'dle frakce (standardní)', opce: 'GL 160 / 220 / 330 (sklo) / atyp' },
    { k: 'material', label: 'Materiál', std: 'ocel S235 (pilíř, podlaha)', opce: 'silnější dle zadání' },
    { k: 'spoje', label: 'Spojovací materiál', std: 'M16', opce: 'jiné' },
    { k: 'vyprazdneni', label: 'Vyprazdňování', std: 'spodní výsyp (jeřáb)', opce: 'jiné' },
    { k: 'uprava', label: 'Povrchová úprava', std: 'žárový zinek / základ', opce: 'lakované (RAL) — příplatek' },
    { k: 'sberatel', label: 'Sběratel (samostatná pozice)', std: 'ne', opce: 'ano (sběratel 5 m³)' },
  ] },
  { title: 'Doplňky', fields: [
    { k: 'polep', label: 'Polep / grafika', std: 'ne', opce: 'ano' },
    { k: 'zamek', label: 'Zámek / bezpečnostní vhoz', std: 'ne', opce: 'ano' },
    { k: 'poznamky', label: 'Jiné poznámky vč. barevného odstínu (RAL)', type: 'text', ral: true },
  ] },
];

// ---- Stavy zakázky (kap. 4 dokumentu) --------------------------------------
// SEED_STAV = výchozí definice stavů. Za běhu se čte z d.workflow.nodes (živé
// pravidlo editovatelné na plátně); tento seed slouží k prvnímu vytvoření
// pravidla a jako fallback. Metadata stavu:
//   onTurn   = role, která je „na tahu"
//   phase    = fáze procesu (obchod|konstrukce|schvaleni|vyroba) pro dashboard
//   lhutaKey = klíč lhůty z číselníku typu (offset od bodu 0 = zadání)
//   lhutaFrom= 'bod0' (výchozí) | 'step' (revize běží od začátku kroku)
//   kind     = start|klient|hold|end|normal (pro plátno a efekty)
const SEED_STAV = {
  novy:      { label: 'Nový — rozdělení do závodu', onTurn: 'vykonny-reditel', terminal: false, phase: 'obchod',     lhutaKey: 'lhutaPrideleniDays', kind: 'start' },
  prideleni: { label: 'Přidělení konstruktéra',     onTurn: 'sef',            terminal: false, phase: 'obchod',     lhutaKey: 'lhutaPrideleniDays', kind: 'normal' },
  prace:     { label: 'Obchodní dokumentace (zkreslení)', onTurn: 'konstrukter', terminal: false, phase: 'konstrukce', lhutaKey: 'lhutaZkresleniDays', kind: 'normal' },
  kontrola:  { label: 'Interní kontrola',  onTurn: 'sef',        terminal: false, phase: 'konstrukce', lhutaKey: 'lhutaKontrolaDays', kind: 'normal' },
  obchodnik: { label: 'U obchodníka',      onTurn: 'obchodnik',  terminal: false, phase: 'schvaleni',  lhutaKey: 'lhutaObchodnikDays', kind: 'normal' },
  klient:    { label: 'U klienta',         onTurn: 'obchodnik',  terminal: false, phase: 'schvaleni',  lhutaKey: 'lhutaKlientDays', kind: 'klient' }, // hlídá obchodník
  revize:    { label: 'Revize',            onTurn: 'konstrukter', terminal: false, phase: 'konstrukce', lhutaKey: 'lhutaRevizeDays', lhutaFrom: 'step', kind: 'normal' },
  podklady:  { label: 'Čeká na podklady',  onTurn: 'obchodnik',  terminal: false, phase: 'konstrukce', hold: true, kind: 'hold' },
  schvaleno: { label: 'Schváleno — výrobní dokumentace', onTurn: 'konstrukter', terminal: false, phase: 'vyroba', lhutaKey: 'lhutaVyrobaDays', noSemafor: true, kind: 'normal' }, // konstrukce vloží výrobní dokumentaci
  dokonceno: { label: 'Ve výrobě / Hotovo', onTurn: null,        terminal: true,  phase: 'vyroba', kind: 'end' },
  zamitnuto: { label: 'Zamítnuto / Storno', onTurn: null,        terminal: true,  kind: 'end' },
};

// ---- PRAVIDLO WORKFLOW (graf) — zdroj pravdy toku zakázky -------------------
// Uzly = stavy (z SEED_STAV + souřadnice x,y pro plátno), hrany = přechody.
// Hrana:
//   action  = klíč akce (shoduje se s efektem v apiTransition / systémovou akcí)
//   from    = zdrojový stav (nebo '*' = z libovolného neterminálního stavu)
//   to      = cílový stav (u self-akcí = from; u dynamických viz altTo)
//   altTo   = alternativní cíl (zkresleno: kontrola vs. obchodník dle internalCheck)
//   roles   = kdo smí (metadata + gate dostupnosti akce)
//   kind    = forward|reject|revize|hold|self|system|klient (barva/typ hrany)
//   source  = user (tlačítko v appce) | system (apiAssign/create) | klient (veřejný náhled)
//   needNote= vyžaduje poznámku
const WF_NODE_XY = {
  novy: [40, 60], prideleni: [250, 60], prace: [460, 60], kontrola: [670, 60],
  obchodnik: [880, 60], klient: [1090, 60], schvaleno: [1300, 60], dokonceno: [1510, 60],
  revize: [460, 250], podklady: [670, 250], zamitnuto: [1090, 250],
};
const SEED_WF_EDGES = [
  { action: 'create',            from: null,        to: 'novy',      roles: ['obchodnik'],                      kind: 'system', source: 'system', label: 'Nová zakázka (zadání)' },
  { action: 'rozdel-zavod',      from: 'novy',      to: 'prideleni', roles: ['vykonny-reditel', 'sef'],         kind: 'forward', source: 'user', label: 'Rozdělit do závodu', needPlant: true },
  { action: 'prideli',           from: 'prideleni', to: 'prace',     roles: ['sef'],                            kind: 'forward', source: 'system', label: 'Přidělit konstruktéra' },
  { action: 'zkresleno',         from: 'prace',     to: 'kontrola',  altTo: 'obchodnik',                        roles: ['konstrukter'], kind: 'forward', source: 'user', label: 'Zkresleno → kontrola' },
  { action: 'zkresleno',         from: 'revize',    to: 'kontrola',  altTo: 'obchodnik',                        roles: ['konstrukter'], kind: 'forward', source: 'user', label: 'Revize zkreslena → kontrola' },
  { action: 'kontrola-ok',       from: 'kontrola',  to: 'obchodnik', roles: ['sef'],                            kind: 'forward', source: 'user', label: 'Kontrola OK' },
  { action: 'kontrola-vrat',     from: 'kontrola',  to: 'prace',     roles: ['sef'],                            kind: 'reject',  source: 'user', label: 'Vrátit z kontroly', needNote: true },
  { action: 'obchodnik-ok',      from: 'obchodnik', to: 'obchodnik', roles: ['obchodnik'],                      kind: 'self',    source: 'user', label: 'Obchodník potvrdil' },
  { action: 'obchodnik-vrat',    from: 'obchodnik', to: 'prace',     roles: ['obchodnik'],                      kind: 'reject',  source: 'user', label: 'Připomínky obchodníka', needNote: true },
  { action: 'odeslat-klientovi', from: 'obchodnik', to: 'klient',    roles: ['obchodnik'],                      kind: 'forward', source: 'user', label: 'Odeslat klientovi', needPdf: true },
  { action: 'schvalit',          from: 'klient',    to: 'schvaleno', roles: ['klient'],                         kind: 'klient',  source: 'klient', label: 'Klient schválil' },
  { action: 'pripominky',        from: 'klient',    to: 'revize',    roles: ['klient'],                         kind: 'revize',  source: 'klient', label: 'Klient poslal připomínky' },
  { action: 'zamitnout',         from: 'klient',    to: 'zamitnuto', roles: ['klient'],                         kind: 'reject',  source: 'klient', label: 'Klient zamítl' },
  { action: 'vlozit-vyrobni-dok', from: 'schvaleno', to: 'dokonceno', roles: ['konstrukter'],                   kind: 'forward', source: 'user', label: 'Vložit výrobní dokumentaci', needVyrobni: true },
  { action: 'hold',              from: '*',         to: 'podklady',  roles: ['obchodnik', 'sef'],               kind: 'hold',    source: 'user', label: 'Pozastavit (čeká na podklady)', needNote: true },
  { action: 'unhold',            from: 'podklady',  to: '@prev',     roles: ['obchodnik', 'sef'],               kind: 'forward', source: 'user', label: 'Podklady doplněny' },
  { action: 'storno',            from: '*',         to: 'zamitnuto', roles: ['obchodnik', 'reditel'],           kind: 'reject',  source: 'user', label: 'Storno', needNote: true },
  { action: 'prideli-zavod',     from: '*',         to: '@self',     roles: ['vykonny-reditel', 'sef'],         kind: 'self',    source: 'user', label: 'Přeřadit závod' },
];
function buildSeedWorkflow() {
  const nodes = Object.keys(SEED_STAV).map(id => {
    const s = SEED_STAV[id]; const xy = WF_NODE_XY[id] || [40, 40];
    return Object.assign({ id, x: xy[0], y: xy[1] }, JSON.parse(JSON.stringify(s)));
  });
  return { nodes, edges: JSON.parse(JSON.stringify(SEED_WF_EDGES)), version: 1 };
}
const SEED_WORKFLOW = buildSeedWorkflow();

// Popisky rolí pro schéma / plátno (kdo je „na tahu")
const ROLE_LABELS = {
  obchodnik: 'Obchodník', sef: 'Šéf konstrukce', konstrukter: 'Konstruktér',
  reditel: 'Ředitel', 'vykonny-reditel': 'Výkonný ředitel výroby', 'vyrobni-reditel': 'Výrobní ředitel závodu',
  klient: 'Klient', '': '—',
};

// ---- Výrobní oblasti / střediska (seed — editovatelné v adminu) -------------
// Každá oblast má svého výrobního ředitele (reditelEmail = konkrétní člověk z databáze).
const SEED_STREDISKA = [
  { key: 'supikovice', label: 'Supíkovice', reditelEmail: '' },
  { key: 'bruntal', label: 'Bruntál', reditelEmail: '' },
  { key: 'bruntal-popelnice', label: 'Bruntál popelnice', reditelEmail: '' },
  { key: 'chomutov', label: 'Chomutov', reditelEmail: '' },
  { key: 'polsko', label: 'Polsko', reditelEmail: '' },
];

// ---- Výchozí číselník typů výrobku (seed) — řady ABROLL kontejnerů ---------
// 6 řad z ceníku ABR-XXX; všechny sdílí dotazník provedení (ABR-DSD) a výchozí lhůty.
// Názvy řad dle oficiální „Typová řada ABR kontejnerů" (kódy ABR-XXX).
const RADY_ABR = [
  ['dsd', 'DSD — kontejnery v normě DIN (DIN 30722)'],
  ['afs', 'AFS — kontejnery v normě AFNOR'],
  ['hbs', 'HBS — Hardox „halbšálen" (půlkulaté provedení)'],
  ['sth', 'STH — stohovací kontejnery dle DIN'],
  ['hbi', 'HBI — Hardox velké vypouklé (BIG & strong)'],
  ['lwc', 'LWC — lehké provedení Hardox / Strenx 700'],
];
const TYP_DEFAULTS = {
  standard: true, normohodiny: 8, revizeNh: 2,
  lhutaZkresleniDays: 3, lhutaRevizeDays: 2, lhutaPrideleniDays: 1, lhutaKontrolaDays: 1,
  lhutaObchodnikDays: 1, lhutaKlientDays: 5, lhutaVyrobaDays: 1,
  internalCheck: true, linkValidDays: 30, params: [],
};
const SEED_TYPES = [
  ...RADY_ABR.map(([key, name]) => ({ key, name, ...TYP_DEFAULTS, dotaznik: DOTAZNIK_ABROLL })),
  { key: 'city', name: 'CITY — uzavřený městský kontejner (hákový)', ...TYP_DEFAULTS, dotaznik: DOTAZNIK_CITY },
  { key: 'mulda', name: 'MULDA — skip / Absetzmulde (řetězová ramena)', ...TYP_DEFAULTS, dotaznik: DOTAZNIK_MULDA },
  { key: 'sld', name: 'SLD — kontejner na separovaný sběr', ...TYP_DEFAULTS, dotaznik: DOTAZNIK_SLD },
  { key: 'vany', name: 'Záchytná vana (sump pallet)', ...TYP_DEFAULTS, dotaznik: DOTAZNIK_VANY },
  { key: 'boxy', name: 'USB / LSB — skladovací stohovací box', ...TYP_DEFAULTS, dotaznik: DOTAZNIK_BOXY },
  { key: 'su', name: 'SU — kontejner na separovaný sběr', ...TYP_DEFAULTS, dotaznik: DOTAZNIK_SU },
];

// ---- Rodiny výrobků (skupiny) — pro přidělování konstruktérů dle skupiny -----
const TYP_FAM = { dsd: 'abroll', afs: 'abroll', hbs: 'abroll', sth: 'abroll', hbi: 'abroll', lwc: 'abroll', city: 'city', mulda: 'mulda', sld: 'sber', su: 'sber', vany: 'sklad', boxy: 'sklad' };
const FAM_LABEL = { abroll: 'ABROLL — hákové kontejnery', city: 'CITY — uzavřené městské', mulda: 'MULDA — skipy', sber: 'Separovaný sběr (SLD, SU)', sklad: 'Skladování (boxy, vany)' };
const FAM_ORDER = ['abroll', 'city', 'mulda', 'sber', 'sklad'];
function familyOf(typKey) { return TYP_FAM[typKey] || 'abroll'; }

// ---- Číselník druhů práce pro evidenci (seed z reálného deníku konstrukce) --
// kind: 'zakazka' = produktivní práce na konkrétní zakázce · 'rezie' = režie mimo zakázku
const SEED_ACTIVITIES = [
  { key: 'vyt-model', label: 'Vytvoření/modifikace modelu a OB-výkresu', kind: 'zakazka' },
  { key: 'chystani-sady', label: 'Chystání sady výkresů, Kusovník, DXF', kind: 'zakazka' },
  { key: 'nula-aktualizace', label: 'Model Nula. Aktualizace', kind: 'zakazka' },
  { key: 'nula-vytvoreni', label: 'Model Nula. Vytvoření/úprava', kind: 'zakazka' },
  { key: 'nula-kontrola', label: 'Model Nula. Kontrola sady podkladů', kind: 'zakazka' },
  { key: 'zmeny-prani', label: 'Změny podle přání', kind: 'zakazka' },
  { key: 'zmeny-vyroba', label: 'Změny/optimalizace podle otázek výroby', kind: 'zakazka' },
  { key: 'navrh-prototyp', label: 'Návrh prototypů', kind: 'zakazka' },
  { key: 'navrh-reseni', label: 'Vytvoření návrhu řešení. Posílání obchodníkům', kind: 'zakazka' },
  { key: 'dily-sdsp', label: 'Díly SD/SP. Vytváření/modifikace dílů', kind: 'zakazka' },
  { key: 'pridani-nula', label: 'Přidání zakázek podle NULA modelů', kind: 'zakazka' },
  { key: 'dokumentace', label: 'Vytvoření dodatečné dokumentace na vyžádání', kind: 'zakazka' },
  { key: 'tendr', label: 'TENDR — modely/prototyp, OB-výkres', kind: 'zakazka' },
  { key: 'konzultace-konstr', label: 'Spolupráce / konzultace konstruktéra', kind: 'rezie' },
  { key: 'konzultace-obch', label: 'Spolupráce / konzultace obchodníka', kind: 'rezie' },
  { key: 'rizeni-prace', label: 'Řízení práce – konstruktéři', kind: 'rezie' },
  { key: 'porada-stredisko', label: 'Porada výrobního střediska', kind: 'rezie' },
  { key: 'porada-ukoly', label: 'Porada podle skutečných úkolů', kind: 'rezie' },
  { key: 'administrativa', label: 'Vyřizování objednávek, e-mailů, dotazů z dílny a telefonátů', kind: 'rezie' },
  { key: 'jina', label: 'Jiná / dodatečná práce', kind: 'rezie' },
];

// ---- České státní svátky (pevné + pohyblivé velikonoční) --------------------
function easterSunday(year) {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher) — vrací {m, d}.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}
const _holCache = {};
function holidaySet(year) {
  if (_holCache[year]) return _holCache[year];
  const set = new Set([
    '01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26',
  ]);
  const es = easterSunday(year);
  const easter = new Date(Date.UTC(year, es.m - 1, es.d));
  const goodFri = new Date(easter); goodFri.setUTCDate(easter.getUTCDate() - 2);
  const easterMon = new Date(easter); easterMon.setUTCDate(easter.getUTCDate() + 1);
  const fmt = (dt) => String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  set.add(fmt(goodFri)); set.add(fmt(easterMon));
  _holCache[year] = set; return set;
}
function isWorkday(dt) {
  const dow = dt.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const key = String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  return !holidaySet(dt.getUTCFullYear()).has(key);
}
// Přičte N pracovních dnů k času a vrátí timestamp konce toho dne (23:59 UTC).
function addBusinessDays(fromTs, days) {
  const dt = new Date(fromTs);
  dt.setUTCHours(0, 0, 0, 0);
  let added = 0;
  while (added < days) { dt.setUTCDate(dt.getUTCDate() + 1); if (isWorkday(dt)) added++; }
  dt.setUTCHours(23, 59, 59, 0);
  return dt.getTime();
}
// Počet celých pracovních dnů mezi dvěma časy (může být záporný).
function businessDaysBetween(aTs, bTs) {
  let sign = 1, a = aTs, b = bTs;
  if (a > b) { sign = -1; a = bTs; b = aTs; }
  const dt = new Date(a); dt.setUTCHours(0, 0, 0, 0);
  const end = new Date(b); end.setUTCHours(0, 0, 0, 0);
  let n = 0;
  while (dt.getTime() < end.getTime()) { dt.setUTCDate(dt.getUTCDate() + 1); if (isWorkday(dt)) n++; }
  return sign * n;
}

function mount(host) {
  const DATA_F = path.join(host.dataDir || __dirname, 'konstrukce.json');
  const FILES_DIR = path.join(host.dataDir || __dirname, 'konstrukce-files');
  try { if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---- živé pravidlo workflow (graf) --------------------------------------
  // STAV = tabulka stavů odvozená z d.workflow.nodes (přepisuje se v load()).
  // Když admin upraví plátno, změní se onTurn / lhůty / fáze / dostupné akce.
  let STAV = {};
  let WF = { nodes: [], edges: [] };
  function syncWorkflow(d) {
    WF = d.workflow || { nodes: [], edges: [] };
    STAV = {};
    (WF.nodes || []).forEach(n => { STAV[n.id] = n; });
    // fallback: doplň případně chybějící stavy ze seedu, ať kód nespadne
    for (const k in SEED_STAV) if (!STAV[k]) STAV[k] = Object.assign({ id: k }, SEED_STAV[k]);
  }
  // Najde hranu grafu pro akci z daného stavu ('*' = odkudkoli).
  function wfEdge(action, fromStav) {
    return (WF.edges || []).find(e => e.action === action && (e.from === fromStav || e.from === '*')) || null;
  }
  function wfActionAllowed(action, fromStav) { return !!wfEdge(action, fromStav); }

  // ---- perzistence ---------------------------------------------------------
  // Práh (podíl lhůty) pro upozornění „blíží se termín" — drží se v synchronu s d.settings.notif.warnPct.
  let WARN_FRAC = 0.8;
  // Výchozí konfigurace notifikací a eskalací (editovatelné v SET-UP).
  const DEFAULT_NOTIF = { warnPct: 80, clientRemind1: 5, clientRemind2: 10, overdueEmail: true, directorDigest: true };
  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(DATA_F, 'utf8')); } catch (_) {}
    if (!d || typeof d !== 'object') d = {};
    if (typeof d.seq !== 'number') d.seq = 0;
    if (!d.roles || typeof d.roles !== 'object') d.roles = {};
    if (!d.fond || typeof d.fond !== 'object') d.fond = {};      // email -> hodin/týden
    if (!d.konstrukterGroups || typeof d.konstrukterGroups !== 'object') d.konstrukterGroups = {}; // email -> [rodiny výrobků]; prázdné = všechny
    if (!Array.isArray(d.types) || !d.types.length) d.types = JSON.parse(JSON.stringify(SEED_TYPES));
    // migrace na 6 řad ABROLL: starý jediný typ 'abroll' nahradíme řadami DSD/AFS/…
    if (!d.types.some(t => t.key === 'dsd')) d.types = JSON.parse(JSON.stringify(SEED_TYPES));
    // doplň chybějící seed typy (CITY/MULDA přidané později) beze změny existujících
    SEED_TYPES.forEach(s => { if (!d.types.some(t => t.key === s.key)) d.types.push(JSON.parse(JSON.stringify(s))); });
    // dotazník seed typů držíme v synchronu s kódem — každý typ svůj (ABROLL řady, CITY, MULDA)
    d.types.forEach(t => { const s = SEED_TYPES.find(x => x.key === t.key); if (s && s.dotaznik) t.dotaznik = JSON.parse(JSON.stringify(s.dotaznik)); });
    // Jednorázová oprava chybných názvů ABROLL řad (DIN/AFNOR/Hardox dle oficiální typové řady) — respektuje pozdější ruční přejmenování.
    if (d._abrNamesFixed !== 1) {
      RADY_ABR.forEach(([key, name]) => { const t = d.types.find(x => x.key === key); if (t) t.name = name; });
      d._abrNamesFixed = 1;
    }
    if (!Array.isArray(d.zakazky)) d.zakazky = [];
    // Migrace na nový tok: staré koncové stavy (byly už schválené a ve výrobě) → dokončeno; ať nespadnou na neznámém STAV.
    d.zakazky.forEach(z => { if (z.stav === 'vyroba' || z.stav === 'stredisko') { z.stav = 'dokonceno'; if (!z.closedAt) z.closedAt = Date.now(); z.deadline = null; } });
    // ---- pravidlo workflow (graf) — vytvoř při prvním běhu, jinak dosync uzly/hrany ----
    if (!d.workflow || typeof d.workflow !== 'object' || !Array.isArray(d.workflow.nodes) || !d.workflow.nodes.length) {
      d.workflow = JSON.parse(JSON.stringify(SEED_WORKFLOW));
    } else {
      if (!Array.isArray(d.workflow.edges)) d.workflow.edges = JSON.parse(JSON.stringify(SEED_WORKFLOW.edges));
      // doplň chybějící seed uzly (nové stavy přidané v kódu) beze změny pozic/úprav uživatele
      SEED_WORKFLOW.nodes.forEach(sn => { if (!d.workflow.nodes.some(n => n.id === sn.id)) d.workflow.nodes.push(JSON.parse(JSON.stringify(sn))); });
    }
    // Per-skupinová pravidla (návrh v sandboxu) + jejich koncepty. Engine je zatím
    // nekonzumuje (produkce jede na výchozím d.workflow) — go-live je samostatný krok.
    if (!d.workflowByFam || typeof d.workflowByFam !== 'object') d.workflowByFam = {};
    if (!d.workflowDraftByFam || typeof d.workflowDraftByFam !== 'object') d.workflowDraftByFam = {};
    syncWorkflow(d);
    if (!Array.isArray(d.notif)) d.notif = [];
    if (!Array.isArray(d.activities) || !d.activities.length) d.activities = JSON.parse(JSON.stringify(SEED_ACTIVITIES));
    if (!Array.isArray(d.timesheet)) d.timesheet = [];
    if (!Array.isArray(d.strediska) || !d.strediska.length) d.strediska = JSON.parse(JSON.stringify(SEED_STREDISKA));
    if (!Array.isArray(d.adresy)) d.adresy = [];   // globální číselník adres dodání (roste automaticky)
    if (!d.settings || typeof d.settings !== 'object') d.settings = {};
    if (typeof d.settings.reportEnabled !== 'boolean') d.settings.reportEnabled = true;
    if (!Array.isArray(d.settings.reportRecipients)) d.settings.reportRecipients = ['tomas.krajca@elkoplast.cz', 'david.sury@elkoplast.cz', 'lukas.pospisil@elkoplast.cz'];
    if (!d.settings.phaseDays || typeof d.settings.phaseDays !== 'object') d.settings.phaseDays = { obchod: 2, konstrukce: 5, schvaleni: 5, vyroba: 10 };
    if (!d.settings.notif || typeof d.settings.notif !== 'object') d.settings.notif = {};
    for (const k in DEFAULT_NOTIF) { if (d.settings.notif[k] == null) d.settings.notif[k] = DEFAULT_NOTIF[k]; }
    if (d.settings.reportFreq !== 'daily' && d.settings.reportFreq !== 'weekly') d.settings.reportFreq = 'weekly';
    if (typeof d.settings.reportDow !== 'number' || d.settings.reportDow < 0 || d.settings.reportDow > 6) d.settings.reportDow = 1; // 1 = pondělí
    WARN_FRAC = Math.min(1, Math.max(0, (Number(d.settings.notif.warnPct) || 80) / 100));
    return d;
  }
  function save(d) { fs.writeFileSync(DATA_F, JSON.stringify(d, null, 2)); }

  // ---- Fáze procesu: Obchod -> Konstrukce -> Schvaleni -> Zadani do vyroby ----
  const PHASE_LABEL = { obchod: 'Obchod', konstrukce: 'Konstrukce', schvaleni: 'Schvaleni', vyroba: 'Zadani do vyroby' };
  const PHASE_OF = { novy: 'obchod', prideleni: 'obchod', obchodnik: 'schvaleni', klient: 'schvaleni', prace: 'konstrukce', kontrola: 'konstrukce', revize: 'konstrukce', podklady: 'konstrukce', schvaleno: 'vyroba', dokonceno: 'vyroba' };
  function auditAt(z, needle, last) { let t = null; (z.audit || []).forEach(a => { if ((a.action || '').indexOf(needle) >= 0) { if (last) t = a.at; else if (t == null) t = a.at; } }); return t; }
  function computePhaseStats(d) {
    const acc = { obchod: [], konstrukce: [], schvaleni: [], vyroba: [] }, total = [];
    for (const z of (d.zakazky || [])) {
      const created = z.createdAt || null;
      const assigned = auditAt(z, 'Přidělení', false);
      const drawn = auditAt(z, 'Zkreslení hotovo', true);
      const approved = auditAt(z, 'Klient schválil', false);
      const toProd = auditAt(z, 'Předáno do výroby', false) || approved;
      const done = z.closedAt || null;
      if (created && assigned) acc.obchod.push(businessDaysBetween(created, assigned));
      if (assigned && drawn) acc.konstrukce.push(businessDaysBetween(assigned, drawn));
      if (drawn && approved) acc.schvaleni.push(businessDaysBetween(drawn, approved));
      if (toProd && done) acc.vyroba.push(businessDaysBetween(toProd, done));
      const end = done || approved;
      if (created && end) total.push(businessDaysBetween(created, end));
    }
    const avg = a => a.length ? Math.round(a.reduce((x, v) => x + v, 0) / a.length * 10) / 10 : null;
    return { obchod: avg(acc.obchod), konstrukce: avg(acc.konstrukce), schvaleni: avg(acc.schvaleni), vyroba: avg(acc.vyroba), total: avg(total),
      n: { obchod: acc.obchod.length, konstrukce: acc.konstrukce.length, schvaleni: acc.schvaleni.length, vyroba: acc.vyroba.length, total: total.length } };
  }
  // Referenční (standardní) typ pro cílové doby fází na dashboardu.
  function refType(d) { return (d.types || []).find(t => t.standard) || (d.types || [])[0] || {}; }
  // Cílové doby fází ODVOZENÉ z per-krokových lhůt typu (jediný zdroj pravdy = Postup / Role a číselník).
  // Kroky jsou offsety od bodu 0 → konec fáze = nejzazší offset jejích kroků; délka fáze = rozdíl konců.
  function phaseDaysFromType(t) {
    t = t || {};
    const n = v => Math.max(0, Number(v) || 0);
    const obchodEnd = n(t.lhutaPrideleniDays);
    const konstrEnd = Math.max(n(t.lhutaZkresleniDays), n(t.lhutaKontrolaDays), obchodEnd);
    const schvalEnd = Math.max(n(t.lhutaObchodnikDays), n(t.lhutaKlientDays), konstrEnd);
    const vyrobaEnd = Math.max(n(t.lhutaVyrobaDays), schvalEnd);
    return { obchod: obchodEnd, konstrukce: konstrEnd - obchodEnd, schvaleni: schvalEnd - konstrEnd, vyroba: vyrobaEnd - schvalEnd };
  }
  function isoWeekKey(ts) { const dt = new Date(ts); const day = (dt.getUTCDay() + 6) % 7; const th = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - day + 3)); const wk = 1 + Math.round((th - new Date(Date.UTC(th.getUTCFullYear(), 0, 4))) / 604800000); return th.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  function buildWeeklyReport(d) {
    const now = Date.now();
    const open = (d.zakazky || []).filter(z => STAV[z.stav] && !STAV[z.stav].terminal);
    const overdue = open.filter(z => semafor(z) === 'red');
    const byPhase = { obchod: 0, konstrukce: 0, schvaleni: 0, vyroba: 0 };
    open.forEach(z => { const ph = (STAV[z.stav] && STAV[z.stav].phase) || PHASE_OF[z.stav]; if (ph) byPhase[ph]++; });
    const ps = computePhaseStats(d), pd = phaseDaysFromType(refType(d));
    const pa = (v, tgt) => (v == null ? '\u2014' : v + ' d') + (tgt ? ' (cíl ' + tgt + ' d)' : '');
    let t = 'Týdenní přehled \u2014 Konstrukce (' + fmtDate(now) + ')\n\n';
    t += 'Otevřených zakázek: ' + open.length + '\nPo termínu: ' + overdue.length + '\n\n';
    t += 'Rozpracováno dle fáze:\n\u2022 Obchod: ' + byPhase.obchod + '\n\u2022 Konstrukce: ' + byPhase.konstrukce + '\n\u2022 Schválení: ' + byPhase.schvaleni + '\n\u2022 Zadání do výroby: ' + byPhase.vyroba + '\n\n';
    if (overdue.length) t += 'Zpožděné zakázky:\n' + overdue.map(z => '\u2022 ' + z.cislo + ' (' + z.zakaznik + ') \u2014 ' + STAV[z.stav].label + ', termín ' + fmtDate(z.deadline) + ', odpovídá ' + (empName(responsibleEmail(z)) || '\u2014')).join('\n') + '\n\n';
    t += 'Průměrná skutečná doba fází (prac. dny):\n\u2022 Obchod: ' + pa(ps.obchod, pd.obchod) + '\n\u2022 Konstrukce: ' + pa(ps.konstrukce, pd.konstrukce) + '\n\u2022 Schválení: ' + pa(ps.schvaleni, pd.schvaleni) + '\n\u2022 Zadání do výroby: ' + pa(ps.vyroba, pd.vyroba) + '\n\u2022 Celý proces: ' + pa(ps.total, null) + '\n';
    return t;
  }

  // ---- role a přístup ------------------------------------------------------
  // Je uživatel výrobním ředitelem některé oblasti? (role odvozená z číselníku oblastí)
  function isVyrobniReditel(d, email) {
    if (!email) return false;
    return (d.strediska || []).some(s => (s.reditelEmail || '').toLowerCase() === email.toLowerCase());
  }
  function oblastReditel(d, key) {
    const s = (d.strediska || []).find(x => x.key === key);
    return s ? (s.reditelEmail || '') : '';
  }
  function maModul(req) {
    if (host.isAdmin(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    const email = (e.email || '').toLowerCase();
    try {
      if ((host.employeeModules(e.email) || []).includes('konstrukce')) return true;
    } catch (_) {}
    // Obchodníci (modul Obchod / Obchod EXP nebo „Rozdělení obchodníků") mají zadávání implicitně.
    if (host.isObchodnik && host.isObchodnik(email)) return true;
    const d = load();
    return !!d.roles[email] || isVyrobniReditel(d, email);
  }
  // Efektivní role uživatele: admin vidí vše; jinak z číselníku rolí, případně
  // odvozeně „vyrobni-reditel", je-li ředitelem některé výrobní oblasti.
  function roleOf(req) {
    const e = host.empSession(req);
    const isAdm = host.isAdmin(req);
    const email = e ? (e.email || '').toLowerCase() : '';
    const d = load();
    let r = email ? (d.roles[email] || '') : '';
    if (!r && email && isVyrobniReditel(d, email)) r = 'vyrobni-reditel';
    // Obchodníci (přístup k modulu Obchod nebo v „Rozdělení obchodníků") mají roli obchodník implicitně.
    if (!r && email && host.isObchodnik && host.isObchodnik(email)) r = 'obchodnik';
    return { email, name: e ? e.name : '', isAdmin: isAdm, role: r };
  }
  // Seznam zaměstnanců intranetu pro výběr osob k rolím (jen pro admina).
  // Celé jméno „Jméno Příjmení". Když adresář má jen křestní jméno (nebo nic),
  // doplní příjmení z e-mailu (jmeno.prijmeni@…). Diakritiku křestního jména
  // z adresáře zachová, příjmení z e-mailu jen zkapitalizuje.
  function displayName(name, email) {
    name = String(name || '').trim();
    if (name.indexOf(' ') > 0) return name;                 // už celé jméno
    const lp = String(email || '').split('@')[0];
    const parts = lp.split(/[._-]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1));
    if (name && parts.length >= 2) return name + ' ' + parts.slice(1).join(' ');  // křestní (s diakritikou) + příjmení z e-mailu
    if (parts.length) return parts.join(' ');
    return name || email || '';
  }
  function adminEmployees() {
    try { return (host.getState().employees || []).map(x => ({ email: (x.email || '').toLowerCase(), name: displayName(x.name, x.email) })).filter(x => x.email).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs')); }
    catch (_) { return []; }
  }
  function empName(email) {
    if (!email) return '';
    try {
      const s = host.getState ? host.getState() : { employees: [] };
      const m = (s.employees || []).find(x => (x.email || '').toLowerCase() === email.toLowerCase());
      return displayName(m && m.name, email);
    } catch (_) { return email; }
  }
  function employeesWithRole(role) {
    const d = load();
    return Object.keys(d.roles).filter(em => d.roles[em] === role);
  }

  // ---- notifikace a e-maily ------------------------------------------------
  function notify(d, email, text, zakId) {
    if (!email) return;
    d.notif.unshift({ id: 'n' + crypto.randomBytes(5).toString('hex'), email: email.toLowerCase(), text, zakId: zakId || null, at: Date.now(), read: false });
    if (d.notif.length > 500) d.notif.length = 500;
  }
  async function mail(to, subject, text, html) {
    if (!to || !host.deliver || !host.mailFrom || !host.mailFrom.user) return;
    try {
      await host.deliver({ to, fromAddr: host.mailFrom.user, fromName: host.mailFrom.name || 'Intranet – konstrukce', subject, text, html: html || mailHtml(text) });
    } catch (e) { console.warn('[konstrukce] e-mail se nepodařilo odeslat (' + to + '): ' + e.message); }
  }
  function mailHtml(text) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#233;line-height:1.55">' +
      esc(text).replace(/\n/g, '<br>') + '</div>';
  }
  // České skloňování + barevný „odznak" dnů v prodlení (čím déle, tím výraznější).
  function sklonDni(n) { n = Math.abs(Number(n) || 0); if (n === 1) return 'den'; if (n >= 2 && n <= 4) return 'dny'; return 'dní'; }
  function sklonZakazek(n) { n = Math.abs(Number(n) || 0); if (n === 1) return 'zakázka'; if (n >= 2 && n <= 4) return 'zakázky'; return 'zakázek'; }
  function dnyBadge(dny) {
    let bg = '#fef9c3', fg = '#a16207'; // 1–2 dny žlutá
    if (dny >= 7) { bg = '#fee2e2'; fg = '#b91c1c'; }      // ≥7 červená
    else if (dny >= 3) { bg = '#ffedd5'; fg = '#c2410c'; } // 3–6 oranžová
    return '<span style="display:inline-block;min-width:30px;text-align:center;padding:3px 11px;border-radius:999px;background:' + bg + ';color:' + fg + ';font-weight:700;font-size:13px;white-space:nowrap">' + dny + ' ' + sklonDni(dny) + '</span>';
  }
  // Bohatý HTML souhrn zpožděných zakázek pro ředitele. `rows` už mají _krok/_termin/_kdo/_dny.
  function digestHtml(rows, today) {
    const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const max = rows.reduce((m, r) => Math.max(m, r._dny), 0);
    const th = (h, center) => '<th style="padding:9px 12px;text-align:' + (center ? 'center' : 'left') + ';font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0">' + h + '</th>';
    const body = rows.map((z, i) => {
      const bg = i % 2 ? '#f8fafc' : '#ffffff';
      const td = (v, extra) => '<td style="padding:9px 12px;border-bottom:1px solid #eef1f4;' + (extra || 'color:#334155') + '">' + v + '</td>';
      return '<tr style="background:' + bg + '">' +
        td('<strong style="color:#0f172a">' + e(z.cislo) + '</strong>') +
        td(e(z.zakaznik)) +
        td(e(z._krok)) +
        td(e(z._termin), 'color:#64748b;white-space:nowrap') +
        td(dnyBadge(z._dny), 'text-align:center') +
        td(e(z._kdo)) + '</tr>';
    }).join('');
    return '<div style="font-family:Segoe UI,Arial,sans-serif;background:#f1f5f9;padding:24px 12px">' +
      '<div style="max-width:660px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">' +
      '<div style="background:#0f172a;padding:18px 24px">' +
      '<div style="color:#fff;font-size:17px;font-weight:700">⚠&nbsp; Zpožděné zakázky konstrukce</div>' +
      '<div style="color:#94a3b8;font-size:13px;margin-top:3px">Stav k ' + e(today) + ' · ' + rows.length + '&nbsp;' + sklonZakazek(rows.length) + ' po termínu · nejdéle ' + max + '&nbsp;' + sklonDni(max) + '</div>' +
      '</div>' +
      '<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px">' +
      '<thead><tr style="background:#f8fafc">' + th('Zakázka') + th('Zákazník') + th('Krok') + th('Termín byl') + th('V prodlení', true) + th('Odpovídá') + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table>' +
      '<div style="padding:13px 24px;background:#fff;border-top:1px solid #eef1f4;color:#94a3b8;font-size:12px">Automatický denní souhrn · intranet, modul Konstrukce</div>' +
      '</div></div>';
  }

  // ---- odvozené hodnoty (semafor, na tahu) ---------------------------------
  function responsibleEmail(z) {
    const st = STAV[z.stav]; if (!st || !st.onTurn) return '';
    if (st.onTurn === 'konstrukter') return z.assignedTo || '';
    if (st.onTurn === 'obchodnik') return z.obchodnikEmail || '';
    if (st.onTurn === 'sef') { const s = employeesWithRole('sef'); return s[0] || ''; }
    if (st.onTurn === 'vykonny-reditel') { const s = employeesWithRole('vykonny-reditel'); return s[0] || ''; }
    return '';
  }
  function semafor(z) {
    const st = STAV[z.stav];
    if (!st || st.terminal || st.hold || st.noSemafor) return 'none';
    if (!z.deadline || !z.stepStartedAt) return 'green';
    const now = Date.now();
    if (now > z.deadline) return 'red';
    // Okno pro „blíží se" počítáme od bodu 0 (zadání), u kroků od začátku kroku (lhutaFrom='step').
    const base = (st.lhutaFrom === 'step') ? z.stepStartedAt : (z.createdAt || z.stepStartedAt);
    const total = z.deadline - base;
    const elapsed = now - base;
    if (total > 0 && elapsed >= WARN_FRAC * total) return 'amber';
    // zbývá poslední pracovní den → oranžová
    if (businessDaysBetween(now, z.deadline) <= 1) return 'amber';
    return 'green';
  }
  function typeOf(d, key) { return d.types.find(t => t.key === key) || d.types[0]; }
  // Zbytkové normohodiny úkolu pro kapacitní přehled.
  function remainingNh(d, z) {
    const t = typeOf(d, z.typKey);
    if (z.stav === 'revize') return t.revizeNh || 2;
    if (z.stav === 'prace' || z.stav === 'kontrola') return t.normohodiny || 8;
    return 0;
  }

  // ---- audit ---------------------------------------------------------------
  function audit(z, by, action, note, from, to) {
    if (!Array.isArray(z.audit)) z.audit = [];
    z.audit.push({ at: Date.now(), by: by || '', action, note: note || '', from: from || '', to: to || '' });
  }
  // Nastaví nový stav + termín + začátek kroku (výchozí lhůta z číselníku).
  function enterState(d, z, stav) {
    z.stav = stav;
    z.stepStartedAt = Date.now();
    const t = typeOf(d, z.typKey);
    // Lhůty kroků jsou OFFSETY od bodu 0 (zadání = z.createdAt) — dny se NESČÍTAJÍ.
    // Termín kroku = zadání + N prac. dní; stejné N u dvou kroků = stejné datum.
    const bod0 = z.createdAt || z.stepStartedAt;
    // Lhůta se čte z uzlu grafu: lhutaKey = klíč lhůty v číselníku typu;
    // lhutaFrom='step' (revize) běží od začátku kroku, jinak offset od bodu 0.
    const node = STAV[stav] || {};
    const days = node.lhutaKey ? Number(t[node.lhutaKey]) : 0;
    if (node.lhutaFrom === 'step') {
      z.deadline = days ? addBusinessDays(z.stepStartedAt, days) : null;
    } else {
      z.deadline = days ? addBusinessDays(bod0, days) : null;
    }
    // vyčistíme eskalační příznaky pro nový krok
    z.esc = { key: stav + ':' + (z.versions.length || 0) };
  }

  const CURRENT_V = (z) => z.versions[z.versions.length - 1] || null;

  // ======================================================================
  //  HTTP handler
  // ======================================================================
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true);
    const p = u.pathname;
    if (!p.startsWith('/konstrukce') && !p.startsWith('/api/konstrukce')) return false;

    // ---------- VEŘEJNÉ cesty klientského náhledu (bez SSO) ----------------
    if (p.startsWith('/konstrukce/nahled/') || p.startsWith('/api/konstrukce/nahled/')) {
      return await handlePublic(req, res, u, p);
    }

    // ---------- interní část: vyžaduje přístup k modulu --------------------
    if (!maModul(req)) {
      if (p.startsWith('/api/')) json(res, 403, { chyba: 'Nemáte přístup k modulu Konstrukce.' });
      else htmlOut(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K modulu Konstrukce nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }

    // stránka modulu
    if ((p === '/konstrukce' || p === '/konstrukce/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { htmlOut(res, 404, '<h1>Chybí konstrukce.html</h1>'); return true; }
      htmlOut(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }

    // interní stažení souboru (PDF/CAD) — jen pro role s přístupem
    if (p === '/api/konstrukce/soubor' && req.method === 'GET') {
      return serveInternalFile(res, u.query);
    }

    try {
      if (p === '/api/konstrukce/katalog' && req.method === 'GET') { json(res, 200, { polozky: KATALOG_ABR }); return true; }
      if (p === '/api/konstrukce/me' && req.method === 'GET') return apiMe(req, res);
      if (p === '/api/konstrukce/data' && req.method === 'GET') return apiData(req, res);
      if (p === '/api/konstrukce/zakazka' && req.method === 'POST') return apiCreate(req, res);
      if (p === '/api/konstrukce/prideli' && req.method === 'POST') return apiAssign(req, res);
      if (p === '/api/konstrukce/upload' && req.method === 'POST') return apiUpload(req, res);
      if (p === '/api/konstrukce/stav' && req.method === 'POST') return apiTransition(req, res);
      if (p === '/api/konstrukce/timer' && req.method === 'POST') return apiTimer(req, res);
      if (p === '/api/konstrukce/komentar' && req.method === 'POST') return apiComment(req, res);
      if (p === '/api/konstrukce/termin' && req.method === 'POST') return apiDeadline(req, res);
      if (p === '/api/konstrukce/notif-read' && req.method === 'POST') return apiNotifRead(req, res);
      if (p === '/api/konstrukce/admin/role' && req.method === 'POST') return apiAdminRole(req, res);
      if (p === '/api/konstrukce/admin/fond' && req.method === 'POST') return apiAdminFond(req, res);
      if (p === '/api/konstrukce/admin/konstrukter-groups' && req.method === 'POST') return apiAdminKonstrGroups(req, res);
      if (p === '/api/konstrukce/admin/workflow' && req.method === 'GET') return apiAdminWorkflowGet(req, res);
      if (p === '/api/konstrukce/admin/workflow' && req.method === 'POST') return apiAdminWorkflowSave(req, res);
      if (p === '/api/konstrukce/admin/typ' && req.method === 'POST') return apiAdminTyp(req, res);
      if (p === '/api/konstrukce/admin/seed' && req.method === 'POST') return apiAdminSeed(req, res);
      if (p === '/api/konstrukce/admin/settings' && req.method === 'POST') return apiAdminSettings(req, res);
      if (p === '/api/konstrukce/admin/report' && req.method === 'GET') return apiReport(req, res, false);
      if (p === '/api/konstrukce/admin/report' && req.method === 'POST') return apiReport(req, res, true);
      if (p === '/api/konstrukce/geocode' && req.method === 'GET') return apiGeocode(req, res, u.query);
      if (p === '/api/konstrukce/timesheet' && req.method === 'GET') return apiTimesheetGet(req, res, u.query);
      if (p === '/api/konstrukce/timesheet' && req.method === 'POST') return apiTimesheetSave(req, res);
      if (p === '/api/konstrukce/timesheet/delete' && req.method === 'POST') return apiTimesheetDelete(req, res);
      if (p === '/api/konstrukce/admin/activity' && req.method === 'POST') return apiAdminActivity(req, res);
      if (p === '/api/konstrukce/admin/stredisko' && req.method === 'POST') return apiAdminStredisko(req, res);
      if (p === '/api/konstrukce/admin/import' && req.method === 'POST') return apiAdminImport(req, res);
    } catch (e) {
      console.error('[konstrukce] chyba obsluhy:', e);
      json(res, 500, { chyba: 'Chyba serveru: ' + e.message }); return true;
    }

    json(res, 404, { chyba: 'Neznámá cesta modulu.' }); return true;
  }

  // ---- /me: kdo jsem a jaká je moje role -----------------------------------
  function apiMe(req, res) {
    const me = roleOf(req);
    json(res, 200, { email: me.email, name: me.name, isAdmin: me.isAdmin, role: me.role || (me.isAdmin ? 'admin' : '') });
    return true;
  }

  // ---- /data: role-filtrovaný přehled --------------------------------------
  function apiData(req, res) {
    const me = roleOf(req);
    const d = load();
    // který stav „vidím"? admin/šéf/ředitel = vše; obchodník = své zakázky; konstruktér = přiřazené.
    const canSeeAll = me.isAdmin || me.role === 'sef' || me.role === 'reditel' || me.role === 'vykonny-reditel';
    let list = d.zakazky.slice();
    if (!canSeeAll) {
      if (me.role === 'obchodnik') list = list.filter(z => (z.obchodnikEmail || '').toLowerCase() === me.email);
      else if (me.role === 'konstrukter') list = list.filter(z => (z.assignedTo || '').toLowerCase() === me.email);
      else if (me.role === 'vyrobni-reditel') {
        const myObl = (d.strediska || []).filter(s => (s.reditelEmail || '').toLowerCase() === me.email).map(s => s.key);
        list = list.filter(z => myObl.includes(z.strediskoKey));  // zakázky přiřazené do jeho závodu
      } else list = [];
    }
    // sečti hodiny z evidence práce podle zakázky (přičtou se k odpracováno)
    d._tsMap = {}; d.timesheet.forEach(t => { if (t.zakId) d._tsMap[t.zakId] = (d._tsMap[t.zakId] || 0) + (t.hours || 0); });
    const view = list.map(z => publicShape(d, z, me)).sort((a, b) => b.createdAt - a.createdAt);

    // kapacitní přehled konstruktérů (pro šéfa/admin)
    let kapacita = null;
    if (me.isAdmin || me.role === 'sef') kapacita = capacityOverview(d);

    const myNotif = d.notif.filter(n => n.email === me.email);
    json(res, 200, {
      me: { email: me.email, name: me.name || empName(me.email), isAdmin: me.isAdmin, role: me.role || (me.isAdmin ? 'admin' : '') },
      zakazky: view,
      types: d.types,
      kapacita,
      konstrukteri: employeesWithRole('konstrukter').map(em => ({ email: em, name: empName(em), groups: (d.konstrukterGroups[em] || []) })),
      families: FAM_ORDER.map(k => ({ key: k, label: FAM_LABEL[k] })),
      strediska: (d.strediska || []).map(s => ({ key: s.key, label: s.label, reditelEmail: s.reditelEmail || '', reditelName: s.reditelEmail ? empName(s.reditelEmail) : '' })),
      adresy: (d.adresy || []).slice().sort((a, b) => a.localeCompare(b, 'cs')),
      roles: (me.isAdmin) ? roleAssignments(d) : undefined,
      employees: (me.isAdmin) ? adminEmployees() : undefined,
      workflow: d.workflow,                            // pravidlo toku (graf) — pro schéma i plátno
      workflowDraft: (me.isAdmin) ? (d.workflowDraft || null) : undefined,  // rozpracovaný koncept plátna
      roleLabels: ROLE_LABELS,
      notif: myNotif.slice(0, 40),
      notifUnread: myNotif.filter(n => !n.read).length,
      now: Date.now(),
      settings: me.isAdmin ? d.settings : undefined,
      phaseDays: phaseDaysFromType(refType(d)),
      phaseDaysType: refType(d).name || '',
      phaseAvg: computePhaseStats(d),
      phaseLabel: PHASE_LABEL,
    });
    return true;
  }

  function capacityOverview(d) {
    const rows = employeesWithRole('konstrukter').map(em => {
      const fondTyden = d.fond[em] || 40;
      const tasks = d.zakazky.filter(z => (z.assignedTo || '').toLowerCase() === em && (z.stav === 'prace' || z.stav === 'kontrola' || z.stav === 'revize'));
      const nh = tasks.reduce((s, z) => s + remainingNh(d, z), 0);
      // dostupné hodiny do nejbližšího termínu (aprox: fond/den = fond/5)
      const denH = fondTyden / 5;
      const dostupne = Math.max(denH, denH * 5); // horizont ~týden
      const vytizeni = dostupne > 0 ? Math.round((nh / dostupne) * 100) : 0;
      return { email: em, name: empName(em), fondTyden, tasks: tasks.length, nh, vytizeni };
    });
    return rows.sort((a, b) => a.vytizeni - b.vytizeni);
  }
  // Přiřazení osob k rolím pro roli-centrickou administraci (role → seznam lidí).
  function roleAssignments(d) {
    const by = (role) => Object.keys(d.roles).filter(em => d.roles[em] === role)
      .map(em => ({ email: em, name: empName(em), fond: d.fond[em] || null, groups: (d.konstrukterGroups[em] || []) }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
    return { sef: by('sef'), konstrukter: by('konstrukter'), obchodnik: by('obchodnik'), reditel: by('reditel'), 'vykonny-reditel': by('vykonny-reditel') };
  }

  // Tvar zakázky pro frontend (bez interních tajností klienta se řeší v public části).
  function publicShape(d, z, me) {
    const t = typeOf(d, z.typKey);
    const cur = CURRENT_V(z);
    const tsSec = ((d._tsMap && d._tsMap[z.id]) || 0) * 3600;
    const totalSec = (z.timeEntries || []).reduce((s, e) => s + (e.seconds || 0), 0) + tsSec;
    const myTimer = z.activeTimer && me && z.activeTimer.user === me.email ? z.activeTimer : null;
    return {
      id: z.id, cislo: z.cislo, createdAt: z.createdAt,
      typKey: z.typKey, typName: t.name, family: familyOf(z.typKey), familyLabel: FAM_LABEL[familyOf(z.typKey)] || '',
      zakaznik: z.zakaznik, kontakt: z.kontakt, kontaktEmail: z.kontaktEmail,
      cisloPoptavky: z.cisloPoptavky, pozadovanyTermin: z.pozadovanyTermin || null,
      params: z.params || {}, dotaznik: z.dotaznik || null, artNo: z.artNo || '',
      stav: z.stav, stavLabel: STAV[z.stav].label, onTurn: STAV[z.stav].onTurn,
      obchodnikEmail: z.obchodnikEmail, obchodnikName: empName(z.obchodnikEmail),
      assignedTo: z.assignedTo || '', assignedName: z.assignedTo ? empName(z.assignedTo) : '',
      deadline: z.deadline || null, stepStartedAt: z.stepStartedAt || null,
      semafor: semafor(z),
      responsible: responsibleEmail(z), responsibleName: empName(responsibleEmail(z)),
      versionCount: z.versions.length,
      currentVersion: cur ? { v: cur.v, hasPdf: !!cur.pdf, hasCad: !!cur.cad, pdfName: cur.pdf && cur.pdf.name, cadName: cur.cad && cur.cad.name, author: empName(cur.author), createdAt: cur.createdAt } : null,
      versions: z.versions.map(v => ({ v: v.v, hasPdf: !!v.pdf, hasCad: !!v.cad, pdfName: v.pdf && v.pdf.name, cadName: v.cad && v.cad.name, author: empName(v.author), createdAt: v.createdAt })),
      comments: (z.comments || []).map(c => ({ id: c.id, author: c.authorName || empName(c.author), role: c.role, text: c.text, at: c.at, versionRef: c.versionRef })),
      totalSec, myTimer, timerRunning: !!(z.activeTimer),
      link: z.link ? { active: z.link.active, expiresAt: z.link.expiresAt, url: '/konstrukce/nahled/' + z.link.token, hasPin: !!z.link.pin, accesses: (z.link.accesses || []).length } : null,
      revisionCount: z.revisionCount || 0,
      strediskoKey: z.strediskoKey || '', strediskoName: z.strediskoName || '',
      vyrobniDok: z.vyrobniDok ? { name: z.vyrobniDok.name, at: z.vyrobniDok.at, author: empName(z.vyrobniDok.author) } : null,
      holdReason: z.holdReason || '', prevStav: z.prevStav || '',
      clientDecision: z.clientDecision || null,
      audit: z.audit || [],
    };
  }

  // Očistí odpovědi dotazníku podle definice typu (jen známá pole, omezené délky).
  function sanitizeDotaznik(t, raw) {
    if (!t || !Array.isArray(t.dotaznik) || !raw || typeof raw !== 'object') return null;
    const out = {};
    t.dotaznik.forEach(sec => (sec.fields || []).forEach(f => {
      const a = raw[f.k]; if (a == null) return;
      if (f.std !== undefined) {
        // pole typu volba: { volba: standard|opce|pozadavek, hodnota }
        const volba = ['standard', 'opce', 'pozadavek'].includes(a.volba) ? a.volba : 'standard';
        const hodnota = String(a.hodnota == null ? '' : a.hodnota).slice(0, 300);
        if (hodnota) out[f.k] = { volba, hodnota };
      } else {
        const v = String(a).slice(0, 500).trim(); if (v) out[f.k] = v;
      }
    }));
    return Object.keys(out).length ? out : null;
  }

  // ---- vytvoření zakázky (obchodník) ---------------------------------------
  async function apiCreate(req, res) {
    const me = roleOf(req);
    if (!(me.isAdmin || me.role === 'obchodnik')) { json(res, 403, { chyba: 'Zadávat požadavky smí jen obchodník.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const zakaznik = String(b.zakaznik || '').trim();
    if (!zakaznik) { json(res, 400, { chyba: 'Vyplňte zákazníka.' }); return true; }
    const d = load();
    const t = typeOf(d, b.typKey);
    d.seq += 1;
    const now = Date.now();
    const cislo = 'VYK-' + new Date(now).getUTCFullYear() + '-' + String(d.seq).padStart(4, '0');
    const z = {
      id: 'z' + crypto.randomBytes(7).toString('hex'), cislo, createdAt: now,
      createdBy: me.email, obchodnikEmail: me.email,
      typKey: t.key, params: b.params && typeof b.params === 'object' ? b.params : {},
      dotaznik: sanitizeDotaznik(t, b.dotaznik), artNo: String(b.artNo || '').slice(0, 60),
      zakaznik, kontakt: String(b.kontakt || '').trim(), kontaktEmail: String(b.kontaktEmail || '').trim(),
      cisloPoptavky: String(b.cisloPoptavky || '').trim(),
      pozadovanyTermin: b.pozadovanyTermin ? String(b.pozadovanyTermin).slice(0, 10) : null,
      stav: 'novy', versions: [], comments: [], timeEntries: [], activeTimer: null,
      assignedTo: '', link: null, revisionCount: 0, audit: [],
    };
    enterState(d, z, 'novy');
    audit(z, me.email, 'Založení požadavku', 'typ: ' + t.name);
    d.zakazky.push(z);
    // globální číselník adres: nová adresa dodání se automaticky přidá
    const adr = z.dotaznik && typeof z.dotaznik.adresaDodani === 'string' ? z.dotaznik.adresaDodani.trim() : '';
    if (adr && !d.adresy.some(x => x.toLowerCase() === adr.toLowerCase())) { d.adresy.push(adr); if (d.adresy.length > 800) d.adresy.shift(); }
    // kontrola realizovatelnosti požadovaného termínu (aprox z výchozích lhůt)
    let warn = null;
    if (z.pozadovanyTermin) {
      // Lhůty jsou offsety od zadání → interně hotovo = nejzazší z interních kroků (ne součet).
      const internalDays = Math.max(t.lhutaPrideleniDays || 0, t.lhutaZkresleniDays || 0, (t.internalCheck ? (t.lhutaKontrolaDays || 0) : 0), t.lhutaObchodnikDays || 0);
      const earliest = addBusinessDays(now, internalDays);
      if (new Date(z.pozadovanyTermin + 'T23:59:59Z').getTime() < earliest) warn = 'Pozor: požadovaný termín je při výchozích lhůtách (interně ~' + internalDays + ' prac. dnů) nereálný ještě před reakcí klienta.';
    }
    employeesWithRole('vykonny-reditel').forEach(em => { notify(d, em, 'Nový požadavek ' + cislo + ' (' + zakaznik + ') — rozdělte do výrobního závodu.', z.id); });
    save(d);
    // e-mail výkonnému řediteli výroby (první krok = rozdělení do závodu)
    for (const em of employeesWithRole('vykonny-reditel')) mail(em, 'Nový požadavek · rozdělení do závodu · ' + cislo, 'Obchodník ' + me.name + ' založil nový požadavek na výkres.\n\nČíslo: ' + cislo + '\nZákazník: ' + zakaznik + '\nTyp: ' + t.name + '\n\nRozdělte prosím zakázku do výrobního závodu (Bruntál / Chomutov / Supíkovice) v intranetu → Konstrukce.');
    json(res, 200, { ok: true, id: z.id, cislo, warn });
    return true;
  }

  // ---- přidělení konstruktéra (šéf) ----------------------------------------
  async function apiAssign(req, res) {
    const me = roleOf(req);
    if (!(me.isAdmin || me.role === 'sef')) { json(res, 403, { chyba: 'Přidělovat smí jen šéf konstrukce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    const konstrukter = String(b.konstrukter || '').toLowerCase().trim();
    if (!konstrukter) { json(res, 400, { chyba: 'Vyberte konstruktéra.' }); return true; }
    const prev = z.assignedTo;
    z.assignedTo = konstrukter;
    if (z.stav === 'prideleni') enterState(d, z, 'prace');
    audit(z, me.email, prev ? 'Přeřazení' : 'Přidělení', 'konstruktér: ' + empName(konstrukter) + (b.duvod ? ' — ' + b.duvod : ''));
    notify(d, konstrukter, 'Byl vám přidělen výkres ' + z.cislo + ' (' + z.zakaznik + '). Termín zkreslení: ' + fmtDate(z.deadline) + '.', z.id);
    save(d);
    mail(konstrukter, 'Přidělen výkres · ' + z.cislo, 'Byl vám přidělen požadavek na výkres.\n\nČíslo: ' + z.cislo + '\nZákazník: ' + z.zakaznik + '\nTermín zkreslení: ' + fmtDate(z.deadline) + '\n\nOtevřete intranet → Konstrukce.');
    json(res, 200, { ok: true });
    return true;
  }

  // ---- upload PDF / CAD (konstruktér) --------------------------------------
  async function apiUpload(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    if (!(me.isAdmin || (me.role === 'konstrukter' && (z.assignedTo || '').toLowerCase() === me.email))) { json(res, 403, { chyba: 'Nahrávat smí jen přiřazený konstruktér.' }); return true; }
    // Výrobní dokumentace — samostatný dokument vkládaný po schválení klientem (nepatří k verzím pro klienta).
    if (b.kind === 'vyrobni') {
      if (z.stav !== 'schvaleno') { json(res, 400, { chyba: 'Výrobní dokumentaci lze vložit až po schválení klientem.' }); return true; }
      const sv = saveFile(z.id, b.name, b.dataUrl, 'vyrobni');
      if (sv.chyba) { json(res, 400, { chyba: sv.chyba }); return true; }
      if (z.vyrobniDok && z.vyrobniDok.path) deleteFile(z.vyrobniDok.path);
      z.vyrobniDok = { name: sv.name, path: sv.path, at: Date.now(), author: me.email };
      audit(z, me.email, 'Vložena výrobní dokumentace', sv.name);
      save(d);
      json(res, 200, { ok: true, vyrobni: true });
      return true;
    }
    const kind = b.kind === 'cad' ? 'cad' : 'pdf';
    const saved = saveFile(z.id, b.name, b.dataUrl, kind);
    if (saved.chyba) { json(res, 400, { chyba: saved.chyba }); return true; }
    // pracujeme s „rozpracovanou" verzí = poslední verze bez uzamčení, nebo nová draft
    let draft = z.versions.find(v => !v.locked);
    if (!draft) { draft = { v: (z.versions.length ? z.versions[z.versions.length - 1].v : 0) + 1, author: me.email, createdAt: Date.now(), locked: false }; z.versions.push(draft); }
    if (draft[kind] && draft[kind].path) deleteFile(draft[kind].path);
    draft[kind] = { name: saved.name, path: saved.path, at: Date.now() };
    draft.author = me.email;
    save(d);
    json(res, 200, { ok: true, versionCount: z.versions.length });
    return true;
  }

  // ---- přechody stavů ------------------------------------------------------
  async function apiTransition(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    const action = String(b.action || '');
    const note = String(b.note || '').slice(0, 1000);
    const isSef = me.isAdmin || me.role === 'sef';
    const isObch = me.isAdmin || (me.role === 'obchodnik' && (z.obchodnikEmail || '').toLowerCase() === me.email) || (me.role === 'obchodnik' && isSef);
    const isKon = me.isAdmin || (me.role === 'konstrukter' && (z.assignedTo || '').toLowerCase() === me.email);
    const isVykonny = me.isAdmin || me.role === 'vykonny-reditel';       // výkonný ředitel výroby (rozděluje do závodů)
    let err = null;

    // Brána řízená pravidlem (grafem): akce je dostupná jen tam, kde v aktuálním
    // stavu existuje hrana. Když admin upraví plátno, projeví se to tady.
    const gedge = wfEdge(action, z.stav);   // hrana pravidla (z výchozího stavu) — pro oznámení dle pravidla
    if (!gedge) {
      json(res, 400, { chyba: 'Akce „' + action + '" není v tomto kroku (' + ((STAV[z.stav] && STAV[z.stav].label) || z.stav) + ') povolena.' });
      return true;
    }

    switch (action) {
      case 'zkresleno': { // konstruktér → interní kontrola
        if (!isKon) { err = 'Označit jako zkreslené smí jen přiřazený konstruktér.'; break; }
        if (z.stav !== 'prace' && z.stav !== 'revize') { err = 'Zakázka není ve stavu, kdy lze zkreslit.'; break; }
        const draft = z.versions.find(v => !v.locked);
        if (!draft || !draft.pdf) { err = 'Nejdřív nahrajte PDF výkresu pro klienta.'; break; }
        stopTimer(z, me.email);
        const t = typeOf(d, z.typKey);
        audit(z, me.email, 'Zkreslení hotovo', 'verze v' + draft.v);
        enterState(d, z, t.internalCheck ? 'kontrola' : 'obchodnik');
        if (t.internalCheck) employeesWithRole('sef').forEach(em => notify(d, em, 'Výkres ' + z.cislo + ' je zkreslený a čeká na interní kontrolu.', z.id));
        else { notify(d, z.obchodnikEmail, 'Výkres ' + z.cislo + ' je připraven k potvrzení.', z.id); mail(z.obchodnikEmail, 'Výkres zkreslen · ' + z.cislo, 'Výkres ' + z.cislo + ' (' + z.zakaznik + ') je zkreslený a čeká na vaše potvrzení.'); }
        break;
      }
      case 'kontrola-ok': { // šéf → u obchodníka
        if (!isSef) { err = 'Interní kontrolu provádí šéf konstrukce.'; break; }
        if (z.stav !== 'kontrola') { err = 'Zakázka není v interní kontrole.'; break; }
        audit(z, me.email, 'Interní kontrola OK', note);
        enterState(d, z, 'obchodnik');
        notify(d, z.obchodnikEmail, 'Výkres ' + z.cislo + ' prošel kontrolou a čeká na vaše potvrzení.', z.id);
        mail(z.obchodnikEmail, 'Výkres zkreslen a zkontrolován · ' + z.cislo, 'Výkres ' + z.cislo + ' (' + z.zakaznik + ') prošel interní kontrolou a čeká na vaše potvrzení v intranetu → Konstrukce.');
        break;
      }
      case 'kontrola-vrat': { // šéf → zpět konstruktérovi
        if (!isSef) { err = 'Vracet z kontroly smí šéf konstrukce.'; break; }
        if (z.stav !== 'kontrola') { err = 'Zakázka není v interní kontrole.'; break; }
        if (!note) { err = 'U vrácení uveďte komentář s výhradami.'; break; }
        addComment(z, me, 'internal', 'Vráceno z interní kontroly: ' + note);
        audit(z, me.email, 'Vráceno z kontroly', note);
        unlockDraft(z);
        enterState(d, z, 'prace');
        notify(d, z.assignedTo, 'Výkres ' + z.cislo + ' vrácen z kontroly k přepracování.', z.id);
        break;
      }
      case 'obchodnik-ok': { // obchodník potvrdí → připraveno k odeslání klientovi (zůstává u obchodníka, čeká na odeslání)
        if (!isObch) { err = 'Potvrdit výkres smí obchodník zakázky.'; break; }
        if (z.stav !== 'obchodnik') { err = 'Zakázka není u obchodníka.'; break; }
        // uzamkneme draft jako oficiální verzi
        lockDraft(z);
        z.obchodnikConfirmed = true;
        audit(z, me.email, 'Obchodník potvrdil výkres', note);
        save(d); json(res, 200, { ok: true, readyToSend: true }); return true;
      }
      case 'obchodnik-vrat': { // obchodník má připomínky → zpět konstruktérovi
        if (!isObch) { err = 'Vracet smí obchodník zakázky.'; break; }
        if (z.stav !== 'obchodnik') { err = 'Zakázka není u obchodníka.'; break; }
        if (!note) { err = 'Uveďte připomínky pro konstruktéra.'; break; }
        addComment(z, me, 'internal', 'Připomínky obchodníka: ' + note);
        audit(z, me.email, 'Vráceno obchodníkem', note);
        unlockDraft(z);
        enterState(d, z, 'prace');
        notify(d, z.assignedTo, 'Výkres ' + z.cislo + ' vrácen obchodníkem k úpravě.', z.id);
        break;
      }
      case 'odeslat-klientovi': { // obchodník odešle veřejný náhled (ručně, s možností upravit text)
        if (!isObch) { err = 'Odeslat klientovi smí obchodník zakázky.'; break; }
        if (z.stav !== 'obchodnik') { err = 'Zakázka není připravena k odeslání.'; break; }
        if (!CURRENT_V(z) || !CURRENT_V(z).pdf) { err = 'Chybí PDF výkresu.'; break; }
        if (!z.kontaktEmail) { err = 'U zakázky chybí e-mail kontaktní osoby klienta.'; break; }
        lockDraft(z);
        const t = typeOf(d, z.typKey);
        const token = crypto.randomBytes(24).toString('hex');
        z.link = { token, active: true, createdAt: Date.now(), expiresAt: addDaysCal(Date.now(), t.linkValidDays || 30), pin: b.pin ? String(b.pin).slice(0, 12) : '', accesses: [] };
        enterState(d, z, 'klient');
        audit(z, me.email, 'Odesláno klientovi', 'odkaz platí do ' + fmtDate(z.link.expiresAt));
        const base = host.baseUrl ? host.baseUrl(req) : '';
        const url = base + '/konstrukce/nahled/' + token;
        const defaultText = 'Dobrý den,\n\nzasíláme Vám ke schválení výkres k zakázce ' + z.cislo + ' (' + z.zakaznik + ').\nProhlédnout a schválit jej můžete zde:\n' + url + '\n' + (z.link.pin ? '\nPřístupový PIN: ' + z.link.pin + '\n' : '') + '\nS pozdravem,\n' + me.name;
        const text = (b.text ? String(b.text) : defaultText).replace('{ODKAZ}', url);
        const subject = b.subject ? String(b.subject) : ('Výkres ke schválení · ' + z.cislo);
        save(d);
        await mail(z.kontaktEmail, subject, text);
        notify(d, z.obchodnikEmail, 'Náhled výkresu ' + z.cislo + ' odeslán klientovi (' + z.kontaktEmail + ').', z.id);
        save(d);
        json(res, 200, { ok: true, url });
        return true;
      }
      case 'hold': { // pozastavení lhůt — čeká na podklady
        if (!isObch && !isSef) { err = 'Pozastavit smí obchodník nebo šéf konstrukce.'; break; }
        if (!note) { err = 'Uveďte důvod čekání na podklady.'; break; }
        if (STAV[z.stav].terminal || z.stav === 'podklady') { err = 'Nelze pozastavit.'; break; }
        z.prevStav = z.stav; z.holdReason = note; z.holdSince = Date.now();
        stopTimer(z, me.email);
        z.stav = 'podklady'; z.deadline = null;
        audit(z, me.email, 'Čeká na podklady', note);
        break;
      }
      case 'unhold': { // doplněny podklady → návrat do původního stavu
        if (!isObch && !isSef) { err = 'Obnovit smí obchodník nebo šéf konstrukce.'; break; }
        if (z.stav !== 'podklady') { err = 'Zakázka nečeká na podklady.'; break; }
        const back = z.prevStav || 'prace';
        audit(z, me.email, 'Podklady doplněny', 'návrat do: ' + STAV[back].label);
        enterState(d, z, back);
        z.holdReason = ''; z.prevStav = '';
        notify(d, responsibleEmail(z), 'Podklady k ' + z.cislo + ' doplněny, pokračujte.', z.id);
        break;
      }
      case 'storno': { // zamítnutí/storno interně (obchodník/ředitel)
        if (!(me.isAdmin || me.role === 'obchodnik' || me.role === 'reditel')) { err = 'Stornovat smí obchodník nebo ředitel.'; break; }
        if (!note) { err = 'Uveďte důvod storna.'; break; }
        stopTimer(z, me.email);
        if (z.link) z.link.active = false;
        z.stav = 'zamitnuto'; z.deadline = null; z.closedAt = Date.now();
        audit(z, me.email, 'Storno', note);
        break;
      }
      case 'rozdel-zavod': { // výkonný ředitel výroby → přiřadí výrobní závod (první krok toku)
        if (!(isVykonny || isSef)) { err = 'Rozdělit do závodu smí výkonný ředitel výroby.'; break; }
        if (z.stav !== 'novy') { err = 'Rozdělit do závodu lze jen nový požadavek.'; break; }
        const skey = String(b.stredisko || '').trim();
        const s = d.strediska.find(x => x.key === skey);
        if (!s) { err = 'Vyberte výrobní závod.'; break; }
        z.strediskoKey = s.key; z.strediskoName = s.label;
        enterState(d, z, 'prideleni');
        audit(z, me.email, 'Rozděleno do závodu', s.label + (note ? ' — ' + note : ''));
        employeesWithRole('sef').forEach(em => notify(d, em, 'Zakázka ' + z.cislo + ' (' + z.zakaznik + ') je rozdělena do závodu ' + s.label + ' — přidělte konstruktéra.', z.id));
        break;
      }
      case 'prideli-zavod': { // přeřazení závodu (šéf / výkonný ředitel) — kdykoli před dokončením
        if (!(isVykonny || isSef)) { err = 'Přeřadit závod smí výkonný ředitel výroby nebo šéf konstrukce.'; break; }
        if (STAV[z.stav].terminal) { err = 'Zakázka je uzavřená.'; break; }
        const skey = String(b.stredisko || '').trim();
        const s = d.strediska.find(x => x.key === skey);
        if (!s) { err = 'Vyberte výrobní závod.'; break; }
        z.strediskoKey = s.key; z.strediskoName = s.label;
        audit(z, me.email, 'Přeřazen závod', s.label + (note ? ' — ' + note : ''));
        save(d); json(res, 200, { ok: true }); return true;
      }
      case 'vlozit-vyrobni-dok': { // konstrukce vloží výrobní dokumentaci → do výroby v přiřazeném závodě (konec toku)
        if (!isKon) { err = 'Výrobní dokumentaci vkládá přiřazený konstruktér.'; break; }
        if (z.stav !== 'schvaleno') { err = 'Výrobní dokumentaci lze vložit až po schválení klientem.'; break; }
        if (!z.vyrobniDok || !z.vyrobniDok.path) { err = 'Nejdřív nahrajte soubor výrobní dokumentace.'; break; }
        if (z.link) z.link.active = false;
        stopTimer(z, me.email);
        z.stav = 'dokonceno'; z.deadline = null; z.closedAt = Date.now();
        audit(z, me.email, 'Vložena výrobní dokumentace → do výroby', (z.strediskoName ? 'závod ' + z.strediskoName : ''));
        notify(d, z.obchodnikEmail, 'Zakázka ' + z.cislo + ' má výrobní dokumentaci a jde do výroby (' + (z.strediskoName || '') + ').', z.id);
        const dir = z.strediskoKey ? oblastReditel(d, z.strediskoKey) : '';
        if (dir) { notify(d, dir, 'Do výroby (' + z.strediskoName + ') přišla zakázka ' + z.cislo + ' s výrobní dokumentací.', z.id); mail(dir, 'Do výroby · ' + z.cislo + ' · ' + z.strediskoName, 'Zakázka ' + z.cislo + ' (' + z.zakaznik + ') má vloženou výrobní dokumentaci a jde do výroby ve vašem závodě ' + z.strediskoName + '.'); }
        break;
      }
      default: err = 'Neznámá akce „' + action + '".';
    }
    if (err) { json(res, 400, { chyba: err }); return true; }
    // Oznámení dle pravidla: hrana může mít notify=[role,…] → e-mail + notifikace
    // všem uvedeným rolím naráz (např. dvě role současně). Doplněk k pevným e-mailům.
    if (gedge && Array.isArray(gedge.notify) && gedge.notify.length) {
      const stLbl = (STAV[z.stav] && STAV[z.stav].label) || z.stav;
      const co = gedge.label || action;
      const seen = {};
      gedge.notify.forEach(role => employeesWithRole(role).forEach(em => {
        if (!em || seen[em]) return; seen[em] = true;
        notify(d, em, 'Zakázka ' + z.cislo + ' — ' + co + ' (nyní: ' + stLbl + ').', z.id);
        mail(em, 'Konstrukce · ' + z.cislo + ' · ' + co, 'Zakázka ' + z.cislo + ' (' + z.zakaznik + '): ' + co + '.\nAktuální krok: ' + stLbl + '.');
      }));
    }
    save(d);
    json(res, 200, { ok: true });
    return true;
  }

  // ---- geokódování adres z OpenStreetMap (Photon) — našeptávač adresy ------
  // Proxy přes server (kvůli CORS a fair-use); při chybě vrací prázdno a UI
  // spadne zpět na interní číselník adres. Krátká paměťová cache dotazů.
  const _geoCache = {}; let _geoCacheKeys = [];
  function apiGeocode(req, res, q) {
    const query = String(q.q || '').trim();
    if (query.length < 3) { json(res, 200, { items: [] }); return true; }
    const lang = ['en', 'de', 'fr', 'it'].includes(q.lang) ? q.lang : 'default';
    const key = lang + '|' + query.toLowerCase();
    if (_geoCache[key]) { json(res, 200, { items: _geoCache[key] }); return true; }
    const url = 'https://photon.komoot.io/api/?limit=6' + (lang !== 'default' ? '&lang=' + lang : '') + '&q=' + encodeURIComponent(query);
    let done = false;
    const finish = (items) => { if (done) return; done = true; if (items && items.length) { _geoCache[key] = items; _geoCacheKeys.push(key); if (_geoCacheKeys.length > 300) delete _geoCache[_geoCacheKeys.shift()]; } json(res, 200, { items: items || [] }); };
    try {
      const r = https.get(url, { headers: { 'User-Agent': 'ElkoplastIntranet/1.0 (konstrukce; david.sury@elkoplast.cz)' }, timeout: 4000 }, (resp) => {
        let data = ''; resp.on('data', c => { data += c; if (data.length > 500000) resp.destroy(); });
        resp.on('end', () => { try { const j = JSON.parse(data); finish((j.features || []).map(f => formatPhoton(f.properties)).filter(Boolean)); } catch (_) { finish([]); } });
      });
      r.on('timeout', () => { r.destroy(); finish([]); });
      r.on('error', () => finish([]));
    } catch (_) { finish([]); }
    return true;
  }
  function formatPhoton(p) {
    if (!p) return '';
    const nm = (p.name && p.name !== p.city && p.name !== p.street) ? p.name : '';
    const line1 = [p.street || nm, p.housenumber].filter(Boolean).join(' ').trim() || nm;
    const city = [p.postcode, p.city || p.town || p.village || p.district || p.county].filter(Boolean).join(' ').trim();
    const out = [line1, city, p.country].filter(Boolean).join(', ');
    return out.length > 4 ? out : '';
  }

  // ---- timer (konstruktér) -------------------------------------------------
  async function apiTimer(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    if (!(me.isAdmin || (me.role === 'konstrukter' && (z.assignedTo || '').toLowerCase() === me.email))) { json(res, 403, { chyba: 'Timer ovládá přiřazený konstruktér.' }); return true; }
    if (b.action === 'start') {
      // zastav případný běžící timer téhož uživatele na jiné zakázce
      d.zakazky.forEach(x => { if (x.activeTimer && x.activeTimer.user === me.email) stopTimer(x, me.email); });
      z.activeTimer = { user: me.email, startedAt: Date.now() };
    } else if (b.action === 'stop') {
      stopTimer(z, me.email);
    } else if (b.action === 'manual') {
      const min = Math.max(0, Math.min(24 * 60, parseInt(b.minutes, 10) || 0));
      if (min > 0) { z.timeEntries.push({ user: me.email, seconds: min * 60, at: Date.now(), note: String(b.note || 'ruční zápis').slice(0, 200) }); }
    }
    save(d);
    json(res, 200, { ok: true, totalSec: (z.timeEntries || []).reduce((s, e) => s + (e.seconds || 0), 0), running: !!z.activeTimer });
    return true;
  }
  function stopTimer(z, user) {
    if (z.activeTimer && (!user || z.activeTimer.user === user)) {
      const sec = Math.round((Date.now() - z.activeTimer.startedAt) / 1000);
      if (sec > 0) z.timeEntries.push({ user: z.activeTimer.user, seconds: sec, at: Date.now(), note: 'timer' });
      z.activeTimer = null;
    }
  }

  // ---- komentář ------------------------------------------------------------
  async function apiComment(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!text) { json(res, 400, { chyba: 'Prázdný komentář.' }); return true; }
    addComment(z, me, 'internal', text);
    save(d);
    json(res, 200, { ok: true });
    return true;
  }
  function addComment(z, me, role, text) {
    if (!Array.isArray(z.comments)) z.comments = [];
    z.comments.push({ id: 'c' + crypto.randomBytes(5).toString('hex'), author: me.email || '', authorName: me.name || (role === 'client' ? 'Klient' : ''), role, text, at: Date.now(), versionRef: CURRENT_V(z) ? CURRENT_V(z).v : null });
  }

  // ---- změna termínu (obchodník; konstruktér se souhlasem — zjednodušeno na žádost) ----
  async function apiDeadline(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const z = d.zakazky.find(x => x.id === b.id);
    if (!z) { json(res, 404, { chyba: 'Zakázka nenalezena.' }); return true; }
    const reason = String(b.duvod || '').trim();
    if (!reason) { json(res, 400, { chyba: 'Změnu termínu je nutné zdůvodnit.' }); return true; }
    const newTs = b.deadline ? new Date(String(b.deadline).slice(0, 10) + 'T23:59:59Z').getTime() : null;
    if (!newTs || isNaN(newTs)) { json(res, 400, { chyba: 'Neplatný termín.' }); return true; }
    const canObch = me.isAdmin || (me.role === 'obchodnik' && (z.obchodnikEmail || '').toLowerCase() === me.email) || me.role === 'sef';
    if (!canObch) { json(res, 403, { chyba: 'Termín běžící zakázky mění obchodník (konstruktér jen se souhlasem obchodníka).' }); return true; }
    const old = z.deadline;
    z.deadline = newTs;
    z.esc = { key: z.stav + ':' + z.versions.length }; // reset eskalace pro nový termín
    audit(z, me.email, 'Změna termínu', 'z ' + fmtDate(old) + ' na ' + fmtDate(newTs) + ' — ' + reason);
    notify(d, responsibleEmail(z), 'Termín zakázky ' + z.cislo + ' změněn na ' + fmtDate(newTs) + '.', z.id);
    save(d);
    json(res, 200, { ok: true });
    return true;
  }

  async function apiNotifRead(req, res) {
    const me = roleOf(req);
    const d = load();
    d.notif.forEach(n => { if (n.email === me.email) n.read = true; });
    save(d);
    json(res, 200, { ok: true });
    return true;
  }

  // ---- admin: role / fond / číselník ---------------------------------------
  async function apiAdminRole(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const email = String(b.email || '').toLowerCase().trim();
    const role = String(b.role || '').trim();
    if (!email) { json(res, 400, { chyba: 'Chybí e-mail.' }); return true; }
    const d = load();
    if (!role) delete d.roles[email];
    else if (['obchodnik', 'sef', 'konstrukter', 'reditel', 'vykonny-reditel'].includes(role)) d.roles[email] = role;
    else { json(res, 400, { chyba: 'Neplatná role.' }); return true; }
    save(d);
    json(res, 200, { ok: true, roles: roleAssignments(d) });
    return true;
  }
  async function apiAdminFond(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const email = String(b.email || '').toLowerCase().trim();
    const h = parseInt(b.fond, 10);
    const d = load();
    if (!isNaN(h) && h > 0) d.fond[email] = h; else delete d.fond[email];
    save(d);
    json(res, 200, { ok: true });
    return true;
  }
  // Skupiny výrobků, které konstruktér zpracovává (prázdné = všechny).
  async function apiAdminKonstrGroups(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const email = String(b.email || '').toLowerCase().trim();
    if (!email) { json(res, 400, { chyba: 'Chybí e-mail.' }); return true; }
    const groups = (Array.isArray(b.groups) ? b.groups : []).map(g => String(g)).filter(g => FAM_ORDER.indexOf(g) >= 0);
    const d = load();
    if (groups.length) d.konstrukterGroups[email] = groups; else delete d.konstrukterGroups[email];
    save(d);
    json(res, 200, { ok: true, groups });
    return true;
  }
  // ---- pravidlo workflow (graf) — čtení / uložení z plátna -----------------
  function apiAdminWorkflowGet(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    const d = load();
    const fam = String((urlLib.parse(req.url, true).query || {}).fam || '');
    const famList = FAM_ORDER.map(k => ({ key: k, label: FAM_LABEL[k] }));
    if (fam && FAM_ORDER.indexOf(fam) >= 0) {
      // per-skupina: pokud výjimka neexistuje, nabídni kopii výchozího jako základ (inherited)
      const has = !!d.workflowByFam[fam];
      const wf = has ? d.workflowByFam[fam] : JSON.parse(JSON.stringify(d.workflow));
      json(res, 200, { ok: true, fam, inherited: !has, workflow: wf, draft: d.workflowDraftByFam[fam] || null, families: famList, roleLabels: ROLE_LABELS, seed: SEED_WORKFLOW });
      return true;
    }
    json(res, 200, { ok: true, fam: '', workflow: d.workflow, draft: d.workflowDraft || null, families: famList, roleLabels: ROLE_LABELS, seed: SEED_WORKFLOW });
    return true;
  }
  // Sanitizace grafu z plátna (společné pro koncept i publikaci).
  function cleanWorkflow(wf) {
    const cleanNodes = (wf.nodes || []).map(n => ({
      id: String(n.id).slice(0, 40), label: String(n.label || n.id).slice(0, 80),
      onTurn: n.onTurn ? String(n.onTurn).slice(0, 40) : null,
      terminal: !!n.terminal, hold: !!n.hold, noSemafor: !!n.noSemafor,
      phase: n.phase ? String(n.phase).slice(0, 20) : undefined,
      lhutaKey: n.lhutaKey ? String(n.lhutaKey).slice(0, 40) : undefined,
      lhutaFrom: n.lhutaFrom === 'step' ? 'step' : undefined,
      kind: String(n.kind || 'normal').slice(0, 20),
      x: Math.round(Number(n.x) || 0), y: Math.round(Number(n.y) || 0),
    }));
    const cleanEdges = (wf.edges || []).map(e => ({
      action: String(e.action || '').slice(0, 40),
      from: e.from === null ? null : String(e.from).slice(0, 40),
      to: String(e.to || '').slice(0, 40),
      altTo: e.altTo ? String(e.altTo).slice(0, 40) : undefined,
      roles: Array.isArray(e.roles) ? e.roles.map(r => String(r).slice(0, 40)) : [],
      notify: Array.isArray(e.notify) ? e.notify.map(r => String(r).slice(0, 40)) : [],
      kind: String(e.kind || 'forward').slice(0, 20),
      source: String(e.source || 'user').slice(0, 20),
      label: String(e.label || '').slice(0, 80),
      needNote: !!e.needNote, needPlant: !!e.needPlant, needPdf: !!e.needPdf, needVyrobni: !!e.needVyrobni,
    })).filter(e => e.action);
    return { nodes: cleanNodes, edges: cleanEdges, version: (Number(wf.version) || 1) };
  }
  // Validace: musí existovat start (kind='start') i konec (terminal), žádný
  // neterminální stav bez odchozí hrany, hrany musí odkazovat na existující uzly.
  function validateWorkflow(wf) {
    if (!wf || !Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) return 'Neplatná struktura pravidla.';
    if (!wf.nodes.length) return 'Pravidlo nemá žádné stavy.';
    const ids = new Set(wf.nodes.map(n => n.id));
    if (ids.size !== wf.nodes.length) return 'Duplicitní ID stavu.';
    if (!wf.nodes.some(n => n.kind === 'start')) return 'Chybí počáteční stav (start).';
    if (!wf.nodes.some(n => n.terminal)) return 'Chybí koncový (terminální) stav.';
    for (const e of wf.edges) {
      if (e.from && e.from !== '*' && !ids.has(e.from)) return 'Hrana odkazuje na neexistující stav: ' + e.from;
      if (e.to && !String(e.to).startsWith('@') && !ids.has(e.to)) return 'Hrana odkazuje na neexistující cíl: ' + e.to;
    }
    // každý neterminální, non-hold stav musí mít cestu dál (odchozí user/system/klient hranu)
    for (const n of wf.nodes) {
      if (n.terminal || n.hold) continue;
      const out = wf.edges.some(e => (e.from === n.id) && !['hold', 'self'].includes(e.kind));
      if (!out) return 'Stav „' + (n.label || n.id) + '" nemá žádný přechod dál.';
    }
    return null;
  }
  async function apiAdminWorkflowSave(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const wf = b.workflow;
    if (!wf || typeof wf !== 'object') { json(res, 400, { chyba: 'Chybí pravidlo.' }); return true; }
    const mode = b.mode === 'draft' ? 'draft' : 'publish';
    const fam = String(b.fam || '');
    const isFam = fam && FAM_ORDER.indexOf(fam) >= 0;
    const cleaned = cleanWorkflow(wf);
    const d = load();
    if (mode === 'draft') {
      // průběžný koncept — bez tvrdé validace (může být rozpracovaný), neovlivní běh
      cleaned.savedAt = Date.now();
      if (isFam) d.workflowDraftByFam[fam] = cleaned; else d.workflowDraft = cleaned;
      save(d);
      json(res, 200, { ok: true, draft: true, fam: isFam ? fam : '', savedAt: cleaned.savedAt });
      return true;
    }
    // publikace — validace; výchozí jde do reálného toku, per-skupina se uloží jako pravidlo skupiny
    const errv = validateWorkflow(cleaned);
    if (errv) { json(res, 400, { chyba: errv }); return true; }
    if (isFam) { d.workflowByFam[fam] = cleaned; delete d.workflowDraftByFam[fam]; }
    else { d.workflow = cleaned; delete d.workflowDraft; }
    save(d);
    json(res, 200, { ok: true, fam: isFam ? fam : '', workflow: cleaned });
    return true;
  }

  async function apiAdminTyp(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const key = String(b.key || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (!key) { json(res, 400, { chyba: 'Chybí klíč typu.' }); return true; }
    let t = d.types.find(x => x.key === key);
    if (b.delete) { d.types = d.types.filter(x => x.key !== key); save(d); json(res, 200, { ok: true, types: d.types }); return true; }
    if (!t) { t = { key, params: [] }; d.types.push(t); }
    const numFields = ['normohodiny', 'revizeNh', 'lhutaZkresleniDays', 'lhutaRevizeDays', 'lhutaPrideleniDays', 'lhutaKontrolaDays', 'lhutaObchodnikDays', 'lhutaKlientDays', 'lhutaVyrobaDays', 'lhutaStrediskoDays', 'linkValidDays'];
    t.name = String(b.name || t.name || key).slice(0, 120);
    t.standard = !!b.standard;
    t.internalCheck = b.internalCheck !== false;
    numFields.forEach(f => { if (b[f] != null && !isNaN(parseInt(b[f], 10))) t[f] = parseInt(b[f], 10); });
    ['lhutaPrideleniDays', 'lhutaKontrolaDays', 'lhutaObchodnikDays', 'lhutaKlientDays'].forEach(f => { if (t[f] == null) t[f] = SEED_TYPES[0][f]; });
    if (Array.isArray(b.params)) t.params = b.params.slice(0, 40).map(pp => ({ label: String(pp.label || '').slice(0, 80), examples: String(pp.examples || '').slice(0, 200) })).filter(pp => pp.label);
    // dotazník: pole sekcí {title, fields:[{k,label,type|std,opce}]} (pro budoucí typy)
    if (Array.isArray(b.dotaznik)) t.dotaznik = b.dotaznik.slice(0, 20).map(sec => ({
      title: String(sec.title || '').slice(0, 80),
      fields: (Array.isArray(sec.fields) ? sec.fields : []).slice(0, 60).map(f => {
        const o = { k: String(f.k || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40), label: String(f.label || '').slice(0, 120) };
        if (f.std !== undefined) { o.std = String(f.std || '').slice(0, 200); o.opce = String(f.opce || '').slice(0, 200); if (f.opceVstup && typeof f.opceVstup === 'object') o.opceVstup = { placeholder: String(f.opceVstup.placeholder || '').slice(0, 60), unit: String(f.opceVstup.unit || '').slice(0, 20), num: !!f.opceVstup.num }; }
        else o.type = f.type === 'number' ? 'number' : 'text';
        return o;
      }).filter(f => f.k && f.label),
    })).filter(sec => sec.fields.length);
    save(d);
    json(res, 200, { ok: true, types: d.types });
    return true;
  }

  // ======================================================================
  //  VEŘEJNÁ ČÁST — klientský náhled (bez přihlášení, přes token)
  // ======================================================================
  async function handlePublic(req, res, u, p) {
    // stránka náhledu
    const mPage = /^\/konstrukce\/nahled\/([a-f0-9]{32,64})\/?$/.exec(p);
    if (mPage && req.method === 'GET') {
      htmlOut(res, 200, publicPage());
      return true;
    }
    // PDF ke stažení pro klienta
    const mPdf = /^\/konstrukce\/nahled\/([a-f0-9]{32,64})\/pdf$/.exec(p);
    if (mPdf && req.method === 'GET') {
      return servePublicPdf(res, mPdf[1], u.query);
    }
    // JSON data náhledu
    const mData = /^\/api\/konstrukce\/nahled\/([a-f0-9]{32,64})$/.exec(p);
    if (mData && req.method === 'GET') {
      return apiPublicData(req, res, mData[1]);
    }
    // akce klienta
    const mAkce = /^\/api\/konstrukce\/nahled\/([a-f0-9]{32,64})\/akce$/.exec(p);
    if (mAkce && req.method === 'POST') {
      return apiPublicAction(req, res, mAkce[1]);
    }
    if (p.startsWith('/api/')) { json(res, 404, { chyba: 'Neplatný odkaz.' }); return true; }
    htmlOut(res, 404, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">Odkaz nenalezen nebo vypršel.</p>');
    return true;
  }

  function findByToken(d, token) {
    return d.zakazky.find(z => z.link && z.link.token === token);
  }
  function linkOk(z) {
    return z && z.link && z.link.active && (!z.link.expiresAt || z.link.expiresAt > Date.now());
  }
  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  }

  function apiPublicData(req, res, token) {
    const d = load();
    const z = findByToken(d, token);
    if (!linkOk(z)) { json(res, 410, { chyba: 'Odkaz vypršel nebo byl deaktivován.' }); return true; }
    // volitelný PIN
    const pin = (req.headers['x-nahled-pin'] || (urlLib.parse(req.url, true).query.pin) || '');
    if (z.link.pin && String(pin) !== z.link.pin) { json(res, 401, { chyba: 'Zadejte PIN.', needPin: true }); return true; }
    z.link.accesses.push({ at: Date.now(), ip: clientIp(req), action: 'view' });
    if (z.link.accesses.length > 300) z.link.accesses.splice(0, z.link.accesses.length - 300);
    save(d);
    const cur = CURRENT_V(z);
    json(res, 200, {
      cislo: z.cislo, zakaznik: z.zakaznik, typName: typeOf(d, z.typKey).name,
      version: cur ? cur.v : null, versionCount: z.versions.length,
      hasPdf: !!(cur && cur.pdf),
      pdfUrl: '/konstrukce/nahled/' + token + '/pdf' + (z.link.pin ? '?pin=' + encodeURIComponent(z.link.pin) : ''),
      decided: z.clientDecision ? { action: z.clientDecision.action, at: z.clientDecision.at, name: z.clientDecision.name } : null,
      history: z.versions.map(v => ({ v: v.v, at: v.createdAt })),
      // veřejné komentáře = jen komunikace s klientem (žádné interní ceny/marže)
      comments: (z.comments || []).filter(c => c.role === 'client' || c.publicToClient).map(c => ({ author: c.role === 'client' ? (c.authorName || 'Klient') : 'ELKOPLAST', text: c.text, at: c.at })),
    });
    return true;
  }

  function servePublicPdf(res, token, query) {
    const d = load();
    const z = findByToken(d, token);
    if (!linkOk(z)) { res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Odkaz vypršel.'); return true; }
    if (z.link.pin && String(query.pin || '') !== z.link.pin) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('PIN'); return true; }
    const cur = CURRENT_V(z);
    if (!cur || !cur.pdf) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bez PDF'); return true; }
    const f = safePath(cur.pdf.path);
    if (!f || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Soubor chybí'); return true; }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="nahled-' + z.cislo + '.pdf"' });
    res.end(fs.readFileSync(f));
    return true;
  }

  async function apiPublicAction(req, res, token) {
    const d = load();
    const z = findByToken(d, token);
    if (!linkOk(z)) { json(res, 410, { chyba: 'Odkaz vypršel nebo byl deaktivován.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    if (z.link.pin && String(b.pin || '') !== z.link.pin) { json(res, 401, { chyba: 'Neplatný PIN.' }); return true; }
    if (z.stav !== 'klient') { json(res, 409, { chyba: 'K této verzi už bylo rozhodnuto.' }); return true; }
    const action = String(b.action || '');
    const name = String(b.name || '').trim().slice(0, 120);
    const ip = clientIp(req);
    const cur = CURRENT_V(z);
    if (cur) cur.locked = true;

    if (action === 'schvalit') {
      if (!name || !b.souhlas) { json(res, 400, { chyba: 'Vyplňte jméno a potvrďte souhlas.' }); return true; }
      z.clientDecision = { action: 'schvalit', name, at: Date.now(), ip, version: cur ? cur.v : null };
      z.link.accesses.push({ at: Date.now(), ip, action: 'schválil: ' + name });
      enterState(d, z, 'schvaleno');   // na tahu konstruktér — vloží výrobní dokumentaci
      z.link.active = false;
      audit(z, name + ' (klient)', 'Klient schválil', 'verze v' + (cur ? cur.v : '?') + ', IP ' + ip);
      notify(d, z.obchodnikEmail, 'Klient SCHVÁLIL výkres ' + z.cislo + '.', z.id);
      employeesWithRole('sef').forEach(em => notify(d, em, 'Klient schválil výkres ' + z.cislo + '.', z.id));
      if (z.assignedTo) notify(d, z.assignedTo, 'Klient schválil ' + z.cislo + ' — vložte výrobní dokumentaci.', z.id);
      save(d);
      mail(z.obchodnikEmail, 'Klient schválil výkres · ' + z.cislo, 'Klient ' + name + ' schválil výkres ' + z.cislo + ' (' + z.zakaznik + ') dne ' + fmtDateTime(Date.now()) + '.\nKonstrukce nyní vloží výrobní dokumentaci a zakázka půjde do výroby v přiřazeném závodě' + (z.strediskoName ? ' (' + z.strediskoName + ')' : '') + '.');
    } else if (action === 'zamitnout') {
      const duvod = String(b.duvod || '').trim().slice(0, 1500);
      if (!duvod) { json(res, 400, { chyba: 'Uveďte prosím důvod zamítnutí.' }); return true; }
      z.clientDecision = { action: 'zamitnout', name, at: Date.now(), ip, duvod };
      addComment(z, { email: '', name: name || 'Klient' }, 'client', 'ZAMÍTNUTO: ' + duvod);
      z.link.accesses.push({ at: Date.now(), ip, action: 'zamítl' });
      z.link.active = false;
      z.stav = 'zamitnuto'; z.deadline = null; z.closedAt = Date.now();
      audit(z, (name || 'klient') + ' (klient)', 'Klient zamítl', duvod + ' — IP ' + ip);
      notify(d, z.obchodnikEmail, 'Klient ZAMÍTL výkres ' + z.cislo + '. Řešte další postup.', z.id);
      save(d);
      mail(z.obchodnikEmail, 'Klient zamítl výkres · ' + z.cislo, 'Klient ' + (name || '') + ' zamítl výkres ' + z.cislo + '.\nDůvod: ' + duvod + '\n\nDomluvte se zákazníkem na dalším postupu.');
    } else if (action === 'pripominky') {
      const text = String(b.text || '').trim().slice(0, 3000);
      if (!text) { json(res, 400, { chyba: 'Napište prosím připomínky.' }); return true; }
      z.clientDecision = null;
      addComment(z, { email: '', name: name || 'Klient' }, 'client', 'Připomínky klienta: ' + text);
      z.link.accesses.push({ at: Date.now(), ip, action: 'připomínky' });
      // založíme revizi: nová verze, zpět na konstruktéra
      z.revisionCount = (z.revisionCount || 0) + 1;
      const nv = { v: (cur ? cur.v : 0) + 1, author: z.assignedTo || '', createdAt: Date.now(), locked: false };
      z.versions.push(nv);
      enterState(d, z, 'revize');
      z.link.active = false; // původní odkaz se uzavře; po revizi se pošle nový
      audit(z, (name || 'klient') + ' (klient)', 'Klient poslal připomínky', 'založena revize v' + nv.v + ' — IP ' + ip);
      notify(d, z.obchodnikEmail, 'Klient poslal PŘIPOMÍNKY k ' + z.cislo + ' — založena revize v' + nv.v + '.', z.id);
      if (z.assignedTo) notify(d, z.assignedTo, 'Revize v' + nv.v + ' u výkresu ' + z.cislo + ' — zapracujte připomínky klienta.', z.id);
      employeesWithRole('sef').forEach(em => notify(d, em, 'Revize u ' + z.cislo + ' (připomínky klienta).', z.id));
      save(d);
      mail(z.obchodnikEmail, 'Klient poslal připomínky · ' + z.cislo, 'Klient ' + (name || '') + ' poslal připomínky k výkresu ' + z.cislo + '.\n\n' + text + '\n\nByla založena revize v' + nv.v + '.');
    } else {
      json(res, 400, { chyba: 'Neznámá akce.' }); return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  // ======================================================================
  //  Soubory
  // ======================================================================
  const ALLOWED_EXT = { pdf: ['pdf'], cad: ['dwg', 'dxf', 'step', 'stp', 'igs', 'iges', 'sldprt', 'sldasm', 'ipt', 'iam', 'prt', 'x_t', 'catpart', 'zip', 'pdf'], vyrobni: ['pdf', 'dwg', 'dxf', 'step', 'stp', 'zip', 'xlsx', 'xls', 'docx', 'doc', 'sldprt', 'sldasm', 'ipt', 'iam', 'prt', 'x_t', 'catpart'] };
  function saveFile(zakId, name, dataUrl, kind) {
    const safeName = String(name || 'soubor').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    const ext = (safeName.split('.').pop() || '').toLowerCase();
    if (!(ALLOWED_EXT[kind] || []).includes(ext)) return { chyba: 'Nepodporovaný typ souboru pro ' + (kind === 'pdf' ? 'PDF náhled (očekává se .pdf)' : 'CAD (dwg, dxf, step, ipt, sldprt, zip…)') + '.' };
    let m = /^data:([^;]*);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return { chyba: 'Neplatný obsah souboru.' };
    const buf = Buffer.from(m[2], 'base64');
    const max = kind === 'pdf' ? 20e6 : 60e6;
    if (buf.length > max) return { chyba: 'Soubor je příliš velký (max ' + Math.round(max / 1e6) + ' MB).' };
    const dir = path.join(FILES_DIR, zakId.replace(/[^a-z0-9]/gi, ''));
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const fn = kind + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext;
    const abs = path.join(dir, fn);
    fs.writeFileSync(abs, buf);
    return { name: safeName, path: path.relative(FILES_DIR, abs) };
  }
  function safePath(rel) {
    if (!rel) return null;
    const abs = path.join(FILES_DIR, rel);
    if (!abs.startsWith(FILES_DIR + path.sep)) return null;
    return abs;
  }
  function deleteFile(rel) { const f = safePath(rel); if (f) { try { fs.unlinkSync(f); } catch (_) {} } }
  function serveInternalFile(res, query) {
    const d = load();
    const z = d.zakazky.find(x => x.id === query.id);
    if (!z) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Nenalezeno'); return true; }
    if (query.kind === 'vyrobni') {
      const meta = z.vyrobniDok;
      const f = meta && safePath(meta.path);
      if (!f || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bez výrobní dokumentace'); return true; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(meta.name) + '"' });
      res.end(fs.readFileSync(f)); return true;
    }
    const v = z.versions.find(x => String(x.v) === String(query.v)) || CURRENT_V(z);
    const kind = query.kind === 'cad' ? 'cad' : 'pdf';
    const meta = v && v[kind];
    if (!meta) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bez souboru'); return true; }
    const f = safePath(meta.path);
    if (!f || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Soubor chybí'); return true; }
    const ct = kind === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    const disp = (kind === 'pdf' && query.dl !== '1') ? 'inline' : 'attachment';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store', 'Content-Disposition': disp + '; filename="' + encodeURIComponent(meta.name) + '"' });
    res.end(fs.readFileSync(f));
    return true;
  }

  function lockDraft(z) { const dr = z.versions.find(v => !v.locked); if (dr) dr.locked = true; }
  function unlockDraft(z) { const dr = z.versions[z.versions.length - 1]; if (dr) dr.locked = false; }

  // ======================================================================
  //  Eskalace (tick) — termíny, semafory, připomínky klientovi (kap. 5)
  // ======================================================================
  async function tick() {
    const d = load();
    let changed = false;
    const now = Date.now();
    const overdueForDirector = [];
    const cfg = (d.settings && d.settings.notif) || DEFAULT_NOTIF;
    const warnFrac = Math.min(1, Math.max(0, (Number(cfg.warnPct) || 80) / 100));
    const remind1 = Number(cfg.clientRemind1) || 0, remind2 = Number(cfg.clientRemind2) || 0;
    for (const z of d.zakazky) {
      const st = STAV[z.stav];
      if (!st || st.terminal || st.hold || st.noSemafor) continue;
      if (!z.esc) z.esc = { key: z.stav + ':' + z.versions.length };
      const stepKey = z.stav + ':' + z.versions.length;
      if (z.esc.key !== stepKey) z.esc = { key: stepKey };

      // --- klient nereaguje (5 / 10 pracovních dnů) ---
      if (z.stav === 'klient' && z.stepStartedAt) {
        const bdays = businessDaysBetween(z.stepStartedAt, now);
        if (remind1 > 0 && bdays >= remind1 && !z.esc.klient5) {
          z.esc.klient5 = true; changed = true;
          notify(d, z.obchodnikEmail, 'Klient nereaguje na náhled ' + z.cislo + ' ' + remind1 + ' prac. dnů — odeslána připomínka.', z.id);
          if (z.kontaktEmail && z.link && z.link.active) {
            const base = host.mailFrom && host.mailFrom.publicUrl ? host.mailFrom.publicUrl : '';
            mail(z.kontaktEmail, 'Připomenutí — výkres ke schválení · ' + z.cislo, 'Dobrý den,\n\ndovolujeme si připomenout výkres ke schválení k zakázce ' + z.cislo + '.\nOdkaz: ' + base + '/konstrukce/nahled/' + z.link.token + '\n\nDěkujeme.');
          }
        }
        if (remind2 > 0 && bdays >= remind2 && !z.esc.klient10) {
          z.esc.klient10 = true; changed = true;
          notify(d, z.obchodnikEmail, 'ÚKOL: Klient nereaguje ' + remind2 + ' prac. dnů na ' + z.cislo + ' — kontaktujte ho telefonicky.', z.id);
          mail(z.obchodnikEmail, 'Klient nereaguje ' + remind2 + ' dnů · ' + z.cislo, 'Klient nereaguje na náhled výkresu ' + z.cislo + ' už ' + remind2 + ' pracovních dnů. Kontaktujte ho prosím telefonicky.');
        }
        continue;
      }

      if (!z.deadline) continue;
      const resp = responsibleEmail(z);
      // --- blíží se termín (oranžová, app-notifikace odpovědné osobě) — okno od bodu 0 (zadání) ---
      const warnBase = (st.lhutaFrom === 'step') ? z.stepStartedAt : (z.createdAt || z.stepStartedAt);
      if (warnBase && z.deadline > warnBase) {
        const frac = (now - warnBase) / (z.deadline - warnBase);
        if (frac >= warnFrac && now < z.deadline && !z.esc.warned80) {
          z.esc.warned80 = true; changed = true;
          if (resp) notify(d, resp, 'Blíží se termín kroku „' + st.label + '" u ' + z.cislo + ' (do ' + fmtDate(z.deadline) + ').', z.id);
        }
      }
      // --- překročení termínu (červená, e-mail odpovědné + obchodník + šéf) ---
      if (now > z.deadline) {
        if (!z.esc.overdue) {
          z.esc.overdue = true; z.esc.overdueDay = fmtDate(now); changed = true;
          const komu = new Set([resp, z.obchodnikEmail, ...employeesWithRole('sef')].filter(Boolean));
          komu.forEach(em => notify(d, em, 'PO TERMÍNU: krok „' + st.label + '" u ' + z.cislo + ' překročil termín.', z.id));
          if (cfg.overdueEmail !== false) {
            const text = 'Zakázka ' + z.cislo + ' (' + z.zakaznik + ') překročila termín kroku „' + st.label + '" (' + fmtDate(z.deadline) + ').\nOdpovědná osoba: ' + (empName(resp) || '—') + '.';
            komu.forEach(em => mail(em, 'Po termínu · ' + z.cislo, text));
          }
        }
        // --- D+1 a dále: denní souhrn řediteli ---
        overdueForDirector.push(z);
      }
    }

    // denní souhrn řediteli (jednou za den, jsou-li zpožděné zakázky ≥ 1 den)
    if (overdueForDirector.length && cfg.directorDigest !== false) {
      const readyForDigest = overdueForDirector.filter(z => z.esc && z.esc.overdueDay && z.esc.overdueDay !== fmtDate(now));
      const today = fmtDate(now);
      if (readyForDigest.length && d._lastDirectorDigest !== today) {
        d._lastDirectorDigest = today; changed = true;
        // Doplníme vypočtené hodnoty (dny v prodlení) a seřadíme nejzpožděnější nahoru.
        const rows = readyForDigest.map(z => ({
          cislo: z.cislo, zakaznik: z.zakaznik,
          _krok: (STAV[z.stav] && STAV[z.stav].label) || z.stav,
          _termin: fmtDate(z.deadline),
          _kdo: empName(responsibleEmail(z)) || '—',
          _dny: Math.max(1, Math.floor((now - z.deadline) / 86400000)),
        })).sort((a, b) => b._dny - a._dny);
        const lines = rows.map(z => '• ' + z.cislo + ' (' + z.zakaznik + ') — „' + z._krok + '", termín byl ' + z._termin + ' → ' + z._dny + ' ' + sklonDni(z._dny) + ' po termínu, odpovídá ' + z._kdo).join('\n');
        const text = 'Přehled zpožděných zakázek konstrukce k ' + today + ' (' + rows.length + ' ' + sklonZakazek(rows.length) + ', nejdéle ' + rows[0]._dny + ' ' + sklonDni(rows[0]._dny) + '):\n\n' + lines;
        const html = digestHtml(rows, today);
        employeesWithRole('reditel').forEach(em => { notify(d, em, readyForDigest.length + ' zpožděných zakázek konstrukce.', null); mail(em, 'Zpožděné zakázky konstrukce · ' + today, text, html); });
      }
    }

    // Report o stavu — denně nebo týdně (zvolený den), zap./vyp. + příjemci v SET-UP
    try {
      if (d.settings && d.settings.reportEnabled && (d.settings.reportRecipients || []).length) {
        const freq = d.settings.reportFreq === 'daily' ? 'daily' : 'weekly';
        const dow = new Date(now).getUTCDay();
        let due = false, subject = 'Týdenní přehled konstrukce';
        if (freq === 'daily') {
          const day = fmtDate(now);
          if (d.settings._lastReportDay !== day) { d.settings._lastReportDay = day; due = true; }
          subject = 'Denní přehled konstrukce';
        } else {
          const wk = isoWeekKey(now), wantDow = typeof d.settings.reportDow === 'number' ? d.settings.reportDow : 1;
          if (dow === wantDow && d.settings._lastReportWeek !== wk) { d.settings._lastReportWeek = wk; due = true; }
        }
        if (due) {
          changed = true;
          const text = buildWeeklyReport(d);
          for (const em of d.settings.reportRecipients) await mail(em, subject, text);
        }
      }
    } catch (_) {}

    if (changed) save(d);
  }

  // ======================================================================
  //  Pomocné formátovače + veřejná HTML stránka
  // ======================================================================
  function fmtDate(ts) { if (!ts) return '—'; const dt = new Date(ts); return String(dt.getUTCDate()).padStart(2, '0') + '.' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '.' + dt.getUTCFullYear(); }
  function fmtDateTime(ts) { const dt = new Date(ts); return fmtDate(ts) + ' ' + String(dt.getUTCHours()).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0'); }
  function addDaysCal(ts, days) { return ts + days * 24 * 3600 * 1000; }

  function publicPage() {
    return PUBLIC_HTML;
  }

  // ======================================================================
  //  Evidence práce (timesheet) — denní zápis hodin po činnostech (kap. 8)
  // ======================================================================
  function tsCanSeeAll(me) { return me.isAdmin || me.role === 'sef' || me.role === 'reditel'; }
  function activityLabel(d, key, fallback) { const a = d.activities.find(x => x.key === key); return a ? a.label : (fallback || key || ''); }
  function activityKind(d, key) { const a = d.activities.find(x => x.key === key); return a ? a.kind : 'rezie'; }

  function apiTimesheetGet(req, res, q) {
    const me = roleOf(req);
    const d = load();
    const all = tsCanSeeAll(me);
    let list = d.timesheet.slice();
    if (!all) list = list.filter(t => (t.user || '').toLowerCase() === me.email);
    else if (q.user) list = list.filter(t => (t.user || '').toLowerCase() === String(q.user).toLowerCase());
    if (q.from) list = list.filter(t => t.date >= q.from);
    if (q.to) list = list.filter(t => t.date <= q.to);
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
    // seznam osob s evidencí (pro filtr managementu)
    const users = {};
    d.timesheet.forEach(t => { const u = (t.user || '').toLowerCase(); if (u) users[u] = (users[u] || 0) + (t.hours || 0); });
    json(res, 200, {
      me: { email: me.email, role: me.role || (me.isAdmin ? 'admin' : ''), canSeeAll: all },
      activities: d.activities,
      entries: list.map(t => ({ id: t.id, user: t.user, userName: empName(t.user), date: t.date, activityKey: t.activityKey || '', activity: t.activity || activityLabel(d, t.activityKey), kind: t.kind || activityKind(d, t.activityKey), zakId: t.zakId || '', zakCislo: t.zakId ? ((d.zakazky.find(z => z.id === t.zakId) || {}).cislo || '') : '', zakazka: t.zakazka || '', hours: t.hours || 0, percent: t.percent == null ? null : t.percent, note: t.note || '' })),
      users: Object.keys(users).map(u => ({ email: u, name: empName(u), hours: Math.round(users[u] * 10) / 10 })).sort((a, b) => b.hours - a.hours),
      zakazky: d.zakazky.map(z => ({ id: z.id, cislo: z.cislo, zakaznik: z.zakaznik })),
    });
    return true;
  }
  async function apiTimesheetSave(req, res) {
    const me = roleOf(req);
    if (!me.email && !me.isAdmin) { json(res, 403, { chyba: 'Neznámý uživatel.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const date = String(b.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { chyba: 'Zadejte platné datum.' }); return true; }
    const hours = Math.round((parseFloat(String(b.hours).replace(',', '.')) || 0) * 100) / 100;
    if (!(hours > 0)) { json(res, 400, { chyba: 'Zadejte počet hodin.' }); return true; }
    const activityKey = String(b.activityKey || '').trim();
    if (!activityKey && !b.activity) { json(res, 400, { chyba: 'Vyberte druh práce.' }); return true; }
    // cílový uživatel: sám sebe; management může zapsat na jiného
    let user = me.email;
    if (tsCanSeeAll(me) && b.user) user = String(b.user).toLowerCase().trim();
    const rec = {
      id: b.id && String(b.id) || 't' + crypto.randomBytes(6).toString('hex'),
      user, date, activityKey,
      activity: activityKey ? activityLabel(d, activityKey) : String(b.activity || '').slice(0, 120),
      kind: activityKey ? activityKind(d, activityKey) : 'rezie',
      zakId: String(b.zakId || '').trim(),
      zakazka: String(b.zakazka || '').trim().slice(0, 80),
      hours, percent: (b.percent === '' || b.percent == null) ? null : Math.max(0, Math.min(100, parseInt(b.percent, 10) || 0)),
      note: String(b.note || '').slice(0, 300), createdAt: Date.now(),
    };
    // pokud je zapsáno na workflow zakázku, doplň její kód do zakazka
    if (rec.zakId) { const z = d.zakazky.find(x => x.id === rec.zakId); if (z && !rec.zakazka) rec.zakazka = z.cislo; }
    const i = d.timesheet.findIndex(t => t.id === rec.id);
    if (i >= 0) {
      if (!tsCanSeeAll(me) && (d.timesheet[i].user || '').toLowerCase() !== me.email) { json(res, 403, { chyba: 'Můžete upravovat jen své záznamy.' }); return true; }
      rec.createdAt = d.timesheet[i].createdAt || rec.createdAt;
      d.timesheet[i] = rec;
    } else d.timesheet.push(rec);
    save(d);
    json(res, 200, { ok: true, id: rec.id });
    return true;
  }
  async function apiTimesheetDelete(req, res) {
    const me = roleOf(req);
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const t = d.timesheet.find(x => x.id === b.id);
    if (!t) { json(res, 404, { chyba: 'Záznam nenalezen.' }); return true; }
    if (!tsCanSeeAll(me) && (t.user || '').toLowerCase() !== me.email) { json(res, 403, { chyba: 'Můžete mazat jen své záznamy.' }); return true; }
    d.timesheet = d.timesheet.filter(x => x.id !== b.id);
    save(d);
    json(res, 200, { ok: true });
    return true;
  }
  async function apiAdminActivity(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const key = String(b.key || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (!key) { json(res, 400, { chyba: 'Chybí klíč činnosti.' }); return true; }
    if (b.delete) { d.activities = d.activities.filter(x => x.key !== key); save(d); json(res, 200, { ok: true, activities: d.activities }); return true; }
    let a = d.activities.find(x => x.key === key);
    if (!a) { a = { key }; d.activities.push(a); }
    a.label = String(b.label || a.label || key).slice(0, 120);
    a.kind = b.kind === 'zakazka' ? 'zakazka' : 'rezie';
    save(d);
    json(res, 200, { ok: true, activities: d.activities });
    return true;
  }
  async function apiAdminStredisko(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load();
    const key = String(b.key || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (!key) { json(res, 400, { chyba: 'Chybí název střediska.' }); return true; }
    if (b.delete) { d.strediska = d.strediska.filter(x => x.key !== key); save(d); json(res, 200, { ok: true, strediska: d.strediska }); return true; }
    let s = d.strediska.find(x => x.key === key);
    if (!s) { s = { key, reditelEmail: '' }; d.strediska.push(s); }
    if (b.label != null) s.label = String(b.label || s.label || key).slice(0, 60);
    if (b.reditel !== undefined) s.reditelEmail = String(b.reditel || '').toLowerCase().trim();
    save(d);
    json(res, 200, { ok: true, strediska: d.strediska });
    return true;
  }
  async function apiAdminImport(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const user = String(b.user || '').toLowerCase().trim();
    if (!user) { json(res, 400, { chyba: 'Zadejte e-mail konstruktéra, na kterého se historie zapíše.' }); return true; }
    let raw = [];
    try { raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'timesheet-import.json'), 'utf8')); } catch (e) { json(res, 400, { chyba: 'Importní soubor nenalezen.' }); return true; }
    const d = load();
    // mapování popisu na klíč činnosti (dle normalizované shody na label + alias z tabulky)
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const byNorm = {}; d.activities.forEach(a => { byNorm[norm(a.label)] = a; });
    // přesné (i překlepové) názvy z původního deníku → klíč činnosti
    const ALIAS = {
      'Vytvoření/modifikace modelu a OB-výkresu': 'vyt-model', 'Chystání sady výkresů, Kusovník, DXF': 'chystani-sady',
      'Model Nula. Aktualizace': 'nula-aktualizace', 'Model Nula. Vytvoření/úprava': 'nula-vytvoreni', 'Model Nula. Kontrola sady podkladů': 'nula-kontrola',
      'Změny podlé přání': 'zmeny-prani', 'Změny/opimizace podlé otázek výroby': 'zmeny-vyroba', 'Návrh prototypů': 'navrh-prototyp',
      'Vytvoření návrhu řešení. Posílání obchodníků': 'navrh-reseni', 'Díly SD/SP. Vytváření/modifikace dílů': 'dily-sdsp',
      'Přidání zakázek podlé NULA modelů': 'pridani-nula', 'Vytvoření dodatečně dokumentaci na vyžádání': 'dokumentace',
      'TENDR project. Vytvoření modelů/prototypu, OB-výkres': 'tendr', 'Spolupráce / konzultaci konstruktera': 'konzultace-konstr',
      'Spolupráce / konzultaci obchodnika': 'konzultace-obch', 'Řízení práce - konstruktéry': 'rizeni-prace',
      'Porada výrobní střediska': 'porada-stredisko', 'Porada podlé skutečně úkoly': 'porada-ukoly',
      'Vyřizování objednávek, e-mailů, dotazů z dílny a telefonátů': 'administrativa', 'jiná / dodatečně práce': 'jina',
    };
    const aliasNorm = {}; Object.keys(ALIAS).forEach(k => { const a = d.activities.find(x => x.key === ALIAS[k]); if (a) aliasNorm[norm(k)] = a; });
    if (b.mode === 'replace') d.timesheet = d.timesheet.filter(t => (t.user || '').toLowerCase() !== user);
    let n = 0;
    raw.forEach(r => {
      const label = r.activity || '';
      const match = byNorm[norm(label)] || aliasNorm[norm(label)];
      d.timesheet.push({
        id: 't' + crypto.randomBytes(6).toString('hex'), user, date: r.date,
        activityKey: match ? match.key : '', activity: match ? match.label : label,
        kind: match ? match.kind : (r.zakazka ? 'zakazka' : 'rezie'),
        zakId: '', zakazka: String(r.zakazka || '').slice(0, 80),
        hours: Math.round((r.hours || 0) * 100) / 100, percent: r.percent == null ? null : r.percent,
        note: String(r.note || '').slice(0, 300), createdAt: Date.now(), imported: true,
      });
      n++;
    });
    save(d);
    json(res, 200, { ok: true, count: n });
    return true;
  }

  // ======================================================================
  //  Reset dat modulu (ostrý provoz) — smaže VŠECHNY zakázky, role, konfiguraci
  // ======================================================================
  function demoClear() {
    try { if (fs.existsSync(FILES_DIR)) fs.rmSync(FILES_DIR, { recursive: true, force: true }); } catch (_) {}
    try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}
    save({ seq: 0, roles: {}, fond: {}, konstrukterGroups: {}, types: JSON.parse(JSON.stringify(SEED_TYPES)), zakazky: [], notif: [] });
  }
  // Smaže JEN zakázky + jejich notifikace a nahrané soubory; role, číselník,
  // střediska, nastavení, evidenci práce i pravidla toku (workflow) ponechá.
  function clearZakazky() {
    const d = load();
    try { if (fs.existsSync(FILES_DIR)) fs.rmSync(FILES_DIR, { recursive: true, force: true }); } catch (_) {}
    try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (_) {}
    d.zakazky = [];
    d.notif = [];
    save(d);
  }
  async function apiAdminSeed(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen správce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    if (b.mode === 'zakazky') { clearZakazky(); json(res, 200, { ok: true, cleared: 'zakazky' }); return true; }
    // 'clear' = úplný reset (i role/konfigurace) — jen při čistém startu
    demoClear();
    json(res, 200, { ok: true, cleared: 'all' });
    return true;
  }

  async function apiAdminSettings(req, res) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen spravce.' }); return true; }
    let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
    const d = load(); d.settings = d.settings || {};
    // phaseDays se už neukládá — cílové doby fází se odvozují z lhůt kroků (Postup / Role a číselník).
    if (typeof b.reportEnabled === 'boolean') d.settings.reportEnabled = b.reportEnabled;
    if (Array.isArray(b.reportRecipients)) d.settings.reportRecipients = b.reportRecipients.map(e => String(e).trim().toLowerCase()).filter(Boolean);
    if (b.reportFreq === 'daily' || b.reportFreq === 'weekly') d.settings.reportFreq = b.reportFreq;
    if (b.reportDow != null) { const dw = parseInt(b.reportDow, 10); if (!isNaN(dw) && dw >= 0 && dw <= 6) d.settings.reportDow = dw; }
    if (b.notif && typeof b.notif === 'object') {
      d.settings.notif = d.settings.notif || {};
      const n = d.settings.notif;
      if (b.notif.warnPct != null) n.warnPct = Math.min(100, Math.max(1, parseInt(b.notif.warnPct, 10) || 80));
      if (b.notif.clientRemind1 != null) n.clientRemind1 = Math.max(0, parseInt(b.notif.clientRemind1, 10) || 0);
      if (b.notif.clientRemind2 != null) n.clientRemind2 = Math.max(0, parseInt(b.notif.clientRemind2, 10) || 0);
      if (typeof b.notif.overdueEmail === 'boolean') n.overdueEmail = b.notif.overdueEmail;
      if (typeof b.notif.directorDigest === 'boolean') n.directorDigest = b.notif.directorDigest;
      WARN_FRAC = Math.min(1, Math.max(0, (Number(n.warnPct) || 80) / 100));
    }
    save(d); json(res, 200, { ok: true, settings: d.settings }); return true;
  }
  async function apiReport(req, res, send) {
    if (!host.isAdmin(req)) { json(res, 403, { chyba: 'Jen spravce.' }); return true; }
    const d = load(); const text = buildWeeklyReport(d);
    if (send) { const rec = (d.settings && d.settings.reportRecipients) || []; for (const em of rec) await mail(em, 'Týdenní přehled konstrukce', text); json(res, 200, { ok: true, sent: rec.length, recipients: rec, text }); return true; }
    json(res, 200, { ok: true, text }); return true;
  }
  return { handle, tick };
}

// Veřejná stránka náhledu (samostatná, bez závislostí na intranetu).
const PUBLIC_HTML = `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Výkres ke schválení · ELKOPLAST</title>
<style>
:root{--g:#0e8a43;--g2:#0a6b34;--g3:#12a350;--ink:#0f1512;--mut:#5b635c;--line:#e3e7e0;--bg:#eef1ec;--red:#c23636;--amber:#b06f00}
*{box-sizing:border-box}
body{margin:0;font-family:Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg)}
.top{background:#fff;border-bottom:1px solid var(--line);padding:12px 18px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:5}
.top .brand{font-weight:800;color:var(--g2);letter-spacing:.5px}
.wrap{max-width:1000px;margin:0 auto;padding:18px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
h1{font-size:19px;margin:0 0 4px}
.muted{color:var(--mut);font-size:14px}
.meta{display:flex;flex-wrap:wrap;gap:6px 20px;margin-top:8px;font-size:14px}
.meta b{color:var(--mut);font-weight:600}
.pdfbox{position:relative;background:#333;border-radius:12px;overflow:hidden;min-height:60vh}
.pdfbox iframe{width:100%;height:78vh;border:0;display:block;background:#525659}
.wm{position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:center;overflow:hidden}
.wm span{color:rgba(255,255,255,.16);font-size:12vw;font-weight:800;transform:rotate(-30deg);white-space:nowrap;letter-spacing:.1em}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
button{font:inherit;border:0;border-radius:10px;padding:12px 18px;cursor:pointer;font-weight:600}
.ok{background:var(--g);color:#fff}.ok:hover{background:var(--g2)}
.rej{background:#fff;color:var(--red);border:1px solid var(--red)}
.note{background:#fff;color:#33513f;border:1px solid var(--line)}
.ghost{background:#eef1ec;color:#33513f}
textarea,input{width:100%;font:inherit;border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:6px}
label{display:block;font-size:14px;font-weight:600;margin-top:10px}
.done{padding:18px;border-radius:12px;text-align:center}
.done.ok{background:#e6f6ec;color:var(--g2);border:1px solid #bfe6cd}
.done.rej{background:#fdecea;color:var(--red);border:1px solid #f5c6cb}
.hide{display:none}
.chk{display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:14px}
.chk input{width:auto;margin-top:3px}
.err{color:var(--red);font-size:14px;margin-top:8px}
.foot{text-align:center;color:var(--mut);font-size:12px;padding:14px}
</style></head><body>
<div class="top"><span class="brand">ELKOPLAST</span><span class="muted">Náhled výkresu ke schválení</span></div>
<div class="wrap" id="root"><div class="card"><p class="muted">Načítám…</p></div></div>
<div class="foot">Zabezpečený náhled · dokument slouží jen ke schválení, nešiřte prosím odkaz dál.</div>
<script>
var TOKEN=location.pathname.split('/').filter(Boolean).pop();
var PIN='';
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function fdt(ts){if(!ts)return'';var d=new Date(ts);function p(n){return(n<10?'0':'')+n}return p(d.getDate())+'.'+p(d.getMonth()+1)+'.'+d.getFullYear()+' '+p(d.getHours())+':'+p(d.getMinutes())}
function api(){return fetch('/api/konstrukce/nahled/'+TOKEN+(PIN?('?pin='+encodeURIComponent(PIN)):''),{cache:'no-store'}).then(function(r){return r.json().then(function(j){return{status:r.status,j:j}})})}
function root(){return document.getElementById('root')}
function load(){
  api().then(function(o){
    if(o.status===401&&o.j.needPin){return pinPrompt()}
    if(o.status!==200){root().innerHTML='<div class="card"><p class="muted">'+esc(o.j.chyba||'Odkaz není platný.')+'</p></div>';return}
    render(o.j)
  }).catch(function(){root().innerHTML='<div class="card"><p class="muted">Nepodařilo se načíst náhled.</p></div>'})
}
function pinPrompt(){
  root().innerHTML='<div class="card"><h1>Zadejte PIN</h1><p class="muted">Tento náhled je chráněn PINem, který jste dostali zvlášť.</p>'+
   '<input id="pin" inputmode="numeric" placeholder="PIN"><div class="btns"><button class="ok" onclick="submitPin()">Pokračovat</button></div><div class="err" id="pe"></div></div>';
}
function submitPin(){PIN=document.getElementById('pin').value.trim();load()}
function render(j){
  var d=j.decided;
  var pdf=j.hasPdf?'<div class="pdfbox"><iframe src="'+esc(j.pdfUrl)+'#toolbar=1&navpanes=0"></iframe><div class="wm"><span>NÁHLED · '+esc(j.zakaznik||'')+'</span></div></div>':'<p class="muted">PDF výkresu není k dispozici.</p>';
  var head='<div class="card"><h1>Výkres '+esc(j.cislo)+'</h1><div class="muted">'+esc(j.typName||'')+'</div>'+
    '<div class="meta"><span><b>Zákazník:</b> '+esc(j.zakaznik)+'</span><span><b>Verze:</b> v'+esc(j.version||'—')+'</span></div></div>';
  var pdfCard='<div class="card">'+pdf+'</div>';
  var actions='';
  if(d){
    if(d.action==='schvalit')actions='<div class="done ok"><b>Výkres byl schválen.</b><br>'+esc(d.name||'')+' · '+fdt(d.at)+'</div>';
    else actions='<div class="done rej"><b>Výkres byl zamítnut.</b><br>'+fdt(d.at)+'</div>';
    actions='<div class="card">'+actions+'</div>';
  }else{
    actions='<div class="card"><p class="muted" style="margin-top:0">Prohlédněte si výkres a zvolte, jak chcete pokračovat:</p>'+
      '<div class="btns">'+
      '<button class="ok" onclick="show(\\'ok\\')">✓ Schválit</button>'+
      '<button class="note" onclick="show(\\'note\\')">✎ Poslat připomínky</button>'+
      '<button class="rej" onclick="show(\\'rej\\')">✕ Zamítnout</button>'+
      '</div>'+
      '<div id="form"></div><div class="err" id="err"></div></div>';
  }
  var comm='';
  if(j.comments&&j.comments.length){
    comm='<div class="card"><b>Komunikace</b>'+j.comments.map(function(c){return '<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><div class="muted">'+esc(c.author)+' · '+fdt(c.at)+'</div><div>'+esc(c.text)+'</div></div>'}).join('')+'</div>';
  }
  root().innerHTML=head+pdfCard+actions+comm;
}
function show(kind){
  var f=document.getElementById('form');if(!f)return;
  if(kind==='ok')f.innerHTML='<label>Vaše jméno<input id="nm" placeholder="Jméno a příjmení"></label>'+
    '<div class="chk"><input type="checkbox" id="sh"><span>Potvrzuji, že výkres odpovídá objednávce a schvaluji jej k výrobě.</span></div>'+
    '<div class="btns"><button class="ok" onclick="send(\\'schvalit\\')">Schválit výkres</button></div>';
  else if(kind==='note')f.innerHTML='<label>Vaše jméno<input id="nm" placeholder="Jméno a příjmení"></label>'+
    '<label>Připomínky k výkresu<textarea id="tx" rows="4" placeholder="Popište, co je třeba upravit…"></textarea></label>'+
    '<div class="btns"><button class="note" onclick="send(\\'pripominky\\')">Odeslat připomínky</button></div>';
  else f.innerHTML='<label>Vaše jméno<input id="nm" placeholder="Jméno a příjmení"></label>'+
    '<label>Důvod zamítnutí<textarea id="dv" rows="3" placeholder="Uveďte prosím důvod…"></textarea></label>'+
    '<div class="btns"><button class="rej" onclick="send(\\'zamitnout\\')">Zamítnout výkres</button></div>';
}
function send(action){
  var b={action:action,pin:PIN,name:(document.getElementById('nm')||{}).value||''};
  if(action==='schvalit')b.souhlas=(document.getElementById('sh')||{}).checked;
  if(action==='pripominky')b.text=(document.getElementById('tx')||{}).value||'';
  if(action==='zamitnout')b.duvod=(document.getElementById('dv')||{}).value||'';
  document.getElementById('err').textContent='';
  fetch('/api/konstrukce/nahled/'+TOKEN+'/akce',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
   .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
   .then(function(o){if(!o.ok){document.getElementById('err').textContent=o.j.chyba||'Nepodařilo se odeslat.';return}load();window.scrollTo(0,0)})
   .catch(function(){document.getElementById('err').textContent='Nepodařilo se odeslat.'})
}
load();
</script></body></html>`;

module.exports = { mount };

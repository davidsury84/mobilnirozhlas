'use strict';
// Jednorázová přestavba vazby smlouva → dokument(y) na Disku.
// Důvod: dřívější rozpad KS (seed-ks-rozpad) odkazoval u KAŽDÉ smlouvy na CELOU
// sdílenou složku. Správně má profil mířit na KONKRÉTNÍ soubor; smlouvy o více
// dokumentech (podsložky) načtou VŠECHNY své soubory (tabulka soubor).
//
// Data (názvy + Drive ID) vytažena přes Drive API z obou KS složek a jejich
// podsložek. Překryvy s hlavními smlouvami (HYCA, ČD Cargo pronájem, Marius
// Pedersen, EUA guarantor) jsou vynechány. Spouští se 1× (meta guard);
// nahrazuje původní profily KS-2025-* / KS-2026-*.

const { todayPrague } = require('./lib/datum');

const SEED_KEY = 'seed_soubory_ks_v1';
const f = (id) => `https://drive.google.com/file/d/${id}/view`;

// Vícedokumentové smlouvy, které UŽ existují jako hlavní profily → jen doplnit soubory.
const BUNDLE = {
  '2025-008': [
    ['Contract CZ2025 MCA0051824', '1LLosVRiZkUKK_NMWrherzUTvmrCdMqjf'],
    ['Contract CZ2025 MCA0051825', '1gvzD2mxDb7AVk0_VNGNIzabUKgVFKjyD'],
    ['Contract CZ2025 MCA0051867', '1t0F81p3n88OFj8vZjZEnxaB7Bo6H85i-'],
  ],
  '2026-012': [
    ['Elkoplast výkup EE 2026', '1ZahVDAmzDLcTLItrMNhYb-LhppzpU1SS'],
    ['Elkoplast výkup EE1 2026', '1t2pP_2B2XyiJtGXUpgucl-J2fxWbLl9-'],
    ['Elkoplast výkup EE 2027', '1sQBhyTUwMarlg1OKR-2e7V7SR67Dz66V'],
    ['Elkoplast výkup1 EE 2027', '1c6q9fRfChtT8M8kRy3TQ-ys_gsu1YgpU'],
    ['Elkoplast CZ ZP 2027 SO', '1gWapWFeKH8IcLj4CibW7EhksWPB4LH2L'],
    ['Elkoplast CZ ZP 2027 MO', '1wyLqigdrVsFTsDZgx6KV5R9JeRt3ASbh'],
    ['Elkoplast CZ EE 2027 VN', '13xrTJEkdRn1AhX8HS6LJULCzt20aEe6b'],
  ],
};

// Nové profily KS z reálných souborů. n = protistrana/název, s = [[název, driveId], …].
const KS2025 = [
  { n: 'OKK Koksovny', s: [['OKK Koksovny KS', '1MSbR5UAGtVofDIYi1BnPv4MRTIDAufit']] },
  { n: 'ČD Cargo (KS + dodatek)', s: [['Kupní smlouva ČD Cargo', '1G4ouqv_VvQVUL_ucnOLDp2duDqt8vBHa'], ['Dodatek ČD Cargo', '12pKPdV68rmZ7aJ5fb-uk-t2djE6sBUtG']] },
  { n: 'Rychvald (odpadové nádoby)', s: [['KS odpadové nádoby Rychvald', '12cecevT8FzOUe6wdia-FNe7-V0SHG6uN'], ['Dodatek č. 2', '1OZPlD74BBazkRxLvr2ki177Z_8KrXna4'], ['KS Rychvald (kopie)', '1iOTdjUMIlIs_EtUApqe6Ph5o6Lg850dL']] },
  { n: 'Vítkovice Steel', s: [['Vítkovice Steel KS', '1Y9rT_tWP3OGFt999ufGa3ZDa5_8sfFvZ']] },
  { n: 'TS Krnov', s: [['TS Krnov', '1LGPnkNAv1rX-hrT-qkC1dmp7RduELLes']] },
  { n: 'Muzeum města Prahy', s: [['KS Muzeum Prahy', '1Fcbq-qF1JkaJ081ROLn9S4gq5oapidK3']] },
  { n: 'EKOPACK Bulgaria', s: [['EKOPACK - BULGARIA', '12LfB3-7vfPno58WPqoeD3QPvYXw9WGnH']] },
  { n: 'Obec Jablůnka', s: [['KS obec Jablůnka', '1G2iGtJ_tXLIwattBQt_4nI4oK5YQ7aoG']] },
  { n: 'Obec Holčovice', s: [['Kupní smlouva Holčovice', '1VFi3siPoNE6c-eqPzJF31lvSsIQDEQz0']] },
  { n: 'OZO Ostrava (Mulda)', s: [['ozo 5ks Mulda', '12rFtO5Llu1Lz3KrECDCvm9MKvhkjDX_U']] },
  { n: 'Obec Louka', s: [['Kupní smlouva vč. přílohy', '1jt08rgOZbXccA8pkvcI3wp84kgI4Kx1l'], ['Doložka ke KS', '1GHvct4rSjG3k0841Dl01PdzEFtIKPvWO']] },
  { n: 'Obec Čechy pod Kosířem', s: [['Kupní smlouva Re-use', '1RAw7cA6QRqK5pNa3kkY5g84hqpbjdQmI'], ['Kupní smlouva vratné nádobí', '1plnhXmwqbdsQsWhjCMyFRz7cq87v_Bc2']] },
  { n: 'Mikroregion Bílé Karpaty (Abroll)', s: [['KS Bílé Karpaty Abroll', '1BBpnwTxTDD-zEXec1Gcw-1j369DM86IK']] },
  { n: 'Svazek obcí Sever Znojemska', s: [['Kupní smlouva Elkoplast', '125aLwxqp9wuNtVbKw7uxl7QJ-P5fAl4S'], ['Příloha č.1 rozpočet', '1NpIZF8tp3ubngorhub0Fx5J13tV9QyfR'], ['Příloha č.2 technická specifikace', '12GWEkFonI1kiavF1iA3pCn_YZPsOy77-'], ['Příloha č.2 rozdělení po obcích', '1gQe52r5fgRNJDrzxb2w76l-0dgF4IPLG'], ['Zpráva o hodnocení TÜV', '1kP5ZDfyqsgVgqiisAj9mrJcsKN_ZGDBw']] },
  { n: 'Frýdecká skládka', s: [['KS Frýdecká skládka', '1-W2lKC3sOoLGSKao6DSrJ_jeQg8NMh47']] },
  { n: 'Mikroregion Luhačovské Zálesí', s: [['Mikroregion Luhačovské Zálesí', '1zxYOp7w58P7UjZ3y0ebuuOPmgIavb4nn'], ['KS Luhačovské zálesí', '1AlZuXp4qAUvPs2OvD_a-R_VD-hGqlvRP']] },
  { n: 'Spolek pro rozvoj venkova Moravský kras', s: [['Kupní smlouva Kelímky', '1ycQV_Nbg-IT8-FsJ1p6YAqGfKh1gzoD1'], ['Příloha 1 SOD Kelímky', '1Dzo25cJFZ0M84j70sI_tOcMpyZIZEgJm']] },
  { n: 'HZS Moravskoslezského kraje (Hlučín)', s: [['HZS Hlučín', '1o3J7hX-hCVqBj0g5gAJbrK_boB1PhCh3']] },
  { n: 'Svazek obcí Mezihoří', s: [['KS Svazek obcí Mezihoří', '1wDvW-X7bRwGcIz4iNahww7WTdzPFb5sq'], ['Konverze KS Kompostéry Mezihoří', '1p46CdHUdugr0lA3m4meTdxYp4AN66nh8']] },
  { n: 'Střední Vsetínsko', s: [['KS Střední Vsetínsko', '1TrmaMDXdiVYpq_GI84Ixy0Gmtv2PdgW0']] },
  { n: 'Velký Týnec (kompostéry OPŽP)', s: [['Kupní smlouva VTýnec kompostéry', '1sDFfTANR-bCSXeLliFP4agT4SpAQYjYH']] },
  { n: 'Pražský plastový koš', s: [['SOD Pražský plastový koš', '1JgCU2sTtTCMvu4xPpq7uXv3I9aVa5R5q'], ['Smlouva o dílo', '1QOvSR1y2Dd1KNoHhh9hQK0dpr7N69-q0'], ['Dodatek č. 1', '1BWTzXPM7fhkWGVS07vGdRNxScBWW5596']] },
  { n: 'Obec Větrník', s: [['Kupní smlouva Větrník', '12A0FCjnPGbvyFUA_OgKccFIKjCkfW_Vf']] },
  { n: 'SAKO Brno', s: [['KS SAKO Brno', '1_ti4RB2qIok3P2wX-M5n-KeaTImbC7D9']] },
  { n: 'Městys Svitávka', s: [['KS Městys Svitávka', '1rdvPHomEnmWkPhRxgEFu1VcLq3wxUwLi']] },
  { n: 'Darkovice', s: [['ELKOPLAST Kupní smlouva podepsaná', '1Myy0E59C_8WesRPP3C56qt8pxP7LBT18'], ['Příloha č.8 TS část B/C/D', '1JDa_idaQ2mV8smVqmozKD6Xrv8uK2wlJ'], ['Část B', '1HWrOdybHb17ca7nidkPHLCJT9yMOMGJI'], ['Část C', '1W_f1iRifdVwMc0Tn1rwYcm83tW540pDg'], ['Část D', '1TrITPDcsO4jPrrLHkIHIvpTT_pBNQzBZ'], ['Předávací protokol myčka', '13SVnai22DWbQpqpxezxBNmzq4fnkbCE7'], ['Protokol kontejnery', '12uba056OlzqsFDUcvADw36yvPem2BfEb']] },
  { n: 'DSO Region Moravská cesta', s: [['DSO Region Moravská cesta', '1srXP-rwHBZoWgrRhvIN10VVfVcFL7cZx'], ['Předávací protokol kompostéry', '19VpGhTHuKkPgBCM05KMC2bAyh-8oIQYo'], ['Předávací protokol nádoby', '17x3jxJVqnYlbVRRscB0xR-4KQ8nhmKRf'], ['Předávací protokol myčka', '1rduywuwHYpk4pGv8lEc3Uk0P8d-EpnV3'], ['Faktura Hls 211250992', '1CA1T28QALZ6PBrXr3xSk2_LEcdFl1vZA']] },
  { n: 'Gradinarium Import', s: [['Gradinarium Import', '1XmKF49uk5NpMEULbODodC9mah__UiJzx']] },
  { n: 'Mikroregion Holešovsko', s: [['KS Elkoplast nádoby', '1Y1ETS1BZSdO-ecq7FtGD2M_qzJB-YaD8'], ['KS Elkoplast', '1wl7GaKZoBgzyKm2H7O7ZszbqUkuRx-ax'], ['Příloha č.1 rozpočet', '1EKT8kAS0Up4SsaNSJkKuFFsrUKJlQYV1'], ['Příloha č.1 nádoby rozpočet', '1ewXz5LZbZSt2lU1deUCE7OG1GdKv584P'], ['Příloha č.2 specifikace', '1_MkejLmo_8a1cqPGx04Gfw8Go8OwQr7J'], ['Příloha č.2 nádoby specifikace', '1K5JQ20kkYp-uuUC_Wm51qrdmoanBx9Qf'], ['Příloha č.3 místa plnění', '1cwWMqRIj7LVVZZyNNsdck1rJLgjmeF5j'], ['Příloha č.3 nádoby místa plnění', '1u6WMW0f_tls3cgOfvotkCsUuqqqXgu83']] },
  { n: 'Obec Rančířov', s: [['Příloha č.1 Kupní smlouva vzor', '1qo1niMfEDPULOHsBSmHxphsvOBrwfLKc'], ['Příloha č.2 Krycí list nabídky', '1UI_XX59qBrKoyLdN8JWmTKSB6SPOh0nN']] },
  { n: 'Město Velká Bíteš', s: [['Kupní smlouva', '1iZy3runPP1_mxvWfKKJYLyQIbvmLyJ86'], ['Příloha č.1 položkový rozpočet', '1DOA1hkVZfC6_NIqG8ELAnkqgsB_KayxT']] },
  { n: 'Obec Bystřička', s: [['Návrh kupní smlouvy / obchodní podmínky', '1R0c2snYXoW_i_amUHQap9FVofPxmagLf'], ['Příloha č.1 rozpočet', '1nVechN2dKDVea5TXfGhrhUMsj5Q-8tGX'], ['Příloha č.2 technická specifikace', '1b3XObi24NbEINr8Frm9I-469YZ5raqZ-'], ['Příloha č.3 KS', '1MwuybepHJwQiVX38Yx7dv3-UzYFScfbV']] },
  { n: 'TS Olomouc', s: [['TS Olomouc', '1X7fNNt0cg8u_dIzj-aWeiWRLuOElngy4']] },
  { n: 'ŘSD ČR', s: [['Kupní smlouva ŘSD', '1n5oUxVGP47RFnEvkVkPFsacSTO0HTVXV']] },
  { n: 'Město Brumov-Bylnice', s: [['Kupní smlouva Brumov-Bylnice', '1a9BOrtKV8w1jf-wDo1YxozW6e50FwlnK']] },
  { n: 'Město Holešov', s: [['Kupní smlouva město Holešov', '15Cx7tWCL4Bip0s3PXBZjYf_zCJRXTsNo']] },
  { n: 'Obec Velké Karlovice', s: [['Kupní smlouva Velké Karlovice', '1BwpOGHdlc17cN1V8KXSb7AYFp8v_rzwQ']] },
  { n: 'Obec Bludov', s: [['Kupní smlouva Bludov', '1DnRGwCLq3wN6CYzpiI4RfFvdDl16rYGR']] },
  { n: 'Kupní smlouva ELKOPLAST (vč. příloh)', s: [['Kupní smlouva ELKOPLAST vč. příloh', '14uINSRiYjNpseMP2uFGwEdVz0ceaOeJt']] },
  { n: 'SOMPO', s: [['Kupní smlouva SOMPO', '1SB0xTAk41IZy1U4jAnw-9BH2lTjAkdvC']] },
  { n: 'Skanska (smlouva o dílo)', s: [['Smlouva o dílo Skanska', '16zR1VFzhiQi7_zLawUB1OjW5x-u_SVeA']] },
  { n: 'Obec Dolní Bečva', s: [['Dolní Bečva smlouva', '1ivGL3npNNSabhtVZjFbt_czhM_AfxXCG']] },
];

const KS2026 = [
  { n: 'Sdružení měst a obcí Východní Moravy (Předcházení vzniku odpadů 2024)', s: [['Zlínský kraj – KS', '1HP9gk-wcGZDEs8ULw0B-weUqADm8Qg1A'], ['Zlínský kraj – opakovaně použ. nádobí', '1e_VECwfMspF5Y9DWbVQpzfy9WkTMtPMS'], ['Zlínský kraj – nádoby a kontejnery', '1k4tY26CQNeGlmkIen3CjHJ-1vtWQwd0j'], ['Olomoucký kraj – RE-USE centrum', '1D43-qJUiEvuAHKVKKa5JZ5FLtKFxQKOv'], ['Olomoucký kraj – opakovaně použ. nádobí', '1-LNOPnKeRzQAC1bi6btRX6uvy_MNtgoV']] },
  { n: 'TS Zlín (velkoobjemové kontejnery)', s: [['TS Zlín velkoobjem. kontejnery', '1llvZwxkqRCDnhIJJ9Bz5bDgu-v-jrvRT']] },
  { n: 'SAKO Brno (Abroll)', s: [['Sako Brno KS Abroll', '1t_iYvdaocetdW-Gnm0zk6QsrOoTJTGGM']] },
  { n: 'Město Železný Brod', s: [['Město Železný Brod KS', '1YBuGDQ7QYK40-ek9s-hlye7FMx90K1g9']] },
  { n: 'Obec Jasenná', s: [['Obec Jasenná KS', '1QIgcg6fO-I_yHFX8gf3YQ1hj9RYlu_Jq']] },
  { n: 'Mikroregion Vysokomýtsko', s: [['Mikroregion Vysokomýtsko KS', '1Cv6O7GnK9mZ_bFIhpSjoichEHmRAbmBP']] },
  { n: 'Statutární město Olomouc (vratné kelímky)', s: [['Olomouc vratné kelímky, úložné boxy', '1KUI7G71sRBSzy3-mkWoXTNnBkF06vowR']] },
  { n: 'Městys Dolní Cerekev', s: [['Městys Dolní Cerekev – kupní smlouva', '1_W-Pom0kuW2YOlipvYu7-rl9Np1hlq2A']] },
  { n: 'M.E. Regia Autosalubritate (Moldávie)', s: [['CONTRACT M.E. Regia Autosalubritate', '1omRT0BgqYeFghMlpQQADMheXDAp6kRYm'], ['Î.M. Regia Autosalubritate KS', '1pypDSMOzHUfyqiay-ZTXKE4Khf97ze_9']] },
  { n: 'Město Kroměříž (polopodzemní kontejnery II)', s: [['Polopodzemní kontejnery II Kroměříž', '1WXzq3CdUByQ17SjhpCZdmVH_bCuXMhKy']] },
  { n: 'Obec Nové Heřminovy', s: [['Nové Heřminovy – kupní smlouva', '10xotQwnEbEMO9UP3YvXy33N7UfEZ4gHl']] },
  { n: 'Obec Nedašov', s: [['Nedašov KS', '15zOKN1GEHvRhNM2ip0np42O9ajFXYC_D']] },
  { n: 'Pro-Doma', s: [['Pro-Doma KS', '1DpHnM97PW8KLO82J7n5GRzqWW_7xMoJ-']] },
  { n: 'Město Mělník', s: [['Mělník – kupní smlouva', '149yrGrHpB2gfORUsG3DIBIDFFzJvBBFv']] },
  { n: 'Město Valašské Meziříčí (koše)', s: [['Valašské Meziříčí KS koše', '13we1vxCe5VIeN-rHcyvPIGb01UrseTnJ']] },
  { n: 'Stavebniny DEK', s: [['Stavebniny DEK smlouva', '1z6_Ufp0F4u7AlLdYT6OfupmJRwJvUJei'], ['DEK × ELKOPLAST', '1_yw4ZAWdU0djHR73Uoegb4kTSLwmmAVR']] },
  { n: 'Ministerstvo obrany (záchytné vany)', s: [['Ministerstvo obrany – záchytné vany', '1MUz5d7Alv8-XA5SrLIICWRZnUDpW8Sr7']] },
  { n: 'Ministerstvo obrany (koše na tříděný odpad)', s: [['Ministerstvo obrany – koše tříděný odpad', '1gLjYzz-i3ue8_GSGYOoEmmoGS6oIGSeV']] },
  { n: 'DSO KTS Ekologie', s: [['KTS Ekologie KS', '1W-hiFzFTXzwfsU6ghTJMpeFkaOY4i1X-']] },
  { n: 'Werner & Weber', s: [['Werner, Weber', '1-9YrbP-KBV_H9KQm5M3qseRYjL9HCT_p']] },
  { n: 'INOVECO Buzau (Rumunsko)', s: [['Contract Buzau INOVECO – signed', '1lMQ_FU7T0g0uljp6n7yGriMbxIotxhzM']] },
  { n: 'Innogy (výkup EE/ZP 2028–2029)', s: [['ZP 2028-2029 MO', '16Pj3zKiZnTh8IRjpZYWsRsuTFaI3cCKJ'], ['ZP 2028-2029 SO', '1kx-YR5qAMQ1TN0DB3ef0Xf8wgZfHbf_J'], ['EE 2028 VN', '1fUa6IXhjWvg64ZoOHjPjm4wGdpUtZEkH'], ['EE 2029 VN', '1hpEiCnqdLNN5nFMAGJRw-yFf9NYHitCC'], ['Výkup EE 2029', '1nhuY7VxXGqwfBui-Ml6qk3p1CUc-KBZE'], ['Výkup EE 2028', '1TxsZysaCExgrY0oZV0s7GmCvn_vL2Qpl']] },
  { n: 'RS TeamTech (Polsko)', s: [['Distribution Agreement', '1y6dASRf22Jwdn3VhI4gdDGyn6-aUXodC'], ['Sublicense Agreement (EN)', '1xFCqTwqXPSzlcuOndCOgkTBlacv5kw38'], ['Karta produktu – kontejner', '1ansu9Mwf7O4SWckCIqqZtmici4jP1CAY']] },
  { n: 'TSK Praha (podlicenční)', s: [['TSK podlicenční smlouva', '1F965b7AomgwFRvG4b-QU3sQRz18BQlIR'], ['Pražský plastový koš KS', '1jImBbG3ukr0cj4RxWc0vlcfyuk-I-wAf']] },
  { n: 'Mikroregion Horácko', s: [['KS kompostéry', '1rFNCd7BkSBgAjqH5kpCfC7lbKk_5yeI_'], ['KS štěpkovač', '1lmWRRNByLMEMl2V8vp1sljCx8bB-pblp'], ['Příloha TS kompostéry', '15ButBWyGUy4VoeSod2bJdXsa1c6_UpkN'], ['Příloha TS štěpkovač', '1X1QRZ2k6nSCSc7-lgfmlrEj7sluxPKHn']] },
  { n: 'DSO Hanácký venkov', s: [['DSO Hanácký venkov KS', '1Q-wxaUJCau5J8lne1pgFAkff-v1mL9Av'], ['Předávací protokol kompostéry', '1yDSDymWpzMN9ni3JH0Ol1r3HBxZLCtWj']] },
  { n: 'Obec Holubice', s: [['KS část A', '182eRDxIPjXipNvRKg836t0TKjYCs0Vb_'], ['KS část B', '1aGAUh7CfysnbAfhyWXIIY17mBH561Cqo'], ['KS část C', '1STzvK7koiDlLoJZCPeaDUnq1Hx9ncRcE'], ['KS část C (opravená)', '14B11J8uZz8_drbi8EVDfm7xPzVAq4VJD']] },
  { n: 'SUTCO (JIHO / Agreement SPL)', s: [['Agreement SPL-ELKOPLAST', '1eQ2aL7syi_MUyOrmBQWwbJWhDg5div0K'], ['Annex 1 List of devices', '1PN9IYyTJ35QkxWmiyemgGMY-0IgMC85Z'], ['Annex 2 Flowchart', '1hqVANE04K4e4ixEHcZsWXWMb_Q2Bm2FN'], ['Annex 3 Layout of Sorting Line', '1mZBtY0UMS1zlFcYoounTpHm9U39VWrum'], ['Annex 4 Technological parameters', '1VCviAJkZQ2qOfbxB4eHvNAtvIigc7jmL'], ['Annex 5 Terms and financial schedule', '1zQa3ZAXGI47-2MGl_7VhfddgWARVbMnk'], ['Annex 6.1 Civil policy SPL', '1MglDGjp7wTg4ZgmTXVRvNV4pkTtgcCvk'], ['Annex 6.2 Civil policy Group', '1fApxzZxAoAVzF4Y7ulaGSd1Akog2toBK'], ['Annex 7 GDPR Information', '1SS9C4CagOij3Ct9aPnPy-r-F0Lap9SJ8']] },
  { n: 'Mírov (věznice)', s: [['Kupní smlouva vč. přílohy', '1mZQB2Fyyelnb_hryoT-XRcpNoOChA5xv'], ['Kupní smlouva vč. přílohy 8', '15fUwk08n5w63lWpOylSIufaleLJDlfF8']] },
  { n: 'Obec Loučka', s: [['KS část 1', '1ho_sg359SIft5QesVxsbBB2PxmERw5GV'], ['KS část 2', '14DQkgTzCQ_bSHgOc6NJt_70Bu6HS70wM'], ['KS část 3', '1_y3m1Uily0zy5dSUjwO2Ep9KMrzGoeCl'], ['Předávací protokol nádoby', '1-t9ppWAegZHh1__kBlpcOgzbShlCppat']] },
];

function ulozSoubory(M, smlouvaId, seznam) {
  seznam.forEach(([nazev, driveId], i) => {
    M.soubor.upsert({ smlouva_id: smlouvaId, nazev, drive_id: driveId, url: f(driveId), mime: 'application/pdf', poradi: i });
  });
}

function rebuildBatch(M, prefix, rows, by) {
  // Smazat staré profily dané dávky (soubory padnou přes ON DELETE CASCADE).
  M.db.prepare(`DELETE FROM smlouva WHERE cislo_smlouvy LIKE ?`).run(`${prefix}-%`);
  let n = 0;
  rows.forEach((row, i) => {
    const cislo = `${prefix}-${String(i + 1).padStart(2, '0')}`;
    const { id } = M.smlouva.upsertDleCisla({
      cislo_smlouvy: cislo,
      kategorie: 'odberatelska', smer: 'prijem', podtyp: 'kupní smlouva',
      protistrana_nazev: row.n,
      predmet: 'Kupní smlouva – kontejnery / nádoby. Detail k doplnění (hodnota, termíny).',
      stav: 'aktivni', stav_popis: 'plnění',
      drive_url: f(row.s[0][1]), je_placeholder: 0,
    }, by);
    ulozSoubory(M, id, row.s);
    n++;
  });
  return n;
}

function seedSoubory(M) {
  if (M.meta.get(SEED_KEY)) return { skipped: true };
  const by = 'seed-soubory';

  // 1) Vícedokumentové hlavní smlouvy → doplnit soubory + srovnat drive_url na 1. soubor.
  let bundlů = 0;
  for (const [cislo, seznam] of Object.entries(BUNDLE)) {
    const s = M.smlouva.getByCislo(cislo);
    if (!s) continue;
    ulozSoubory(M, s.id, seznam);
    M.smlouva.update(s.id, { drive_url: f(seznam[0][1]) }, by);
    bundlů++;
  }

  // 2) Přestavba KS dávek z reálných souborů.
  const a = rebuildBatch(M, 'KS-2025', KS2025, by);
  const b = rebuildBatch(M, 'KS-2026', KS2026, by);

  M.meta.set(SEED_KEY, todayPrague());
  console.log(`[smlouvy] seed soubory: KS-2025=${a}, KS-2026=${b} profilů z reálných souborů; ${bundlů} vícedokumentových doplněno`);
  return { ks2025: a, ks2026: b, bundlů };
}

module.exports = { seedSoubory, SEED_KEY, KS2025, KS2026, BUNDLE };

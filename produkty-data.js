/* Produktový katalog Elkoplast — sdílená data pro intranet (knihovna) i školení obchodníků.
   Zdroj: audit složky PRODUCTS (7/2026) — vytěženo z obchodních výkresů (OB), fotodokumentace a ceníků.
   Cover fotky (reálné snímky) jsou v /assets/produkty-. Kde fotka není, katalog zobrazí placeholder.
   POZOR: data slouží i pro test znalostí — hodnoty neměň bez ověření ve výkresech. */
window.PRODUKTY_SEED = [
  {
    key: "abroll",
    name: "Abroll (hákové) kontejnery",
    shortDesc: "Ocelové kontejnery nakládané hákovým nosičem na podvozek nákladního vozidla.",
    description: "Nejširší produktová rodina Elkoplastu (32 podřad, přes 440 výkresů). Kontejnery pro svoz a přepravu odpadu, sutě, kovošrotu a separovaných frakcí, manipulované hákovým (abroll) nosičem dle národních norem. Zahrnuje uzavřené městské typy CITY (CSD/DSD/POP/WDG/WFR/RAM), otevřené a bezvýztuhové provedení (WD, WF, ECL), zesílené Hardox verze pro šrot (HBI, HDC) i zákaznická a exportní provedení dle norem a odběratelů (AFS Afnor-Francie, DSD-DIN Německo, NL, ACTS, ALST, SUEZ, REMONDIS, PREZERO aj.).",
    material: "Konstrukční ocel S235 (bočnice/podlaha, plechy 2–5 mm), zesílené verze Hardox 450 a QSTE 690 (HBI/HDC); rámy z profilů IPN/UPN/JEKL; nátěr v odstínu RAL dle zákazníka.",
    variants: ["CITY CSD (české uzavřené)", "CITY DSD (dle DIN)", "CITY POP (popelničák)", "CITY WDG (ala Gotzen)", "ABR WD/WF/ECL (bezvýztuhové)", "ABR HBI + HDC (Hardox pro šrot)", "ABR HBS (půlkulaté muldy)", "ABR HM (hausmüll s víky)", "ABR STH (stohovatelné)", "ABR PT (plata)", "exportní AFS/DSD/NL/AFO", "zákaznická: SUEZ, REMONDIS, PREZERO"],
    dimensions: "Délka 3300–7000 mm, šířka 2000–2420 mm, výška 400–2350 mm (kódováno v názvu, např. 3600×2000×1500).",
    volumes: "Cca 5–40 m³; městské CITY typicky ~10–20 m³ (CSD 3600×2000×1500 = 10,8 m³), Hardox HBI 7000×2300×1500 = 25 m³.",
    keyFacts: [
      "Manipulace hákovým (abroll) nosičem — jiný systém než řetězové zvedání muld. Toto je klíčové rozlišení pro obchodníka.",
      "Trojčíslí/dvojčíslí na konci názvu = tloušťky plechů v mm (podlaha/bočnice/čela): 322 = 3/2/2 mm, 534 = 5/3/4 mm, HBI '53' = 5 mm podlaha / 3 mm bočnice z Hardoxu.",
      "Prefix CITY = uzavřené městské kontejnery, ABR = otevřená/průmyslová provedení.",
      "HBI a HDC jsou zesílené z otěruvzdorného plechu Hardox 450 (+ QSTE 690) pro kovošrot.",
      "Národní/normová provedení: DSD = dle DIN, AFS = dle francouzské normy Afnor, dále NL, CH, švédské AFO — nutno dodržet standard nosiče."
    ],
    cover: "/assets/produkty-abroll.jpg"
  },
  {
    key: "skips-muldy",
    name: "Muldy / stavební kontejnery (skipy)",
    shortDesc: "Otevřené i zakryté muldy (skipy) zvedané řetězovými rameny nosiče.",
    description: "Druhá největší rodina (přes 150 výkresů) — muldy / stavební skipy nakládané řetězovými/lanovými rameny (Absetzmulden). Zahrnuje otevřené muldy AM, provedení s víky/klapkami (AMK, DMC, DMS, DMP, DMPM) a další typy (SMR, ASM, KM-KUKA). Národní provedení jsou tříděna do podsložek: CZ, DIN, CH, CHN, NL, FR, PREZERO a speciální CRAN_MULDE (jeřábová mulda).",
    material: "Ocel S235 (plechy dle kódu 2–6 mm), rám a nosníky z profilů U/UPN; svary přerušované/průběžné dle listu; nátěr RAL.",
    variants: ["AM (Absetzmulde – otevřená)", "AMK (s víkem/klapkou)", "DMC / DMS / DMP / DMPM (s víky)", "SMR", "ASM", "KM / KM-RA (Kuka mulda)", "provedení CH/CHN/NL/FR/DIN/CZ/PreZero", "CRAN_MULDE (jeřábová)"],
    dimensions: "Rozměrově dané typem a objemem; výška bočnic mj. varianta 890 mm (S_890mm).",
    volumes: "Cca 2,2 – 12 m³ (AM-NL 2,2 m³; AM 5,5 / 7,0 / 10,0 m³; DMC-CH 12,0 m³; ASM-CH 11,8 m³).",
    keyFacts: [
      "Muldy (skipy) se zvedají řetězovými/lanovými rameny nosiče (Absetzcontainer) — nezaměňovat s hákovým abroll systémem.",
      "Trojčíslí v názvu = tloušťky plechů v mm (433 = 4/3/3, 534 = 5/3/4, 644 = 6/4/4).",
      "Prefix rozlišuje provedení: AM = otevřená, AMK/DMC/DMS/DMP = s víky/klapkami.",
      "Objemová řada 2,2 / 3,5 / 5,5 / 7,0 / 10,0 / 12,0 m³ podle typu a národního standardu.",
      "Přípona S_890mm = varianta s bočnicí výšky 890 mm. Národní provedení mají vlastní podsložky."
    ],
    cover: null
  },
  {
    key: "sld",
    name: "SLD — kontejnery na separovaný sběr",
    shortDesc: "Kontejnery 2,0–4,0 m³ pro separovaný sběr, s vícekomorovými a odhlučněnými variantami.",
    description: "Řada SLD (typy SM a PM) o objemu 2,0–4,0 m³ určená pro separovaný sběr (papír/plast/sklo). K dispozici je Excel ceník s kalkulací (nákupní i prodejní ceny, hmotnosti, ložení na vozidlo). Nabízí vícekomorová provedení (Duo, Triglo), verzi papír/plast, lakované provedení a odhlučnění.",
    material: "Ocel S235 (plechy 2/3 mm); lakované provedení jako příplatek.",
    variants: ["SLD-SM 2,0 / 2,5 / 3,0 / 3,5 / 4,0", "SLD-PM 2,5 / 3,0 / 3,5 / 4,0", "SLD-SM-NOR-3,0", "příplatky: papír/plast, Duo, Triglo, lakované, odhlučnění"],
    dimensions: "Dle typu (kóty na výkresech); jednotný přehled v listu „SLD-SM přehled typů“.",
    volumes: "2,0 / 2,5 / 3,0 / 3,5 / 4,0 m³.",
    keyFacts: [
      "Hmotnosti dle velikosti: SM-2,0 = 205 kg, 2,5 = 250 kg, 3,0 = 280 kg, 3,5 = 320 kg, 4,0 = 350 kg.",
      "Vícekomorové provedení: Duo (+40 kg) a Triglo (+80 kg) pro sběr více frakcí; verze papír/plast (+20 kg).",
      "Příplatkové možnosti: lakování, odhlučnění (2–2,5 m³ i 3–4 m³).",
      "Ceník (2017-03) počítá s kurzem 26,5 CZK/EUR a PC marží 15 %.",
      "Ložení na vozidlo: SM-2,0 = 10 ks na LKW 6,5 / 20 ks na LKW 13,6; SM-4,0 = 5 ks / 12 ks."
    ],
    cover: "/assets/produkty-sld.jpg"
  },
  {
    key: "su-kontejnery",
    name: "SU kontejnery na separovaný sběr",
    shortDesc: "Kontejnery 3,0 a 5,0 m³ pro separovaný sběr papíru, nápojových kartonů a skla (velikosti S/M/L).",
    description: "Řada SU — kontejnery o objemu 3,0 a 5,0 m³ pro separovaný sběr, v provedeních podle sbírané frakce a vhozového otvoru: PA (papír), DR (nápojové kartony/plast) a GL (sklo). Každá frakce ve velikostech S/M/L a s dvouhrdlovým provedením (2H).",
    material: "Ocel S235 (pilíř, podlaha, sběratel); spojovací materiál M16.",
    variants: ["5,0 m³: S/M/L × PA / DR / GL", "3,0 m³: S/M/L × PA / DR / GL", "provedení 2H (dvouhrdlové)"],
    dimensions: "Dle typu; sběratel 5 m³ jako samostatná pozice (386 kg).",
    volumes: "3,0 a 5,0 m³.",
    keyFacts: [
      "Provedení dle frakce: PA = papír, DR = nápojové kartony/plast, GL = sklo; číslo (GL160/220/330) rozlišuje velikost vhozu.",
      "Velikosti S / M / L a dvouhrdlové provedení (2H) v každé objemové řadě 3,0 a 5,0 m³.",
      "Hmotnost provedení 5,0-S-PA2040 ≈ 744 kg.",
      "Výkresy jsou systematicky číslovány SU-01.001 až SU-01.018."
    ],
    cover: null
  },
  {
    key: "sum-pallets",
    name: "Záchytné vany (sump pallets)",
    shortDesc: "Ocelové záchytné vany pro bezpečné skladování sudů a IBC s únikem kapalin.",
    description: "Záchytné vany (sump pallets) pro skladování sudů a nádob s nebezpečnými/znečišťujícími kapalinami — zachytávají případný únik. Řada podle záchytného objemu: 217, 224, 420, 450 a 858 litrů.",
    material: "Ocel (svařovaná vana).",
    variants: ["217 L", "224 L", "420 L", "450 L", "858 L"],
    dimensions: "Např. 217 L cca 830 × 830 mm (dle výkresu SMP-217L).",
    volumes: "Záchytný objem 217 / 224 / 420 / 450 / 858 l.",
    keyFacts: [
      "Číslo v názvu = záchytný (jímací) objem vany v litrech (217–858 l).",
      "Účel: bezpečné skladování sudů/IBC s kapalinami — vana zachytí únik dle předpisů o nakládání s nebezpečnými látkami.",
      "Hmotnost vany 217 L ≈ 51 kg.",
      "5 velikostí, každá s jedním výkresem."
    ],
    cover: null
  },
  {
    key: "usb-boxy",
    name: "USB boxy (univerzální stohovací boxy)",
    shortDesc: "Univerzální stohovatelné ocelové boxy pro skladování a manipulaci ve výrobě a skladu.",
    description: "Univerzální skladovací/stohovací boxy (USB) v řadě objemů a rozměrů, konstruované pro stohování (samostatný výkres STOHOVÁNÍ). Robustní ocelové provedení s výztuhami, doplněné fotodokumentací a obchodním výkresem. Existuje i varianta USB 150 LTH.",
    material: "Ocel S235 — stěny 2 mm, výztuhy/rohy 5 mm.",
    variants: ["USB 0,5 (1200×600×850)", "USB 1 (1200×1200×850)", "USB 1,5 (1200×1200×1200)", "USB 2 (1200×2400×850)", "USB 20.00 (2400×1200×850)", "USB 1200×800×600", "USB 150 LTH"],
    dimensions: "1200×600×850, 1200×1200×850, 1200×1200×1200, 1200×2400×850, 2400×1200×850, 1200×800×600 mm.",
    volumes: "Řada 0,5 / 1 / 1,5 / 2 (číslo v názvu ≈ objem v m³).",
    keyFacts: [
      "Boxy jsou stohovatelné — samostatný výkres „STOHOVÁNÍ“ řeší bezpečné stavění na sebe.",
      "Rozměr a objem jsou kódovány v názvu (USB 1 = 1200×1200×850 mm ≈ 1 m³, hmotnost ~153 kg).",
      "Ocel S235, stěny 2 mm, rohové výztuhy 5 mm; kód „22“ = tloušťky plechů 2/2 mm.",
      "K dispozici je i obecný „OBCHODNÍ VÝKRES“ pro prezentaci řady."
    ],
    cover: "/assets/produkty-usb-boxy.jpg"
  },
  {
    key: "flachmulden",
    name: "Flachmulden (ploché muldy)",
    shortDesc: "Nízkoprofilové muldy s velkou plochou dna pro objemný lehký odpad, provedení CH.",
    description: "Ploché muldy (Flachmulden) — nízkoprofilové kontejnery s velkou půdorysnou plochou pro objemný lehký materiál, provedení CH. Zahrnuje typy FLM1, FLM2, FLMD, FLMK1, FLMK2, včetně variant připravených pro provoz pod střechou („for ROOF“).",
    material: "Ocel S235 (plechy 3 a 5 mm) a S355 (nosné části plech 10 mm); rám z profilů UPN 140/180, U 200×50×5 a JEKL 120×60.",
    variants: ["FLM1-CH / FLM2-CH", "FLMD-CH", "FLMK1-CH / FLMK2-CH", "verze „for ROOF“ (pod střechu)"],
    dimensions: "Např. FLM-CH 4250×1850×1900 mm (15,0 m³) a 5000×1850×1900 mm (17,6 m³); nízká FLMK 4100×1850×520 mm (4,0 m³).",
    volumes: "Cca 4,0 – 17,6 m³.",
    keyFacts: [
      "„Flachmulden“ = ploché muldy s velkou plochou dna pro objemný lehký odpad.",
      "Kód „533“ na konci názvu = tloušťky plechů 5/3/3 mm.",
      "Nosné prvky používají i ocel S355 (plech 10 mm) — vyšší pevnost než běžné S235.",
      "Existují varianty upravené pro provoz pod střechou („for ROOF“)."
    ],
    cover: null
  },
  {
    key: "lsb",
    name: "LSB — Lehký skladovací box",
    shortDesc: "Lehké stohovatelné ocelové skladovací boxy pro dílny a sklady.",
    description: "Lehké skladovací boxy (LSB) v řadě velikostí odvozených od objemu. Otevřené ocelové bedny z tenkého plechu s rámem z úhelníku, vhodné pro skladování a manipulaci. Číslo v názvu (02.40, 03.20, 04.00, 05.00) odpovídá objemu (0,24–0,50 m³). Provedení „_SB“ = upravená varianta.",
    material: "Ocel S235 — plechy 2,0 mm (stěny) a 5 mm (výztuhy), rám z úhelníku L 60×60×3.",
    variants: ["LSB 02.40", "LSB 02.40 SB", "LSB 03.20", "LSB 04.00", "LSB 05.00"],
    dimensions: "LSB 04.00 = 1000 × 800 × 500 mm (odpovídá objemu 0,4 m³).",
    volumes: "Cca 0,24 – 0,50 m³ (číslo v názvu = objem).",
    keyFacts: [
      "Číslo v názvu (např. 04.00) udává objem boxu v m³ (LSB 04.00 = 0,4 m³, rozměr 1000×800×500 mm).",
      "Lehká konstrukce — LSB 04.00 váží jen cca 61 kg (plech 2,0 mm).",
      "Existuje varianta „_SB“ (upravené provedení).",
      "Ocel S235, výztuhy z plechu 5 mm."
    ],
    cover: null
  },
  {
    key: "flat-glass",
    name: "Kontejnery na ploché sklo",
    shortDesc: "Speciální ocelové bedny/stojany (BS) pro bezpečnou přepravu a skladování tabulového skla.",
    description: "Přepravní/skladovací kontejnery (bedny na sklo, typ BS) určené pro tabulové ploché sklo — s podepřením tabulí ve svislé poloze. Doloženo výkresem BS-2000×990×990 a fotodokumentací reálných beden na sklo.",
    material: "Ocel S235 (plechy 3/4 mm), rám z profilu U 100×60×4.",
    variants: ["BS (bedna na sklo) 2000×990×990"],
    dimensions: "BS 2000 × 990 × 990 mm (vnější obálka cca 2130 × 1244 × 990 mm dle výkresu).",
    volumes: "Přepravní stojan — hmotnost prázdné bedny cca 414 kg.",
    keyFacts: [
      "Určeno pro tabulové ploché sklo — bedny fixují sklo ve svislé poloze pro bezpečnou přepravu.",
      "Provedení BS-2000×990×990 má hmotnost cca 414 kg.",
      "Konstrukce ocel S235, plechy 3–4 mm, rám z profilu U 100×60×4."
    ],
    cover: "/assets/produkty-flat-glass.jpg"
  },
  {
    key: "kps",
    name: "KPS — překlápěcí nádoba na kolečkách",
    shortDesc: "Mobilní ocelová nádoba s hákem, čepy vyklápění a čtyřmi kolečky.",
    description: "Nádoby KPS s hákem pro zavěšení/vyklápění, čepy vyklápění a pojezdovými kolečky (typ KPH 200K). Dvě doložené velikosti půdorysu. Robustní konstrukce ze skeletu a dna (přes 490 kg).",
    material: "Ocel (materiál 11 375 = S235JRG dle staré ČSN); háky a čepy, kolečka KPH 200K.",
    variants: ["KPS-2000×1400×700", "KPS-2000×990×990"],
    dimensions: "2000 × 1400 × 700 mm a 2000 × 990 × 990 mm (kód „43“ = tloušťky plechů 4/3 mm).",
    volumes: "Dáno půdorysem a výškou (0,7 resp. 0,99 m).",
    keyFacts: [
      "Nádoba je mobilní — osazena 4 pojezdovými kolečky (KPH 200K) a hákem pro zavěšení/vyklopení.",
      "Kód „43“ v názvu = tloušťky plechů 4 mm a 3 mm.",
      "Hmotnost KPS-2000×1400×700 ≈ 491 kg."
    ],
    cover: null
  },
  {
    key: "asp",
    name: "ASP — sběrné vany/nádoby",
    shortDesc: "Menší ocelové sběrné nádoby s vanou, víkem a vyklápěcí pákou.",
    description: "Řada malých ocelových sběrných nádob (vana + víko + háček víka + páka s uzávěrem STEELCON) ve velikostech 600, 800 a 1500. K dispozici je i speciální provedení ASP-600-LITHIUM (bezpečnostní verze dle názvu, pravděpodobně pro sběr lithiových baterií). Přesné určení číselného označení ověřit u produktového managementu.",
    material: "Ocel S235 a S355 (háček víka plech 5 mm S355), spojovací materiál M8/M20, uzávěr STEELCON; nátěr RAL.",
    variants: ["ASP-600", "ASP-600-LITHIUM", "ASP-800", "ASP-1500"],
    dimensions: "ASP-600 vnější rozměry cca 1060 × 999 × 1000 mm (dle výkresu).",
    volumes: "Číslo v názvu (600/800/1500) pravděpodobně objem v litrech — ve výkrese nepotvrzeno.",
    keyFacts: [
      "ASP-600 má provozní hmotnost cca 190 kg (vana 147,9 kg, víko 25,9 kg).",
      "Nádoba má výklopné víko jištěné háčkem a samojistné matice M20, uzávěr typu STEELCON.",
      "Existuje dedikované provedení ASP-600-LITHIUM (bezpečnostní verze).",
      "Objem dle číselného označení ve výkrese potvrzen není — ověřit."
    ],
    cover: null
  },
  {
    key: "geesink",
    name: "Geesink (nádoby GSK)",
    shortDesc: "Lehké ocelové nádoby řady GSK kompatibilní se svozovým systémem Geesink.",
    description: "Řada GSK-1000 / 1300 / 1600 — lehčí ocelové nádoby (tenký plech 1,5–2 mm) navázané na svozový systém značky Geesink. Přesné určení číselného označení (objem vs. typ) není v listech uvedeno; jde o lehkou konstrukci s malou hmotností.",
    material: "Ocel S235, tenké plechy 1,5 a 2 mm; nátěr RAL.",
    variants: ["GSK-1000", "GSK-1300", "GSK-1600"],
    dimensions: "GSK-1300 cca 1660 × 1515 × 1135 mm (dle výkresu).",
    volumes: "Číslo v názvu (1000/1300/1600) pravděpodobně objem v litrech — nepotvrzeno.",
    keyFacts: [
      "Lehká konstrukce — GSK-1300 váží jen cca 139 kg (plech pouze 1,5–2 mm).",
      "Řada je vázána na svozovou techniku značky Geesink.",
      "Objem dle číselného označení není v listech potvrzen — ověřit."
    ],
    cover: null
  },
  {
    key: "mgb-1100-fl",
    name: "MGB 1100 FL (kovová nádoba 1100 l)",
    shortDesc: "Ocelová nádoba na odpad (Müllgroßbehälter) 1100 l s plochým víkem na kolečkách.",
    description: "MGB 1100 FL = velkoobjemová kovová nádoba na odpad (Müllgroßbehälter) o objemu 1100 litrů, provedení FL/FLH s plochým víkem (Flachdeckel). Pojízdná na 4 kolečkách, kompatibilní se standardními výsypnými systémy pro 1100 l nádoby.",
    material: "Ocel (pozinkovaný/lakovaný plech dle provedení).",
    variants: ["MGB-1100-FLH (ploché víko / Flachdeckel)"],
    dimensions: "Cca 1370 (š) × 1265 (h) × ~1450 mm (v) dle kót výkresu.",
    volumes: "1100 l (standardní MGB).",
    keyFacts: [
      "MGB = Müllgroßbehälter, velkoobjemová nádoba 1100 l dle evropského standardu.",
      "Provedení FL/FLH = ploché víko (Flachdeckel).",
      "Pojízdná nádoba na 4 kolečkách, kompatibilní s vyklápěči na 1100 l."
    ],
    cover: null
  },
  {
    key: "bdf-platforms",
    name: "BDF plošiny (výměnné nástavby)",
    shortDesc: "Ocelová výměnná nástavba / plošina (swap-body) pro nákladní vozidla dle systému BDF.",
    description: "Výměnné nástavby (německy Wechselbrücke, systém BDF) — rámové plošiny odstavitelné a vyměnitelné mezi vozidly. Převážně zakázkové provedení s bohatou fotodokumentací.",
    material: "Ocel; protikorozní ochrana dle DIN EN ISO 12944, tryskání SA 2,5, nátěr 2K-epoxid, odstín RAL 3002 (Kaminrot).",
    variants: ["BDF-Wechselbrücke (standardní výměnná nástavba)"],
    dimensions: "Rám cca 10960 mm délka dle výkresu; přesné rozměry dle zakázky.",
    volumes: "Neuvádí se (plošina, nikoli objemová nádoba).",
    keyFacts: [
      "Jde o swap-body / výměnnou nástavbu dle systému BDF (Wechselbrücke), odstavitelnou na podpěry.",
      "Předepsaná protikorozní ochrana dle DIN EN ISO 12944 (tryskání SA 2,5, 2K-epoxid).",
      "Standardní barevný odstín RAL 3002 (Kaminrot).",
      "Převážně zakázkový produkt (technicky 1 výkres, jinak fotodokumentace)."
    ],
    cover: "/assets/produkty-bdf-platforms.jpg"
  },
  {
    key: "cla-1100",
    name: "CLA 1100 (kontejner 1100 l)",
    shortDesc: "Kontejner třídy CLA o objemu 1100 l (varianta CLA 1100 SKB) — podklady se doplňují.",
    description: "Podle názvu jde o kontejner o objemu 1100 litrů (třída CLA), s variantou CLA 1100 SKB. Ve složce zatím nejsou výkresy ani fotografie — technické parametry je nutné doplnit od produktového managementu.",
    material: "Doplňuje se.",
    variants: ["CLA 1100", "CLA 1100 SKB"],
    dimensions: "Doplňuje se.",
    volumes: "1100 l (dle názvu kategorie).",
    keyFacts: [
      "Objem 1100 l vyplývá z názvu; ostatní parametry se doplňují.",
      "Existuje varianta CLA 1100 SKB."
    ],
    cover: null
  },
  {
    key: "mgb-800-ch",
    name: "MGB 800 CH (kovová nádoba 800 l)",
    shortDesc: "Kovová nádoba na odpad 800 l, provedení CH — podklady se doplňují.",
    description: "Podle názvu jde o velkoobjemovou kovovou nádobu MGB o objemu 800 litrů, provedení CH. Ve složce zatím nejsou žádné soubory — reálné parametry je nutné doplnit od produktového managementu.",
    material: "Doplňuje se.",
    variants: ["MGB 800 CH"],
    dimensions: "Doplňuje se.",
    volumes: "800 l (dle názvu).",
    keyFacts: [
      "MGB = Müllgroßbehälter; zde 800 l, provedení CH.",
      "Parametry se doplňují."
    ],
    cover: null
  }
];

window.PRODUKTY_VARIANTS={"abroll":[{"n":"ABR ACTS","img":"/assets/pv-abroll-00-abr-acts.jpg","g":["/assets/pv-abroll-00-abr-acts.jpg","/assets/pv-abroll-00-abr-acts-1.jpg"]},{"n":"ABR AFO (švédsko Hamo)"},{"n":"ABR AFS (LENAERTS)","img":"/assets/pv-abroll-02-abr-afs-lenaerts.jpg","g":["/assets/pv-abroll-02-abr-afs-lenaerts.jpg","/assets/pv-abroll-02-abr-afs-lenaerts-1.jpg","/assets/pv-abroll-02-abr-afs-lenaerts-2.jpg","/assets/pv-abroll-02-abr-afs-lenaerts-3.jpg","/assets/pv-abroll-02-abr-afs-lenaerts-4.jpg"]},{"n":"ABR AFS (VANHEEDEE)","img":"/assets/pv-abroll-03-abr-afs-vanheedee.jpg","g":["/assets/pv-abroll-03-abr-afs-vanheedee.jpg","/assets/pv-abroll-03-abr-afs-vanheedee-1.jpg","/assets/pv-abroll-03-abr-afs-vanheedee-2.jpg","/assets/pv-abroll-03-abr-afs-vanheedee-3.jpg","/assets/pv-abroll-03-abr-afs-vanheedee-4.jpg"]},{"n":"ABR AFS (francouzske)","img":"/assets/pv-abroll-04-abr-afs-francouzske.jpg","g":["/assets/pv-abroll-04-abr-afs-francouzske.jpg","/assets/pv-abroll-04-abr-afs-francouzske-1.jpg","/assets/pv-abroll-04-abr-afs-francouzske-2.jpg","/assets/pv-abroll-04-abr-afs-francouzske-3.jpg","/assets/pv-abroll-04-abr-afs-francouzske-4.jpg"],"more":82},{"n":"ABR ALST","img":"/assets/pv-abroll-05-abr-alst.jpg","g":["/assets/pv-abroll-05-abr-alst.jpg","/assets/pv-abroll-05-abr-alst-1.jpg","/assets/pv-abroll-05-abr-alst-2.jpg","/assets/pv-abroll-05-abr-alst-3.jpg","/assets/pv-abroll-05-abr-alst-4.jpg"],"more":11},{"n":"ABR BS","img":"/assets/pv-abroll-06-abr-bs.jpg","g":["/assets/pv-abroll-06-abr-bs.jpg","/assets/pv-abroll-06-abr-bs-1.jpg","/assets/pv-abroll-06-abr-bs-2.jpg","/assets/pv-abroll-06-abr-bs-3.jpg","/assets/pv-abroll-06-abr-bs-4.jpg"]},{"n":"ABR DSD","img":"/assets/pv-abroll-07-abr-dsd.jpg","g":["/assets/pv-abroll-07-abr-dsd.jpg","/assets/pv-abroll-07-abr-dsd-1.jpg","/assets/pv-abroll-07-abr-dsd-2.jpg","/assets/pv-abroll-07-abr-dsd-3.jpg","/assets/pv-abroll-07-abr-dsd-4.jpg"],"more":25},{"n":"ABR ECL (bezvýztuhové)","img":"/assets/pv-abroll-08-abr-ecl-bezvyztuhove.jpg"},{"n":"ABR HBI (hardox šroťaři)","img":"/assets/pv-abroll-09-abr-hbi-hardox-srotari.jpg","g":["/assets/pv-abroll-09-abr-hbi-hardox-srotari.jpg","/assets/pv-abroll-09-abr-hbi-hardox-srotari-1.jpg","/assets/pv-abroll-09-abr-hbi-hardox-srotari-2.jpg","/assets/pv-abroll-09-abr-hbi-hardox-srotari-3.jpg","/assets/pv-abroll-09-abr-hbi-hardox-srotari-4.jpg"],"more":9},{"n":"ABR HBS (halbshal muldy)","img":"/assets/pv-abroll-10-abr-hbs-halbshal-muldy.jpg","g":["/assets/pv-abroll-10-abr-hbs-halbshal-muldy.jpg","/assets/pv-abroll-10-abr-hbs-halbshal-muldy-1.jpg","/assets/pv-abroll-10-abr-hbs-halbshal-muldy-2.jpg","/assets/pv-abroll-10-abr-hbs-halbshal-muldy-3.jpg","/assets/pv-abroll-10-abr-hbs-halbshal-muldy-4.jpg"],"more":9},{"n":"ABR HDC (hardox GTS)","img":"/assets/pv-abroll-11-abr-hdc-hardox-gts.jpg","g":["/assets/pv-abroll-11-abr-hdc-hardox-gts.jpg","/assets/pv-abroll-11-abr-hdc-hardox-gts-1.jpg"]},{"n":"ABR HM (hausmull s víky)","img":"/assets/pv-abroll-12-abr-hm-hausmull-s-viky.jpg","g":["/assets/pv-abroll-12-abr-hm-hausmull-s-viky.jpg","/assets/pv-abroll-12-abr-hm-hausmull-s-viky-1.jpg"]},{"n":"ABR LWC","img":"/assets/pv-abroll-13-abr-lwc.jpg"},{"n":"ABR NL","img":"/assets/pv-abroll-14-abr-nl.jpg","g":["/assets/pv-abroll-14-abr-nl.jpg","/assets/pv-abroll-14-abr-nl-1.jpg"]},{"n":"ABR PREZERO DE","img":"/assets/pv-abroll-15-abr-prezero-de.jpg","g":["/assets/pv-abroll-15-abr-prezero-de.jpg","/assets/pv-abroll-15-abr-prezero-de-1.jpg","/assets/pv-abroll-15-abr-prezero-de-2.jpg","/assets/pv-abroll-15-abr-prezero-de-3.jpg","/assets/pv-abroll-15-abr-prezero-de-4.jpg"],"more":24},{"n":"ABR PT (plata)","img":"/assets/pv-abroll-16-abr-pt-plata.jpg","g":["/assets/pv-abroll-16-abr-pt-plata.jpg","/assets/pv-abroll-16-abr-pt-plata-1.jpg","/assets/pv-abroll-16-abr-pt-plata-2.jpg","/assets/pv-abroll-16-abr-pt-plata-3.jpg","/assets/pv-abroll-16-abr-pt-plata-4.jpg"],"more":3},{"n":"ABR RAM"},{"n":"ABR REMONDIS","img":"/assets/pv-abroll-18-abr-remondis.jpg","g":["/assets/pv-abroll-18-abr-remondis.jpg","/assets/pv-abroll-18-abr-remondis-1.jpg","/assets/pv-abroll-18-abr-remondis-2.jpg","/assets/pv-abroll-18-abr-remondis-3.jpg","/assets/pv-abroll-18-abr-remondis-4.jpg"],"more":4},{"n":"ABR STH (stohovatelne)","img":"/assets/pv-abroll-19-abr-sth-stohovatelne.jpg","g":["/assets/pv-abroll-19-abr-sth-stohovatelne.jpg","/assets/pv-abroll-19-abr-sth-stohovatelne-1.jpg","/assets/pv-abroll-19-abr-sth-stohovatelne-2.jpg","/assets/pv-abroll-19-abr-sth-stohovatelne-3.jpg","/assets/pv-abroll-19-abr-sth-stohovatelne-4.jpg"],"more":13},{"n":"ABR SUEZ","img":"/assets/pv-abroll-20-abr-suez.jpg","g":["/assets/pv-abroll-20-abr-suez.jpg","/assets/pv-abroll-20-abr-suez-1.jpg","/assets/pv-abroll-20-abr-suez-2.jpg","/assets/pv-abroll-20-abr-suez-3.jpg","/assets/pv-abroll-20-abr-suez-4.jpg"],"more":24},{"n":"ABR TH (thermocont)"},{"n":"ABR WD (bezvýztuh DIN)","img":"/assets/pv-abroll-22-abr-wd-bezvyztuh-din.jpg","g":["/assets/pv-abroll-22-abr-wd-bezvyztuh-din.jpg","/assets/pv-abroll-22-abr-wd-bezvyztuh-din-1.jpg","/assets/pv-abroll-22-abr-wd-bezvyztuh-din-2.jpg","/assets/pv-abroll-22-abr-wd-bezvyztuh-din-3.jpg","/assets/pv-abroll-22-abr-wd-bezvyztuh-din-4.jpg"],"more":137},{"n":"ABR WF (bezvýztuh Afnor)","img":"/assets/pv-abroll-23-abr-wf-bezvyztuh-afnor.jpg"},{"n":"CITY CSD (ceske)","img":"/assets/pv-abroll-24-city-csd-ceske.jpg","g":["/assets/pv-abroll-24-city-csd-ceske.jpg","/assets/pv-abroll-24-city-csd-ceske-1.jpg","/assets/pv-abroll-24-city-csd-ceske-2.jpg","/assets/pv-abroll-24-city-csd-ceske-3.jpg","/assets/pv-abroll-24-city-csd-ceske-4.jpg"],"more":127},{"n":"CITY DSD (DIN)","img":"/assets/pv-abroll-25-city-dsd-din.jpg","g":["/assets/pv-abroll-25-city-dsd-din.jpg","/assets/pv-abroll-25-city-dsd-din-1.jpg","/assets/pv-abroll-25-city-dsd-din-2.jpg","/assets/pv-abroll-25-city-dsd-din-3.jpg","/assets/pv-abroll-25-city-dsd-din-4.jpg"],"more":34},{"n":"CITY POP (popelničák)","img":"/assets/pv-abroll-26-city-pop-popelnicak.jpg","g":["/assets/pv-abroll-26-city-pop-popelnicak.jpg","/assets/pv-abroll-26-city-pop-popelnicak-1.jpg","/assets/pv-abroll-26-city-pop-popelnicak-2.jpg","/assets/pv-abroll-26-city-pop-popelnicak-3.jpg","/assets/pv-abroll-26-city-pop-popelnicak-4.jpg"]},{"n":"CITY RAM","img":"/assets/pv-abroll-27-city-ram.jpg"},{"n":"CITY WDC","img":"/assets/pv-abroll-28-city-wdc.jpg","g":["/assets/pv-abroll-28-city-wdc.jpg","/assets/pv-abroll-28-city-wdc-1.jpg","/assets/pv-abroll-28-city-wdc-2.jpg","/assets/pv-abroll-28-city-wdc-3.jpg","/assets/pv-abroll-28-city-wdc-4.jpg"],"more":16},{"n":"CITY WDG (ala Gotzen)","img":"/assets/pv-abroll-29-city-wdg-ala-gotzen.jpg","g":["/assets/pv-abroll-29-city-wdg-ala-gotzen.jpg","/assets/pv-abroll-29-city-wdg-ala-gotzen-1.jpg","/assets/pv-abroll-29-city-wdg-ala-gotzen-2.jpg","/assets/pv-abroll-29-city-wdg-ala-gotzen-3.jpg","/assets/pv-abroll-29-city-wdg-ala-gotzen-4.jpg"],"more":19},{"n":"CITY-SÍT´","img":"/assets/pv-abroll-30-city-sit.jpg","g":["/assets/pv-abroll-30-city-sit.jpg","/assets/pv-abroll-30-city-sit-1.jpg","/assets/pv-abroll-30-city-sit-2.jpg","/assets/pv-abroll-30-city-sit-3.jpg","/assets/pv-abroll-30-city-sit-4.jpg"],"more":3},{"n":"CITY-WFR","img":"/assets/pv-abroll-31-city-wfr.jpg","g":["/assets/pv-abroll-31-city-wfr.jpg","/assets/pv-abroll-31-city-wfr-1.jpg","/assets/pv-abroll-31-city-wfr-2.jpg","/assets/pv-abroll-31-city-wfr-3.jpg"]}],"asp":[{"n":"ASP-1500","img":"/assets/pv-asp-00-asp-1500.jpg"},{"n":"ASP-600","img":"/assets/pv-asp-01-asp-600.jpg"},{"n":"ASP-600-LITHIUM","img":"/assets/pv-asp-02-asp-600-lithium.jpg"},{"n":"ASP-800","img":"/assets/pv-asp-03-asp-800.jpg"}],"bdf-platforms":[{"n":"Fotografie","img":"/assets/pv-bdf-platforms-00-fotografie.jpg","g":["/assets/pv-bdf-platforms-00-fotografie.jpg","/assets/pv-bdf-platforms-00-fotografie-1.jpg","/assets/pv-bdf-platforms-00-fotografie-2.jpg","/assets/pv-bdf-platforms-00-fotografie-3.jpg","/assets/pv-bdf-platforms-00-fotografie-4.jpg"],"more":14},{"n":"BDF-Wechselbrücke","img":"/assets/pv-bdf-platforms-01-bdf-wechselbr-cke.jpg"}],"cla-1100":[{"n":"CLA 1100"},{"n":"CLA 1100 SKB"}],"flachmulden":[{"n":"FLM1-CH_","img":"/assets/pv-flachmulden-00-flm1-ch.jpg","g":["/assets/pv-flachmulden-00-flm1-ch.jpg","/assets/pv-flachmulden-00-flm1-ch-1.jpg","/assets/pv-flachmulden-00-flm1-ch-2.jpg","/assets/pv-flachmulden-00-flm1-ch-3.jpg"]},{"n":"FLM2-CH_"},{"n":"FLMD-CH_"},{"n":"FLMK1-CH_","img":"/assets/pv-flachmulden-03-flmk1-ch.jpg"},{"n":"FLMK2-CH_"}],"flat-glass":[{"n":"Fotografie","img":"/assets/pv-flat-glass-00-fotografie.jpg","g":["/assets/pv-flat-glass-00-fotografie.jpg","/assets/pv-flat-glass-00-fotografie-1.jpg","/assets/pv-flat-glass-00-fotografie-2.jpg","/assets/pv-flat-glass-00-fotografie-3.jpg","/assets/pv-flat-glass-00-fotografie-4.jpg"],"more":3},{"n":"BS-2000x990x990-KONTEJNER","s":"2000×990×990 mm","img":"/assets/pv-flat-glass-01-bs-2000x990x990-kontejner.jpg"}],"geesink":[{"n":"GSK-1000","img":"/assets/pv-geesink-00-gsk-1000.jpg"},{"n":"GSK-1300","img":"/assets/pv-geesink-01-gsk-1300.jpg"},{"n":"GSK-1600","img":"/assets/pv-geesink-02-gsk-1600.jpg"}],"kps":[{"n":"KPS-2000x1400x700-43","s":"2000×1400×700 mm","img":"/assets/pv-kps-00-kps-2000x1400x700-43.jpg"},{"n":"KPS-2000x990x990-43","s":"2000×990×990 mm","img":"/assets/pv-kps-01-kps-2000x990x990-43.jpg"}],"lsb":[{"n":"LSB 02.40_LacNam","img":"/assets/pv-lsb-00-lsb-02-40-lacnam.jpg"},{"n":"LSB 02.40_LacNam_SB","img":"/assets/pv-lsb-01-lsb-02-40-lacnam-sb.jpg"},{"n":"LSB 03.20_LacNam","img":"/assets/pv-lsb-02-lsb-03-20-lacnam.jpg"},{"n":"LSB 04.00_LacNam","img":"/assets/pv-lsb-03-lsb-04-00-lacnam.jpg"},{"n":"LSB 05.00_LacNam","img":"/assets/pv-lsb-04-lsb-05-00-lacnam.jpg"}],"mgb-1100-fl":[{"n":"MGB-1100-FLH","img":"/assets/pv-mgb-1100-fl-00-mgb-1100-flh.jpg"}],"mgb-800-ch":[],"skips-muldy":[{"n":"CH: FLM-CH-17,6-533","s":"17,6 m³","img":"/assets/pv-skips-muldy-00-ch-flm-ch-17-6-533.jpg"},{"n":"CH: AM-CH-11,0-644","s":"11,0 m³","img":"/assets/pv-skips-muldy-01-ch-am-ch-11-0-644.jpg"},{"n":"CH: AM-CH-6,7-534","s":"6,7 m³","img":"/assets/pv-skips-muldy-02-ch-am-ch-6-7-534.jpg"},{"n":"CH: AM-CH-11,0-655-MULDA","s":"11,0 m³","img":"/assets/pv-skips-muldy-03-ch-am-ch-11-0-655-mulda.jpg"},{"n":"CH: AM-CH-9,5-644-","s":"9,5 m³","img":"/assets/pv-skips-muldy-04-ch-am-ch-9-5-644.jpg"},{"n":"CH: ASM-CH-11,8-644-","s":"11,8 m³","img":"/assets/pv-skips-muldy-05-ch-asm-ch-11-8-644.jpg"},{"n":"CH: ASM-CH-9,8-644- MULDA","s":"9,8 m³","img":"/assets/pv-skips-muldy-06-ch-asm-ch-9-8-644-mulda.jpg"},{"n":"CH: DMA-CH 10.54-01-00 MULDA","img":"/assets/pv-skips-muldy-07-ch-dma-ch-10-54-01-00-mulda.jpg"},{"n":"CH: DMA-CH 6.54-01-00 MULDA","img":"/assets/pv-skips-muldy-08-ch-dma-ch-6-54-01-00-mulda.jpg"},{"n":"CH: DMC-CH-10,0-534","s":"10,0 m³","img":"/assets/pv-skips-muldy-09-ch-dmc-ch-10-0-534.jpg"},{"n":"CH: DMC-CH-10,0-544","s":"10,0 m³","img":"/assets/pv-skips-muldy-10-ch-dmc-ch-10-0-544.jpg"},{"n":"CH: DMC-CH-12,0-534-","s":"12,0 m³","img":"/assets/pv-skips-muldy-11-ch-dmc-ch-12-0-534.jpg"},{"n":"CH: DMC-CH-12,0-544","s":"12,0 m³","img":"/assets/pv-skips-muldy-12-ch-dmc-ch-12-0-544.jpg"},{"n":"CH: DMC-CH-6,3-534","s":"6,3 m³","img":"/assets/pv-skips-muldy-13-ch-dmc-ch-6-3-534.jpg"},{"n":"CH: SMR-CH-4,0-534","s":"4,0 m³","img":"/assets/pv-skips-muldy-14-ch-smr-ch-4-0-534.jpg"},{"n":"CH: SMR-CH-6,0-644-","s":"6,0 m³","img":"/assets/pv-skips-muldy-15-ch-smr-ch-6-0-644.jpg"},{"n":"CH: ASM-CH-11,8-644","s":"11,8 m³","img":"/assets/pv-skips-muldy-16-ch-asm-ch-11-8-644.jpg"},{"n":"CH: ASM-CH-7,5-534","s":"7,5 m³","img":"/assets/pv-skips-muldy-17-ch-asm-ch-7-5-534.jpg"},{"n":"CH: ASM-CH-9,8-644","s":"9,8 m³","img":"/assets/pv-skips-muldy-18-ch-asm-ch-9-8-644.jpg"},{"n":"CH: DMC-CH-10,0-534 OB NOVÉ VÍKO","s":"10,0 m³","img":"/assets/pv-skips-muldy-19-ch-dmc-ch-10-0-534-ob-nove-viko.jpg"},{"n":"CH: DMC-CH-10,0-534 OB STARÉ VÍKO","s":"10,0 m³","img":"/assets/pv-skips-muldy-20-ch-dmc-ch-10-0-534-ob-stare-viko.jpg"},{"n":"CH: DMC-CH-12,0-534 OB nové víko","s":"12,0 m³","img":"/assets/pv-skips-muldy-21-ch-dmc-ch-12-0-534-ob-nove-viko.jpg"},{"n":"CH: DMC-CH-12,0-534","s":"12,0 m³","img":"/assets/pv-skips-muldy-22-ch-dmc-ch-12-0-534.jpg"},{"n":"CH: DMC-CH-12,0-544","s":"12,0 m³","img":"/assets/pv-skips-muldy-23-ch-dmc-ch-12-0-544.jpg"},{"n":"CH: DMC-CH-6,3-534 OB NOVÉ VÍKO","s":"6,3 m³","img":"/assets/pv-skips-muldy-24-ch-dmc-ch-6-3-534-ob-nove-viko.jpg"},{"n":"CH: DMC-CH-6,3-534 OB STARÉ VÍKO","s":"6,3 m³","img":"/assets/pv-skips-muldy-25-ch-dmc-ch-6-3-534-ob-stare-viko.jpg"},{"n":"CH: SMR-CH-4,0-534","s":"4,0 m³","img":"/assets/pv-skips-muldy-26-ch-smr-ch-4-0-534.jpg"},{"n":"CHN: AM-CHN-6,7-534 OB CONTRACT","s":"6,7 m³","img":"/assets/pv-skips-muldy-27-chn-am-chn-6-7-534-ob-contract.jpg"},{"n":"CHN: AM-CHN-6,7-534","s":"6,7 m³","img":"/assets/pv-skips-muldy-28-chn-am-chn-6-7-534.jpg"},{"n":"CHN: AM-CHN-6,7-534-S1_vyztužení L","s":"6,7 m³","img":"/assets/pv-skips-muldy-29-chn-am-chn-6-7-534-s1-vyztuzeni-l.jpg"},{"n":"CHN: AM-CHN-9,5-534","s":"9,5 m³","img":"/assets/pv-skips-muldy-30-chn-am-chn-9-5-534.jpg"},{"n":"CHN: AM-CHN-9,5-644","s":"9,5 m³","img":"/assets/pv-skips-muldy-31-chn-am-chn-9-5-644.jpg"},{"n":"CHN: ASM-CHN-11,8-644 OB CONTRACT","s":"11,8 m³","img":"/assets/pv-skips-muldy-32-chn-asm-chn-11-8-644-ob-contract.jpg"},{"n":"CHN: ASM-CHN-11,8-644","s":"11,8 m³","img":"/assets/pv-skips-muldy-33-chn-asm-chn-11-8-644.jpg"},{"n":"CHN: ASM-CHN-7,5-534-S1","s":"7,5 m³","img":"/assets/pv-skips-muldy-34-chn-asm-chn-7-5-534-s1.jpg"},{"n":"CHN: ASM-CHN-9,8-644 OB CONTRACT","s":"9,8 m³","img":"/assets/pv-skips-muldy-35-chn-asm-chn-9-8-644-ob-contract.jpg"},{"n":"CHN: ASM-CHN-9,8-644","s":"9,8 m³","img":"/assets/pv-skips-muldy-36-chn-asm-chn-9-8-644.jpg"},{"n":"CHN: DMC-CHN-12-534 OB CONTRACTS","img":"/assets/pv-skips-muldy-37-chn-dmc-chn-12-534-ob-contracts.jpg"},{"n":"CHN: DMC-CHN-12-534","img":"/assets/pv-skips-muldy-38-chn-dmc-chn-12-534.jpg"},{"n":"CHN: DMC-CHN-6,3-534","s":"6,3 m³","img":"/assets/pv-skips-muldy-39-chn-dmc-chn-6-3-534.jpg"},{"n":"CHN: DMC-CHN-6,3-534-S1_vyztužení L","s":"6,3 m³","img":"/assets/pv-skips-muldy-40-chn-dmc-chn-6-3-534-s1-vyztuzeni-l.jpg"},{"n":"CHN: DMC-CHN-6,3-534-S2","s":"6,3 m³","img":"/assets/pv-skips-muldy-41-chn-dmc-chn-6-3-534-s2.jpg"},{"n":"CZ: AM-10,0-534-S_890mm","s":"10,0 m³","img":"/assets/pv-skips-muldy-42-cz-am-10-0-534-s-890mm.jpg"},{"n":"CZ: AM-10,0-644-S-890mm","s":"10,0 m³","img":"/assets/pv-skips-muldy-43-cz-am-10-0-644-s-890mm.jpg"},{"n":"CZ: AM-5,5-644-K_890 mm-","s":"5,5 m³","img":"/assets/pv-skips-muldy-44-cz-am-5-5-644-k-890-mm.jpg"},{"n":"CZ: AM-7,0-534-S_890mm","s":"7,0 m³","img":"/assets/pv-skips-muldy-45-cz-am-7-0-534-s-890mm.jpg"},{"n":"CZ: AM-7,0-644-S_890mm","s":"7,0 m³","img":"/assets/pv-skips-muldy-46-cz-am-7-0-644-s-890mm.jpg"},{"n":"CZ: AMK-10,0-534-S-890mm","s":"10,0 m³","img":"/assets/pv-skips-muldy-47-cz-amk-10-0-534-s-890mm.jpg"},{"n":"CZ: DMS-10,0-534-S_890mm","s":"10,0 m³","img":"/assets/pv-skips-muldy-48-cz-dms-10-0-534-s-890mm.jpg"},{"n":"CZ: DMS-7,0-533","s":"7,0 m³","img":"/assets/pv-skips-muldy-49-cz-dms-7-0-533.jpg"},{"n":"CZ: DMS-7,0-534-S_890mm","s":"7,0 m³","img":"/assets/pv-skips-muldy-50-cz-dms-7-0-534-s-890mm.jpg"},{"n":"CZ: AM-10,0-534-SBL-S_890mm","s":"10,0 m³","img":"/assets/pv-skips-muldy-51-cz-am-10-0-534-sbl-s-890mm.jpg"},{"n":"CZ: AM-5,5-644-SBL","s":"5,5 m³","img":"/assets/pv-skips-muldy-52-cz-am-5-5-644-sbl.jpg"},{"n":"CZ: AM-7,0-534-SBL-S_890mm","s":"7,0 m³","img":"/assets/pv-skips-muldy-53-cz-am-7-0-534-sbl-s-890mm.jpg"},{"n":"CZ: AMK-5,5-534-SBL","s":"5,5 m³","img":"/assets/pv-skips-muldy-54-cz-amk-5-5-534-sbl.jpg"},{"n":"CZ: AMK-7,0-534-SBL-890mm","s":"7,0 m³","img":"/assets/pv-skips-muldy-55-cz-amk-7-0-534-sbl-890mm.jpg"},{"n":"CZ: DMP-7,0-534-SBL","s":"7,0 m³","img":"/assets/pv-skips-muldy-56-cz-dmp-7-0-534-sbl.jpg"},{"n":"CZ: DMS-5,5-534-SBL","s":"5,5 m³","img":"/assets/pv-skips-muldy-57-cz-dms-5-5-534-sbl.jpg"},{"n":"CZ: DMS-7,0-534-SBL","s":"7,0 m³","img":"/assets/pv-skips-muldy-58-cz-dms-7-0-534-sbl.jpg"},{"n":"CZ: DMS-7,0-534-SBL-S_890mm","s":"7,0 m³","img":"/assets/pv-skips-muldy-59-cz-dms-7-0-534-sbl-s-890mm.jpg"},{"n":"CZ: SMR-10,0-534-SBL-S_890mm","s":"10,0 m³","img":"/assets/pv-skips-muldy-60-cz-smr-10-0-534-sbl-s-890mm.jpg"},{"n":"CZ: SMR-5,5-534-SBL","s":"5,5 m³","img":"/assets/pv-skips-muldy-61-cz-smr-5-5-534-sbl.jpg"},{"n":"CZ: SMR-5,5-534-SBL-S_890mm","s":"5,5 m³","img":"/assets/pv-skips-muldy-62-cz-smr-5-5-534-sbl-s-890mm.jpg"},{"n":"CZ: SMR-7,0-534-SBL","s":"7,0 m³","img":"/assets/pv-skips-muldy-63-cz-smr-7-0-534-sbl.jpg"},{"n":"CZ: SMR-7,0-534-SBL-S_890 mm","s":"7,0 m³","img":"/assets/pv-skips-muldy-64-cz-smr-7-0-534-sbl-s-890-mm.jpg"},{"n":"CZ: SMR-5,5-544-S-890mm","s":"5,5 m³","img":"/assets/pv-skips-muldy-65-cz-smr-5-5-544-s-890mm.jpg"},{"n":"CZ: SMR-7,0-534-S_890mm","s":"7,0 m³","img":"/assets/pv-skips-muldy-66-cz-smr-7-0-534-s-890mm.jpg"},{"n":"DIN: AM-10,0-534","s":"10,0 m³","img":"/assets/pv-skips-muldy-67-din-am-10-0-534.jpg"},{"n":"DIN: AM-10,0-634","s":"10,0 m³","img":"/assets/pv-skips-muldy-68-din-am-10-0-634.jpg"},{"n":"DIN: AM-10,0-644","s":"10,0 m³","img":"/assets/pv-skips-muldy-69-din-am-10-0-644.jpg"},{"n":"DIN: AM-5,5-534 DIN-GmbH","s":"5,5 m³","img":"/assets/pv-skips-muldy-70-din-am-5-5-534-din-gmbh.jpg"},{"n":"DIN: AM-5,5-634 DIN-GmbH","s":"5,5 m³","img":"/assets/pv-skips-muldy-71-din-am-5-5-634-din-gmbh.jpg"},{"n":"DIN: AM-5,5-644 DIN-GmbH","s":"5,5 m³","img":"/assets/pv-skips-muldy-72-din-am-5-5-644-din-gmbh.jpg"},{"n":"DIN: AM-7,0-534","s":"7,0 m³","img":"/assets/pv-skips-muldy-73-din-am-7-0-534.jpg"},{"n":"DIN: AM-7,0-534+MATICE","s":"7,0 m³","img":"/assets/pv-skips-muldy-74-din-am-7-0-534-matice.jpg"},{"n":"DIN: AM-7,0-634-","s":"7,0 m³","img":"/assets/pv-skips-muldy-75-din-am-7-0-634.jpg"},{"n":"DIN: AM-7,0-644","s":"7,0 m³","img":"/assets/pv-skips-muldy-76-din-am-7-0-644.jpg"},{"n":"DIN: AMK-10,0-534","s":"10,0 m³","img":"/assets/pv-skips-muldy-77-din-amk-10-0-534.jpg"},{"n":"DIN: AMK-10,0-644","s":"10,0 m³","img":"/assets/pv-skips-muldy-78-din-amk-10-0-644.jpg"},{"n":"DIN: AMK-5,5-644","s":"5,5 m³","img":"/assets/pv-skips-muldy-79-din-amk-5-5-644.jpg"},{"n":"DIN: AMK-7,0-534","s":"7,0 m³","img":"/assets/pv-skips-muldy-80-din-amk-7-0-534.jpg"},{"n":"DIN: AMK-7,0-644-","s":"7,0 m³","img":"/assets/pv-skips-muldy-81-din-amk-7-0-644.jpg"},{"n":"DIN: AM-5,5-534-","s":"5,5 m³","img":"/assets/pv-skips-muldy-82-din-am-5-5-534.jpg"},{"n":"DIN: AM-5,5-634-","s":"5,5 m³","img":"/assets/pv-skips-muldy-83-din-am-5-5-634.jpg"},{"n":"DIN: AM 5,5-644-","s":"5,5 m³","img":"/assets/pv-skips-muldy-84-din-am-5-5-644.jpg"},{"n":"DIN: AM-10,0-534-","s":"10,0 m³","img":"/assets/pv-skips-muldy-85-din-am-10-0-534.jpg"},{"n":"DIN: AM-10,0-644-","s":"10,0 m³","img":"/assets/pv-skips-muldy-86-din-am-10-0-644.jpg"},{"n":"DIN: AM-7,0-534-","s":"7,0 m³","img":"/assets/pv-skips-muldy-87-din-am-7-0-534.jpg"},{"n":"DIN: AMK-5,5-534-","s":"5,5 m³","img":"/assets/pv-skips-muldy-88-din-amk-5-5-534.jpg"},{"n":"DIN: AMK-5,5-644-","s":"5,5 m³","img":"/assets/pv-skips-muldy-89-din-amk-5-5-644.jpg"},{"n":"DIN: AMK-7,0-534-","s":"7,0 m³","img":"/assets/pv-skips-muldy-90-din-amk-7-0-534.jpg"},{"n":"DIN: DMC-10,0-534-","s":"10,0 m³","img":"/assets/pv-skips-muldy-91-din-dmc-10-0-534.jpg"},{"n":"DIN: DMC-8,0-534-","s":"8,0 m³","img":"/assets/pv-skips-muldy-92-din-dmc-8-0-534.jpg"},{"n":"DIN: DMP-10,0-534-","s":"10,0 m³","img":"/assets/pv-skips-muldy-93-din-dmp-10-0-534.jpg"},{"n":"DIN: DMP-7,0-644-","s":"7,0 m³","img":"/assets/pv-skips-muldy-94-din-dmp-7-0-644.jpg"},{"n":"DIN: DMS-7,0-534-","s":"7,0 m³","img":"/assets/pv-skips-muldy-95-din-dms-7-0-534.jpg"},{"n":"DIN: DMS-7,0-644-","s":"7,0 m³","img":"/assets/pv-skips-muldy-96-din-dms-7-0-644.jpg"},{"n":"DIN: SMR-10,0-534-","s":"10,0 m³","img":"/assets/pv-skips-muldy-97-din-smr-10-0-534.jpg"},{"n":"DIN: SMR-10,0-644-","s":"10,0 m³","img":"/assets/pv-skips-muldy-98-din-smr-10-0-644.jpg"},{"n":"DIN: SMR-5,5-534-","s":"5,5 m³","img":"/assets/pv-skips-muldy-99-din-smr-5-5-534.jpg"},{"n":"DIN: SMR-5,5-644-","s":"5,5 m³","img":"/assets/pv-skips-muldy-100-din-smr-5-5-644.jpg"},{"n":"DIN: DMC-10,0-534 OB NOVÉ VÍKO","s":"10,0 m³","img":"/assets/pv-skips-muldy-101-din-dmc-10-0-534-ob-nove-viko.jpg"},{"n":"DIN: DMC-8,0-534 OB NOVÉ VÍKO","s":"8,0 m³","img":"/assets/pv-skips-muldy-102-din-dmc-8-0-534-ob-nove-viko.jpg"},{"n":"DIN: DMP-10,0-644","s":"10,0 m³","img":"/assets/pv-skips-muldy-103-din-dmp-10-0-644.jpg"},{"n":"DIN: DMP-5,5-534-","s":"5,5 m³","img":"/assets/pv-skips-muldy-104-din-dmp-5-5-534.jpg"},{"n":"DIN: DMP-7,0-534","s":"7,0 m³","img":"/assets/pv-skips-muldy-105-din-dmp-7-0-534.jpg"},{"n":"DIN: DMPM-10,0-534","s":"10,0 m³","img":"/assets/pv-skips-muldy-106-din-dmpm-10-0-534.jpg"},{"n":"DIN: DMPM-7,0-534","s":"7,0 m³","img":"/assets/pv-skips-muldy-107-din-dmpm-7-0-534.jpg"},{"n":"DIN: DMS-10,0-534","s":"10,0 m³","img":"/assets/pv-skips-muldy-108-din-dms-10-0-534.jpg"},{"n":"DIN: DMS-10,0-644","s":"10,0 m³","img":"/assets/pv-skips-muldy-109-din-dms-10-0-644.jpg"},{"n":"DIN: DMS-5,5-534","s":"5,5 m³","img":"/assets/pv-skips-muldy-110-din-dms-5-5-534.jpg"},{"n":"DIN: DMS-7,0-534","s":"7,0 m³","img":"/assets/pv-skips-muldy-111-din-dms-7-0-534.jpg"},{"n":"DIN: SMR-10,0-534","s":"10,0 m³","img":"/assets/pv-skips-muldy-112-din-smr-10-0-534.jpg"},{"n":"DIN: SMR-10,0-644","s":"10,0 m³","img":"/assets/pv-skips-muldy-113-din-smr-10-0-644.jpg"},{"n":"DIN: SMR-5,5-544","s":"5,5 m³","img":"/assets/pv-skips-muldy-114-din-smr-5-5-544.jpg"},{"n":"DIN: SMR-7,0-534","s":"7,0 m³","img":"/assets/pv-skips-muldy-115-din-smr-7-0-534.jpg"},{"n":"DIN: SMR-7,0-644","s":"7,0 m³","img":"/assets/pv-skips-muldy-116-din-smr-7-0-644.jpg"},{"n":"DMPM-DIN: DMPM-10,0-534","s":"10,0 m³","img":"/assets/pv-skips-muldy-117-dmpm-din-dmpm-10-0-534.jpg"},{"n":"DMPM-DIN: DMPM-7,0-534","s":"7,0 m³","img":"/assets/pv-skips-muldy-118-dmpm-din-dmpm-7-0-534.jpg"},{"n":"FR: AM-FR-10,0-434","s":"10,0 m³","img":"/assets/pv-skips-muldy-119-fr-am-fr-10-0-434.jpg"},{"n":"FR: AM-FR-10,0-444","s":"10,0 m³","img":"/assets/pv-skips-muldy-120-fr-am-fr-10-0-444.jpg"},{"n":"FR: AM-FR-8,0-434","s":"8,0 m³","img":"/assets/pv-skips-muldy-121-fr-am-fr-8-0-434.jpg"},{"n":"FR: AM-FR-8,0-444","s":"8,0 m³","img":"/assets/pv-skips-muldy-122-fr-am-fr-8-0-444.jpg"},{"n":"FR: SMR-FR-5,0-444","s":"5,0 m³","img":"/assets/pv-skips-muldy-123-fr-smr-fr-5-0-444.jpg"},{"n":"FR: AM-FR-10_OB","img":"/assets/pv-skips-muldy-124-fr-am-fr-10-ob.jpg"},{"n":"FR: AM-FR-8_OB","img":"/assets/pv-skips-muldy-125-fr-am-fr-8-ob.jpg"},{"n":"NL: AM-NLN-3-533","img":"/assets/pv-skips-muldy-126-nl-am-nln-3-533.jpg"},{"n":"NL: AM-NLN-6-553","img":"/assets/pv-skips-muldy-127-nl-am-nln-6-553.jpg"},{"n":"NL: AM-NLN-9-553","img":"/assets/pv-skips-muldy-128-nl-am-nln-9-553.jpg"},{"n":"NL: AM-NL-2,2-433","s":"2,2 m³","img":"/assets/pv-skips-muldy-129-nl-am-nl-2-2-433.jpg"},{"n":"NL: AM-NL-2,2_OB","img":"/assets/pv-skips-muldy-130-nl-am-nl-2-2-ob.jpg"},{"n":"NL: AM-NL-3,5 433","s":"3,5 m³","img":"/assets/pv-skips-muldy-131-nl-am-nl-3-5-433.jpg"},{"n":"NL: AM-NL-3,5_OB","img":"/assets/pv-skips-muldy-132-nl-am-nl-3-5-ob.jpg"},{"n":"NL: AM-NL-4_OB","img":"/assets/pv-skips-muldy-133-nl-am-nl-4-ob.jpg"},{"n":"NL: AM-NL-5_OB","img":"/assets/pv-skips-muldy-134-nl-am-nl-5-ob.jpg"},{"n":"NL: KM- KUKA MULDA 10CCM_OB","img":"/assets/pv-skips-muldy-135-nl-km-kuka-mulda-10ccm-ob.jpg"},{"n":"NL: KM-R-10,0-54332","s":"10,0 m³","img":"/assets/pv-skips-muldy-136-nl-km-r-10-0-54332.jpg"},{"n":"NL: KM-RA-10,0-54332","s":"10,0 m³","img":"/assets/pv-skips-muldy-137-nl-km-ra-10-0-54332.jpg"},{"n":"PREZERO: AM-PreZero-10,0-644","s":"10,0 m³","img":"/assets/pv-skips-muldy-138-prezero-am-prezero-10-0-644.jpg"},{"n":"PREZERO: AM-PreZero-5,5-644","s":"5,5 m³","img":"/assets/pv-skips-muldy-139-prezero-am-prezero-5-5-644.jpg"},{"n":"PREZERO: AM-PreZero-7,0-644","s":"7,0 m³","img":"/assets/pv-skips-muldy-140-prezero-am-prezero-7-0-644.jpg"},{"n":"PREZERO: AMK-PreZero-5,5-644","s":"5,5 m³","img":"/assets/pv-skips-muldy-141-prezero-amk-prezero-5-5-644.jpg"},{"n":"PREZERO: AMK-PreZero-7,0-644","s":"7,0 m³","img":"/assets/pv-skips-muldy-142-prezero-amk-prezero-7-0-644.jpg"},{"n":"PREZERO: DMS-PreZero-10,0-644","s":"10,0 m³","img":"/assets/pv-skips-muldy-143-prezero-dms-prezero-10-0-644.jpg"},{"n":"PREZERO: DMS-PreZero-5,5-644","s":"5,5 m³","img":"/assets/pv-skips-muldy-144-prezero-dms-prezero-5-5-644.jpg"},{"n":"PREZERO: DMS-PreZero-7,0-644","s":"7,0 m³","img":"/assets/pv-skips-muldy-145-prezero-dms-prezero-7-0-644.jpg"},{"n":"PREZERO: SMC-PreZero-7,0-644","s":"7,0 m³","img":"/assets/pv-skips-muldy-146-prezero-smc-prezero-7-0-644.jpg"},{"n":"PREZERO: 2.1-AM-NL-PreZero-10,0-544","s":"2,1 m³","img":"/assets/pv-skips-muldy-147-prezero-2-1-am-nl-prezero-10-0-544.jpg"},{"n":"PREZERO: 2.1-AM-NL-PreZero-6,0 544","s":"2,1 m³","img":"/assets/pv-skips-muldy-148-prezero-2-1-am-nl-prezero-6-0-544.jpg"}],"sld":[{"n":"Fotografie","img":"/assets/pv-sld-00-fotografie.jpg","g":["/assets/pv-sld-00-fotografie.jpg","/assets/pv-sld-00-fotografie-1.jpg","/assets/pv-sld-00-fotografie-2.jpg"]},{"n":"SLD-PM-2,5-00-00 KONTEJNER","s":"2,5 m³","img":"/assets/pv-sld-01-sld-pm-2-5-00-00-kontejner.jpg"},{"n":"SLD-PM-3,5-00-00 KONTEJNER","s":"3,5 m³","img":"/assets/pv-sld-02-sld-pm-3-5-00-00-kontejner.jpg"},{"n":"SLD-PM-3-00-00 KONTEJNER","img":"/assets/pv-sld-03-sld-pm-3-00-00-kontejner.jpg"},{"n":"SLD-PM-4-00-00 KONTEJNER","img":"/assets/pv-sld-04-sld-pm-4-00-00-kontejner.jpg"},{"n":"SLD-SM prehled typu","img":"/assets/pv-sld-05-sld-sm-prehled-typu.jpg"},{"n":"SLD-SM-2,5-00-00 KONTEJNER","s":"2,5 m³","img":"/assets/pv-sld-06-sld-sm-2-5-00-00-kontejner.jpg"},{"n":"SLD-SM-2-00-00 KONTEJNER","img":"/assets/pv-sld-07-sld-sm-2-00-00-kontejner.jpg"},{"n":"SLD-SM-3,5-00-00 KONTEJNER","s":"3,5 m³","img":"/assets/pv-sld-08-sld-sm-3-5-00-00-kontejner.jpg"},{"n":"SLD-SM-3-00-00 KONTEJNER","img":"/assets/pv-sld-09-sld-sm-3-00-00-kontejner.jpg"},{"n":"SLD-SM-4-00-00 KONTEJNER","img":"/assets/pv-sld-10-sld-sm-4-00-00-kontejner.jpg"},{"n":"SLD-SM-NOR-3,0","s":"3,0 m³","img":"/assets/pv-sld-11-sld-sm-nor-3-0.jpg"}],"su-kontejnery":[{"n":"SU-01.001-00 5,0-S-PA2040-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-00-su-01-001-00-5-0-s-pa2040-2h.jpg"},{"n":"SU-01.002-00 5,0-M-PA2050-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-01-su-01-002-00-5-0-m-pa2050-2h.jpg"},{"n":"SU-01.003-00 5,0-L-PA2060-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-02-su-01-003-00-5-0-l-pa2060-2h.jpg"},{"n":"SU-01.004-00 5,0-S-DR60-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-03-su-01-004-00-5-0-s-dr60-2h.jpg"},{"n":"SU-01.005-00 5,0-M-DR80-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-04-su-01-005-00-5-0-m-dr80-2h.jpg"},{"n":"SU-01.006-00 5,0-L-DR100-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-05-su-01-006-00-5-0-l-dr100-2h.jpg"},{"n":"SU-01.007-00 5,0-S-GL160-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-06-su-01-007-00-5-0-s-gl160-2h.jpg"},{"n":"SU-01.008-00 5,0-M-GL220-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-07-su-01-008-00-5-0-m-gl220-2h.jpg"},{"n":"SU-01.009-00 5,0-L-GL330-2H","s":"5,0 m³","img":"/assets/pv-su-kontejnery-08-su-01-009-00-5-0-l-gl330-2h.jpg"},{"n":"SU-01.010-00 3,0-S-PA2040-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-09-su-01-010-00-3-0-s-pa2040-2h.jpg"},{"n":"SU-01.011-00 3,0-M-PA2050-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-10-su-01-011-00-3-0-m-pa2050-2h.jpg"},{"n":"SU-01.012-00 3,0-L-PA2060-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-11-su-01-012-00-3-0-l-pa2060-2h.jpg"},{"n":"SU-01.013-00 3,0-S-DR60-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-12-su-01-013-00-3-0-s-dr60-2h.jpg"},{"n":"SU-01.014-00 3,0-M-DR80-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-13-su-01-014-00-3-0-m-dr80-2h.jpg"},{"n":"SU-01.015-00 3,0-L-DR100-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-14-su-01-015-00-3-0-l-dr100-2h.jpg"},{"n":"SU-01.016-00 3,0-S-GL160-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-15-su-01-016-00-3-0-s-gl160-2h.jpg"},{"n":"SU-01.017-00 3,0-M-GL220-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-16-su-01-017-00-3-0-m-gl220-2h.jpg"},{"n":"SU-01.018-00 3,0-L-GL330-2H","s":"3,0 m³","img":"/assets/pv-su-kontejnery-17-su-01-018-00-3-0-l-gl330-2h.jpg"}],"sum-pallets":[{"n":"217L","img":"/assets/pv-sum-pallets-00-217l.jpg"},{"n":"224L","img":"/assets/pv-sum-pallets-01-224l.jpg"},{"n":"420L","img":"/assets/pv-sum-pallets-02-420l.jpg"},{"n":"450L","img":"/assets/pv-sum-pallets-03-450l.jpg"},{"n":"858L","img":"/assets/pv-sum-pallets-04-858l.jpg"}],"usb-boxy":[{"n":"Fotografie","img":"/assets/pv-usb-boxy-00-fotografie.jpg","g":["/assets/pv-usb-boxy-00-fotografie.jpg","/assets/pv-usb-boxy-00-fotografie-1.jpg","/assets/pv-usb-boxy-00-fotografie-2.jpg","/assets/pv-usb-boxy-00-fotografie-3.jpg","/assets/pv-usb-boxy-00-fotografie-4.jpg"],"more":1},{"n":"USB 150 LTH","img":"/assets/pv-usb-boxy-01-usb-150-lth.jpg"},{"n":"USB 20.00 2400x1200x850-333","s":"2400×1200×850 mm","img":"/assets/pv-usb-boxy-02-usb-20-00-2400x1200x850-333.jpg"},{"n":"OBCHODNÍ VÝKRES","img":"/assets/pv-usb-boxy-03-obchodni-vykres.jpg"},{"n":"STOHOVÁNÍ","img":"/assets/pv-usb-boxy-04-stohovani.jpg"},{"n":"USB 0,5 - 1200x600x850","s":"1200×600×850 mm · 0,5 m³","img":"/assets/pv-usb-boxy-05-usb-0-5-1200x600x850.jpg"},{"n":"USB 1 - 1200x1200x850","s":"1200×1200×850 mm","img":"/assets/pv-usb-boxy-06-usb-1-1200x1200x850.jpg"},{"n":"USB 1,5 - 1200x1200x1200","s":"1200×1200×1200 mm · 1,5 m³","img":"/assets/pv-usb-boxy-07-usb-1-5-1200x1200x1200.jpg"},{"n":"USB 1-1200x1200x850-22","s":"1200×1200×850 mm","img":"/assets/pv-usb-boxy-08-usb-1-1200x1200x850-22.jpg"},{"n":"USB 2 - 1200x2400x850","s":"1200×2400×850 mm","img":"/assets/pv-usb-boxy-09-usb-2-1200x2400x850.jpg"},{"n":"USB-1200x800x600-1,5","s":"1200×800×600 mm · 1,5 m³","img":"/assets/pv-usb-boxy-10-usb-1200x800x600-1-5.jpg"}]};

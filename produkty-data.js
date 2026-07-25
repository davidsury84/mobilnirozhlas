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

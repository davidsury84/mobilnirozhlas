# Design Brief — Firemní intranet ELKOPLAST CZ

> Balíček pro AI/online design nástroj (v0, Lovable, Figma AI, UX/UI LLM…). Obsahuje účel aplikace,
> technická omezení, kompletní designový systém (CSS tokeny + 10 barevných motivů) a strukturu
> hlavních obrazovek. Cíl: navrhnout modernější, profesionálnější vzhled — smět přeuspořádat rozvržení,
> zjemnit typografii, komponenty a hierarchii. **Zachovat: češtinu, funkčnost sekcí, zelenou firemní barvu,
> přepínatelné motivy přes CSS proměnné, běh jako 1 HTML soubor bez build-kroku.**

## 1) Co to je
Interní firemní intranet výrobní firmy ELKOPLAST CZ (kovovýroba, plasty, odpadové hospodářství).
Slouží zaměstnancům (přihlášení firemním Google účtem @elkoplast.cz) i správcům (administrace).
Není to marketingový web — je to **pracovní portál / dashboard**.

Hlavní role a pohledy:
- **Zaměstnanec (intranet):** úvodní dashboard (uvítací banner + rychlé akce + „k vyřízení" + dlaždice),
  levý úzký ikonový sidebar (rozbalovací při najetí), sekce: Směrnice (k seznámení a potvrzení),
  Knihovna dokumentů, Úkoly ze směrnic, BOZP termíny, Školení s testy, Dovolená (žádosti+konto),
  Průzkumy (Grit/spokojenost/pozornost), + provozní moduly dle přístupu (Kovo, E-shop, Doprava,
  Sklady, Kalkulačky, Hlídač sortimentu…).
- **Správce (administrace):** horní vodorovná navigace (záložky): Směrnice, Knihovna, Zaměstnanci,
  Uchazeči, Přístupy, Organizační struktura, Adaptace, Statistiky, Průzkumy, Cenový monitoring,
  Aktivita, Nastavení. Obsah v kartách, tabulkách, modálních oknech.

## 2) Technická omezení (DŮLEŽITÉ pro návrh)
- **Jeden statický HTML soubor**, vanilla JS (žádný React/Vue/build). CSS je inline v `<style>`.
- Bez externích CSS/JS knihoven kromě volitelných CDN (SheetJS pro export). Fonty: IBM Plex Sans/Serif/Mono.
- **Motivy = CSS proměnné** na :root (10 variant vč. 2 tmavých). „Chrome" (hlavička/patička/pozadí)
  používá povrchové tokeny (--paper/--ink/--line), aby se automaticky přizpsobil světlému i tmavému motivu.
- Vše musí zůstat plně responzivní (desktop i mobil), přístupné, česky.

## 3) Co chceme zlepšit (brief pro návrháře)
- Modernější, „appovější" a profesionálnější vzhled inspirovaný čistými intranetovými portály (styl SharePoint hub):
  výrazná uvítací hlavička, řada rychlých akcí (ikonové dlaždice), obsah v kartách, případně dvousloupcové rozvržení,
  panel novinek, widget nadcházejících termínů/kalendáře, jemné stíny a vzdušná hierarchie.
- Zpřehlednit husté administrační tabulky a rozsáhlé detaily (např. report psychotestu).
- Sjednotit komponenty (dlaždice, karty, pill/badge, tlačítka) do konzistentní sady.
- Zachovat rychlost a jednoduchost (žádné těžké animace).

---
## 4) DESIGNOVÝ SYSTÉM — kompletní CSS (tokeny + komponenty)
Následuje reálný `<style>` blok aplikace (barvy, typografie, hlavička, patička, dlaždice, karty,
sidebar, modály, tabulky, badge). Slouží jako výchozí stav k redesignu:

```css
:root{
  --bg:#eef1ec;
  --bg-2:#f7f9f5;
  --paper:#ffffff;
  --ink:#0f1512;
  --ink-soft:#5b635c;
  --line:#e3e7e0;
  --line-strong:#cdd3ca;
  --green:#0e8a43;
  --green-2:#12a350;
  --green-d:#0a6b34;
  --green-soft:#e6f6ec;
  --yellow:#ffd21a;
  --yellow-2:#ffc400;
  --yellow-soft:#fff6d2;
  --amber:#7a5c0e;
  --amber-soft:#fff6d2;
  --red:#c23636;
  --red-soft:#fbe9e7;
  --shadow:0 1px 2px rgba(15,21,18,.04), 0 10px 30px rgba(15,21,18,.07);
  --shadow-lg:0 12px 40px rgba(15,21,18,.14);
  --radius:14px;
  --radius-sm:10px;
  --grad-green:linear-gradient(135deg,#15ab57,#0a6b34);
  --grad-dark:linear-gradient(135deg,#11271c,#0b1411 60%,#0d1f17);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg-2);
  color:var(--ink);
  font-family:"IBM Plex Sans",system-ui,sans-serif;
  font-size:15px;
  line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
.mono{font-family:"IBM Plex Mono",monospace}
button{font-family:inherit;cursor:pointer}
input,select,textarea{font-family:inherit;font-size:14px}
a{color:var(--green-d);text-underline-offset:2px}
code{font-family:"IBM Plex Mono",monospace;background:var(--bg-2);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:.9em}

/* ---------- App shell ---------- */
header.appbar{
  position:sticky;top:0;z-index:30;
  background:var(--paper);color:var(--ink);
  border-bottom:1px solid var(--line);
  box-shadow:0 1px 0 var(--line), 0 6px 22px rgba(15,21,18,.05);
  -webkit-backdrop-filter:saturate(1.1);backdrop-filter:saturate(1.1);
}
.appbar-inner{max-width:1240px;margin:0 auto;padding:12px 24px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}
.brand .logo{
  width:40px;height:40px;border-radius:12px;background:var(--grad-green);
  display:grid;place-items:center;font-weight:800;color:#fff;font-size:21px;
  box-shadow:0 6px 16px rgba(10,107,52,.28);
}
.brand h1{font-size:17.5px;font-weight:700;margin:0;letter-spacing:-.02em;line-height:1.1}
.brand small{display:block;font-size:10.5px;color:var(--ink-soft);font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-top:3px}
nav.tabs{display:flex;gap:3px;margin-left:auto;flex-wrap:wrap;align-items:center}
nav.tabs button{
  background:transparent;border:1px solid transparent;color:var(--ink-soft);
  padding:8px 14px;border-radius:9px;font-weight:600;font-size:13.5px;transition:.16s;letter-spacing:-.01em;
}
nav.tabs button:hover{background:var(--bg-2);color:var(--ink)}
nav.tabs button.active{background:var(--green-soft);color:var(--green-d);box-shadow:none;font-weight:700}

main{max-width:1180px;margin:0 auto;padding:28px 22px 80px}
.view{display:none}
.view.active{display:block;animation:fade .28s ease}
@keyframes fade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}

/* ---------- Common bits ---------- */
.row{display:flex;gap:14px;flex-wrap:wrap}
.spread{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
.muted{color:var(--ink-soft)}
.view-head{margin:2px 0 22px}
.view-head h2{margin:0;font-size:26px;font-weight:700;letter-spacing:-.025em}
.view-head h2::after{content:"";display:block;width:46px;height:4px;border-radius:999px;background:linear-gradient(90deg,var(--green-2),var(--yellow));margin-top:9px}
.view-head p{margin:10px 0 0;color:var(--ink-soft);font-size:14px}

.btn{
  border:1px solid transparent;background:var(--grad-green);color:#fff;
  padding:10px 17px;border-radius:11px;font-weight:600;font-size:14px;transition:.18s;
  box-shadow:0 3px 12px rgba(10,107,52,.28);
}
.btn:hover{transform:translateY(-1px);box-shadow:0 7px 20px rgba(10,107,52,.36);filter:saturate(1.08)}
.btn:active{transform:translateY(0)}
.btn.ghost{background:var(--paper);color:var(--ink);border-color:var(--line-strong);box-shadow:0 1px 2px rgba(15,21,18,.05)}
.btn.ghost:hover{background:var(--bg-2);border-color:var(--green-2);color:var(--green-d)}
.btn.yellow{background:linear-gradient(150deg,var(--yellow),var(--yellow-2));color:#11271c;box-shadow:0 3px 12px rgba(255,196,0,.4)}
.btn.yellow:hover{box-shadow:0 7px 20px rgba(255,196,0,.5)}
.btn.sm{padding:7px 12px;font-size:13px;border-radius:9px}
.btn.danger{background:#fff;border-color:var(--red);color:var(--red);box-shadow:none}
.btn.danger:hover{background:var(--red-soft);transform:none;box-shadow:none}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;filter:none}

.card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);transition:.18s}
.card.pad{padding:20px 22px}

label.field{display:block;margin-bottom:14px}
label.field span{display:block;font-size:12px;font-weight:600;color:var(--ink-soft);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
input[type=text],input[type=email],input[type=password],select,textarea{
  width:100%;padding:10px 13px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--paper);color:var(--ink);transition:.15s;
}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--green-2);box-shadow:0 0 0 3px var(--green-soft)}
textarea{resize:vertical;min-height:90px}

.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.green{background:var(--green-soft);color:var(--green-d)}
.pill.amber{background:var(--yellow-soft);color:var(--amber);border:1px solid #f3e0a0}
.pill.gray{background:var(--bg-2);color:var(--ink-soft)}
.pill.red{background:#fbe9e7;color:#b3261e;border:1px solid #f3c1bb}
.pill.yellow{background:linear-gradient(150deg,var(--yellow),var(--yellow-2));color:#11271c}

.tag{display:inline-block;padding:3px 10px;border-radius:7px;font-size:12px;background:var(--green-soft);color:var(--green-d);font-weight:500;margin:2px 3px 2px 0}
.chk{display:flex;gap:12px;align-items:flex-start;cursor:pointer;user-select:none}
.chk input{width:20px;height:20px;margin-top:2px;accent-color:var(--green-2);flex:none}

table.grid{width:100%;border-collapse:collapse;font-size:14px}
table.grid th,table.grid td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
table.grid th{font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-soft);font-weight:600;background:var(--bg-2)}
table.grid tr:last-child td{border-bottom:none}
table.grid tbody tr:hover{background:var(--bg-2)}

.empty{text-align:center;padding:48px 20px;color:var(--ink-soft)}
.empty .big{font-size:34px;margin-bottom:8px}

/* ---------- Directive list cards ---------- */
.dir-card{padding:20px 22px;display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.dir-card:hover{box-shadow:var(--shadow-lg);transform:translateY(-2px);border-color:var(--line-strong)}
.dir-card + .dir-card{margin-top:14px}
.dir-main{flex:1;min-width:240px}
.dir-card h3{margin:0 0 4px;font-size:17px;font-weight:600}
.dir-meta{font-size:13px;color:var(--ink-soft);margin-bottom:10px}
.progress{height:9px;border-radius:999px;background:#e7eae4;overflow:hidden;max-width:340px}
.progress > i{display:block;height:100%;background:linear-gradient(90deg,var(--green-2),var(--green-d));transition:width .4s}
.dir-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

/* ---------- Document paper (styled directive) ---------- */
.doc-paper{
  background:#fff;border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:54px 60px;max-width:820px;margin:0 auto;
  font-family:"IBM Plex Serif",Georgia,serif;color:#26271f;line-height:1.65;
}
.doc-paper h1{font-family:"IBM Plex Sans";font-size:28px;font-weight:700;margin:.2em 0 .5em;letter-spacing:-.015em;color:var(--ink)}
.doc-paper h1::after{content:"";display:block;width:54px;height:4px;border-radius:999px;background:linear-gradient(90deg,var(--green-2),var(--yellow));margin-top:12px}
.doc-paper h2{font-family:"IBM Plex Sans";font-size:21px;font-weight:600;margin:1.4em 0 .4em;border-bottom:2px solid var(--green-soft);padding-bottom:5px}
.doc-paper h3{font-family:"IBM Plex Sans";font-size:17px;font-weight:600;margin:1.2em 0 .3em}
.doc-paper p{margin:.7em 0}
.doc-paper ul,.doc-paper ol{margin:.7em 0;padding-left:1.5em}
.doc-paper li{margin:.3em 0}
.doc-paper table{border-collapse:collapse;width:100%;margin:1em 0;font-family:"IBM Plex Sans";font-size:14px}
.doc-paper th,.doc-paper td{border:1px solid var(--line-strong);padding:8px 10px;text-align:left}
.doc-paper th{background:#faf9f6}
.doc-paper blockquote{border-left:3px solid var(--green-2);margin:1em 0;padding:.2em 1em;color:var(--ink-soft);font-style:italic}
.doc-paper img{max-width:100%;height:auto}
.doc-paper a{color:var(--green-2)}
@media print{
  header.appbar,nav,.no-print{display:none!important}
  body{background:#fff}
  .doc-paper{box-shadow:none;border:none;padding:0;max-width:none}
}

/* ---------- Stats ---------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,var(--green-2),var(--yellow))}
.kpi .v{font-family:"IBM Plex Mono";font-size:32px;font-weight:600;letter-spacing:-.02em;color:var(--green-d)}
.kpi .l{font-size:12px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
.matrix-wrap{overflow:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--paper);box-shadow:var(--shadow)}
table.matrix{border-collapse:separate;border-spacing:0;font-size:13px;min-width:100%}
table.matrix th,table.matrix td{padding:8px 10px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);white-space:nowrap}
table.matrix thead th{position:sticky;top:0;background:var(--bg-2);z-index:2;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-soft);vertical-align:bottom}
table.matrix th.who{position:sticky;left:0;background:var(--bg-2);z-index:3;text-align:left;min-width:200px}
table.matrix td.who{position:sticky;left:0;background:var(--paper);z-index:1;text-align:left;font-weight:500}
table.matrix tbody tr:hover td{background:#f6f8f6}
table.matrix tbody tr:hover td.who{background:#eef3ef}
.cell-ok{color:var(--green);font-weight:700;text-align:center}
.cell-no{color:var(--line-strong);text-align:center}
/* Přístupy: úzké sloupce se svislými popisky, skupinové hlavičky */
table.matrix th.mod{padding:10px 3px 6px;text-align:center;min-width:34px}
table.matrix th.mod .vlab{display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;font-size:11px;letter-spacing:.02em;max-height:120px;text-transform:none}
table.matrix th.mod .cnt{display:block;font-size:10px;color:var(--ink-soft);font-weight:400;margin-top:4px}
table.matrix tr.grp th{position:sticky;top:0;z-index:2;background:var(--green-soft);color:var(--green-2);font-size:10px;text-transform:uppercase;letter-spacing:.06em;text-align:center;padding:4px 6px;border-bottom:1px solid var(--line)}
table.matrix td.mod{text-align:center;padding:6px 3px}
table.matrix td.mod:hover{background:#eaf2ec}
table.matrix .grp-l{border-left:2px solid var(--line-strong)}
.cell-na{color:#cfcec6;text-align:center}

/* ---------- Organizační plátno (drag & drop) ---------- */
.org-seg{display:inline-flex;background:var(--bg-2);border:1px solid var(--line);border-radius:10px;padding:3px;margin-bottom:18px;gap:3px}
.org-seg button{border:none;background:none;padding:7px 18px;border-radius:8px;font:inherit;font-weight:600;font-size:14px;color:var(--ink-soft);cursor:pointer;transition:.12s}
.org-seg button.active{background:var(--paper);color:var(--ink);box-shadow:0 1px 2px rgba(15,21,18,.1)}
.org-zoom{display:inline-flex;align-items:center;gap:4px;margin-right:6px}
.org-zoom .btn{padding:6px 10px;font-weight:700}
.org-canvas{position:relative;overflow:auto;height:560px;border:1px solid var(--line);border-radius:12px;
  background:radial-gradient(circle,#dfe5dc 1px,transparent 1.4px) 0 0/24px 24px, var(--paper);
  touch-action:none;-webkit-user-select:none;user-select:none}
.org-viewport{position:relative}
.org-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--ink-soft);font-size:14px;padding:20px}
.org-inner{position:relative;min-width:100%;min-height:100%}
.org-node{position:absolute;width:198px;background:var(--paper);border:1px solid var(--line-strong);border-radius:11px;
  box-shadow:0 1px 3px rgba(15,21,18,.12);padding:9px 10px 11px;z-index:2;cursor:grab;transition:box-shadow .12s,border-color .12s}
.org-node.moving{cursor:grabbing;box-shadow:0 12px 30px rgba(8,18,12,.22);z-index:5}
.org-node .obx-grip{height:13px;margin:-2px 0 3px;text-align:center;color:var(--line-strong);font-size:12px;letter-spacing:3px;cursor:grab;line-height:12px;user-select:none}
.org-node.ved{border-color:var(--green-2);box-shadow:0 0 0 2px var(--green-soft),0 1px 3px rgba(15,21,18,.10)}
.org-node.drop{border-color:var(--green);box-shadow:0 0 0 3px var(--green-soft)}
.org-node .obx-title{width:100%;border:1px solid transparent;background:transparent;font-family:inherit;font-weight:700;font-size:13.5px;color:var(--ink);padding:4px 5px;border-radius:6px}
.org-node .obx-title::placeholder{color:var(--ink-soft);font-weight:500}
.org-node .obx-title:focus{border-color:var(--line-strong);background:#fff;outline:none;cursor:text}
.org-node .obx-positions{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.org-node .obx-positions:empty{margin-top:0}
.org-node .obx-pos{display:flex;align-items:center;gap:3px}
.org-node .obx-pos input{flex:1;min-width:0;border:1px solid var(--line);background:#fff;border-radius:6px;padding:3px 6px;font-size:12px;font-family:inherit;color:var(--ink)}
.org-node .obx-pos input:focus{border-color:var(--green-2);outline:none}
.org-node .obx-pos-del{border:none;background:none;color:#b3261e;cursor:pointer;font-size:14px;font-weight:700;line-height:1;padding:0 3px}
.org-node .obx-addpos{width:100%;margin-top:6px;border:1px dashed var(--line-strong);background:#fff;color:var(--green-d);border-radius:7px;padding:4px 8px;font-size:12px;font-weight:600;cursor:pointer}
.org-node .obx-addpos:hover{border-color:var(--green);background:var(--green-soft)}
.org-node .obx-foot{display:flex;align-items:center;justify-content:flex-start;margin-top:8px;padding:0 3px}
.org-node .obx-ved{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-soft);cursor:pointer;user-select:none}
.org-node .obx-ved input{width:15px;height:15px;accent-color:var(--green-2);cursor:pointer}
.org-node .rm{position:absolute;top:-9px;left:-8px;width:19px;height:19px;line-height:17px;text-align:center;border-radius:999px;background:var(--paper);border:1px solid var(--line-strong);color:#b3261e;cursor:pointer;font-size:13px;font-weight:700;display:none;z-index:6}
.org-node:hover .rm{display:block}
.org-node .obx-handle{position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);width:15px;height:15px;border-radius:999px;background:var(--green-2);border:2px solid var(--paper);cursor:crosshair;z-index:4;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.org-node .obx-handle:hover{background:var(--green);transform:translateX(-50%) scale(1.15)}
.org-ghost{position:fixed;z-index:9999;pointer-events:none;opacity:.92;box-shadow:0 12px 30px rgba(8,18,12,.3)}
svg.org-lines{position:absolute;top:0;left:0;overflow:visible;z-index:1;pointer-events:none}

/* ---------- Modal ---------- */
.overlay{position:fixed;inset:0;background:rgba(28,29,26,.45);display:none;z-index:60;padding:24px;overflow:auto}
.overlay.show{display:flex;align-items:flex-start;justify-content:center}
.modal{background:var(--paper);border-radius:18px;max-width:640px;width:100%;margin:auto;box-shadow:0 30px 70px rgba(8,18,12,.4);animation:pop .2s ease;overflow:hidden}
@keyframes pop{from{opacity:0;transform:scale(.97) translateY(6px)}to{opacity:1;transform:none}}
.modal-head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;background:linear-gradient(180deg,var(--bg-2),var(--paper))}
.modal-head h3{margin:0;font-size:18px}
.modal-body{padding:22px}
.modal-foot{padding:16px 22px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:10px;background:var(--bg-2)}
.x{background:none;border:none;font-size:22px;color:var(--ink-soft);line-height:1;padding:2px 6px}

/* ---------- Reading mode ---------- */
.read-shell{max-width:880px;margin:0 auto}
.read-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:20px}
.ack-box{
  max-width:820px;margin:26px auto 0;background:linear-gradient(180deg,var(--green-soft),#fff 70%);border:2px solid var(--green-2);
  border-radius:var(--radius);padding:24px 28px;box-shadow:var(--shadow);
}
.ack-box.done{border-color:var(--green);background:var(--green-soft)}
.ack-check{display:flex;gap:12px;align-items:flex-start;cursor:pointer;user-select:none}
.ack-check input{width:20px;height:20px;margin-top:2px;accent-color:var(--green-2);flex:none}
.ack-check span{font-size:15px}
.toast{
  position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);
  background:var(--grad-dark);color:#fff;padding:13px 22px;border-radius:12px;font-weight:500;
  opacity:0;transition:.3s;z-index:80;box-shadow:0 10px 34px rgba(8,18,12,.4);border:1px solid rgba(255,210,26,.25);
}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---------- Přepínač barevného motivu ---------- */
#themeBtn{position:fixed;right:20px;bottom:20px;z-index:95;width:52px;height:52px;border-radius:50%;border:2px solid var(--yellow);background:var(--grad-green);box-shadow:0 8px 24px rgba(10,107,52,.4);display:grid;place-items:center;cursor:pointer;color:#fff;transition:.15s}
#themeBtn:hover{transform:translateY(-2px) scale(1.05)}
#themeBtn svg{width:22px;height:22px}
#themePop{position:fixed;right:18px;bottom:74px;z-index:90;background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-lg);padding:14px;display:none;width:214px}
#themePop.show{display:block}
#themePop h4{margin:0 0 11px;font-size:13px;font-weight:600}
.thm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.thm-sw{height:44px;border-radius:11px;cursor:pointer;border:2px solid transparent;position:relative;box-shadow:0 2px 6px rgba(15,21,18,.12)}
.thm-sw.active{border-color:var(--ink)}
.thm-sw .dot{position:absolute;right:5px;top:5px;width:11px;height:11px;border-radius:50%;background:var(--yellow);box-shadow:0 0 0 2px rgba(255,255,255,.7)}
.thm-name{font-size:10px;color:var(--ink-soft);text-align:center;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media print{#themeBtn,#themePop{display:none!important}}

.hint{background:var(--yellow-soft);border:1px solid #f1dda0;border-left:4px solid var(--yellow);border-radius:10px;padding:12px 15px;font-size:13px;color:var(--amber);margin-bottom:16px}
.divider{height:1px;background:var(--line);margin:22px 0}
.inline-actions{display:flex;gap:8px;flex-wrap:wrap}
.chip-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cat-chip{display:inline-flex;align-items:center;gap:6px;background:var(--green-soft);color:var(--green-d);border-radius:8px;padding:5px 9px;font-size:13px;font-weight:500}
.cat-chip button{background:none;border:none;color:var(--green-d);font-size:15px;line-height:1;padding:0 2px}
.cat-chip button:hover{color:var(--red)}

/* ---------- Intranet zaměstnanců (#muj) ---------- */
.mj-shell{display:flex;max-width:1320px;margin:0 auto;align-items:flex-start;gap:6px}
.mj-side{width:64px;flex:none;padding:16px 8px;position:sticky;top:69px;align-self:flex-start;z-index:25}
.mj-main{flex:1;min-width:0;padding:26px 26px 80px;max-width:1120px}
.mj-main.mj-full{max-width:none;padding:0}
.mj-nav{display:flex;flex-direction:column;gap:3px;border:1px solid transparent;border-radius:14px;transition:box-shadow .16s}
.mj-side:hover .mj-nav{position:absolute;top:0;left:0;width:236px;background:var(--paper);border-color:var(--line);box-shadow:var(--shadow-lg);padding:10px;z-index:40;max-height:calc(100vh - 84px);overflow-y:auto;overscroll-behavior:contain}
.mj-grp{display:none;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-soft);margin:14px 10px 6px}
.mj-side:hover .mj-grp{display:block}
.mj-side:hover .mj-grp:first-child{margin-top:2px}
.mj-link{position:relative;display:flex;align-items:center;gap:11px;padding:10px 11px;border-radius:11px;color:var(--ink);font-weight:500;font-size:14px;cursor:pointer;transition:.15s;border:1px solid transparent;text-align:left;width:100%;background:transparent;font-family:inherit;justify-content:center}
.mj-side:hover .mj-link{justify-content:flex-start}
.mj-link svg{width:21px;height:21px;color:var(--ink-soft);flex:none}
.mj-link:hover{background:var(--bg-2)}
.mj-link.active{background:var(--green-soft);color:var(--green-d);border-color:#cfe9d8}
.mj-link.active svg{color:var(--green-2)}
.mj-link.soon{color:var(--ink-soft);cursor:default}
.mj-link.soon:hover{background:transparent}
.mj-link.has-todo::after{content:"";position:absolute;top:7px;right:9px;width:8px;height:8px;border-radius:50%;background:var(--yellow-2);box-shadow:0 0 0 2px var(--bg)}
.mj-side:hover .mj-link.has-todo::after{display:none}
.mj-link .lbl{display:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mj-side:hover .mj-link .lbl{display:block}
.mj-link .mj-badge{display:none;flex:none;min-width:20px;height:20px;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;align-items:center;justify-content:center;background:linear-gradient(150deg,var(--yellow),var(--yellow-2));color:#11271c}
.mj-side:hover .mj-link .mj-badge{display:inline-flex}
.mj-link .mj-soon{display:none;flex:none;font-size:10px;font-weight:600;letter-spacing:.03em;color:var(--line-strong);text-transform:uppercase}
.mj-side:hover .mj-link .mj-soon{display:inline}
@media(max-width:820px){
  .mj-shell{flex-direction:column;gap:0}
  .mj-side{width:100%;position:static;padding:12px 14px 0}
  .mj-nav{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:6px;padding-bottom:6px}
  .mj-side:hover .mj-nav{position:static;width:auto;background:transparent;border:none;box-shadow:none;padding:0}
  .mj-grp{display:none!important}
  .mj-link{justify-content:flex-start;width:auto;white-space:nowrap}
  .mj-link .lbl{display:inline!important;overflow:visible}
  .mj-link.has-todo::after{display:none}
  .mj-link .mj-soon{display:inline}
  .mj-main{padding:18px 16px 70px;max-width:none}
  .mj-main.mj-full{padding:0}
}
.dash-hero{margin:6px 0 24px}
.dash-hero h2{margin:0;font-size:27px;font-weight:700;letter-spacing:-.025em}
.dash-hero p{margin:8px 0 0;color:var(--ink-soft);font-size:14px}
/* Uvítací banner (moderní intranetový portál) */
.mj-hero{position:relative;overflow:hidden;border-radius:20px;padding:30px 32px;color:#fff;background:var(--grad-green);box-shadow:0 14px 40px rgba(10,107,52,.22);margin:2px 0 26px}
.mj-hero::after{content:"";position:absolute;right:-50px;top:-70px;width:280px;height:280px;border-radius:50%;background:rgba(255,255,255,.09)}
.mj-hero::before{content:"";position:absolute;right:90px;bottom:-110px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.055)}
.mj-hero>*{position:relative;z-index:1}
.mj-hero .date{font-size:12px;text-transform:uppercase;letter-spacing:.09em;opacity:.85;font-weight:600;margin-bottom:7px}
.mj-hero h2{margin:0;font-size:27px;font-weight:800;letter-spacing:-.025em;color:#fff}
.mj-hero p{margin:9px 0 0;font-size:14.5px;opacity:.96;max-width:580px;line-height:1.5}
.mj-hero .stats{display:flex;gap:14px;margin-top:20px;flex-wrap:wrap}
.mj-hero .stat{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:10px 16px;min-width:96px;backdrop-filter:blur(2px)}
.mj-hero .stat b{display:block;font-size:23px;font-weight:800;line-height:1.05}
.mj-hero .stat span{font-size:11.5px;opacity:.9;letter-spacing:.02em}
/* Řada rychlých akcí (ploché barevné dlaždice jako moderní intranet) */
.mj-quick{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:12px}
.mj-quick button{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;background:var(--grad-green);color:#fff;border-radius:15px;padding:17px 8px;font-size:12.5px;font-weight:600;text-align:center;line-height:1.2;box-shadow:0 7px 18px rgba(10,107,52,.18);transition:.16s;min-height:96px;border:none;cursor:pointer;font-family:inherit}
.mj-quick button:hover{transform:translateY(-3px);box-shadow:0 13px 28px rgba(10,107,52,.3)}
.mj-quick button svg{width:26px;height:26px;stroke:#fff;stroke-width:1.9;fill:none}
.mj-quick .qbadge{position:absolute;top:7px;right:9px}
.dash-sec{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-soft);margin:26px 0 12px}
.dash-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:16px}
.tile{position:relative;display:flex;flex-direction:column;gap:11px;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:20px 20px 18px;box-shadow:var(--shadow);transition:.18s;cursor:pointer;min-height:158px;text-align:left;font:inherit;color:inherit}
.tile:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg);border-color:var(--line-strong)}
.tile.soon{cursor:default}
.tile.soon:hover{transform:none;box-shadow:var(--shadow);border-color:var(--line)}
.tile-ic{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;background:var(--green-soft);color:var(--green-d)}
.tile-ic svg{width:24px;height:24px}
.tile.accent .tile-ic{background:linear-gradient(150deg,var(--yellow),var(--yellow-2));color:#11271c}
.tile h3{margin:0;font-size:16px;font-weight:600}
.tile p{margin:0;font-size:13px;color:var(--ink-soft);line-height:1.45}
.tile-foot{margin-top:auto;padding-top:4px}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:4px 11px;border-radius:999px}
.badge.todo{background:linear-gradient(150deg,var(--yellow),var(--yellow-2));color:#11271c}
.badge.ok{background:var(--green-soft);color:var(--green-d)}
.badge.soon{background:#eceeea;color:var(--ink-soft)}
.crumb{display:flex;align-items:center;gap:9px;margin:2px 0 20px;font-size:14px;flex-wrap:wrap}
.crumb a{cursor:pointer;color:var(--green-d);font-weight:500}
.crumb a:hover{text-decoration:underline}
.crumb .sep{color:var(--line-strong)}
.crumb .cur{color:var(--ink-soft)}
.li-item{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:15px 18px;box-shadow:var(--shadow);transition:.15s}
.li-item:hover{border-color:var(--line-strong);box-shadow:var(--shadow-lg)}
.li-item.clickable{cursor:pointer}
.li-item.clickable:hover{transform:translateY(-1px)}
.li-item + .li-item{margin-top:10px}
.li-item .li-t{font-weight:600;font-size:15px}
.li-left{display:flex;align-items:center;gap:14px;min-width:0}
.li-ic{width:42px;height:42px;border-radius:12px;background:var(--green-soft);color:var(--green-d);display:grid;place-items:center;flex:none}
.li-ic svg{width:22px;height:22px}
.li-ic.folder{background:linear-gradient(150deg,var(--yellow),var(--yellow-2));color:#11271c}
.li-chev{color:var(--line-strong);flex:none}
.li-chev svg{width:20px;height:20px}
.read-shell-mj{max-width:880px;margin:0 auto}
.ack-card{margin-top:20px;background:linear-gradient(180deg,var(--green-soft),#fff 75%);border:2px solid var(--green-2);border-radius:var(--radius);padding:22px 24px;box-shadow:var(--shadow)}
.ack-card.done{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--green-soft)}
.ack-card .chk span{font-size:15px;line-height:1.55}
.ack-card .cf-wrap{margin-top:16px}
.ec{width:100%;border:1px solid var(--line);background:var(--paper);padding:6px 8px;border-radius:7px;font:inherit;color:var(--ink);transition:border-color .12s,box-shadow .12s}
.ec:hover{border-color:var(--line-strong)}
.ec:focus{outline:none;border-color:var(--green-2);box-shadow:0 0 0 2px var(--green-soft)}
.ec.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:13px}
#employeeTable td{padding:6px 8px;vertical-align:middle}
.app-foot{border-top:1px solid var(--line);background:var(--paper);margin-top:48px;padding:20px 24px;color:var(--ink-soft);font-size:12px;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
.app-foot .fmark{width:20px;height:20px;border-radius:6px;background:var(--grad-green);display:inline-grid;place-items:center;color:#fff;font-size:12px;font-weight:800;flex:none}
.app-foot b{color:var(--ink);font-weight:600}
```

---
## 5) BAREVNÉ MOTIVY (10 variant, přepínají CSS proměnné)
Objekt `THEMES` v JS — každý motiv přemapuje tokeny. Chrome se řídí --paper/--ink/--line, akcent --green/--grad-green.

```js
const THEMES = {
  zelena:  { label:"Zelená",   "--green":"#0e8a43","--green-2":"#12a350","--green-d":"#0a6b34","--green-soft":"#dcf0e3","--grad-green":"linear-gradient(135deg,#15ab57,#0a6b34)","--grad-dark":"linear-gradient(135deg,#11271c,#0b1411 60%,#0d1f17)","--bg":"#e2eee5","--bg-2":"#eef6f0","--paper":"#ffffff","--line":"#d3e3d8","--line-strong":"#b6d0bf" },
  modra:   { label:"Modrá",    "--green":"#1763c7","--green-2":"#2f86e8","--green-d":"#114e9e","--green-soft":"#d7e6f8","--grad-green":"linear-gradient(135deg,#2f86e8,#114e9e)","--grad-dark":"linear-gradient(135deg,#0f2034,#0a1421 60%,#0d1c2e)","--bg":"#dde9f7","--bg-2":"#ebf3fc","--paper":"#ffffff","--line":"#cadcf1","--line-strong":"#aac6e6" },
  fialova: { label:"Fialová",  "--green":"#6d3fb0","--green-2":"#824fc8","--green-d":"#512a89","--green-soft":"#e7d9f8","--grad-green":"linear-gradient(135deg,#824fc8,#512a89)","--grad-dark":"linear-gradient(135deg,#1f1430,#130b1f 60%,#1a0f2b)","--bg":"#e8dcf6","--bg-2":"#f2eafb","--paper":"#ffffff","--line":"#ddccf3","--line-strong":"#c6abeb" },
  tyrkys:  { label:"Tyrkysová","--green":"#0d9488","--green-2":"#14b8a6","--green-d":"#0a6e66","--green-soft":"#d2efe9","--grad-green":"linear-gradient(135deg,#14b8a6,#0a6e66)","--grad-dark":"linear-gradient(135deg,#0f2724,#0a1715 60%,#0d201d)","--bg":"#d8efea","--bg-2":"#e9f7f4","--paper":"#ffffff","--line":"#c6e7e0","--line-strong":"#a6d8cf" },
  oranzova:{ label:"Oranžová", "--green":"#d9701a","--green-2":"#ef8a22","--green-d":"#aa540f","--green-soft":"#fce3cf","--grad-green":"linear-gradient(135deg,#ef8a22,#aa540f)","--grad-dark":"linear-gradient(135deg,#2a1a0f,#160d07 60%,#22140b)","--bg":"#fbe7d4","--bg-2":"#fdf1e6","--paper":"#ffffff","--line":"#f2d8bf","--line-strong":"#e8bf98" },
  grafit:  { label:"Grafit",   "--green":"#3a4250","--green-2":"#4a5464","--green-d":"#272d38","--green-soft":"#dfe3ea","--grad-green":"linear-gradient(135deg,#4a5464,#272d38)","--grad-dark":"linear-gradient(135deg,#1a1d22,#0e1013 60%,#16191e)","--bg":"#e2e6ed","--bg-2":"#eef0f4","--paper":"#ffffff","--line":"#d4d9e2","--line-strong":"#bbc2ce" },
  tmava:   { label:"Tmavá",    "--green":"#16a34a","--green-2":"#22c55e","--green-d":"#5ee08a","--green-soft":"#15331f","--grad-green":"linear-gradient(135deg,#22c55e,#15803d)","--grad-dark":"linear-gradient(135deg,#0d1411,#080c0a 60%,#0b120e)","--bg":"#0f1512","--bg-2":"#171e19","--paper":"#1a221d","--ink":"#e9efe9","--ink-soft":"#97a59c","--line":"#29332c","--line-strong":"#3a463e","--amber":"#f0c45a","--yellow-soft":"#3a3416" },
  antracit:{ label:"Antracit", "--green":"#4f86f7","--green-2":"#7aa2ff","--green-d":"#9bb8ff","--green-soft":"#16335e","--grad-green":"linear-gradient(135deg,#4f86f7,#2b5fd0)","--grad-dark":"linear-gradient(135deg,#141a28,#0e1320 60%,#1a2236)","--bg":"#0f1420","--bg-2":"#1e2636","--paper":"#171d2b","--ink":"#e6ebf5","--ink-soft":"#8e9bb3","--line":"#2a3447","--line-strong":"#3a4660","--amber":"#ffce6e","--yellow-soft":"#2e2a14" },
  google:  { label:"Google",   "--green":"#1a73e8","--green-2":"#4285f4","--green-d":"#1558b3","--green-soft":"#e8f0fe","--grad-green":"linear-gradient(135deg,#4285f4,#1a67d8)","--grad-dark":"linear-gradient(135deg,#202124,#17181a 60%,#1c1d1f)","--bg":"#f5f8fd","--bg-2":"#f1f3f4","--paper":"#ffffff","--line":"#e6e9ee","--line-strong":"#dadce0" }
```

---
## 6) STRUKTURA HLAVNÍCH OBRAZOVEK (zjednodušené HTML)

### 6a) Hlavička (sdílená admin i intranet) — bílá ve světlých motivech
```html
<header class="appbar">
  <div class="appbar-inner">
    <div class="brand">
      <div class="logo">✓</div>
      <div><h1>Intranet ELKOPLAST CZ</h1><small>Intranet pro zaměstnance</small></div>
    </div>
    <nav class="tabs"><!-- admin: záložky sekcí; intranet: Správa / Odhlásit --></nav>
  </div>
</header>
```

### 6b) Zaměstnanecký layout (úzký ikonový sidebar + obsah)
```html
<div class="mj-shell">
  <aside class="mj-side"><!-- ikony sekcí, rozbalí se popisky při hoveru --></aside>
  <main class="mj-main"><div id="mujBody"><!-- obsah dané sekce --></div></main>
</div>
```

### 6c) Úvodní dashboard zaměstnance (nově ve stylu moderního intranetu)
```html
<!-- 1) Uvítací banner (branded gradient) -->
<div class="mj-hero">
  <div class="date">pátek 10. července 2026</div>
  <h2>Dobrý den, Marie 👋</h2>
  <p>Čeká na vás 2 položky k vyřízení. Vše zvládnete přímo odsud.</p>
  <div class="stats">
    <div class="stat"><b>2</b><span>k vyřízení</span></div>
    <div class="stat"><b>3</b><span>dostupné moduly</span></div>
  </div>
</div>

<!-- 2) Řada rychlých akcí (ploché zelené ikonové dlaždice) -->
<div class="mj-quick">
  <button><svg>…</svg><span class="lbl">Směrnice</span></button>
  <!-- Úkoly, Knihovna, BOZP, Školení, Dovolená, Průzkumy… -->
</div>

<!-- 3) K vyřízení (řádkové karty) -->
<div class="dash-sec">K vyřízení</div>
<div class="li-item"><div class="li-left"><div class="li-ic">ikona</div>
  <div><div class="li-t">Testovací směrnice A</div><div class="muted">Směrnice</div></div></div>
  <a class="btn sm">Přečíst a potvrdit</a></div>

<!-- 4) Rychlý přístup / Provozy (dlaždice .tile v .dash-grid) -->
<div class="dash-sec">Rychlý přístup</div>
<div class="dash-grid">
  <div class="tile"><div class="tile-ic">ikona</div><div><h3>Směrnice</h3><p>popis</p></div>
    <div class="tile-foot"><span class="badge todo">2 k potvrzení</span></div></div>
</div>
```

### 6d) Administrace — karta + tabulka + modal
```html
<section class="view">
  <div class="view-head"><h2>Sekce</h2><p>popisek</p></div>
  <div class="card pad"><!-- obsah, formuláře, tabulky .tbl / .grid / .matrix --></div>
</section>
<!-- Modal: .overlay > .modal > .modal-head / .modal-body / .modal-foot -->
```

### 6e) Patička (bílá, s brand značkou)
```html
<footer class="app-foot"><span class="fmark">✓</span>
  <span>Intranet ELKOPLAST CZ · verze abc123 · aktualizováno 10. 7. 2026</span></footer>
```

---
## 7) Komponenty k dispozici (názvosloví tříd)
- **Layout:** `.appbar`/`.appbar-inner`/`.brand`, `.mj-shell`/`.mj-side`/`.mj-main`, `.app-foot`, `main`, `.view`, `.view-head`.
- **Hero/akce:** `.mj-hero` (+`.date`/`.stats`/`.stat`), `.mj-quick button` (ploché barevné dlaždice).
- **Karty/dlaždice:** `.card`(+`.pad`), `.tile`(+`.tile-ic`/`.tile-foot`/`.accent`), `.dash-grid`, `.dash-sec`, `.dash-hero`.
- **Seznamy:** `.li-item`/`.li-left`/`.li-ic`/`.li-t`.
- **Tabulky:** `.tbl`, `.grid`, `.matrix`(+ sticky hlavičky), `.matrix-wrap`.
- **Prvky:** `.btn`(+`.ghost`/`.sm`/`.danger`), `.pill`(+`.green`/`.amber`/`.red`/`.gray`), `.badge`(+`.todo`/`.ok`/`.soon`), `.field`, `.ec` (inputy), `.muted`, `.mono`.
- **Modal:** `.overlay`/`.modal`/`.modal-head`/`.modal-body`/`.modal-foot`.

## 8) Zadání pro nástroj
„Navrhni modernější, profesionální vzhled tohoto firemního intranetu (pracovní portál, ne marketing).
Zachovej češtinu, zelenou firemní identitu, přepínatelné motivy přes CSS proměnné a běh jako jeden HTML soubor
bez build-kroku (vanilla, inline CSS). Zaměř se na: čistou vzdušnou hierarchii, výrazný uvítací banner,
konzistentní ikonové dlaždice rychlých akcí, přehledné karty a tabulky, jemné stíny, dvousloupcové rozvržení
úvodní stránky (obsah + pravý widget: nadcházející termíny/novinky). Vrať CSS proměnné + komponentní CSS
a příklady HTML struktur odpovídající výše uvedenému názvosloví tříd, ať jdou přímo nasadit."

/* ============================================================
   Seznámení se směrnicemi – ONLINE server (bez závislostí)
   ------------------------------------------------------------
   Spuštění:   node server.js
   Proměnné prostředí (volitelné):
     PORT            port (výchozí 8080)
     ADMIN_PASSWORD  heslo do správy (jinak se vygeneruje a vypíše)
     PUBLIC_URL      veřejná adresa, např. https://intranet.elkoplast.cz
     DATA_DIR        kam ukládat data (výchozí ./data)
     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  – přihlášení zaměstnanců přes Google (intranet)
     ALLOWED_HD      omezení SSO na firemní doménu, např. elkoplast.cz
     REPORT_EMAIL    příjemce měsíčního vyhodnocení (výchozí tomas.krajca@elkoplast.cz)
     REPORT_DAY      den v měsíci pro odeslání (1–28, výchozí 1)
     REPORT_ENABLED  0 = vypnout měsíční vyhodnocení (výchozí zapnuto)
   ============================================================ */
const http   = require('http');
const https  = require('https');
const net    = require('net');
const tls    = require('tls');
const fs     = require('fs');
const path   = require('path');
const url     = require('url');
const os     = require('os');
const crypto = require('crypto');
const produktyFotky = require('./produkty-fotky'); // fotky produktů z Disku (widget „Fotka týdne")

/* ---------- volitelný .env (bez závislostí) ---------- */
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t[0] === '#') continue;
      const i = t.indexOf('='); if (i < 0) continue;
      const k = t.slice(0, i).trim(); let v = t.slice(i + 1).trim();
      if (v.length > 1 && ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'"))) v = v.slice(1, -1);
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch (_) {}
})();

const ROOT     = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const APP_FILE = path.join(ROOT, 'seznameni-se-smernicemi.html');
// Verze běžící instance (pro patičku) — commit z Railway + čas buildu (mtime hlavního souboru)
const GIT_COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || process.env.GIT_COMMIT || '').slice(0, 7);
// Čas nasazení: primárně z .build-time (otiskne Dockerfile při buildu); fallback mtime souboru.
let BUILD_TIME;
try { BUILD_TIME = Number(require('fs').readFileSync(path.join(ROOT, '.build-time'), 'utf8').trim()) || 0; } catch (_) { BUILD_TIME = 0; }
if (!BUILD_TIME) { try { BUILD_TIME = require('fs').statSync(APP_FILE).mtimeMs; } catch (_) { BUILD_TIME = Date.now(); } }
function injectVersion(html) { return html.replace('<!--VERSION-->', '<script>window.__VER__=' + JSON.stringify({ commit: GIT_COMMIT, built: BUILD_TIME }) + ';<\/script>'); }
// Lišta „Zobrazit jako…": při náhledu žlutý pruh s tlačítkem Ukončit, jinak pro skutečného admina plovoucí spouštěč.
function injectViewAsUI(html, req) {
  let bar = '';
  if (viewAsActive(req)) {
    const e = empSession(req) || {};
    bar = '<div id="__va" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#b06f00;color:#fff;font:600 13px/1.4 Segoe UI,Arial;padding:9px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 -2px 10px rgba(0,0,0,.25)">'
      + '<span style="font-size:16px">👁️</span><span>Prohlížíte aplikaci jako <b>' + esc(e.name || e.email) + '</b> <span style="opacity:.85">(' + esc(e.email) + ')</span></span>'
      + '<a href="/view-as" style="color:#fff;margin-left:auto">Změnit</a>'
      + '<button onclick="fetch(\'/api/view-as/stop\',{method:\'POST\'}).then(function(){location.href=\'/\'})" style="background:#fff;color:#8a5600;border:0;border-radius:8px;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer">Ukončit náhled</button></div>';
  } else if (isRealAdmin(req)) {
    bar = '<a id="__valaunch" href="/view-as" title="Zobrazit aplikaci jako konkrétní zaměstnanec" style="position:fixed;left:16px;bottom:16px;z-index:2147483000;background:#0e8a43;color:#fff;font:700 13px Segoe UI,Arial;padding:9px 13px;border-radius:22px;text-decoration:none;box-shadow:0 3px 12px rgba(0,0,0,.25)">👤 Zobrazit jako…</a>';
  }
  if (!bar) return html;
  const i = html.lastIndexOf('</body>');   // pozor: HTML má </body> i uvnitř JS template stringů → injektujeme před POSLEDNÍ
  return i < 0 ? html + bar : html.slice(0, i) + bar + html.slice(i);
}
const VIEW_AS_PAGE = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zobrazit jako zaměstnanec</title>
<style>
:root{--g:#0e8a43;--g2:#0a6b34;--ink:#1c2320;--mut:#6b736c;--line:#e3e7e0;--bg:#eef1ec}
*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:760px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:22px;margin:6px 0 4px}.sub{color:var(--mut);font-size:14px;margin:0 0 18px}
.now{background:#fff6e6;border:1px solid #f0d79a;border-radius:12px;padding:12px 14px;margin-bottom:16px;display:none;align-items:center;gap:12px;flex-wrap:wrap}
.now b{color:#8a5600}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.search{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:10px;font:inherit;margin-bottom:12px}
.emp{display:flex;align-items:center;gap:12px;padding:10px 6px;border-bottom:1px solid #eef1ec;cursor:pointer;border-radius:8px}
.emp:hover{background:#f2f6f0}
.av{width:34px;height:34px;border-radius:50%;background:var(--g);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;flex:0 0 auto;font-size:14px}
.nm{font-weight:700}.em{color:var(--mut);font-size:12.5px}
.tag{font-size:11px;font-weight:700;border-radius:20px;padding:2px 9px;background:#eef1ec;color:#55605a;margin-left:6px}
.tag.adm{background:#e9d8f5;color:#6a1b9a}
.btn{border:0;border-radius:10px;padding:9px 15px;font:inherit;font-weight:700;cursor:pointer;background:var(--g);color:#fff}
.btn:hover{background:var(--g2)}.btn.ghost{background:#eef1ec;color:#33513f}
.right{margin-left:auto}.muted{color:var(--mut)}a{color:var(--g2)}
</style></head><body><div class="wrap">
<p style="margin:0"><a href="/">&larr; Zpět na intranet</a></p>
<h1>👤 Zobrazit jako zaměstnanec</h1>
<p class="sub">Prohlédněte si aplikaci přesně tak, jak ji vidí konkrétní člověk — jeho dlaždice, moduly a oprávnění. Náhled je jen pro čtení vaší strany; kdykoli ho ukončíte.</p>
<div class="now" id="now"></div>
<div class="card">
  <input class="search" id="q" placeholder="Hledat jméno nebo e-mail…" autocomplete="off">
  <div id="list"><p class="muted">Načítám zaměstnance…</p></div>
</div></div>
<script>
var EMPS=[];
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function initials(n){n=(n||'').trim();if(!n)return '?';var p=n.split(/\\s+/);return ((p[0]||'')[0]||'')+((p[1]||'')[0]||'')||n[0]}
function load(){
  fetch('/api/me',{cache:'no-store'}).then(function(r){return r.json()}).then(function(me){
    var now=document.getElementById('now');
    if(me&&me.viewAs&&me.employee){
      now.style.display='flex';
      now.innerHTML='<span style="font-size:18px">👁️</span><span>Právě prohlížíte jako <b>'+esc(me.employee.name||me.employee.email)+'</b> <span class="muted">('+esc(me.employee.email)+')</span></span>'+
        '<button class="btn ghost right" onclick="stop()">Ukončit náhled</button>';
    } else { now.style.display='none'; }
  });
  fetch('/api/view-as/employees',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
    EMPS=(j&&j.employees)||[]; renderList();
  }).catch(function(){document.getElementById('list').innerHTML='<p class="muted">Nepodařilo se načíst seznam.</p>'});
}
function renderList(){
  var q=(document.getElementById('q').value||'').toLowerCase().trim();
  var rows=EMPS.filter(function(e){return !q||(e.name||'').toLowerCase().indexOf(q)>=0||(e.email||'').toLowerCase().indexOf(q)>=0});
  var el=document.getElementById('list');
  if(!rows.length){el.innerHTML='<p class="muted">Nikdo neodpovídá hledání.</p>';return}
  el.innerHTML=rows.map(function(e){
    return '<div class="emp" onclick="viewAs(\\''+esc(e.email).replace(/'/g,"\\\\'")+'\\')">'+
      '<div class="av">'+esc(initials(e.name).toUpperCase())+'</div>'+
      '<div><div class="nm">'+esc(e.name||e.email)+(e.admin?'<span class="tag adm">admin</span>':'')+(e.modules?'<span class="tag">'+e.modules+' modulů</span>':'')+'</div><div class="em">'+esc(e.email)+'</div></div>'+
      '<button class="btn right" onclick="event.stopPropagation();viewAs(\\''+esc(e.email).replace(/'/g,"\\\\'")+'\\')">Zobrazit jako</button></div>';
  }).join('');
}
function viewAs(email){
  fetch('/api/view-as',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email})}).then(function(r){return r.json()}).then(function(j){
    if(!j||!j.ok){alert((j&&j.error)||'Nepodařilo se přepnout.');return}
    location.href='/';
  });
}
function stop(){fetch('/api/view-as/stop',{method:'POST'}).then(function(){location.reload()})}
document.getElementById('q').addEventListener('input',renderList);
load();
</script></body></html>`;
const SMI_APP_FILE = path.join(ROOT, 'SMI_aplikace.html');   // hotová SMI aplikace (modul E-shop)
const KALK_APP_FILE = path.join(ROOT, 'kalkulace-lisy.html'); // aplikace modulu Kalkulace-lisy (napojí se později)
const KALK_APP_URL = process.env.KALKULACE_APP_URL || 'https://lisy-production.up.railway.app/'; // aplikace Kalkulace-lisy (Railway); lze přepsat proměnnou
const LOXXER_KALK_APP_URL = process.env.LOXXER_KALK_APP_URL || 'https://loxxer-kalkulace-production.up.railway.app'; // LOXXER Kalkulátor (Railway); interní nástroj obchodníka na nabídky LOXXER
const LOXXER_WEB_URL = process.env.LOXXER_WEB_URL || 'https://loxxer-production.up.railway.app'; // Veřejná prezentace LOXXER (Railway); má /admin na správu fotky a textů
const SVOZ_ESA_URL = process.env.SVOZ_ESA_URL || ''; // aplikace „Kalkulačka svoz ESA" (repo kalkulacka-svoz-esa) — doplň URL nasazení
const RANGES_WATCHDOG_URL = process.env.RANGES_WATCHDOG_URL || ''; // aplikace „Hlídač sortimentu" (repo ranges-watchdog)
const TRIDICI_LINKA_APP_URL = process.env.TRIDICI_LINKA_APP_URL || 'https://tridici-linka-production.up.railway.app'; // aplikace „Design třídicí linky" — digitální dvojče (repo tridici-linka-railway); lze přepsat proměnnou
const TRIDICI_LINKA_APP_FILE = path.join(ROOT, 'design-tridici-linky.html'); // alternativně lokální soubor (stejně jako u Kalkulace-lisy)
const PREKLADISTE_APP_URL = process.env.PREKLADISTE_APP_URL || ''; // aplikace „Kalkulačka překladiště" — prodejní kalkulačka (repo prekladiste-kalkulacka); doplň URL nasazení
const LOZNYPLAN_APP_URL = (process.env.LOZNYPLAN_APP_URL || 'https://loznyplan-production.up.railway.app').replace(/\/$/, ''); // aplikace „Ložný plán" — plánování nakládky (repo loznyplan, Railway služba loznyplan)
const LODAKY_APP_URL = (process.env.LODAKY_APP_URL || '').replace(/\/$/, ''); // aplikace „Lodní kontejnery" (repo lodni-kontejnery) — nacenění obchodníka přes SSO
const PREKLADISTE_APP_FILE = path.join(ROOT, 'kalkulacka-prekladiste.html'); // alternativně lokální soubor
const PREKLAD_VEREJNY_FILE = path.join(ROOT, 'preklad-verejny.html'); // veřejný klientský funnel (lead-gen kalkulačka překladiště, mimo přihlašovací závoru)
const KOVOKALK_APP_FILE = path.join(ROOT, 'kalkulacka-kovo.html'); // modul „Kalkulace KOVO" — variabilní kalkulačka nacenění výrobků kovovýroby
const FREELO_EMAIL = process.env.FREELO_EMAIL || '';     // modul Freelo: e-mail účtu (basic auth)
const FREELO_API_KEY = process.env.FREELO_API_KEY || ''; // modul Freelo: API klíč (Freelo → Nastavení profilu → API)
const SVOZ_ESA_FILE = path.join(ROOT, 'kalkulacka-svoz-esa.html'); // alternativně lokální soubor
// Dovolená: úložiště žádostí + (volitelně) zápis do sdíleného Google kalendáře přes service account
const VAC_F = path.join(DATA_DIR, 'vacation.json');
const VACREP_F = path.join(DATA_DIR, 'vacation-report.json');
const AUTHDOM_F = path.join(DATA_DIR, 'auth-domeny.json'); // přístup z ostatních firemních domén (schvaluje správce) // měsíční report čerpání dovolené (příjemci, den, historie)
const VACATION_CALENDAR_ID = process.env.VACATION_CALENDAR_ID || '';       // ID sdíleného kalendáře „Dovolené"
const GOOGLE_SA_CLIENT_EMAIL = process.env.GOOGLE_SA_CLIENT_EMAIL || '';   // client_email ze service-account JSON
const GOOGLE_SA_PRIVATE_KEY = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'); // private_key (PEM; \n → nové řádky)
const GRIT_FILE = path.join(ROOT, 'grit.html');              // test houževnatosti (Grit)
const JSS_FILE  = path.join(ROOT, 'jss.html');               // dotazník pracovní spokojenosti (JSS)
const TW44_FILE = path.join(ROOT, 'tw44.html');              // test kognitivní zátěže (TW44)
const VYKRESY_FILE = path.join(ROOT, 'vykresy.html');        // test čtení strojírenských výkresů (praktický, 15 otázek)
const LOGIKA_FILE = path.join(ROOT, 'logika.html');          // test logického myšlení pro nábor nákupčí/logistik (20 úloh)
const ABROLL_FILE = path.join(ROOT, 'abroll-skoleni.html');  // interaktivní školení ABROLL + závěrečný test
const PRODUKTY_FILE = path.join(ROOT, 'produkty-skoleni.html'); // interaktivní školení Produkty (znalosti obchodníků) + závěrečný test
const PRUMYSL_FILE = path.join(ROOT, 'prumysl-skoleni.html'); // interaktivní školení Průmysl (obchodník: skladování, Li-Ion, ADR) + závěrečný test
const LOXXER_SKOLENI_FILE = path.join(ROOT, 'loxxer-skoleni.html'); // interaktivní školení LOXXER (obchodník: protipožární skříně na Li-Ion baterie) + závěrečný test
const ACTS_SKOLENI_FILE = path.join(ROOT, 'acts-skoleni.html'); // interaktivní školení ACTS (železniční abroll kontejnery) + závěrečný test
const VYKRESY_SKOLENI_FILE = path.join(ROOT, 'vykresy-skoleni.html'); // interaktivní školení Čtení technických výkresů (ČSN/ISO) + závěrečný test
const SVAROVANI_SKOLENI_FILE = path.join(ROOT, 'svarovani-skoleni.html'); // průvodce svařováním: hodnocení svarů (ISO 5817), fotogalerie vad, QC + závěrečný test
const ZENTEX_SKOLENI_FILE = path.join(ROOT, 'zentex-skoleni.html'); // interaktivní školení ZENTEX (lisovací kontejnery — výběr vhodného lisu) + závěrečný test (20 z 50 otázek)
const TRIDICI_SKOLENI_FILE = path.join(ROOT, 'tridici-linky-skoleni.html'); // interaktivní školení Třídicí linky (12 kapitol: technologie, trh, ekonomika) + závěrečný test (24 z 60 otázek)
const KONCEPT_FILE = path.join(ROOT, 'intranet-koncept.html'); // náhledový koncept redesignu intranetu (SharePoint hub)
const PUB_DIR  = path.join(DATA_DIR, 'published');
const STATE_F  = path.join(DATA_DIR, 'state.json');
const ACKS_F   = path.join(DATA_DIR, 'acks.json');
const LIB_F    = path.join(DATA_DIR, 'library.json');        // knihovna: pracovní řád, SOP, postupy (verzované)
const LIBACK_F = path.join(DATA_DIR, 'library-acks.json');   // potvrzení vázaná na konkrétní verzi dokumentu
const REPORT_F = path.join(DATA_DIR, 'report-state.json');   // stav měsíčního vyhodnocení (kdy naposled odesláno)
const GRIT_F   = path.join(DATA_DIR, 'grit-results.json');   // výsledky testu houževnatosti (neanonymní)
const JSS_F    = path.join(DATA_DIR, 'jss-results.json');    // výsledky dotazníku pracovní spokojenosti
const TW44_F   = path.join(DATA_DIR, 'tw44-results.json');   // výsledky testu kognitivní zátěže (neanonymní)
const VYKRESY_F = path.join(DATA_DIR, 'vykresy-results.json'); // výsledky testu čtení výkresů (zaměstnanci i uchazeči)
const LOGIKA_F = path.join(DATA_DIR, 'logika-results.json'); // výsledky testu logického myšlení (nábor nákupčí/logistik)
const LOGIKA_OT_SEED = path.join(ROOT, 'logika-otazky.json');      // otázky testu logiky — seed v repu (výchozí sada 25 úloh)
const LOGIKA_OT_F = path.join(DATA_DIR, 'logika-otazky.json');     // otázky testu logiky — editovatelná kopie na volume (má přednost)
const ABROLL_F = path.join(DATA_DIR, 'abroll-results.json'); // výsledky testu ABROLL (max 3 pokusy na osobu)
const PRODUKTY_F = path.join(DATA_DIR, 'produkty-results.json'); // výsledky testu znalosti produktů (max 3 pokusy na osobu)
const PRUMYSL_F = path.join(DATA_DIR, 'prumysl-results.json'); // výsledky testu Průmysl (obchodník) — max 3 pokusy na osobu
const LOXXER_SKOLENI_F = path.join(DATA_DIR, 'loxxer-skoleni-results.json'); // výsledky testu LOXXER (obchodník) — max 3 pokusy na osobu
const ACTS_SKOLENI_F = path.join(DATA_DIR, 'acts-skoleni-results.json'); // výsledky testu ACTS (železniční abroll kontejnery) — max 3 pokusy na osobu
const VYKRESY_SKOLENI_F = path.join(DATA_DIR, 'vykresy-skoleni-results.json'); // výsledky testu školení Čtení výkresů — max 3 pokusy na osobu
const SVAROVANI_SKOLENI_F = path.join(DATA_DIR, 'svarovani-skoleni-results.json'); // výsledky testu školení Průvodce svařováním — max 3 pokusy na osobu
const ZENTEX_SKOLENI_F = path.join(DATA_DIR, 'zentex-skoleni-results.json'); // výsledky testu školení ZENTEX (lisovací kontejnery) — max 3 pokusy na osobu
const TRIDICI_SKOLENI_F = path.join(DATA_DIR, 'tridici-linky-skoleni-results.json'); // výsledky testu školení Třídicí linky — max 3 pokusy na osobu
const MOBILIAR_FILE = path.join(ROOT, 'mobiliar.html');      // veřejné obrázkové hodnocení venkovního mobiliáře (katalog WeiDu)
const MOBILIAR_F = path.join(DATA_DIR, 'mobiliar-hlasovani.json'); // hlasy hodnocení mobiliáře — upsert dle rid (anonymní id prohlížeče)
// Veřejná sběrná doména pro ZÁKAZNICKÉ průzkumy (alias na tuto app, bez „intranet" v adrese).
// Průzkumy pro uchazeče a zaměstnance sem nepatří — zůstávají na intranetu (pozvánky ?i=, SSO).
// Víc hostů odděl čárkou; první = adresa zobrazovaná v adminu.
const SURVEY_HOSTS = (process.env.SURVEY_HOSTS || 'vyzkum.elkoplast.cz,survey.elkoplast.cz').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const SURVEY_PUBLIC_URL = process.env.SURVEY_PUBLIC_URL || ('https://' + SURVEY_HOSTS[0]);
// Registr průzkumů na sběrné doméně: neuhodnutelná cesta (slug) → HTML soubor průzkumu.
// Odkaz funguje jen s přesným slugem; kořen domény ukazuje neutrální rozcestník bez odkazů na průzkumy.
const MOBILIAR_SLUG = process.env.MOBILIAR_SLUG || 'mobiliar-mqvsx02utcemzm';
const SURVEY_SLUGS = { [MOBILIAR_SLUG]: () => MOBILIAR_FILE };
const MOBILIAR_PUBLIC_URL = SURVEY_PUBLIC_URL + '/' + MOBILIAR_SLUG;   // sběrný odkaz zobrazovaný v adminu
// Neutrální stránka kořene sběrné domény (nic neprozrazuje, nikam dál nevede).
const SURVEY_LANDING = '<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex"><title>ELKOPLAST — zákaznické průzkumy</title></head>' +
  '<body style="margin:0;min-height:100svh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;background:#f2f5f1;color:#111713">' +
  '<div style="text-align:center;padding:32px;max-width:440px"><div style="font-weight:800;letter-spacing:.05em;color:#08612d;margin-bottom:10px">ELKOPLAST CZ</div>' +
  '<h1 style="font-size:22px;margin:0 0 10px">Zákaznické průzkumy</h1>' +
  '<p style="color:#5d675f;font-size:15px;margin:0">Pro účast v průzkumu potřebujete přímý odkaz, který jsme vám poslali. Bez něj tu nic k vidění není 🙂</p></div></body></html>';
const CFG_F    = path.join(DATA_DIR, 'mail.config.json');
const SECRET_F = path.join(DATA_DIR, 'secret.json');
const ACTLOG_F  = path.join(DATA_DIR, 'activity.json');   // jednoduchý log aktivity (přihlášení, pozvánky, průzkumy)
const CENMON_F  = path.join(DATA_DIR, 'cenmon.json');     // cenový monitoring: naše položky (export SMI), katalog MEVA, ruční páry
const INVITES_F = path.join(DATA_DIR, 'invites.json');    // stav pozvánek dle e-mailu: {invitedAt, acceptedAt, lastLoginAt}
const UKOLY_F   = path.join(DATA_DIR, 'smernice-ukoly.json'); // úkoly vyplývající ze směrnic (záložka „Úkoly ze směrnic")
const KOVOKALK_F = path.join(DATA_DIR, 'kovo-kalkulace.json'); // Kalkulace KOVO: parametry (s historií změn) + výrobky
const OBCHOD_F   = path.join(DATA_DIR, 'obchod-zastupitelnost.json');
const GARANTI_F  = path.join(DATA_DIR, 'garanti-navrhy.json'); // návrhy garantů ze SK/PL z veřejné stránky + nastavení veřejného odkazu // Obchod: rozdělení obchodníků / zastupitelnost PM (editovatelná tabulka)
const PREKLAD_LEADY_F = path.join(DATA_DIR, 'preklad-leady.json'); // Obchod → Leady: kontakty z veřejné kalkulačky překladiště (lead-gen)
const AKTUALITY_F = path.join(DATA_DIR, 'aktuality.json');    // aktuality (novinky) na intranetu: {posts:[{id,title,body,image,author,authorEmail,ts,likes:{email:ts}}]}
const SITE_F      = path.join(DATA_DIR, 'site.json');         // nastavení vzhledu intranetu (např. vlastní hero banner)
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');           // nahrané obrázky (aktuality, banner) — persistentní volume
for (const d of [DATA_DIR, PUB_DIR, UPLOADS_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

/* ---------- malé util ---------- */
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function writeJson(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); }

// Jednorázově: přidej Tomáši Buršovi přístup k modulu „kontejnery" (Lodní kontejnery). Běží dokud ho ve state nenajde.
(function seedTomasKontejnery() {
  try {
    const s = readJson(STATE_F, null);
    if (!s || !Array.isArray(s.employees) || s._seedTomasKontejnery) return;
    const e = s.employees.find(x => (x.email || '').toLowerCase() === 'tomas.bursa@elkoplast.cz');
    if (!e) { console.log('[seed] Tomáš Burša zatím není ve state — přidělte modul „kontejnery" ručně v Přístupech.'); return; }
    if (!Array.isArray(e.modules)) e.modules = [];
    if (e.modules.indexOf('kontejnery') < 0) e.modules.push('kontejnery');
    s._seedTomasKontejnery = true; writeJson(STATE_F, s);
    console.log('[seed] Tomáš Burša → přidán modul „kontejnery".');
  } catch (err) { console.error('[seed] tomas kontejnery:', err.message); }
})();

// Jednorázová oprava (2026-08-11): někdo přes „Odesílané e-maily" přepsal šablonu pozvánky do intranetu.
// Vracíme na původní výchozí text („Dobrý den {jmeno5}, byli jste pozváni…"). Šablona zůstává dál editovatelná.
(function () {
  try {
    const s = readJson(STATE_F, null);
    if (!s || s._inviteTplReset20260811) return;
    s._inviteTplReset20260811 = true;
    if (s.settings && s.settings.mailTpl && s.settings.mailTpl.invite) {
      console.log('[migrace] šablona pozvánky byla přepsaná (subject: ' + JSON.stringify((s.settings.mailTpl.invite.subject || '').slice(0, 60)) + ') → vráceno na výchozí.');
      delete s.settings.mailTpl.invite;
    }
    writeJson(STATE_F, s);
  } catch (err) { console.error('[migrace] invite tpl reset:', err.message); }
})();

/* ---------- jednoduchý log aktivity + stav pozvánek ---------- */
// Zapíše událost do logu (posledních 500). Typy: login, admin-login, invite-sent, invite-accepted, survey.
function logActivity(type, who, detail) {
  try {
    const log = readJson(ACTLOG_F, []);
    log.push({ ts: Date.now(), type, email: (who && who.email) || '', name: (who && who.name) || '', detail: detail || '' });
    if (log.length > 500) log.splice(0, log.length - 500);
    writeJson(ACTLOG_F, log);
  } catch (e) {}
}
function readInvites() { const m = readJson(INVITES_F, {}); return (m && typeof m === 'object') ? m : {}; }

/* ---------- Cenový monitoring (ESHOP × MEVA) ----------
   Naše položky = ruční nahrání exportu ze SMI (kód, název, cena).
   Ceny MEVA = crawl veřejného webu mevatec.cz (sitemap → produktové stránky …-P/).
   Párování = podobnost názvů (tokeny bez diakritiky + shoda čísel, např. objem 120/240 l). */
function cenmonRead() {
  const d = readJson(CENMON_F, {});
  return { polozky: d.polozky || [], polozkyMeta: d.polozkyMeta || null, meva: d.meva || [], mevaMeta: d.mevaMeta || null, pary: d.pary || {} };
}
function cenmonWrite(d) { writeJson(CENMON_F, d); }

const CENMON_SCAN = { bezi: false, hotovo: 0, celkem: 0, chyb: 0, od: null };
async function cenmonMevaScan() {
  if (CENMON_SCAN.bezi) return;
  CENMON_SCAN.bezi = true; CENMON_SCAN.hotovo = 0; CENMON_SCAN.chyb = 0; CENMON_SCAN.od = Date.now();
  try {
    const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
    const sm = await (await fetch('https://www.mevatec.cz/sitemaps/sitemap.xml', { headers: UA })).text();
    const urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(u => /-P\/$/.test(u));
    CENMON_SCAN.celkem = urls.length;
    const vysledky = [];
    let i = 0;
    async function worker() {
      while (i < urls.length) {
        const url = urls[i++];
        try {
          const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const h = await r.text();
          const nazev = ((h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
          const bezDph = parseFloat(((h.match(/class="price-value">\s*([\d\s]+[.,]?\d*)\s*Kč/) || [])[1] || '').replace(/\s/g, '').replace(',', '.'));
          const sDph = parseFloat((h.match(/itemprop="price"\s+content="([\d.]+)"/) || [])[1] || '');
          if (nazev && (bezDph || sDph)) vysledky.push({ url, nazev, cenaBezDph: bezDph || null, cenaSDph: sDph || null });
        } catch (_) { CENMON_SCAN.chyb++; }
        CENMON_SCAN.hotovo++;
        await sleep(120);   // šetrné tempo (~4 souběžně × 120 ms)
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    const d = cenmonRead();
    d.meva = vysledky;
    d.mevaMeta = { kdy: Date.now(), celkem: urls.length, nacteno: vysledky.length, chyb: CENMON_SCAN.chyb };
    cenmonWrite(d);
    logActivity('cenmon', { email: '', name: 'server' }, 'MEVA crawl: ' + vysledky.length + ' produktů (' + CENMON_SCAN.chyb + ' chyb)');
  } catch (e) {
    logActivity('cenmon-chyba', { email: '', name: 'server' }, String(e.message || e).slice(0, 120));
  } finally { CENMON_SCAN.bezi = false; }
}

function cenmonNorm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function cenmonTokeny(s) {
  const n = cenmonNorm(s);
  const tokeny = new Set(n.split(/[^a-z0-9]+/).filter(t => t.length > 1));
  const cisla = new Set((n.match(/\d+/g) || []).map(Number).filter(x => x > 1));
  return { tokeny, cisla };
}
function cenmonSkore(a, b) {
  let spol = 0; a.tokeny.forEach(t => { if (b.tokeny.has(t)) spol++; });
  const uni = a.tokeny.size + b.tokeny.size - spol;
  let s = uni ? spol / uni : 0;
  if (a.cisla.size && b.cisla.size) {
    let cs = 0; a.cisla.forEach(c => { if (b.cisla.has(c)) cs++; });
    s = cs ? s + 0.2 * Math.min(1, cs / a.cisla.size) : s * 0.35;   // čísla (objemy) se musí potkat
  }
  return s;
}
// Pro každou naši položku najde nejlepší kandidáty z MEVA (top 4) + aplikuje ruční páry.
function cenmonSrovnani(items) {
  const d = cenmonRead();
  const polozky = Array.isArray(items) ? items : d.polozky;   // volitelně spáruje položky poslané z klienta (SMI aplikace)
  const mevaTok = d.meva.map(m => ({ m, t: cenmonTokeny(m.nazev) }));
  const out = [];
  for (const p of polozky) {
    const pt = cenmonTokeny(p.nazev);
    const kandidati = [];
    for (const { m, t } of mevaTok) {
      const s = cenmonSkore(pt, t);
      if (s >= 0.25) kandidati.push({ s: Math.round(s * 100) / 100, url: m.url, nazev: m.nazev, cenaBezDph: m.cenaBezDph, cenaSDph: m.cenaSDph });
    }
    kandidati.sort((x, y) => y.s - x.s);
    const par = d.pary[p.kod || p.nazev] || null;
    let vybrany = null;
    if (par && par.stav === 'zamitnuto') vybrany = null;
    else if (par && par.mevaUrl) vybrany = kandidati.find(k => k.url === par.mevaUrl) || (d.meva.filter(m => m.url === par.mevaUrl).map(m => ({ s: 1, url: m.url, nazev: m.nazev, cenaBezDph: m.cenaBezDph, cenaSDph: m.cenaSDph }))[0] || null);
    else if (kandidati.length && kandidati[0].s >= 0.45) vybrany = kandidati[0];
    out.push({ kod: p.kod || '', nazev: p.nazev, cena: p.cena, meva: vybrany, kandidati: kandidati.slice(0, 4), stavParu: par ? par.stav : (vybrany ? 'auto' : 'neparovano') });
  }
  return out;
}
// Označí, že jsme pozvánku odeslali (nastaví invitedAt) a zaloguje ji.
function markInvited(email, name) {
  email = (email || '').toLowerCase(); if (!email) return;
  const m = readInvites(); const r = m[email] || {};
  r.invitedAt = Date.now(); if (name && !r.name) r.name = name;
  m[email] = r; writeJson(INVITES_F, m);
  logActivity('invite-sent', { email, name: name || email }, '');
}
// Zaznamená přihlášení; při prvním přihlášení nastaví acceptedAt (= „přijal pozvánku / je aktivní").
function markLogin(email, name, via) {
  email = (email || '').toLowerCase(); if (!email) return;
  const m = readInvites(); const r = m[email] || {};
  const firstAccept = !r.acceptedAt;
  if (firstAccept) r.acceptedAt = Date.now();
  r.lastLoginAt = Date.now(); if (name) r.name = name;
  m[email] = r; writeJson(INVITES_F, m);
  logActivity('login', { email, name: name || email }, via || '');
  if (firstAccept && r.invitedAt) logActivity('invite-accepted', { email, name: name || email }, '');
  return { prvni: firstAccept };
}

/* ---------- bezpečnost / přihlášení ---------- */
let SEC = readJson(SECRET_F, null);
if (!SEC) { SEC = { secret: crypto.randomBytes(24).toString('hex'), password: process.env.ADMIN_PASSWORD || crypto.randomBytes(5).toString('hex') }; writeJson(SECRET_F, SEC); }
if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== SEC.password) { SEC.password = process.env.ADMIN_PASSWORD; writeJson(SECRET_F, SEC); }
function token() { return crypto.createHmac('sha256', SEC.secret).update('admin-v1').digest('hex'); }
function isAuthed(req) { const c = req.headers.cookie || ''; const m = c.match(/sm_auth=([a-f0-9]+)/); return m && m[1] === token(); }
/* ---------- role admin (Google) + superadmin ---------- */
const SUPERADMIN = (process.env.SUPERADMIN || 'david.sury@elkoplast.cz').toLowerCase();
function isAdminEmp(email) { email = (email || '').toLowerCase(); if (!email) return false; if (email === SUPERADMIN) return true; const s = readJson(STATE_F, { employees: [] }); const e = (s.employees || []).find(x => (x.email || '').toLowerCase() === email); return !!(e && e.admin); }
function isSuperadmin(req) { const e = empSession(req); return !!(e && (e.email || '').toLowerCase() === SUPERADMIN); }
// Admin = heslo (záloha) NEBO přihlášený zaměstnanec se superadmin/admin rolí
function isAdmin(req) { if (viewAsActive(req)) { const e = empSession(req); return !!(e && isAdminEmp(e.email)); } if (isAuthed(req)) return true; const e = empSession(req); return !!(e && isAdminEmp(e.email)); }

/* ---------- Sdílená „závora" celého webu (aby intranet nebyl veřejný) ----------
   Aktivní jen když je nastavené SITE_PASSWORD. Dokud návštěvník nezadá toto heslo,
   každá stránka i API vrací přihlašovací obrazovku / 401. Cookie sm_gate (HMAC). */
const SITE_PASSWORD = (process.env.SITE_PASSWORD || '').trim();
function gateToken() { return crypto.createHmac('sha256', SEC.secret).update('gate-v1:' + SITE_PASSWORD).digest('hex'); }
// Závora je aktivní, pokud je k dispozici aspoň jeden způsob přihlášení (Google SSO nebo sdílené heslo).
function gateActive() { return ssoEnabled() || !!SITE_PASSWORD; }
function gatePassed(req) {
  if (!gateActive()) return true;                                                    // žádné přihlášení nenastaveno → web otevřený (jako dřív)
  if (empSession(req)) return true;                                                   // přihlášený zaměstnanec přes Google
  if (isAuthed(req)) return true;                                                     // přihlášený admin
  if (SITE_PASSWORD && (req.headers.cookie || '').includes('sm_gate=' + gateToken())) return true; // sdílené heslo
  return false;
}
function gatePage() {
  const google = ssoEnabled()
    ? '<a class="gbtn" href="/auth/google/login"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M45 24c0-1.5-.1-3-.4-4.4H24v8.4h11.8c-.5 2.8-2 5.1-4.4 6.7v5.5h7.1C42.7 36.5 45 30.8 45 24z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.8 28.3c-.4-1.3-.7-2.7-.7-4.3s.3-3 .7-4.3v-5.7H4.5C3 17.1 2.2 20.4 2.2 24s.8 6.9 2.3 10l7.3-5.7z"/><path fill="#EA4335" d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8.1 6.9 4.5 14l7.3 5.7c1.7-5.2 6.5-9 12.2-9z"/></svg> Přihlásit se přes Google</a>'
    : '';
  const sep = (ssoEnabled() && SITE_PASSWORD) ? '<div class="sep">nebo</div>' : '';
  const pass = SITE_PASSWORD
    ? '<form onsubmit="return go(event)"><input id="p" type="password" placeholder="Přístupové heslo" autocomplete="current-password"><button type="submit">Vstoupit</button><div class="err" id="e"></div></form>'
    : '';
  const hint = ssoEnabled() ? 'Přihlaste se firemním účtem ELKOPLAST.' : 'Zadejte přístupové heslo.';
  return '<!doctype html><html lang="cs"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Intranet ELKOPLAST CZ — přihlášení</title>'
    + '<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;display:grid;place-items:center;'
    + 'background:radial-gradient(900px 480px at 100% -8%,#e6f6ec,transparent 62%),#eef1ec;color:#0f1512}'
    + '.card{width:min(92vw,380px);background:#fff;border:1px solid #e3e7e0;border-radius:16px;box-shadow:0 10px 30px rgba(15,21,18,.08);padding:30px 28px;text-align:center}'
    + '.logo{width:46px;height:46px;border-radius:12px;background:linear-gradient(150deg,#ffd21a,#ffc400);display:grid;place-items:center;margin:0 auto 14px;font-size:24px;color:#11271c;font-weight:800}'
    + 'h1{font-size:18px;margin:0 0 4px}p{color:#5b635c;font-size:13px;margin:0 0 18px}'
    + '.gbtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:11px;border:1px solid #cdd3ca;border-radius:10px;background:#fff;color:#1c1d1a;font-weight:600;font-size:15px;text-decoration:none;margin-bottom:6px}'
    + '.gbtn:hover{border-color:#12a350;background:#f7faf8}.sep{color:#9aa29a;font-size:12px;margin:12px 0;text-transform:uppercase;letter-spacing:.05em}'
    + 'input{width:100%;padding:12px 14px;border:1px solid #cdd3ca;border-radius:10px;font-size:15px;margin-bottom:10px;font-family:inherit}'
    + 'input:focus{outline:none;border-color:#12a350}button{width:100%;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,#15ab57,#0a6b34);color:#fff;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit}'
    + '.err{color:#c23636;font-size:13px;min-height:18px;margin-top:8px}</style></head><body>'
    + '<div class="card"><div class="logo">✓</div><h1>Intranet ELKOPLAST CZ</h1><p>' + hint + '</p>'
    + google + sep + pass + '</div>'
    + '<script>async function go(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'try{var r=await fetch("/gate-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});'
    + 'if(r.ok){location.reload();}else{e.textContent="Nesprávné heslo.";}}catch(x){e.textContent="Chyba spojení.";}return false;}</script></body></html>';
}

/* ---------- SSO zaměstnanců (Google OIDC, bez závislostí) ---------- */
const GOOGLE = { clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '', hd: (process.env.ALLOWED_HD || '').trim() };
function ssoEnabled() { return !!(GOOGLE.clientId && GOOGLE.clientSecret); }
// Demo přihlášení zaměstnance – jen když NENÍ zapnuté SSO. Standardně jen na localhost;
// na testovacím nasazení (bez domény pro Google) lze povolit i mimo localhost přes ALLOW_DEV_LOGIN=1.
// Bezpečnostní pojistka: v produkci je zapnuté SSO → dev přihlášení je vždy vypnuté bez ohledu na flag.
function devAllowed(req) { const h = (req.headers.host || '').toLowerCase(); if (ssoEnabled()) return false; return process.env.ALLOW_DEV_LOGIN === '1' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h); }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64').toString('utf8'); }
function cookieVal(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? decodeURIComponent(m[1]) : ''; }
function empSign(payload) { const data = b64url(JSON.stringify(payload)); const sig = crypto.createHmac('sha256', SEC.secret).update('emp:' + data).digest('hex').slice(0, 32); return data + '.' + sig; }
function empVerify(str) { if (!str) return null; const i = str.lastIndexOf('.'); if (i < 0) return null; const data = str.slice(0, i), sig = str.slice(i + 1); const exp = crypto.createHmac('sha256', SEC.secret).update('emp:' + data).digest('hex').slice(0, 32); if (sig !== exp) return null; try { return JSON.parse(b64urlDecode(data)); } catch (_) { return null; } }
/* ---------- Pozvánkový hash pro NEzaměstnance (dotazníky bez přihlášení) ----------
   Token = b64url(JSON{e:email, n:jméno}) + "." + HMAC("inv:"+data)[0..32]. Bez expirace.
   Slouží jako podepsaný „kdo to je" v odkazu ?i=... — server osobu pozná, aniž se hlásí. */
function inviteSign(email, name) { const data = b64url(JSON.stringify({ e: (email || '').toLowerCase(), n: name || '' })); const sig = crypto.createHmac('sha256', SEC.secret).update('inv:' + data).digest('hex').slice(0, 32); return data + '.' + sig; }
function inviteVerify(str) { if (!str) return null; const i = str.lastIndexOf('.'); if (i < 0) return null; const data = str.slice(0, i), sig = str.slice(i + 1); const exp = crypto.createHmac('sha256', SEC.secret).update('inv:' + data).digest('hex').slice(0, 32); if (sig !== exp) return null; try { const o = JSON.parse(b64urlDecode(data)); return o && o.e ? o : null; } catch (_) { return null; } }
function empSessionReal(req) { return empVerify(cookieVal(req, 'sm_emp')); }
function findEmployeeByEmail(email) { email = (email || '').toLowerCase(); if (!email) return null; const s = readJson(STATE_F, { employees: [] }); return (s.employees || []).find(x => (x.email || '').toLowerCase() === email) || null; }
/* ---------- „Zobrazit jako zaměstnanec" — impersonace pro admina (náhled aplikace jeho očima) ----------
   Cookie sm_view_as = podepsaný e-mail cílového zaměstnance. Ctí se JEN když je žadatel skutečný admin.
   Během náhledu vrací empSession() impersonovaného zaměstnance → všechny moduly renderují jeho pohled,
   isAdmin() je odvozen od impersonované identity (takže admin vidí i to, co běžný člověk nevidí). */
function viewAsSign(email) { const data = b64url(JSON.stringify({ e: (email || '').toLowerCase(), t: Date.now() })); const sig = crypto.createHmac('sha256', SEC.secret).update('viewas:' + data).digest('hex').slice(0, 32); return data + '.' + sig; }
function viewAsVerify(str) { if (!str) return null; const i = str.lastIndexOf('.'); if (i < 0) return null; const data = str.slice(0, i), sig = str.slice(i + 1); const exp = crypto.createHmac('sha256', SEC.secret).update('viewas:' + data).digest('hex').slice(0, 32); if (sig !== exp) return null; try { const o = JSON.parse(b64urlDecode(data)); return o && o.e ? o.e : null; } catch (_) { return null; } }
// Skutečný admin (ignoruje impersonaci) — jen ten smí náhled zapnout/vypnout.
function isRealAdmin(req) { if (isAuthed(req)) return true; const e = empSessionReal(req); return !!(e && isAdminEmp(e.email)); }
// Impersonovaný zaměstnanec, je-li aktivní platná view-as cookie a žadatel je skutečný admin; jinak null.
function viewAsEmp(req) { const raw = cookieVal(req, 'sm_view_as'); if (!raw) return null; const va = viewAsVerify(raw); if (!va) return null; if (!isRealAdmin(req)) return null; const real = ((empSessionReal(req) || {}).email || '').toLowerCase(); if (va.toLowerCase() === real) return null; return findEmployeeByEmail(va); }
function viewAsActive(req) { return !!viewAsEmp(req); }
function empSession(req) { const imp = viewAsEmp(req); if (imp) return { email: imp.email, name: imp.name || imp.email, _viewAs: true }; return empSessionReal(req); }
/* ---------- SSO do externích aplikací (nabídkový kalkulátor) ---------- */
// Token = b64url(JSON{email,name,exp}) + "." + HMAC-SHA256("sso:"+data, SEC.secret)[0..32]. Krátká platnost.
const SSO_SHARED_SECRET = process.env.SSO_SHARED_SECRET || SEC.secret; // nastav stejně jako INTRANET_SSO_SECRET v nabídkové app
function ssoSign(payload) { const data = b64url(JSON.stringify(payload)); const sig = crypto.createHmac('sha256', SSO_SHARED_SECRET).update('sso:' + data).digest('hex').slice(0, 32); return data + '.' + sig; }
const NABIDKY_URL = process.env.NABIDKY_URL || 'https://lisy-production.up.railway.app';
// Poptávky pro intranet se čtou z CMS klientských kalkulaček (lisy.elkoplast.cz) —
// tam reálně přistávají „Příchozí poptávky". Endpoint /api/leads-export je chráněn
// sdíleným X-Ingest-Secret (LEADS_INGEST_SECRET). Odznak = celkový počet poptávek.
const POPTAVKY_URL = process.env.POPTAVKY_URL || 'https://lisy.elkoplast.cz';
const NABIDKY_INGEST_SECRET = process.env.LEADS_INGEST_SECRET || '';
let _poptavkyCache = { n: 0, at: 0 };
// Stáhne výpis poptávek z CMS. cb(err, leads[]).
function fetchPoptavkyList(cb) {
  try {
    const u = new URL(POPTAVKY_URL.replace(/\/$/, '') + '/api/leads-export');
    const mod = u.protocol === 'http:' ? require('http') : https;
    const rq = mod.get({ hostname: u.hostname, path: u.pathname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      headers: NABIDKY_INGEST_SECRET ? { 'X-Ingest-Secret': NABIDKY_INGEST_SECRET } : {} }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => {
        try { const j = JSON.parse(d); cb(null, (j && j.leads) || []); } catch (e) { cb(e); }
      });
    });
    rq.on('error', cb);
    rq.setTimeout(6000, () => { try { rq.destroy(new Error('Časový limit')); } catch (_) {} });
  } catch (e) { cb(e); }
}
function refreshPoptavkyCount() { fetchPoptavkyList((err, leads) => { if (!err) _poptavkyCache = { n: (leads || []).length, at: Date.now() }; }); }
setTimeout(refreshPoptavkyCount, 3000);
setInterval(refreshPoptavkyCount, 60 * 1000);
// HTTPS POST application/x-www-form-urlencoded → JSON (výměna kódu za token u Google)
function httpsPostForm(hostname, pathName, form) {
  return new Promise((resolve, reject) => {
    const body = Object.keys(form).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(form[k])).join('&');
    const r = https.request({ method: 'POST', hostname, path: pathName, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (resp) => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} if (resp.statusCode >= 200 && resp.statusCode < 300 && j) return resolve(j); reject(new Error((j && (j.error_description || j.error)) || ('HTTP ' + resp.statusCode + ': ' + d.slice(0, 200)))); });
    });
    r.on('error', e => reject(new Error('Spojení s Google: ' + e.message)));
    r.setTimeout(20000, () => { try { r.destroy(new Error('Google: časový limit spojení.')); } catch (_) {} });
    r.write(body); r.end();
  });
}

/* ---------- konfigurace pošty ---------- */
function loadConfig() {
  const c = readJson(CFG_F, {});
  return {
    host: c.host || '', port: Number(c.port || 587), secure: !!c.secure,
    user: c.user || '', pass: c.pass || '', fromName: c.fromName || 'Směrnice',
    publicUrl: c.publicUrl || process.env.PUBLIC_URL || ''
  };
}
let CFG = loadConfig();
function writeConfig(obj) { const cur = readJson(CFG_F, {}); const merged = Object.assign({}, cur, obj); if (obj.pass === undefined || obj.pass === '') merged.pass = cur.pass || ''; writeJson(CFG_F, merged); CFG = loadConfig(); }
function configStatus() { return { configured: !!(CFG.host && CFG.user), host: CFG.host, port: CFG.port, secure: CFG.secure, user: CFG.user, fromName: CFG.fromName, hasPass: !!CFG.pass }; }

/* ============================================================
   SMTP klient (bez závislostí) – STARTTLS i SSL, AUTH LOGIN/PLAIN
   ============================================================ */
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function rfc2047(s) { return /^[\x00-\x7F]*$/.test(s || '') ? (s || '') : ('=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='); }
function wrap76(s) { return s.replace(/(.{76})/g, '$1\r\n'); }
function ehloName() { return (os.hostname() || 'localhost').replace(/[^A-Za-z0-9.\-]/g, '') || 'localhost'; }

function smtpSend(cfg, mail) {
  return new Promise((resolve, reject) => {
    const host = cfg.host, port = Number(cfg.port) || 587, secure = !!cfg.secure;
    let sock, buf = '', resolver = null, queue = [], settled = false;
    const fail = (e) => { if (settled) return; settled = true; try { sock && sock.destroy(); } catch (_) {} reject(e instanceof Error ? e : new Error(String(e))); };
    function pump() { while (true) { const lines = buf.split('\n'); let endIdx = -1, code = null; for (let i = 0; i < lines.length; i++) { const ln = lines[i].replace(/\r$/, ''); const m = ln.match(/^(\d{3}) /); if (m) { endIdx = i; code = parseInt(m[1], 10); break; } } if (endIdx < 0) break; const resp = { code, text: lines.slice(0, endIdx + 1).join('\n') }; buf = lines.slice(endIdx + 1).join('\n'); if (resolver) { const r = resolver; resolver = null; r(resp); } else queue.push(resp); } }
    function onData(chunk) { buf += chunk.toString('utf8'); pump(); }
    function read() { return new Promise((res) => { if (queue.length) res(queue.shift()); else resolver = res; }); }
    function write(line) { sock.write(line + '\r\n'); }
    async function cmd(line, codes) { write(line); const r = await read(); if (codes && codes.indexOf(r.code) < 0) throw new Error('SMTP ' + r.code + ': ' + r.text.replace(/\n/g, ' ')); return r; }
    function upgradeTLS() { return new Promise((res, rej) => { const t = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => res(t)); t.on('error', rej); }); }
    async function flow() {
      await read();
      let r = await cmd('EHLO ' + ehloName(), [250]); let caps = r.text.toUpperCase();
      if (!secure && caps.indexOf('STARTTLS') >= 0) { await cmd('STARTTLS', [220]); sock.removeListener('data', onData); const t = await upgradeTLS(); sock = t; buf = ''; queue = []; sock.on('data', onData); sock.on('error', fail); r = await cmd('EHLO ' + ehloName(), [250]); caps = r.text.toUpperCase(); }
      if (cfg.user) { if (caps.indexOf('AUTH') >= 0 && caps.indexOf('LOGIN') >= 0) { await cmd('AUTH LOGIN', [334]); await cmd(b64(cfg.user), [334]); await cmd(b64(cfg.pass || ''), [235]); } else { await cmd('AUTH PLAIN ' + b64('\0' + cfg.user + '\0' + (cfg.pass || '')), [235]); } }
      const fromAddr = mail.fromAddr || cfg.user;
      const ccList = mail.cc ? (Array.isArray(mail.cc) ? mail.cc : [mail.cc]).map((x) => String(x).trim()).filter(Boolean) : [];
      await cmd('MAIL FROM:<' + fromAddr + '>', [250]);
      await cmd('RCPT TO:<' + mail.to + '>', [250, 251]);
      for (const c of ccList) await cmd('RCPT TO:<' + c + '>', [250, 251]);
      await cmd('DATA', [354]);
      const boundary = 'b_' + crypto.randomBytes(8).toString('hex');
      const fromHeader = mail.fromName ? (rfc2047(mail.fromName) + ' <' + fromAddr + '>') : fromAddr;
      const headers = ['From: ' + fromHeader, 'To: <' + mail.to + '>'].concat(
        ccList.length ? ['Cc: ' + ccList.map((c) => '<' + c + '>').join(', ')] : [],
        ['Subject: ' + rfc2047(mail.subject || ''), 'Date: ' + new Date().toUTCString(), 'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@' + host + '>', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' + boundary + '"']).join('\r\n');
      const textPart = '--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + wrap76(Buffer.from(mail.text || '', 'utf8').toString('base64'));
      const htmlPart = '--' + boundary + '\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + wrap76(Buffer.from(mail.html || '', 'utf8').toString('base64'));
      let body = headers + '\r\n\r\n' + textPart + '\r\n' + htmlPart + '\r\n--' + boundary + '--\r\n';
      body = body.replace(/\r?\n/g, '\r\n').replace(/\r\n\./g, '\r\n..');
      sock.write(body + '\r\n.\r\n');
      const fin = await read(); if (fin.code !== 250) throw new Error('SMTP ' + fin.code + ': ' + fin.text.replace(/\n/g, ' '));
      await cmd('QUIT', [221]).catch(() => {});
      if (!settled) { settled = true; try { sock.destroy(); } catch (_) {} resolve(true); }
    }
    function begin() { sock.on('data', onData); sock.on('error', fail); sock.setTimeout(25000); sock.on('timeout', () => fail(new Error('Časový limit SMTP spojení.'))); flow().catch(fail); }
    try { if (secure) { sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, begin); sock.on('error', fail); } else { sock = net.connect({ host, port }, begin); sock.on('error', fail); } } catch (e) { fail(e); }
  });
}

/* ============================================================
   Resend (HTTPS API) – funguje i tam, kde je SMTP blokované
   ============================================================ */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function resendSend(mail) {
  return new Promise((resolve, reject) => {
    const key = process.env.RESEND_API_KEY;
    const fromEmail = (mail.fromEmail || process.env.RESEND_FROM || 'onboarding@resend.dev').trim();
    const fromName = mail.fromName || '';
    const from = fromName ? (fromName + ' <' + fromEmail + '>') : fromEmail;
    // Resend chce POLE adres. Příjemci k nám chodí i jako řetězec „a@x.cz, b@x.cz" → rozdělit,
    // jinak Resend vrátí 422 (Invalid `to` field) a e-mail s více příjemci se neodešle.
    const addrs = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;,\n]/))
      .map((x) => String(x).trim()).filter((x) => x && x.indexOf('@') > 0);
    const to = addrs(mail.to), cc = addrs(mail.cc);
    if (!to.length) return reject(new Error('Resend: chybí platný příjemce (' + String(mail.to || '') + ')'));
    const payload = JSON.stringify({ from: from, to: to, cc: cc.length ? cc : undefined, subject: mail.subject || '', html: mail.html || undefined, text: mail.text || undefined });
    const r = https.request({ method: 'POST', hostname: 'api.resend.com', path: '/emails', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (resp) => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) return resolve(true);
        let msg = d; try { const j = JSON.parse(d); msg = j.message || j.error || d; } catch (_) {}
        reject(new Error('Resend ' + resp.statusCode + ': ' + msg));
      });
    });
    r.on('error', e => reject(new Error('Resend spojení: ' + e.message)));
    r.setTimeout(20000, () => { try { r.destroy(new Error('Resend: časový limit spojení.')); } catch (_) {} });
    r.write(payload); r.end();
  });
}
// jednotné odeslání: když je nastavený RESEND_API_KEY → Resend, jinak SMTP
// Centrální EVIDENCE všech odeslaných e-mailů — každý mail z libovolného modulu projde tudy
// a zapíše se do DATA_DIR/mail-log.json (Rozesílky → Historie odeslaných e-mailů).
function mailLogAppend(entry) {
  try {
    const f = path.join(DATA_DIR, 'mail-log.json');
    let l = []; try { l = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (_) {}
    l.push(entry);
    if (l.length > 800) l = l.slice(-800);
    fs.writeFileSync(f, JSON.stringify(l));
  } catch (_) {}
}
function mailLogRead(n) {
  try { const l = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'mail-log.json'), 'utf8')) || []; return l.slice(-(n || 200)).reverse(); } catch (_) { return []; }
}
// Centrální vypínač rozesílek: správce může v přehledu „Rozesílky" zrušit odesílání kterékoli
// registrované rozesílky, bez ohledu na nastavení uvnitř modulu. Klíče = report.key.
const ROZESILKY_OFF_F = () => path.join(DATA_DIR, 'rozesilky-vypnute.json');
function rozesilkyOff() { try { return JSON.parse(fs.readFileSync(ROZESILKY_OFF_F(), 'utf8')) || {}; } catch (_) { return {}; } }
function rozesilkyOffWrite(o) { try { fs.writeFileSync(ROZESILKY_OFF_F(), JSON.stringify(o, null, 2)); } catch (_) {} }
function reportDisabled(key) { return !!rozesilkyOff()[key]; }
function deliver(mail) {
  const zaznam = { ts: Date.now(), to: String((mail && mail.to) || ''), subject: String((mail && mail.subject) || '').slice(0, 200), from: String((mail && (mail.fromName || mail.fromAddr)) || '').slice(0, 100) };
  // MAIL_DRY_RUN=1 → nic se neodešle, jen se vypíše co by odešlo. Pro lokální běh s produkčními
  // proměnnými (railway run): jinak plánovač nad prázdným DATA_DIR rozešle všechny reporty naostro.
  if ((process.env.MAIL_DRY_RUN || '') === '1') {
    console.log('[mail:DRY_RUN] NEODESLÁNO → ' + zaznam.to + ' · ' + zaznam.subject);
    return Promise.resolve({ ok: true, dryRun: true });
  }
  const p = process.env.RESEND_API_KEY ? resendSend(mail) : smtpSend(CFG, mail);
  return Promise.resolve(p).then(
    (r) => { mailLogAppend(Object.assign({ ok: true }, zaznam)); return r; },
    (e) => { mailLogAppend(Object.assign({ ok: false, chyba: String((e && e.message) || e).slice(0, 200) }, zaznam)); throw e; }
  );
}

/* ============================================================
   stav (směrnice/zaměstnanci) + potvrzení
   ============================================================ */
// Celé jméno „Jméno Příjmení". Když adresář má jen křestní jméno (nebo nic),
// doplní příjmení z e-mailu (jmeno.prijmeni@…). Křestní s diakritikou zachová,
// příjmení z e-mailu jen zkapitalizuje. Používá se globálně (adresář = celá app).
function displayName(name, email) {
  name = String(name || '').trim();
  if (name.indexOf(' ') > 0) return name;                 // už celé jméno
  const lp = String(email || '').split('@')[0];
  const parts = lp.split(/[._-]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1));
  if (name && parts.length >= 2) return name + ' ' + parts.slice(1).join(' ');
  if (parts.length) return parts.join(' ');
  return name || email || '';
}
// Vrací true, pokud u jména chybí příjmení (jednoslovné / prázdné).
function needsSurname(name) { return !String(name || '').trim() || String(name).trim().indexOf(' ') <= 0; }

function getState() {
  const s = readJson(STATE_F, { categories: [], employees: [], directives: [], profiles: [] });
  // Doplň celé jméno pro zobrazení ve všech modulech (bez zápisu na disk).
  (s.employees || []).forEach(e => { if (e && needsSurname(e.name)) e.name = displayName(e.name, e.email); });
  const acks = readJson(ACKS_F, []);
  (s.directives || []).forEach(d => {
    const merged = Object.assign({}, d.acks || {});
    acks.filter(a => a.dirId === d.id).forEach(a => { if (!merged[a.email]) merged[a.email] = { name: a.name, ts: a.ts }; });
    d.acks = merged;
  });
  return s;
}
function recordAck(a) {
  const acks = readJson(ACKS_F, []);
  const email = (a.email || '').toLowerCase();
  if (!acks.find(x => x.dirId === a.dirId && x.email === email)) { acks.push({ dirId: a.dirId, dirTitle: a.dirTitle || '', email, name: a.name || email, ts: a.ts || Date.now() }); writeJson(ACKS_F, acks); }
}
// Najde zaměstnance podle e-mailu; pokud chybí, automaticky ho založí (SSO první přihlášení).
/* ---------- Přístup z ostatních firemních domén (elkoplast.de / sk / ro …) ----------
   Hlavní doména (ALLOWED_HD) se pouští automaticky. Ostatní firemní domény smí dovnitř,
   až když konkrétní adresu schválí správce; do té doby se založí žádost a přijde upozornění. */
const AUTH_DOMENY_DEFAULT = ['elkoplast.de', 'elkoplast.sk', 'elkoplast.ro', 'elkoplast.pl', 'elkoplast.eu', 'elkoplast.fr', 'elkoplast.nl'];
const AUTH_POVOLENI_SEED = ['petr.barna@elkoplast.de'];   // předschváleno na žádost správce (2026-08-27)
function authDomCfg() {
  const d = readJson(AUTHDOM_F, null) || {};
  return {
    domeny: Array.isArray(d.domeny) && d.domeny.length ? d.domeny : AUTH_DOMENY_DEFAULT.slice(),
    povoleni: Array.isArray(d.povoleni) ? d.povoleni : AUTH_POVOLENI_SEED.slice(),
    zadosti: Array.isArray(d.zadosti) ? d.zadosti : []
  };
}
function authDomWrite(cfg) { writeJson(AUTHDOM_F, { domeny: cfg.domeny, povoleni: cfg.povoleni, zadosti: (cfg.zadosti || []).slice(0, 500) }); return authDomCfg(); }
function authDomain(email) { return String(email || '').toLowerCase().split('@')[1] || ''; }
function authHlavniDomena() { return (GOOGLE.hd || 'elkoplast.cz').toLowerCase(); }
// '' = smí dovnitř, 'ceka' = žádost čeká na schválení, 'cizi' = doména mimo firmu
function authStav(email) {
  email = String(email || '').toLowerCase();
  const dom = authDomain(email);
  if (!dom) return 'cizi';
  if (dom === authHlavniDomena()) return '';
  const cfg = authDomCfg();
  if (cfg.domeny.indexOf(dom) < 0) return 'cizi';
  return cfg.povoleni.map(x => String(x).toLowerCase()).indexOf(email) >= 0 ? '' : 'ceka';
}
// Zaznamená žádost o přístup a upozorní správce (jen jednou za adresu).
function authZadost(email, name) {
  email = String(email || '').toLowerCase();
  const cfg = authDomCfg();
  let z = cfg.zadosti.find(x => String(x.email || '').toLowerCase() === email);
  if (z) { z.pokusy = (z.pokusy || 1) + 1; z.posledni = new Date().toISOString(); authDomWrite(cfg); return z; }
  z = { email, name: name || '', ts: new Date().toISOString(), posledni: new Date().toISOString(), pokusy: 1, stav: 'čeká' };
  cfg.zadosti.unshift(z); authDomWrite(cfg);
  try {
    Promise.resolve(deliver({
      to: SUPERADMIN, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet ELKOPLAST',
      subject: 'Žádost o přístup do intranetu: ' + email,
      html: '<p><b>' + esc(name || email) + '</b> (' + esc(email) + ') se pokusil přihlásit do intranetu.</p>' +
        '<p>Adresa je z firemní domény <b>' + esc(authDomain(email)) + '</b>, která vyžaduje schválení správcem.</p>' +
        '<p>Schválit můžete v intranetu → Správa → Přístupy → „Přístup z ostatních domén“.</p>'
    })).catch(() => {});
  } catch (_) {}
  return z;
}
function ensureEmployee(email, name) {
  email = (email || '').toLowerCase();
  const s = readJson(STATE_F, { categories: [], employees: [], directives: [], profiles: [] });
  s.employees = s.employees || [];
  let e = s.employees.find(x => (x.email || '').toLowerCase() === email);
  if (!e) {
    e = { id: 'g' + crypto.randomBytes(6).toString('hex'), name: displayName(name, email), email, cats: [] };
    s.employees.push(e); writeJson(STATE_F, s);
  } else if (needsSurname(e.name)) {
    // dopočítej příjmení stávajícímu (křestní z Google + příjmení z e-mailu) a ulož
    const full = displayName(e.name || name, email);
    if (full && full !== e.name) { e.name = full; writeJson(STATE_F, s); }
  }
  return e;
}
// Jednorázový backfill při startu: doplní příjmení do uloženého adresáře.
(function backfillEmployeeNames() {
  try {
    const s = readJson(STATE_F, { employees: [] });
    let changed = 0;
    (s.employees || []).forEach(e => { if (e && needsSurname(e.name)) { const full = displayName(e.name, e.email); if (full && full !== e.name) { e.name = full; changed++; } } });
    if (changed) { writeJson(STATE_F, s); console.log('[adresář] doplněno příjmení u ' + changed + ' zaměstnanců'); }
  } catch (_) {}
})();
// Komu je položka (směrnice/dokument) určena: základ = všem / dle oddělení; pak zúžení TAGY (má-li položka tagy, musí zaměstnanec mít shodný tag).
function assignedTo(item, emp) {
  const cats = (emp && emp.cats) || [], tags = (emp && emp.tags) || [];
  const base = item.assignAll || (item.assignCats || []).some(c => cats.indexOf(c) >= 0);
  if (!base) return false;
  const at = item.assignTags || [];
  return at.length ? at.some(t => tags.indexOf(t) >= 0) : true;
}
// Směrnice, které se týkají daného zaměstnance, + stav přečtení a zda je publikovaná.
function myDirectives(email) {
  email = (email || '').toLowerCase();
  const s = getState();
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  return (s.directives || [])
    .filter(d => assignedTo(d, emp))
    .map(d => {
      const ack = d.acks && d.acks[email];
      // published: stránka /s/<id> existuje, nebo ji server umí vygenerovat z obsahu (lazy publikace)
      return { id: d.id, title: d.title, kategorie: d.kategorie || null, verze: d.verze || 1, ack: !!ack, ackTs: ack ? ack.ts : null, published: !!(d.html) || fs.existsSync(path.join(PUB_DIR, String(d.id).replace(/[^a-z0-9]/gi, '') + '.html')) };
    });
}

/* ---------- knihovna (verzované dokumenty: pracovní řád, SOP, postupy) ---------- */
function readLibrary() { const l = readJson(LIB_F, { docs: [], folders: [] }); l.docs = l.docs || []; l.folders = l.folders || []; return l; }
function libAcks() { return readJson(LIBACK_F, []); }
function curVersion(d) { return d.cur || (d.versions && d.versions.length ? d.versions[d.versions.length - 1].v : 1); }
function recordLibAck(a) {
  const acks = libAcks(); const email = (a.email || '').toLowerCase(); const v = Number(a.v);
  if (!acks.find(x => x.docId === a.docId && Number(x.v) === v && x.email === email)) { acks.push({ docId: a.docId, v, email, name: a.name || email, ts: a.ts || Date.now() }); writeJson(LIBACK_F, acks); }
}
function libAcked(docId, v, email) { email = (email || '').toLowerCase(); v = Number(v); return libAcks().some(x => x.docId === docId && Number(x.v) === v && x.email === email); }
// Dokumenty knihovny, které se týkají zaměstnance (aktuální verze + stav potvrzení).
function myLibrary(email) {
  email = (email || '').toLowerCase();
  const s = getState(); const lib = readLibrary();
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const acks = libAcks();
  const docs = (lib.docs || [])
    .filter(d => assignedTo(d, emp))
    .map(d => {
      const v = curVersion(d);
      const ack = acks.find(x => x.docId === d.id && Number(x.v) === v && x.email === email);
      return { id: d.id, title: d.title, kind: d.kind || 'dokument', folderId: d.folderId || null, requireAck: d.requireAck !== false, v, acked: !!ack, ackTs: ack ? ack.ts : null };
    });
  const folders = (lib.folders || []).map(f => ({ id: f.id, name: f.name, parentId: f.parentId || null }));
  return { folders, docs };
}
// Nejbližší termín, kdy lze průzkum vyplnit znovu = měsíc od posledního vyplnění (limit 1× měsíčně).
function nextFillAt(ts) { const d = new Date(ts); d.setMonth(d.getMonth() + 1); return d.getTime(); }
// Průzkumy/testy dostupné zaměstnanci + jestli (a kdy) je vyplnil. Datum vyplnění = ts posledního záznamu (upsert dle e-mailu).
function mySurveys(email) {
  email = (email || '').toLowerCase();
  const DEFS = [
    { id: 'grit', title: 'Test houževnatosti (Grit)', desc: '10 otázek · vytrvalost a dlouhodobá vášeň pro cíle', mins: 3, file: GRIT_F },
    { id: 'jss',  title: 'Dotazník pracovní spokojenosti (JSS)', desc: '36 otázek · 9 oblastí pracovní spokojenosti', mins: 8, file: JSS_F },
    { id: 'tw44', title: 'Test kognitivní zátěže (TW44)', desc: 'krátké subtesty pozornosti a paměti', mins: 6, file: TW44_F },
    { id: 'vykresy', title: 'Test čtení výkresů', desc: '15 otázek · praktické čtení strojírenské výkresové dokumentace', mins: 10, file: VYKRESY_F },
    { id: 'logika', title: 'Test logického myšlení (nákup a logistika)', desc: '29 úloh · odhady, dedukce, rozhodování, řízení zásob — kreativní logika', mins: 40, file: LOGIKA_F },
  ];
  return DEFS.map(d => {
    const rec = readJson(d.file, []).find(r => (r.email || '').toLowerCase() === email);
    const filledAt = rec ? (rec.ts || null) : null;
    const nextAt = filledAt ? nextFillAt(filledAt) : null;
    const canFill = !filledAt || Date.now() >= nextAt;   // vyplnit lze max 1× měsíčně
    return { id: d.id, title: d.title, desc: d.desc, mins: d.mins, filled: !!rec, filledAt, nextAt, canFill };
  });
}
// Test houževnatosti (Grit) – percentil populace ČR z průměru (HS 1,0–5,0)
const GRIT_PCT = { 18: 0, 19: 0, 20: 1, 21: 1, 22: 1, 23: 2, 24: 3, 25: 5, 26: 6, 27: 9, 28: 12, 29: 16, 30: 20, 31: 25, 32: 31, 33: 37, 34: 44, 35: 51, 36: 58, 37: 64, 38: 70, 39: 76, 40: 81, 41: 85, 42: 89, 43: 92, 44: 94, 45: 96, 46: 97, 47: 98, 48: 99, 49: 99, 50: 100 };
function gritPct(avg) { const k = Math.round(avg * 10); if (k < 18) return 0; if (k > 50) return 100; return GRIT_PCT[k] != null ? GRIT_PCT[k] : 0; }
// Uloží (upsert podle e-mailu) výsledek; jméno a oddělení (= 1. kategorie) dohledá ze zaměstnanců.
function recordGrit(a) {
  const email = (a.email || '').toLowerCase();
  const hs = Math.round(Math.max(1, Math.min(5, Number(a.hs) || 0)) * 10) / 10;
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  // subškály (nepovinné — starší vyplnění je nemají): konzistence zájmů a vytrvalost úsilí, 1–5
  const kz = (a.kz != null && isFinite(a.kz)) ? Math.round(Math.max(1, Math.min(5, Number(a.kz))) * 10) / 10 : null;
  const vu = (a.vu != null && isFinite(a.vu)) ? Math.round(Math.max(1, Math.min(5, Number(a.vu))) * 10) / 10 : null;
  const rec = { email, name, dept, hs, kz, vu, pct: gritPct(hs), ts: Date.now() };
  const results = readJson(GRIT_F, []);
  const i = results.findIndex(r => (r.email || '').toLowerCase() === email);
  if (i >= 0 && results[i].ts && Date.now() < nextFillAt(results[i].ts)) return { blocked: true, nextAt: nextFillAt(results[i].ts) };
  if (i >= 0) results[i] = rec; else results.push(rec);
  writeJson(GRIT_F, results);
  logActivity('survey', { email, name }, 'Test houževnatosti (Grit)');
  return rec;
}
// Uloží (upsert podle e-mailu) výsledek dotazníku spokojenosti (JSS) vč. demografie.
function recordJss(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(36, Math.min(216, Math.round(Number(a.total) || 0)));
  const rec = { email, name, dept, total, pct: Math.round(Number(a.pct) || 0), subs: Array.isArray(a.subs) ? a.subs : [],
    pozice: (a.pozice || '').trim(), delka: (a.delka || '').trim(), stredisko: (a.stredisko || '').trim(), zarazeni: (a.zarazeni || '').trim(), ts: Date.now() };
  const results = readJson(JSS_F, []);
  const i = results.findIndex(r => (r.email || '').toLowerCase() === email);
  if (i >= 0 && results[i].ts && Date.now() < nextFillAt(results[i].ts)) return { blocked: true, nextAt: nextFillAt(results[i].ts) };
  if (i >= 0) results[i] = rec; else results.push(rec);
  writeJson(JSS_F, results);
  logActivity('survey', { email, name }, 'Dotazník pracovní spokojenosti (JSS)');
  return rec;
}
// Uloží (upsert podle e-mailu) výsledek testu kognitivní zátěže TW44.
function recordTw44(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const rec = { email, name, dept, variant: (a.variant || '').slice(0, 16),
    subtests: (a.subtests && typeof a.subtests === 'object') ? a.subtests : {},
    attr: (a.attr && typeof a.attr === 'object') ? a.attr : null,
    indices: (a.indices && typeof a.indices === 'object') ? a.indices : {}, ts: Date.now() };
  const results = readJson(TW44_F, []);
  const i = results.findIndex(r => (r.email || '').toLowerCase() === email);
  if (i >= 0 && results[i].ts && Date.now() < nextFillAt(results[i].ts)) return { blocked: true, nextAt: nextFillAt(results[i].ts) };
  if (i >= 0) results[i] = rec; else results.push(rec);
  writeJson(TW44_F, results);
  logActivity('survey', { email, name }, 'Test kognitivní zátěže (TW44)');
  return rec;
}
// Uloží (upsert podle e-mailu) výsledek testu čtení strojírenských výkresů (zaměstnanec i uchazeč).
function recordVykresy(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || a.kandidat || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const celkem = Math.max(1, Math.round(Number(a.otazekCelkem) || 15));
  const skore = Math.max(0, Math.min(celkem, Math.round(Number(a.skore) || 0)));
  const procenta = Math.max(0, Math.min(100, Math.round((a.procenta != null && isFinite(a.procenta)) ? Number(a.procenta) : skore / celkem * 100)));
  const rec = { email, name, dept,
    pozice: String(a.pozice || '').slice(0, 80),
    skore, otazekCelkem: celkem, procenta,
    hodnoceni: String(a.hodnoceni || VYKRESY_HODNOCENI[vykresyPasmo(procenta)]).slice(0, 60),
    casVyprsel: !!a.casVyprsel,
    casPouzityS: Math.max(0, Math.round(Number(a.casPouzityS) || 0)),
    limitS: Math.max(0, Math.round(Number(a.limitS) || 0)),
    oblasti: (Array.isArray(a.oblasti) ? a.oblasti : []).slice(0, 12).map(o => ({
      oblast: String((o || {}).oblast || '').slice(0, 60),
      spravne: Math.max(0, Math.round(Number((o || {}).spravne) || 0)),
      celkem: Math.max(0, Math.round(Number((o || {}).celkem) || 0)) })),
    odpovedi: (Array.isArray(a.odpovedi) ? a.odpovedi : []).slice(0, 40).map(o => ({
      otazka: Math.round(Number((o || {}).otazka) || 0),
      oblast: String((o || {}).oblast || '').slice(0, 60),
      spravne: !!(o || {}).spravne,
      odpovedKandidata: (o || {}).odpovedKandidata == null ? null : String((o || {}).odpovedKandidata).slice(0, 200),
      spravnaOdpoved: String((o || {}).spravnaOdpoved || '').slice(0, 200) })),
    ts: Date.now() };
  const results = readJson(VYKRESY_F, []);
  const i = results.findIndex(r => (r.email || '').toLowerCase() === email);
  if (i >= 0 && results[i].ts && Date.now() < nextFillAt(results[i].ts)) return { blocked: true, nextAt: nextFillAt(results[i].ts) };
  if (i >= 0) results[i] = rec; else results.push(rec);
  writeJson(VYKRESY_F, results);
  logActivity('survey', { email, name }, 'Test čtení výkresů');
  return rec;
}
// Uloží (upsert dle e-mailu) výsledek testu logického myšlení — stejný tvar záznamu jako test výkresů.
function recordLogika(a) {
  const email = (a.email || '').toLowerCase();
  const s2 = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s2.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || a.kandidat || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s2.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const celkem = Math.max(1, Math.round(Number(a.otazekCelkem) || 29));
  const skore = Math.max(0, Math.min(celkem, Math.round(Number(a.skore) || 0)));
  const procenta = Math.max(0, Math.min(100, Math.round((a.procenta != null && isFinite(a.procenta)) ? Number(a.procenta) : skore / celkem * 100)));
  const rec = { email, name, dept,
    pozice: String(a.pozice || '').slice(0, 80),
    skore, otazekCelkem: celkem, procenta,
    hodnoceni: String(a.hodnoceni || LOGIKA_HODNOCENI[logikaPasmo(procenta)]).slice(0, 60),
    casVyprsel: !!a.casVyprsel,
    casPouzityS: Math.max(0, Math.round(Number(a.casPouzityS) || 0)),
    limitS: Math.max(0, Math.round(Number(a.limitS) || 0)),
    oblasti: (Array.isArray(a.oblasti) ? a.oblasti : []).slice(0, 12).map(o => ({
      oblast: String((o || {}).oblast || '').slice(0, 60),
      spravne: Math.max(0, Math.round(Number((o || {}).spravne) || 0)),
      celkem: Math.max(0, Math.round(Number((o || {}).celkem) || 0)) })),
    odpovedi: (Array.isArray(a.odpovedi) ? a.odpovedi : []).slice(0, 40).map(o => ({
      otazka: Math.round(Number((o || {}).otazka) || 0),
      oblast: String((o || {}).oblast || '').slice(0, 60),
      spravne: !!(o || {}).spravne,
      odpovedKandidata: (o || {}).odpovedKandidata == null ? null : String((o || {}).odpovedKandidata).slice(0, 200),
      spravnaOdpoved: String((o || {}).spravnaOdpoved || '').slice(0, 200) })),
    ts: Date.now() };
  const results = readJson(LOGIKA_F, []);
  const i = results.findIndex(r => (r.email || '').toLowerCase() === email);
  if (i >= 0 && results[i].ts && Date.now() < nextFillAt(results[i].ts)) return { blocked: true, nextAt: nextFillAt(results[i].ts) };
  if (i >= 0) results[i] = rec; else results.push(rec);
  writeJson(LOGIKA_F, results);
  logActivity('survey', { email, name }, 'Test logického myšlení (nákup a logistika)');
  return rec;
}
// Otázky testu logiky: editovaná verze z volume má přednost, jinak seed z repa.
function loadLogikaOtazky() {
  for (const f of [LOGIKA_OT_F, LOGIKA_OT_SEED]) {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d && Array.isArray(d.questions) && d.questions.length) return d; } catch (_) {}
  }
  return null;
}
function validLogikaOtazky(d) {
  if (!d || !Array.isArray(d.cats) || d.cats.length < 1 || d.cats.length > 12) return 'Chybí oblasti (1–12).';
  if (!Array.isArray(d.questions) || d.questions.length < 5 || d.questions.length > 60) return 'Počet úloh musí být 5–60.';
  const lm = Math.round(+d.limitMin || 0); if (lm < 5 || lm > 120) return 'Limit musí být 5–120 minut.';
  for (let i = 0; i < d.questions.length; i++) {
    const q = d.questions[i];
    if (!q || typeof q.text !== 'string' || q.text.trim().length < 10) return 'Úloha ' + (i + 1) + ': chybí zadání.';
    if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some(o => typeof o !== 'string' || !o.trim())) return 'Úloha ' + (i + 1) + ': musí mít přesně 4 neprázdné možnosti.';
    if (!(q.correct >= 0 && q.correct <= 3)) return 'Úloha ' + (i + 1) + ': správná odpověď musí být jedna ze 4 možností.';
    if (!(q.cat >= 0 && q.cat < d.cats.length)) return 'Úloha ' + (i + 1) + ': neplatná oblast.';
    if (typeof q.correctText !== 'string' || q.correctText.trim().length < 5) return 'Úloha ' + (i + 1) + ': chybí vysvětlení (proč je odpověď správně).';
  }
  return null;
}
/* ---- Hodnocení venkovního mobiliáře (katalog WeiDu) — veřejný obrázkový průzkum ----
   Fotky: assets/mobiliar/<kód>.jpg (např. ob-001), kódy odpovídají katalogu (ob-001 = WD-OB-001).
   Respondent vybírá z šestic fotek 2 nejhezčí: 1 = vybráno, 0 = zobrazeno/nevybráno.
   Anonymní (bez jména). Klient posílá průběžně celý svůj stav; server upsertuje dle rid. */
const MOBILIAR_KATEGORIE = [
  { key: 'ob',  nazev: 'Lavičky',         pocet: 96 },
  { key: 'tc',  nazev: 'Stoly a sezení',  pocet: 36 },
  { key: 'otc', nazev: 'Odpadkové koše',  pocet: 84 },
  { key: 'osl', nazev: 'Lehátka',         pocet: 24 },
  { key: 'opb', nazev: 'Květináče',       pocet: 24 },
];
function mobiliarKodOk(kod) {
  const m = /^([a-z]+)-(\d{3})$/.exec(String(kod || ''));
  if (!m) return false;
  const kat = MOBILIAR_KATEGORIE.find(k => k.key === m[1]);
  return !!kat && +m[2] >= 1 && +m[2] <= kat.pocet;
}
function recordMobiliar(b) {
  const rid = String(b.rid || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  if (rid.length < 8) return { error: 'Neplatné id hlasování.' };
  const ROLE = ['obchodnik', 'zakaznik', 'ostatni', 'neuvedeno'];
  const votesIn = (b.votes && typeof b.votes === 'object') ? b.votes : {};
  const votes = {};
  for (const kod of Object.keys(votesIn)) {
    if (!mobiliarKodOk(kod)) continue;
    const v = Math.round(+votesIn[kod]);
    if (v >= 0 && v <= 5) votes[kod] = v > 0 ? 1 : 0;
  }
  const all = readJson(MOBILIAR_F, []);
  let rec = all.find(r => r.rid === rid);
  const novy = !rec;
  if (!rec) { rec = { rid, createdAt: Date.now() }; all.push(rec); }
  rec.role = ROLE.indexOf(b.role) >= 0 ? b.role : (rec.role || 'neuvedeno');
  // hlasy jen přibývají/mění se — menší payload (např. ze staré záložky) nesmí smazat už uložené
  rec.votes = Object.assign({}, rec.votes || {}, votes);
  rec.ts = Date.now();
  writeJson(MOBILIAR_F, all);
  if (novy) logActivity('mobiliar', { email: '', name: 'anonym' }, 'Hodnocení mobiliáře: nový respondent (' + rec.role + ')');
  return { ok: true, ulozeno: Object.keys(rec.votes).length };
}
/* ---- Automatické odeslání výsledku testu na HR manažera (settings.hrEmail) + interpretace ---- */
const SURVEY_NAZVY = { grit: 'Test houževnatosti (Grit)', jss: 'Dotazník pracovní spokojenosti (JSS)', tw44: 'Test kognitivní zátěže (TW44)', vykresy: 'Test čtení výkresů', logika: 'Test logického myšlení (nákup a logistika)' };
/* Test čtení výkresů — pásma dle procent (stejná hranice jako v testu samotném) */
function vykresyPasmo(p) { return p >= 90 ? 'vyborna' : p >= 70 ? 'dobra' : p >= 50 ? 'zakladni' : 'nedostatecna'; }
const VYKRESY_HODNOCENI = { vyborna: 'Výborná úroveň', dobra: 'Dobrá úroveň', zakladni: 'Základní orientace', nedostatecna: 'Nedostatečná úroveň' };
const VYKRESY_DOPORUCENI = {
  vyborna: 'Kandidát čte výkresy spolehlivě — bez omezení pro samostatnou práci podle výkresové dokumentace.',
  dobra: 'Drobné mezery, běžnou výrobní dokumentaci zvládne. Doporučujeme krátké zaškolení na firemní standardy kreslení.',
  zakladni: 'Ve výkresech se orientuje jen částečně. Jednodušší úkoly zvládne pod dohledem; před samostatnou prací doporučujeme školení čtení výkresů.',
  nedostatecna: 'Čtení výkresů zatím neovládá. Pro práci podle výkresové dokumentace je nutné důkladné zaškolení.',
};
/* Test logického myšlení — pásma (těžký test, hranice níž než u výkresů) */
function logikaPasmo(p) { return p >= 85 ? 'vyborne' : p >= 65 ? 'dobre' : p >= 45 ? 'prumer' : 'slabe'; }
const LOGIKA_HODNOCENI = { vyborne: 'Výborné logické myšlení', dobre: 'Dobré logické myšlení', prumer: 'Průměrný výsledek', slabe: 'Slabý výsledek' };
const LOGIKA_DOPORUCENI = {
  vyborne: 'Kandidát řeší i neznámé úlohy samostatně a přesně — přesně profil „pálí mu to". Silný adept na pozici nákupčí/logistik; doporučujeme pokračovat pohovorem nad reálným nákupním případem.',
  dobre: 'Solidní úsudek, chyby spíš v návalu než v principu. Vhodný kandidát; u pohovoru prověřte oblasti s nejnižší úspěšností.',
  prumer: 'Zvládá přímočaré úlohy, u chytáků a víceúrovňové logiky chybuje. Zvažte podle ostatních kritérií — pro seniorní nákupní roli spíše slabší.',
  slabe: 'Logické myšlení pod úrovní potřebnou pro samostatnou nákupní/logistickou roli. Nedoporučujeme pokračovat jen na základě sympatie z pohovoru.',
};
function vykresyFmtCas(sec) { sec = Math.max(0, Math.round(sec || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
// Pracovní pásma dle skóre 1–5 (publikované normy neexistují — percentil je jen orientační).
function gritPasmo(v) { return v < 3 ? 'nizke' : (v < 4 ? 'stredni' : 'vysoke'); }
const GRIT_TXT = {
  celkove: {
    nizke: 'Celkové skóre GRIT se nachází v nižším pásmu. Výsledek naznačuje, že kandidát může být citlivější na delší období bez viditelného pokroku nebo na úkoly, které vyžadují dlouhodobé držení stejného směru. V pracovním prostředí proto pravděpodobně bude fungovat lépe tam, kde jsou cíle členěné do kratších etap, očekávání jsou průběžně upřesňována a zpětná vazba přichází pravidelně. Výsledek sám o sobě nevypovídá o schopnostech ani potenciálu; spíše ukazuje, že pro stabilní výkon bude důležitý dobrý role-fit, jasná priorizace a kvalitní vedení.',
    stredni: 'Celkové skóre GRIT se nachází ve středním pásmu. Výsledek odpovídá běžné úrovni dlouhodobého pracovního úsilí a stability směru. Kandidát pravděpodobně dokáže vytrvat, pokud rozumí smyslu práce, dostává přiměřeně jasné cíle a má odpovídající podmínky pro výkon. Pro přesnější interpretaci je vhodné sledovat zejména rozdíl mezi dílčími složkami — konzistencí zájmů a vytrvalostí úsilí.',
    vysoke: 'Celkové skóre GRIT se nachází ve vyšším pásmu. Výsledek naznačuje silnější tendenci držet dlouhodobý směr a pokračovat i při ztížení podmínek nebo dočasném neúspěchu. V pracovním prostředí to může být výhoda zejména v rolích s delším cyklem učení, vyšší náročností a potřebou dotahování. Současně je vhodné sledovat, zda se tato vytrvalost neobrací do přetěžování, přílišného setrvávání v nefunkčním postupu nebo nižší ochoty opustit neefektivní cestu.',
  },
  kz: {
    nizke: 'Konzistence zájmů je nižší. Kandidát může mít tendenci častěji přehodnocovat priority, nechávat se více přitahovat novými podněty a hůře držet jeden dlouhodobý směr. V dynamických rolích to nemusí být slabina, ale v pozicích vyžadujících stabilní tematické zaměření, rutinní follow-through nebo dlouhé dotažení jedné linie práce bude důležité více pracovat s prioritizací a vyjasněním „co je teď hlavní".',
    stredni: 'Konzistence zájmů je ve středním pásmu. Kandidát pravděpodobně zvládá držet směr, ale podle kontextu může část energie přesouvat i k novým tématům. Vhodné je průběžně ověřovat, jak silně je vázán na smysl role, jak se rozhoduje mezi konkurenčními prioritami a jak pracuje s dlouhodobou motivací.',
    vysoke: 'Konzistence zájmů je vyšší. Kandidát pravděpodobně drží dlouhodobý směr stabilněji, méně často přeskakuje mezi prioritami a může být spolehlivější v rolích, kde je potřeba tematická soustředěnost a dlouhodobé budování expertizy. Výhodou je menší rozptylování; hlídat je třeba dostatečnou flexibilitu při změně strategie nebo zadání.',
  },
  vu: {
    nizke: 'Vytrvalost úsilí je nižší. Kandidát může být citlivější na překážky, pomalejší výsledný pokrok nebo opakované zádrhely. Lépe proto funguje s kratším feedback loopem, jasně viditelnými mezikroky a vedením, které umí rychle pomoci obnovit tempo po neúspěchu. Výsledek neznamená nízkou schopnost, ale vyšší potřebu struktury a podpory při delších či náročnějších úkolech.',
    stredni: 'Vytrvalost úsilí je ve středním pásmu. Kandidát pravděpodobně běžně zvládá držet pracovní tempo i přes dílčí komplikace; reakce na náročnější období bude záležet na kvalitě vedení, srozumitelnosti očekávání a smysluplnosti úkolu. Doptejte se na konkrétní příklady práce po neúspěchu.',
    vysoke: 'Vytrvalost úsilí je vyšší. Kandidát pravděpodobně dobře pokračuje i při obtížích, vrací se po setbacku k cíli a má vyšší pracovní staminu — cenné v prostředí s náročnou adaptací, vysokou odpovědností nebo opakovanými překážkami. Vedení by mělo sledovat i hranici mezi vytrvalostí a přepalováním či setrváváním v neefektivním postupu.',
  },
};
const GRIT_AKCE_SRV = {
  nizke: { obraz: 'kratší tah na branku, citlivější na překážky nebo nízkou smysluplnost úkolu', kom: 'stručně, konkrétně, časté mezníky, rychlá zpětná vazba', onb: 'rozdělit práci na kratší sprinty; jasné priority; časté check-iny', fit: 'vhodnější tam, kde je rychlá zpětná vazba, pestrost a kratší cykly dokončení', ot: '„Popište projekt, který se protáhl. Co vás udrželo?" · „Kdy jste změnil(a) směr a proč?"', cile: '30/60/90denní cíle; definovat 3 kritické návyky follow-through', mer: 'dochvilnost k termínům, uzavírání úkolů, počet nedokončených aktivit' },
  stredni: { obraz: 'běžná úroveň; výsledek silně závisí na smyslu role, manažerovi a systému práce', kom: 'standardně, ale ověřovat, co kandidáta dlouhodobě drží', onb: 'standardní onboarding + 1–2 cílené podpory podle subškál', fit: 'široké spektrum rolí', ot: '„Co vás drží u obtížných úkolů déle než ostatní?"', cile: 'jeden delší cíl + dva kratší milníky', mer: 'plnění milníků, kvalita follow-upu, stabilita priorit' },
  vysoke: { obraz: 'dobrá pracovní stamina, vyšší pravděpodobnost dotahování a držení směru', kom: 'dávat smysl, autonomii a dlouhodobý rámec, ne mikromanagement', onb: 'stretch cíle, ownership, ale hlídat přetížení', fit: 'role s delším cyklem učení, náročnou adaptací, odborným růstem', ot: '„Kdy jste měl(a) pokračovat, a kdy bylo správné přestat?"', cile: 'delší projekt s jasným business výsledkem; vedle toho limit na kapacitu', mer: 'dokončení dlouhých úkolů, míra samostatnosti, riziko overcommitmentu' },
};
function gritProfilVetaSrv(kz, vu) {
  if (kz == null || vu == null) return '';
  const d = vu - kz;
  if (d >= 0.4) return 'Relativně silnější je vytrvalost úsilí, slabší konzistence zájmů: kandidát spíše „doběhne", co je rozběhnuté, ale hrozí rozptylování mezi tématy. Pomůže jasná prioritizace a menší počet souběžných cílů.';
  if (d <= -0.4) return 'Relativně silnější je konzistence zájmů, slabší vytrvalost úsilí: kandidát drží tematický směr, ale při zádrhelech může polevit. Pomůže krátký feedback loop a podpora rychlého návratu do tempa po neúspěchu.';
  return 'Obě složky (konzistence zájmů i vytrvalost úsilí) jsou vyrovnané — profil bez výrazné vnitřní disproporce.';
}
const GRIT_BENCHMARK_SRV = 'Orientační kontext: ve výzkumech dospělých bývá průměr zhruba 3,2–3,7; česká adaptace Grit-S měla průměr 3,29. Oficiální normy publikovány nejsou.';
const GRIT_DISCLAIMER = 'Limity: dle autorky škály (A. Duckworth) není Grit Scale určena k výběru zaměstnanců a nemá publikované normy — percentil je jen orientační. Skóre se výrazně překrývá s pečlivostí; prediktivně bývá užitečnější vytrvalost úsilí. Výsledek je sebehodnocení — používat jako doplňkový podklad k rozhovoru a adaptaci, nikdy jako cut-off či jediné kritérium (čl. 22 GDPR).';
function jssPasmoFacet(s) { return s <= 12 ? 'nespokojenost' : (s >= 16 ? 'spokojenost' : 'neutrální'); }
function jssPasmoTotal(t) { return t <= 108 ? 'převažuje nespokojenost' : (t >= 144 ? 'převažuje spokojenost' : 'smíšený / neutrální postoj'); }
function tw44UspesnostSrv(rec) {
  let f = 0, a = 0; const st = rec.subtests || {};
  Object.keys(st).forEach(k => { const s = st[k] || {}; f += (s.found || 0); a += (s.found || 0) + (s.miss || 0) + (s.notfound || 0); });
  return { found: f, pct: a ? Math.round(f / a * 100) : 0 };
}
function tw44Interpretace(ix) {
  const v = [];
  if (ix.zatizeni != null) v.push('Stupeň zátěže ' + ix.zatizeni + ' — ' + (ix.zatizeni <= 0 ? 'pod časovým tlakem výkon neklesá (odolnost vůči stresu)' : ix.zatizeni <= 2 ? 'mírný pokles výkonu pod tlakem (běžná reakce)' : 'výraznější pokles výkonu pod časovým tlakem — na stres reaguje citlivěji'));
  if (ix.uceni != null) v.push('Vliv učení ' + (ix.uceni > 0 ? '+' : '') + ix.uceni + ' % — ' + (ix.uceni >= 10 ? 'výrazné zlepšení opakováním, rychle se učí' : ix.uceni >= 0 ? 'stabilní výkon, mírný efekt učení' : 'výkon v čase klesal (možná únava či pokles soustředění)'));
  if (ix.produktivita != null) v.push('Produktivita v průběhu testu: ' + (ix.produktivita > 0 ? '+' : '') + ix.produktivita + ' %');
  if (ix.rychlost != null) v.push('Zrychlení reakcí: ' + (ix.rychlost > 0 ? '+' : '') + ix.rychlost + ' %');
  if (ix.stabilita != null) v.push('Stabilita výkonu: ' + (ix.stabilita > 0 ? '+' : '') + ix.stabilita + ' %');
  return v;
}
function surveyVysledekRadky(kind, rec) {
  if (kind === 'grit') {
    const pc = gritPasmo(rec.hs); const ak = GRIT_AKCE_SRV[pc];
    const r = [
      ['Celkové GRIT (1–5)', String(rec.hs).replace('.', ',') + ' — pásmo ' + ({ nizke: 'nízké (1,0–2,9)', stredni: 'střední (3,0–3,9)', vysoke: 'vysoké (4,0–5,0)' })[pc]],
      ['Text do reportu — celkové skóre', GRIT_TXT.celkove[pc]],
    ];
    if (rec.kz != null) r.push(['Konzistence zájmů (1–5)', String(rec.kz).replace('.', ',')], ['Text do reportu — konzistence', GRIT_TXT.kz[gritPasmo(rec.kz)]]);
    if (rec.vu != null) r.push(['Vytrvalost úsilí (1–5)', String(rec.vu).replace('.', ',')], ['Text do reportu — vytrvalost', GRIT_TXT.vu[gritPasmo(rec.vu)]]);
    const profil = gritProfilVetaSrv(rec.kz, rec.vu);
    if (profil) r.push(['Profil subškál', profil]);
    r.push(
      ['Pravděpodobný obraz kandidáta', ak.obraz],
      ['Jak komunikovat', ak.kom],
      ['Rozvoj / onboarding', ak.onb],
      ['Role-fit', ak.fit],
      ['Otázky do rozhovoru', ak.ot],
      ['Cíle ve zkušební době', ak.cile],
      ['Co měřit', ak.mer],
      ['Orientační percentil', rec.pct + ' % (bez publikovaných norem — jen orientačně)'],
      ['Benchmark', GRIT_BENCHMARK_SRV],
      ['Upozornění', GRIT_DISCLAIMER]
    );
    return r;
  }
  if (kind === 'jss') {
    const r = [
      ['Celkové skóre (36–216)', rec.total + ' — ' + jssPasmoTotal(rec.total)],
      ['Spokojenost', rec.pct + ' %'],
      ['Pozice', rec.pozice || '—'], ['Zařazení', rec.zarazeni || '—'], ['Středisko', rec.stredisko || '—'], ['Na pozici', rec.delka || '—'],
    ];
    (rec.subs || []).forEach(s => r.push([s.name + ' (4–24)', s.score + ' — ' + jssPasmoFacet(s.score)]));
    return r;
  }
  if (kind === 'vykresy') {
    const r = [
      ['Výsledek', rec.skore + ' / ' + rec.otazekCelkem + ' správně (' + rec.procenta + ' %)'],
      ['Hodnocení', rec.hodnoceni || VYKRESY_HODNOCENI[vykresyPasmo(rec.procenta)]],
    ];
    if (rec.pozice) r.push(['Pozice', rec.pozice]);
    r.push(['Čas', vykresyFmtCas(rec.casPouzityS) + ' / limit ' + vykresyFmtCas(rec.limitS) + (rec.casVyprsel ? ' — čas vypršel (nezodpovězené = chybné)' : '')]);
    (rec.oblasti || []).forEach(o => r.push(['Oblast — ' + o.oblast, o.spravne + ' / ' + o.celkem]));
    const chyby = (rec.odpovedi || []).filter(o => !o.spravne);
    if (chyby.length) r.push(['Chybné otázky', chyby.map(o => 'č. ' + o.otazka + ' (' + o.oblast + ')').join(' · ')]);
    r.push(['Doporučení', VYKRESY_DOPORUCENI[vykresyPasmo(rec.procenta)]],
      ['Upozornění', 'Orientační výsledek — doporučujeme doplnit krátkým pohovorem nad reálným firemním výkresem.']);
    return r;
  }
  if (kind === 'logika') {
    const r = [
      ['Výsledek', rec.skore + ' / ' + rec.otazekCelkem + ' správně (' + rec.procenta + ' %)'],
      ['Hodnocení', rec.hodnoceni || LOGIKA_HODNOCENI[logikaPasmo(rec.procenta)]],
    ];
    if (rec.pozice) r.push(['Pozice', rec.pozice]);
    r.push(['Čas', vykresyFmtCas(rec.casPouzityS) + ' / limit ' + vykresyFmtCas(rec.limitS) + (rec.casVyprsel ? ' — čas vypršel (nezodpovězené = chybné)' : '')]);
    (rec.oblasti || []).forEach(o => r.push(['Oblast — ' + o.oblast, o.spravne + ' / ' + o.celkem]));
    const chyby = (rec.odpovedi || []).filter(o => !o.spravne);
    if (chyby.length) r.push(['Chybné úlohy', chyby.map(o => 'č. ' + o.otazka + ' (' + o.oblast + ')').join(' · ')]);
    r.push(['Doporučení', LOGIKA_DOPORUCENI[logikaPasmo(rec.procenta)]],
      ['Upozornění', 'Test měří úsudek, ne znalosti. Doporučujeme projít 1–2 chybné úlohy na pohovoru — zajímá nás, JAK kandidát přemýšlel.']);
    return r;
  }
  const su = tw44UspesnostSrv(rec); const ix = rec.indices || {};
  const r = [['Varianta', rec.variant || '—'], ['Nalezené cíle', String(su.found)], ['Úspěšnost hledání', su.pct + ' %']];
  tw44Interpretace(ix).forEach(t => r.push(['Index', t]));
  if (rec.attr) r.push(['Doplněk – hledání písmene „' + (rec.attr.letter || '?') + '"', (rec.attr.found || 0) + ' z ' + (rec.attr.total || 0) + (rec.attr.miss ? ' (chybně ' + rec.attr.miss + ')' : '')]);
  return r;
}
async function poslatHrVysledek(kind, rec) {
  try {
    if (!emailConfigured() || !rec || rec.blocked) return;
    const s = getState(); const hr = ((s.settings || {}).hrEmail || '').trim();
    if (!hr) return;
    const nazev = SURVEY_NAZVY[kind] || kind;
    const radky = surveyVysledekRadky(kind, rec);
    const subject = 'Výsledek: ' + (rec.name || rec.email) + ' — ' + nazev;
    const text = nazev + '\n' + (rec.name || '') + ' <' + rec.email + '>' + (rec.dept && rec.dept !== '—' ? ' · ' + rec.dept : '') + '\n' +
      new Date(rec.ts).toLocaleString('cs-CZ') + '\n\n' + radky.map(x => x[0] + ': ' + x[1]).join('\n') +
      '\n\nDetail s interpretací: https://intranet.elkoplast.cz/admin (Průzkumy)';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1c1d1a;line-height:1.5">' +
      '<h2 style="font-size:17px;margin:0 0 4px">' + esc(nazev) + '</h2>' +
      '<p style="margin:0 0 14px"><strong>' + esc(rec.name || rec.email) + '</strong> &lt;' + esc(rec.email) + '&gt;' +
      (rec.dept && rec.dept !== '—' ? ' · ' + esc(rec.dept) : '') + '<br><span style="color:#77796f">' + new Date(rec.ts).toLocaleString('cs-CZ') + '</span></p>' +
      '<table style="border-collapse:collapse">' + radky.map(x =>
        '<tr><td style="border:1px solid #dcdbd4;padding:6px 10px;background:#faf9f6;font-weight:bold;white-space:nowrap">' + esc(x[0]) + '</td>' +
        '<td style="border:1px solid #dcdbd4;padding:6px 10px">' + esc(x[1]) + '</td></tr>').join('') + '</table>' +
      '<p style="margin-top:14px;font-size:12px;color:#77796f">Automatická zpráva intranetu — plný detail v administraci, záložka Průzkumy.</p></div>';
    await deliver({ to: hr, subject, text, html });
    logActivity('survey-mail', { email: rec.email, name: rec.name }, 'Výsledek (' + nazev + ') odeslán na HR: ' + hr);
  } catch (e) { try { logActivity('survey-mail-chyba', { email: (rec || {}).email || '', name: '' }, String(e.message || e)); } catch (_) {} }
}

// Report průzkumu jako HTML e-mail (ruční odeslání z detailu; sdílí řádky s automatickým HR mailem).
function surveyReportHtml(kind, rec, poznamka) {
  const nazev = SURVEY_NAZVY[kind] || kind;
  const radky = surveyVysledekRadky(kind, rec);
  const pozn = (poznamka || '').trim();
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1c1d1a;line-height:1.55;max-width:720px">' +
    '<div style="background:#11271c;color:#eef3ee;padding:16px 20px;border-radius:10px 10px 0 0"><h2 style="margin:0;font-size:18px">' + esc(nazev) + '</h2>' +
    '<div style="color:#9fd9b6;font-size:13px;margin-top:3px">Report kandidáta / zaměstnance</div></div>' +
    '<div style="border:1px solid #dcdbd4;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">' +
    '<p style="margin:0 0 14px"><strong style="font-size:15px">' + esc(rec.name || rec.email) + '</strong> &lt;' + esc(rec.email) + '&gt;' +
    (rec.dept && rec.dept !== '—' ? ' · ' + esc(rec.dept) : '') + '<br><span style="color:#77796f">vyplněno ' + new Date(rec.ts).toLocaleString('cs-CZ') + '</span></p>' +
    (pozn ? '<p style="background:#f0f6f2;border-left:3px solid #2d7a52;padding:8px 12px;margin:0 0 14px;font-style:italic">' + esc(pozn) + '</p>' : '') +
    '<table style="border-collapse:collapse;width:100%">' + radky.map(x =>
      '<tr><td style="border:1px solid #dcdbd4;padding:7px 11px;background:#faf9f6;font-weight:bold;white-space:nowrap;vertical-align:top">' + esc(x[0]) + '</td>' +
      '<td style="border:1px solid #dcdbd4;padding:7px 11px">' + esc(x[1]) + '</td></tr>').join('') + '</table>' +
    '<p style="margin-top:16px;font-size:12px;color:#77796f">Interní podklad HR — ELKOPLAST CZ. Doplňková informace ze sebehodnocení, nikoli samostatné selekční kritérium. Plný interaktivní detail: intranet.elkoplast.cz → Průzkumy.</p></div></div>';
}
function surveyRec(kind, email) {
  const f = kind === 'jss' ? JSS_F : kind === 'tw44' ? TW44_F : kind === 'vykresy' ? VYKRESY_F : kind === 'logika' ? LOGIKA_F : GRIT_F;
  return readJson(f, []).find(r => (r.email || '').toLowerCase() === String(email || '').toLowerCase());
}

// ABROLL školení – závěrečný test. Jeden záznam na e-mail, pole attempts[] (max 3 pokusy).
const ABROLL_MAX = 3;
function abrollStatus(email) {
  email = (email || '').toLowerCase();
  const rec = readJson(ABROLL_F, []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, ABROLL_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordAbroll(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(ABROLL_F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= ABROLL_MAX) { writeJson(ABROLL_F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(ABROLL_F, results);
  logActivity('abroll', { email, name }, 'Test ABROLL · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, ABROLL_MAX - rec.attempts.length), passed };
}
// Test znalosti produktů (školení obchodníků) – jeden záznam na e-mail, pole attempts[] (max 3 pokusy).
// Dvě samostatná školení: KOVO (ocelové výrobky) a ROTO (plastové výrobky) — každé má vlastní soubor výsledků.
const PRODUKTY_MAX = 3;
function produktyType(t) { return (String(t || '').toLowerCase() === 'roto') ? 'roto' : 'kovo'; }
function produktyFile(t) { return path.join(DATA_DIR, 'produkty-' + produktyType(t) + '-results.json'); }
const PRODUKTY_TYP_NAZEV = { kovo: 'Produkty KOVO', roto: 'Produkty ROTO' };
function produktyStatus(email, type) {
  email = (email || '').toLowerCase();
  const rec = readJson(produktyFile(type), []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, PRODUKTY_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordProdukty(a) {
  const type = produktyType(a.type);
  const F = produktyFile(type);
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= PRODUKTY_MAX) { writeJson(F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(F, results);
  logActivity('produkty', { email, name }, 'Test ' + PRODUKTY_TYP_NAZEV[type] + ' · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, PRODUKTY_MAX - rec.attempts.length), passed };
}
// Školení Průmysl (obchodník: skladování, Li-Ion baterie, ADR) – závěrečný test. Jeden záznam na e-mail, pole attempts[] (max 3 pokusy).
const PRUMYSL_MAX = 3;
function prumyslStatus(email) {
  email = (email || '').toLowerCase();
  const rec = readJson(PRUMYSL_F, []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, PRUMYSL_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordPrumysl(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(PRUMYSL_F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= PRUMYSL_MAX) { writeJson(PRUMYSL_F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(PRUMYSL_F, results);
  logActivity('prumysl', { email, name }, 'Test Průmysl · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, PRUMYSL_MAX - rec.attempts.length), passed };
}
// Školení LOXXER (obchodník: protipožární skříně na Li-Ion baterie) – závěrečný test. Jeden záznam na e-mail, pole attempts[] (max 3 pokusy).
const LOXXER_SKOLENI_MAX = 3;
function loxxerSkoleniStatus(email) {
  email = (email || '').toLowerCase();
  const rec = readJson(LOXXER_SKOLENI_F, []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, LOXXER_SKOLENI_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordLoxxerSkoleni(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(LOXXER_SKOLENI_F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= LOXXER_SKOLENI_MAX) { writeJson(LOXXER_SKOLENI_F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(LOXXER_SKOLENI_F, results);
  logActivity('loxxer-skoleni', { email, name }, 'Test LOXXER · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, LOXXER_SKOLENI_MAX - rec.attempts.length), passed };
}
// Školení ACTS (železniční abroll kontejnery) – závěrečný test. Jeden záznam na e-mail, pole attempts[] (max 3 pokusy).
const ACTS_SKOLENI_MAX = 3;
function actsSkoleniStatus(email) {
  email = (email || '').toLowerCase();
  const rec = readJson(ACTS_SKOLENI_F, []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, ACTS_SKOLENI_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordActsSkoleni(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(ACTS_SKOLENI_F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= ACTS_SKOLENI_MAX) { writeJson(ACTS_SKOLENI_F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(ACTS_SKOLENI_F, results);
  logActivity('acts-skoleni', { email, name }, 'Test ACTS · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, ACTS_SKOLENI_MAX - rec.attempts.length), passed };
}
// Školení ZENTEX (lisovací kontejnery — výběr vhodného lisu) – závěrečný test 20 z 50 otázek. Jeden záznam na e-mail, pole attempts[] (max 3 pokusy).
const ZENTEX_SKOLENI_MAX = 3;
function zentexSkoleniStatus(email) {
  email = (email || '').toLowerCase();
  const rec = readJson(ZENTEX_SKOLENI_F, []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, ZENTEX_SKOLENI_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordZentexSkoleni(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(ZENTEX_SKOLENI_F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= ZENTEX_SKOLENI_MAX) { writeJson(ZENTEX_SKOLENI_F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(ZENTEX_SKOLENI_F, results);
  logActivity('zentex-skoleni', { email, name }, 'Test ZENTEX · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, ZENTEX_SKOLENI_MAX - rec.attempts.length), passed };
}
// Školení Třídicí linky (technologie, trh a ekonomika dotřídění) – závěrečný test. Jeden záznam na e-mail, pole attempts[] (max 3 pokusy).
const TRIDICI_SKOLENI_MAX = 3;
function tridiciSkoleniStatus(email) {
  email = (email || '').toLowerCase();
  const rec = readJson(TRIDICI_SKOLENI_F, []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, TRIDICI_SKOLENI_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordTridiciSkoleni(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(TRIDICI_SKOLENI_F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= TRIDICI_SKOLENI_MAX) { writeJson(TRIDICI_SKOLENI_F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(TRIDICI_SKOLENI_F, results);
  logActivity('tridici-linky-skoleni', { email, name }, 'Test Třídicí linky · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, TRIDICI_SKOLENI_MAX - rec.attempts.length), passed };
}
// Školení Čtení technických výkresů (ČSN/ISO) – závěrečný test. Jeden záznam na e-mail, pole attempts[] (max 3 pokusy).
const VYKRESY_SKOLENI_MAX = 3;
function vykresySkoleniStatus(email) {
  email = (email || '').toLowerCase();
  const rec = readJson(VYKRESY_SKOLENI_F, []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, VYKRESY_SKOLENI_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordVykresySkoleni(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(VYKRESY_SKOLENI_F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= VYKRESY_SKOLENI_MAX) { writeJson(VYKRESY_SKOLENI_F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(VYKRESY_SKOLENI_F, results);
  logActivity('vykresy-skoleni', { email, name }, 'Test Čtení výkresů · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, VYKRESY_SKOLENI_MAX - rec.attempts.length), passed };
}
// Školení Průvodce svařováním (ISO 5817) – závěrečný test. Jeden záznam na e-mail; test je JEDNORÁZOVÝ (1 pokus, bez opakování).
const SVAROVANI_SKOLENI_MAX = 1;
function svarovaniSkoleniStatus(email) {
  email = (email || '').toLowerCase();
  const rec = readJson(SVAROVANI_SKOLENI_F, []).find(r => (r.email || '').toLowerCase() === email);
  const attempts = (rec && Array.isArray(rec.attempts)) ? rec.attempts : [];
  const best = attempts.reduce((m, a) => Math.max(m, a.pct || 0), 0);
  return { attemptsUsed: attempts.length, attemptsLeft: Math.max(0, SVAROVANI_SKOLENI_MAX - attempts.length), best, passed: attempts.some(a => a.passed) };
}
function recordSvarovaniSkoleni(a) {
  const email = (a.email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [], categories: [] });
  const emp = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  const name = emp ? (emp.name || email) : (a.name || email);
  let dept = '—';
  if (emp && emp.cats && emp.cats.length) { const c = (s.categories || []).find(x => x.id === emp.cats[0]); dept = c ? c.name : '—'; }
  const total = Math.max(0, Math.round(Number(a.total) || 0));
  const correct = Math.max(0, Math.min(total, Math.round(Number(a.correct) || 0)));
  const pct = Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0)));
  const passed = pct >= 80;
  const results = readJson(SVAROVANI_SKOLENI_F, []);
  let rec = results.find(r => (r.email || '').toLowerCase() === email);
  if (!rec) { rec = { email, name, dept, attempts: [] }; results.push(rec); }
  rec.name = name; rec.dept = dept; if (!Array.isArray(rec.attempts)) rec.attempts = [];
  if (rec.attempts.length >= SVAROVANI_SKOLENI_MAX) { writeJson(SVAROVANI_SKOLENI_F, results); return { blocked: true, attemptsUsed: rec.attempts.length }; }
  rec.attempts.push({ correct, total, pct, passed, ts: Date.now() });
  writeJson(SVAROVANI_SKOLENI_F, results);
  logActivity('svarovani-skoleni', { email, name }, 'Test Průvodce svařováním · pokus ' + rec.attempts.length + ' · ' + pct + ' %' + (passed ? ' · splněno' : ''));
  return { ok: true, attempt: rec.attempts.length, attemptsLeft: Math.max(0, SVAROVANI_SKOLENI_MAX - rec.attempts.length), passed };
}
// Klíče modulů, ke kterým má zaměstnanec přístup (přiděluje správce v administraci).
function employeeModules(email) {
  email = (email || '').toLowerCase();
  const s = readJson(STATE_F, { employees: [] });
  const e = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
  return (e && Array.isArray(e.modules)) ? e.modules : [];
}
// Smí uživatel zadávat aktuality a měnit banner? = má modul „aktuality" nebo je správce.
function canPostAktuality(req) {
  const e = empSession(req); if (!e) return false;
  if (isAdmin(req)) return true;
  return employeeModules(e.email).indexOf('aktuality') >= 0;
}
// Uloží obrázek z data URL (base64) do UPLOADS_DIR a vrátí veřejnou cestu /uploads/<jméno>. Vrací null pro neplatný vstup.
function saveDataUrlImage(dataUrl) {
  let m = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  let buf;
  if (m) { buf = Buffer.from(m[2], 'base64'); }
  else {
    // SVG přichází i jako data:image/svg+xml;utf8,… nebo ;charset=utf-8,… (ne base64)
    const sv = /^data:image\/svg\+xml(?:;[^,]*)?,([\s\S]+)$/.exec(dataUrl || '');
    if (!sv) return null;
    m = [null, 'svg+xml']; buf = Buffer.from(decodeURIComponent(sv[1]), 'utf8');
  }
  const ext = m[1] === 'jpeg' ? 'jpg' : (m[1] === 'svg+xml' ? 'svg' : m[1]);
  if (buf.length > 8e6) throw new Error('Obrázek je příliš velký (max 8 MB).');
  const fn = crypto.randomBytes(8).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, fn), buf);
  return '/uploads/' + fn;
}
// Orientace PDF podle prvního /MediaBox (+ /Rotate). Vrací 'landscape' | 'portrait' | '' (nezjištěno).
function pdfOrientation(buf) {
  try {
    const head = buf.slice(0, Math.min(buf.length, 500000)).toString('latin1');
    const m = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(head);
    if (!m) return '';
    let w = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
    let h = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
    const r = /\/Rotate\s+(-?\d+)/.exec(head);
    if (r) { const deg = ((parseInt(r[1], 10) % 360) + 360) % 360; if (deg === 90 || deg === 270) { const t = w; w = h; h = t; } }
    if (!w || !h) return '';
    return w > h * 1.03 ? 'landscape' : 'portrait';
  } catch (_) { return ''; }
}
// Uloží PDF z data URL do UPLOADS_DIR a vrátí veřejnou cestu /uploads/<jméno>.pdf.
function saveDataUrlPdf(dataUrl) {
  const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length) return null;
  if (buf.length > 8e6) throw new Error('PDF je příliš velké (max 8 MB).');
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new Error('Soubor není platné PDF.');
  const fn = crypto.randomBytes(8).toString('hex') + '.pdf';
  fs.writeFileSync(path.join(UPLOADS_DIR, fn), buf);
  return '/uploads/' + fn;
}
function deleteUpload(pub) { if (pub && pub.indexOf('/uploads/') === 0) { try { fs.unlinkSync(path.join(UPLOADS_DIR, pub.slice(9).replace(/[^a-zA-Z0-9._-]/g, ''))); } catch (_) {} } }

/* ============================================================
   Kalkulace KOVO (modul „kovokalk") — variabilní kalkulačka nacenění
   ------------------------------------------------------------
   Jeden výpočetní motor pro všechny řady: materiál (+odpad) → mzdy
   (×odvody) → režie → povrch (zinek/lak) → VPC → PC → EUR.
   Parametry i výrobky spravuje správce v aplikaci; každá změna
   hodnoty parametru dostane razítko (updatedAt/updatedBy), z něhož
   kalkulačka počítá semafor aktuálnosti. Seed = hodnoty a data
   zdrojových sešitů z auditu složky PRODUCTS (7/2026).
   ============================================================ */
const KOVOKALK_SEED = {
  params: {
    kurzEUR:    { label: 'Kurz EUR', unit: 'CZK/EUR', v: 24.5, src: 'Kalkulace průměr Muldy DIN+CH / bedny Contracts', note: 'jinde 23,5–26; tlačítkem lze převzít denní kurz ČNB', updatedAt: Date.UTC(2024, 7, 15), updatedBy: 'seed (audit 7/2026)' },
    kurzPLN:    { label: 'Kurz PLN', unit: 'CZK/PLN', v: 5.9, src: 'Kalkulace muldy DIN 2024', note: '', updatedAt: Date.UTC(2024, 7, 15), updatedBy: 'seed (audit 7/2026)' },
    matS235:    { label: 'Ocel S235', unit: 'Kč/kg', v: 24, src: 'Kalkulace ABR-DSD / AFS', note: 'rozpor 17,5 (HBI) až 25 (CSD) napříč sešity', updatedAt: Date.UTC(2026, 5, 3), updatedBy: 'seed (audit 7/2026)' },
    matHardox:  { label: 'Hardox 450', unit: 'Kč/kg', v: 44, src: 'Kalkulace ABR-HBI-TSR', note: '', updatedAt: Date.UTC(2025, 0, 21), updatedBy: 'seed (audit 7/2026)' },
    matQstE:    { label: 'QStE 690', unit: 'Kč/kg', v: 40, src: 'Kalkulace ABR-HBI-TSR', note: '', updatedAt: Date.UTC(2025, 0, 21), updatedBy: 'seed (audit 7/2026)' },
    matProfily: { label: 'Profily / IPN / UPN', unit: 'Kč/kg', v: 25, src: 'Kalkulace ABR-HBI-TSR (IPN/UPN 22, profily 25)', note: '', updatedAt: Date.UTC(2025, 0, 21), updatedBy: 'seed (audit 7/2026)' },
    matVypalky: { label: 'Výpalky', unit: 'Kč/kg', v: 37.5, src: 'Kalkulace ABR-HBI-TSR (35–40)', note: '', updatedAt: Date.UTC(2025, 0, 21), updatedBy: 'seed (audit 7/2026)' },
    odpad:      { label: 'Odpad materiálu', unit: '%', v: 5, src: 'konvence všech kalkulací (skutečnost 3–15 % dle rozborů odpadu)', note: '', updatedAt: Date.UTC(2026, 5, 3), updatedBy: 'seed (audit 7/2026)' },
    odvody:     { label: 'Odvody z mezd', unit: '%', v: 50, src: 'všechny sešity (×1,5)', note: 'legislativní', updatedAt: Date.UTC(2026, 5, 3), updatedBy: 'seed (audit 7/2026)' },
    rezieCZ:    { label: 'Režie výroba CZ', unit: '% z hrubých mezd', v: 150, src: 'ABR / CITY-CSD / GSK', note: 'jinde 75–130 % — 4 modely bez psané metodiky', updatedAt: Date.UTC(2026, 5, 3), updatedBy: 'seed (audit 7/2026)' },
    reziePL:    { label: 'Režie výroba PL', unit: '% z hrubých mezd', v: 110, src: 'CITY WDG/CSD (Elkoplast PL)', note: '', updatedAt: Date.UTC(2026, 3, 16), updatedBy: 'seed (audit 7/2026)' },
    zinek:      { label: 'Zinkování', unit: 'Kč/kg', v: 15, src: 'Kalkulace bedny Contracts (vč. dopravy do zinkovny)', note: 'starší řady počítají 12,5 (2022) a 11 (2019)', updatedAt: Date.UTC(2026, 4, 12), updatedBy: 'seed (audit 7/2026)' },
    barvaZaklad:{ label: 'Barva — základ', unit: 'Kč/kg', v: 65, src: 'Kalkulace ABR-DSD', note: 'rozptyl 50–80 napříč živými sešity', updatedAt: Date.UTC(2026, 5, 3), updatedBy: 'seed (audit 7/2026)' },
    barvaVrch:  { label: 'Barva — vrchní lak', unit: 'Kč/kg', v: 110, src: 'Kalkulace ABR-DSD', note: 'rozptyl 100–120', updatedAt: Date.UTC(2026, 5, 3), updatedBy: 'seed (audit 7/2026)' },
    dopravaPL:  { label: 'Doprava PL → Bruntál', unit: 'Kč/ks', v: 1500, src: 'Kalkulace muldy DIN 2024', note: '', updatedAt: Date.UTC(2026, 3, 21), updatedBy: 'seed (audit 7/2026)' },
    marzeVPC:   { label: 'Marže VPC', unit: '%', v: 10, src: 'ABR 10 % · CITY/bedny 12 % · PL 10 % · Bruntál dolak. 3–5 %', note: 'nepsaná politika', updatedAt: Date.UTC(2026, 5, 3), updatedBy: 'seed (audit 7/2026)' },
    prirazkaPC: { label: 'Ceníková přirážka PC', unit: '%', v: 10, src: 'per zákazník 3–15 % (Renewi 15, Geesink 3–5)', note: 'historicky vyjednáno, bez pravidla', updatedAt: Date.UTC(2018, 5, 1), updatedBy: 'seed (audit 7/2026)' },
  },
  products: [
    { id: 'najezd5000', name: 'Nájezd kontejnerový 5000', rada: 'Nájezdy', mat: [{ p: 'matS235', kg: 336 }], nakup: 0, mzdy: 1050, misto: 'CZ', povrch: 'zinek', znGain: 1.03, barvaKg: 0, dopravaKc: 0, dataDate: '2026-03', src: 'Najezdy kalkkulace guiding rails.xlsx', refCzk: 18497, refLabel: 'VPC', refDate: '2026-03' },
    { id: 'cpr8', name: 'Bedna CPR 8/2,5 öla', rada: 'Bedny Contracts', mat: [{ p: 'matS235', kg: 111 }], nakup: 350, mzdy: 850, misto: 'CZ', povrch: 'zinek', znGain: 1.08, barvaKg: 0, dopravaKc: 0, dataDate: '2026-05', src: 'Kalkulace bedny Contracts (hmotnosti: Hmotnosti zinku 3/2018)', refCzk: null, refLabel: '', refDate: '' },
    { id: 'amch95', name: 'Mulda AM-CH-9,5 (644 kg)', rada: 'Muldy CH', mat: [{ p: 'matS235', kg: 644 }], nakup: 400, mzdy: 1900, misto: 'CZ', povrch: 'lak', znGain: 1, barvaKg: 18, dopravaKc: 0, dataDate: '2026-06', src: 'Kalkulace muldy CH 2024 + Správné značení muld', refCzk: null, refLabel: '', refDate: '' },
    { id: 'sld35', name: 'SLD SM 3,5', rada: 'SLD', mat: [{ p: 'matS235', kg: 720 }], nakup: 600, mzdy: 1320, misto: 'CZ', povrch: 'lak', znGain: 1, barvaKg: 25, dopravaKc: 0, dataDate: '2025-04', src: 'Kalkulace SLD ver 201902 (normy práce 1 320 Kč/ks)', refCzk: 16000, refLabel: 'VPC (odhad z ceníku 2019)', refDate: '2019-02' },
    { id: 'asp800', name: 'ASP 800 pozink', rada: 'ASP', mat: [{ p: 'matS235', kg: 182 }], nakup: 500, mzdy: 2000, misto: 'CZ', povrch: 'zinek', znGain: 1.05, barvaKg: 0, dopravaKc: 0, dataDate: '2019-03', src: 'Kalkulace ASP 800 ver 201902 (poslední nákladový rozpad!)', refCzk: 14460, refLabel: 'VPC ceník', refDate: '2026-06' },
    { id: 'cla1100', name: 'CLA 1100 pozink', rada: 'CLA 1100', mat: [{ p: 'matS235', kg: 104 }], nakup: 600, mzdy: 342, misto: 'CZ', povrch: 'zinek', znGain: 1.06, barvaKg: 0, dopravaKc: 0, dataDate: '2016-07', src: 'Kalkulace 1100 l bez vík stohovatelné (2016)', refCzk: 6076, refLabel: 'PC ceník 248 €', refDate: '2018-06' },
    { id: 'hbi18', name: 'ABR-HBI-TSR 18 m³ (Hardox)', rada: 'ABR / hardox', mat: [{ p: 'matHardox', kg: 1700 }, { p: 'matS235', kg: 510 }], nakup: 2500, mzdy: 23000, misto: 'CZ', povrch: 'lak', znGain: 1, barvaKg: 85, dopravaKc: 0, dataDate: '2025-01', src: 'Kalkulace ABR-HBI-TSR-18+36cbm (ceny mat. 21.1.2025)', refCzk: 190000, refLabel: 'VPC', refDate: '2025-01' },
  ],
};
function readKovoKalk() {
  let d = readJson(KOVOKALK_F, null);
  if (!d || !d.params || !Array.isArray(d.products)) { d = JSON.parse(JSON.stringify(KOVOKALK_SEED)); writeJson(KOVOKALK_F, d); }
  return d;
}
// Uloží parametry/výrobky; parametr se změněnou hodnotou dostane razítko změny (kdo + kdy).
function saveKovoKalk(body, who) {
  const cur = readKovoKalk();
  if (body.params && typeof body.params === 'object') {
    for (const k of Object.keys(body.params)) {
      const n = body.params[k]; if (!n || typeof n !== 'object') continue;
      const o = cur.params[k] || {};
      const nv = Number(n.v);
      if (!isFinite(nv)) continue;
      const changed = !o.updatedAt || Number(o.v) !== nv;
      cur.params[k] = {
        label: (n.label !== undefined ? n.label : o.label) || k,
        unit: (n.unit !== undefined ? n.unit : o.unit) || '',
        v: nv,
        src: (n.src !== undefined ? n.src : o.src) || '',
        note: (n.note !== undefined ? n.note : o.note) || '',
        updatedAt: changed ? Date.now() : o.updatedAt,
        updatedBy: changed ? (who || 'admin') : (o.updatedBy || ''),
      };
    }
  }
  if (Array.isArray(body.products)) {
    cur.products = body.products
      .filter(x => x && typeof x === 'object' && x.name)
      .map(x => ({
        id: String(x.id || ('p' + crypto.randomBytes(4).toString('hex'))),
        name: String(x.name).slice(0, 120), rada: String(x.rada || '').slice(0, 80),
        mat: (Array.isArray(x.mat) ? x.mat : []).map(m => ({ p: String(m.p || 'matS235'), kg: Number(m.kg) || 0 })),
        nakup: Number(x.nakup) || 0, mzdy: Number(x.mzdy) || 0,
        misto: x.misto === 'PL' ? 'PL' : 'CZ',
        povrch: (x.povrch === 'lak' || x.povrch === 'zadny') ? x.povrch : 'zinek',
        znGain: Number(x.znGain) || 1.05, barvaKg: Number(x.barvaKg) || 0, dopravaKc: Number(x.dopravaKc) || 0,
        dataDate: String(x.dataDate || '').slice(0, 7), src: String(x.src || '').slice(0, 200),
        refCzk: (x.refCzk === null || x.refCzk === undefined || x.refCzk === '') ? null : Number(x.refCzk),
        refLabel: String(x.refLabel || '').slice(0, 80), refDate: String(x.refDate || '').slice(0, 7),
      }));
  }
  writeJson(KOVOKALK_F, cur);
  return cur;
}
// Denní kurzovní lístek ČNB (EUR, PLN) — cache 6 h; při výpadku vrací null a kalkulačka
// zůstane u ručně nastaveného kurzu.
let cnbCache = { at: 0, data: null };
function fetchCnbKurz() {
  return new Promise((resolve) => {
    if (cnbCache.data && Date.now() - cnbCache.at < 6 * 3600 * 1000) return resolve(cnbCache.data);
    const rq = https.get('https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt', (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const lines = d.split('\n');
          const out = { date: (lines[0] || '').split(' ')[0] || '' };
          for (const ln of lines) {
            const p = ln.split('|'); if (p.length < 5) continue;
            const mn = parseFloat(String(p[2]).replace(',', '.')) || 1;
            const kurz = parseFloat(String(p[4]).replace(',', '.'));
            if (p[3] === 'EUR' && isFinite(kurz)) out.eur = Math.round(kurz / mn * 1000) / 1000;
            if (p[3] === 'PLN' && isFinite(kurz)) out.pln = Math.round(kurz / mn * 1000) / 1000;
          }
          if (out.eur) { cnbCache = { at: Date.now(), data: out }; return resolve(out); }
          resolve(null);
        } catch (_) { resolve(null); }
      });
    });
    rq.on('error', () => resolve(null));
    rq.setTimeout(10000, () => { try { rq.destroy(); } catch (_) {} resolve(null); });
  });
}

/* ============================================================
   Úkoly ze směrnic (záložka „Úkoly ze směrnic")
   ------------------------------------------------------------
   Závazky vytažené ze směrnic a vnitřních pokynů na Disku
   (Pracovní řád, E-IS-*, P-*). Seed = výchozí seznam; stav plnění
   a poznámky mění správce v intranetu → data/smernice-ukoly.json.
   kat: jednorazove (zavést/napravit) | rocni | prubezne
   stav: '' (neověřeno) | plni | neplni | splneno
   ============================================================ */
const UKOLY_SEED = [
  // — jednorázové: zavést či napravit —
  { id: 'eticky-dotaznik', kat: 'jednorazove', termin: '2025-12-31',
    ukol: 'Zavést etický dotazník pro klíčové dodavatele',
    jak: 'Sestavit dotazník (zákaz dětské a nucené práce, pracovní standardy), rozeslat klíčovým dodavatelům a vyhodnotit odpovědi. Termín byl „nejpozději do konce roku 2025".',
    kdo: 'Vedení + oddělení nákupu', zdroj: 'P-04 Prevence dětské a nucené práce' },
  { id: 'cile-bozp', kat: 'jednorazove',
    ukol: 'Aktualizovat kvantitativní cíle BOZP (stanovené jen pro rok 2024)',
    jak: 'Revize směrnice: stanovit cíle pro aktuální rok (počet úrazů, % proškolených, prověrky) a nechat schválit vedením.',
    kdo: 'Vedoucí BOZP + vedení', zdroj: 'E-IS-15 Politika BOZP' },
  { id: 'gdpr-revize', kat: 'jednorazove',
    ukol: 'Provést roční revizi směrnice o ochraně osobních údajů (od 2021 bez aktualizace)',
    jak: 'Směrnice ukládá roční kontrolu a aktualizaci pověřeným zaměstnancem — provést revizi a zapsat datum aktualizace do hlavičky.',
    kdo: 'Mzdové účetní', zdroj: 'E-IS-10 GDPR, bod 1.3' },
  { id: 'hlaseni-energii', kat: 'jednorazove',
    ukol: 'Zavést systém hlášení spotřeby energií (cíl z roku 2018)',
    jak: 'Ověřit, zda systém vznikl; pokud ne, nastavit pravidelné hlášení spotřeby po střediscích.',
    kdo: 'Vedení / správci provozů', zdroj: 'E-IS-09 Energy Policy' },
  { id: 'hesla-interval', kat: 'jednorazove',
    ukol: 'Stanovit interval povinné změny hesel',
    jak: 'Směrnice vyžaduje „pravidelnou" změnu hesel, ale neurčuje interval — doplnit do směrnice a technicky vynutit.',
    kdo: 'IT — Lucie Sedláčková', zdroj: 'E-IS-17 Informační bezpečnost' },
  { id: 'zalohy-test', kat: 'jednorazove',
    ukol: 'Definovat frekvenci testů obnovitelnosti záloh',
    jak: 'Určit interval (např. čtvrtletně), provést zkušební obnovu ze zálohy a vést záznam o výsledku.',
    kdo: 'IT — Lucie Sedláčková / Jaroslav Ježek', zdroj: 'E-IS-17 Informační bezpečnost' },
  { id: 'prohlidky-evidence', kat: 'jednorazove',
    ukol: 'Zavést evidenci termínů periodických lékařských prohlídek',
    jak: 'Pracovní řád prohlídky vyžaduje (vstupní, periodická, mimořádná, výstupní), ale termíny se nikde nesledují — vést evidenci po zaměstnancích a hlídat expiraci.',
    kdo: 'Personální oddělení', zdroj: 'Pracovní řád, čl. BOZP' },
  { id: 'certifikace-terminy', kat: 'jednorazove',
    ukol: 'Dohledat termíny recertifikace EcoVadis a ISO 14001',
    jak: 'Zjistit platnost certifikátů, na které se směrnice odvolává, a zavést hlídání termínů recertifikačních auditů.',
    kdo: 'Lucie Sedláčková / vedení', zdroj: 'E-IS-14 Prohlášení o udržitelnosti' },
  { id: 'zaznam-zmen', kat: 'jednorazove',
    ukol: 'Obnovit Záznam změn ve směrnicích (poslední zápis 12. 5. 2017)',
    jak: 'Doplnit změny od roku 2017 a při každé nové či aktualizované směrnici provést zápis.',
    kdo: 'Lucie Sedláčková', zdroj: 'Záznam změn ve směrnicích a formulářích' },
  { id: 'rad-vyplata', kat: 'jednorazove',
    ukol: 'Doplnit den výplaty mzdy do Pracovního řádu (číslo dne v textu chybí)',
    jak: 'V kapitole Mzda doplnit konkrétní výplatní den („vyplácena vždy X. dne kalendářního měsíce"); opravit i překlep u pozdních příchodů („0 30 minut").',
    kdo: 'Personální oddělení', zdroj: 'Pracovní řád, kap. Mzda' },
  { id: 'stravovani-novela', kat: 'jednorazove',
    ukol: 'Revidovat směrnici o stravování podle novely zákona o daních z příjmů',
    jak: 'Směrnice cituje znění před rokem 2024 (55 % ceny jídla / 70 % limitu stravného) — sladit s aktuální úpravou stravovacího paušálu.',
    kdo: 'Mzdová účetní', zdroj: 'E-IS-01 Závodní stravování' },
  { id: 'cislovani-eis15', kat: 'jednorazove',
    ukol: 'Opravit duplicitní číslo směrnice E-IS-15 (Komunikace vs. BOZP)',
    jak: 'Soubor „E-IS-16 Komunikace s vedením" má uvnitř hlavičku E-IS-15 Komunikace a dialog — sjednotit číslování a opravit hlavičku; opravit také e-mail s mezerou v E-IS-13.',
    kdo: 'Lucie Sedláčková', zdroj: 'E-IS-16 / E-IS-15 / E-IS-13' },
  // — pravidelné: ročně —
  { id: 'proverka-bozp', kat: 'rocni', frekvence: '1× ročně',
    ukol: 'Prověrka BOZP na všech výrobních pracovištích',
    jak: 'Provést prověrku na každém pracovišti (Zlín, Bruntál, Supíkovice, Chomutov), zjištění zapsat a předat vedení.',
    kdo: 'Vedoucí BOZP + vedoucí středisek', zdroj: 'E-IS-15 Politika BOZP' },
  { id: 'skoleni-bozp', kat: 'rocni', frekvence: '1× ročně',
    ukol: 'Školení BOZP a první pomoci — 100 % zaměstnanců',
    jak: 'Proškolit všechny zaměstnance a vést prezenční listiny; nováčky školit při nástupu.',
    kdo: 'Vedoucí BOZP (+ externí bezpečák)', zdroj: 'E-IS-15 + Pracovní řád' },
  { id: 'skoleni-kyber', kat: 'rocni', frekvence: '1× ročně + při nástupu',
    ukol: 'Školení kyberbezpečnosti pro všechny uživatele systémů',
    jak: 'Každoroční připomenutí a aktualizace znalostí (interní komunikace nebo online školení); noví zaměstnanci při nástupu.',
    kdo: 'Lucie Sedláčková / Jaroslav Ježek', zdroj: 'E-IS-17 + P-05' },
  { id: 'skoronehody-vyhodnoceni', kat: 'rocni', frekvence: 'min. 1× ročně',
    ukol: 'Vyhodnocení knihy skoronehod',
    jak: 'Vyhodnotit evidenci skoronehod po pobočkách a zahrnout výsledky do přezkoumání vedením (ISO 45001).',
    kdo: 'Oddělení BOZP → vedení', zdroj: 'E-IS-18 Skoronehody' },
  { id: 'cile-bozp-report', kat: 'rocni', frekvence: '1× ročně',
    ukol: 'Vyhodnocení cílů BOZP a report vedení',
    jak: 'Vyhodnotit plnění kvantitativních cílů (úrazy, školení, prověrky), reportovat vedení a promítnout do cílů dalšího období.',
    kdo: 'Vedoucí BOZP', zdroj: 'E-IS-15 Politika BOZP' },
  { id: 'odpocet-meridel', kat: 'rocni', frekvence: 'ročně k 1. 1.',
    ukol: 'Odpočet všech měřidel energií v Bruntále',
    jak: 'Odpočet hlavních i podružných měřidel nejbližší pracovní den k 1. 1.; zápis papírově i do excel tabulky u vedoucího výrobního úseku.',
    kdo: 'Vedoucí výrobního úseku Bruntál', zdroj: 'E-IS-08 Rozpočet energií' },
  { id: 'revize-pomeru', kat: 'rocni', frekvence: 'ročně do konce února',
    ukol: 'Revize rozúčtovacího poměru energií mezi střediska',
    jak: 'Podle skutečných odpočtů k 1. 1. upravit procentuální poměr v tabulce Bruntal-energie.xls.',
    kdo: 'Účtárna (Jarmila Šimová)', zdroj: 'E-IS-08 Rozpočet energií' },
  { id: 'vyuctovani-najemnici', kat: 'rocni', frekvence: 'ročně do března',
    ukol: 'Vyúčtování energií externím odběratelům (nájemníkům)',
    jak: 'Podle odpočtu k 1. 1. předložit nájemníkům vyúčtování za předchozí rok; při velkém nárůstu spotřeby zvýšit zálohy.',
    kdo: 'Účtárna', zdroj: 'E-IS-08 Rozpočet energií' },
  { id: 'inventarizace-pohledavek', kat: 'rocni', frekvence: 'ročně k 31. 12.',
    ukol: 'Inventarizace pohledávek',
    jak: 'K 31. 12. zaslat odběratelům seznam neuhrazených faktur.',
    kdo: 'Mirka (účtárna)', zdroj: 'E-IS-03 Pohledávky po splatnosti' },
  // — pravidelné: měsíčně a průběžně —
  { id: 'kontrola-splatnosti', kat: 'prubezne', frekvence: '1× měsíčně',
    ukol: 'Kontrola faktur po splatnosti nad 30 dní',
    jak: 'Rozeslat obchodníkům seznam faktur po splatnosti (ČR i zahraničí), řešit upomínky a zapisovat do tabulky; nad 45 dní předžalobní upomínka, bez úhrady do 10 dnů předat právničce.',
    kdo: 'Jana / Lucka (účtárna)', zdroj: 'E-IS-03 Pohledávky po splatnosti' },
  { id: 'helios-dluznici', kat: 'prubezne', frekvence: 'každých 14 dní',
    ukol: 'Aktualizace skupiny dlužníků v Heliosu',
    jak: 'Aktualizovat skupinu organizací s fakturami nad 30 dní po splatnosti (upozornění při vystavování nové faktury).',
    kdo: 'Lucka (účtárna)', zdroj: 'E-IS-03 Pohledávky po splatnosti' },
  { id: 'insolvence-kontrola', kat: 'prubezne', frekvence: '1× měsíčně',
    ukol: 'Kontrola odběratelů se saldem po splatnosti v insolvenčním rejstříku',
    jak: 'Prověřit insolvenční rejstřík; na velké pohledávky a firmy v insolvenci nastavit hlídacího psa (CESR).',
    kdo: 'Lucka (účtárna)', zdroj: 'E-IS-03 Pohledávky po splatnosti' },
  { id: 'stravovani-podklady', kat: 'prubezne', frekvence: 'měsíčně po uzávěrce',
    ukol: 'Podklady o stravování pro mzdovou účetní',
    jak: 'Po ukončení kalendářního měsíce předložit evidenci strávníků mzdové účetní; úhrada srážkou ze mzdy.',
    kdo: 'Pověřené osoby středisek', zdroj: 'E-IS-01 Závodní stravování' },
  { id: 'dodavatele-proverky', kat: 'prubezne', frekvence: 'průběžně (nový dodavatel)',
    ukol: 'Prověřování nových klíčových dodavatelů',
    jak: 'U nových dodavatelů (zejména mimo EU) prověřit sídlo, právní formu a etické chování; vyžádat potvrzení o dodržování pracovních standardů.',
    kdo: 'Oddělení nákupu', zdroj: 'P-04 Prevence dětské a nucené práce' },
  { id: 'gdpr-pouceni', kat: 'prubezne', frekvence: 'průběžně (při změně)',
    ukol: 'Poučení oprávněných osob o GDPR při změně pracovního zařazení',
    jak: 'Při změně zařazení s dopadem na práci s osobními údaji osobu znovu poučit a sepsat písemný záznam.',
    kdo: 'Mzdové účetní', zdroj: 'E-IS-10 GDPR, bod 2.10' }
];
// Uložený stav + doplnění nových úkolů ze seedu (podle id) — úpravy stavu/poznámek zůstávají.
function readUkoly() {
  const saved = readJson(UKOLY_F, null);
  const items = (saved && Array.isArray(saved.items)) ? saved.items.slice() : [];
  for (const s of UKOLY_SEED) if (!items.find(x => x.id === s.id)) items.push(Object.assign({ stav: '', pozn: '' }, s));
  return { items };
}
function updateUkol(id, patch) {
  const cur = readUkoly();
  const it = cur.items.find(x => x.id === id);
  if (!it) return null;
  if (patch.stav !== undefined && ['', 'plni', 'neplni', 'splneno'].indexOf(patch.stav) >= 0) it.stav = patch.stav;
  if (patch.pozn !== undefined) it.pozn = String(patch.pozn).slice(0, 500);
  if (patch.kdo !== undefined && String(patch.kdo).trim()) it.kdo = String(patch.kdo).slice(0, 200);
  writeJson(UKOLY_F, cur);
  return it;
}

/* ============================================================
   Dovolená: organizační struktura, konto, schvalování
   ============================================================ */
function readVac() { const v = readJson(VAC_F, { requests: [] }); if (!Array.isArray(v.requests)) v.requests = []; return v; }
function writeVac(v) { writeJson(VAC_F, v); }

/* ---------- Jednorázový import zůstatků dovolené (z vac-import.json v kořeni repa) ----------
   Spustí se při startu. Spáruje podle normalizovaného jména se stávajícími zaměstnanci,
   doplní konto (vacDays=Celkem, vacUsedInit=Čerpání, vacCarry=převod). Chybějící založí
   jako „jen evidence" (noApproval, bez e-mailu). Idempotentní přes settings.vacImportVersion. */
const VAC_IMPORT_FILE = path.join(ROOT, 'vac-import.json');
function vacNorm(x) { return (x == null ? '' : String(x)).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' '); }
function runVacImport() {
  try {
    if (!fs.existsSync(VAC_IMPORT_FILE)) return;
    const imp = readJson(VAC_IMPORT_FILE, null);
    if (!imp || !Array.isArray(imp.records) || !imp.records.length) return;
    const s = readJson(STATE_F, { employees: [] });
    s.employees = s.employees || []; s.settings = s.settings || {};
    if (s.settings.vacImportVersion === imp.version) { console.log('[vac-import] verze ' + imp.version + ' už naimportována – přeskočeno.'); return; }
    try { fs.writeFileSync(path.join(DATA_DIR, 'state.backup-vacimport-' + imp.version + '.json'), JSON.stringify(s, null, 2)); } catch (_) {}
    // Párování jen proti PŮVODNÍM zaměstnancům a každého lze „obsadit" jen jednou.
    const existingByName = {}; s.employees.forEach(e => { const k = vacNorm(e.name); if (!(k in existingByName)) existingByName[k] = e; });
    const takenNames = new Set(s.employees.map(e => vacNorm(e.name)));
    const claimed = new Set();
    let matched = 0, created = 0;
    imp.records.forEach(r => {
      const key = vacNorm(r.name);
      let e = existingByName[key];
      if (e && !claimed.has(e.id)) { claimed.add(e.id); matched++; }
      else {
        // Nový záznam (jen evidence). Při kolizi jména (duplicitní jména v Excelu / už obsazený) přidám os. číslo.
        let name = r.name; if (takenNames.has(vacNorm(name)) && r.os != null) name = r.name + ' (' + r.os + ')';
        e = { id: 'v' + crypto.randomBytes(6).toString('hex'), name: name, email: '', cats: [], modules: [], noApproval: true, imported: true };
        if (r.center) e.stredisko = r.center;
        s.employees.push(e); takenNames.add(vacNorm(name)); created++;
      }
      if (r.vacDays != null) e.vacDays = r.vacDays;
      if (r.vacUsedInit != null) e.vacUsedInit = r.vacUsedInit;
      if (r.carry != null) e.vacCarry = r.carry;
      if (r.os != null) e.osCislo = r.os;
      e.vacImported = true;
    });
    s.settings.vacImportVersion = imp.version;
    s.settings.vacImportAt = Date.now();
    writeJson(STATE_F, s);
    console.log('[vac-import] hotovo (verze ' + imp.version + '): napárováno ' + matched + ', nově vytvořeno ' + created + ', celkem ' + imp.records.length + ' řádků.');
    // Diagnostika: stávající lidé s e-mailem, které Excel NEnapároval (možná odlišný formát jména) → doplní se ručně.
    const unmatched = s.employees.filter(e => e.email && !e.imported && !claimed.has(e.id)).map(e => e.name);
    if (unmatched.length) console.log('[vac-import] BEZ dovolené (nenapárováno, ' + unmatched.length + '): ' + unmatched.join(', '));
  } catch (err) { console.warn('[vac-import] chyba: ' + err.message); }
}

// Počet pracovních dnů (po–pá) v rozsahu; celý půlden odečte 0.5. Státní svátky zatím neřešíme.
function workingDays(from, to, halfDay) {
  const a = new Date(from + 'T00:00:00'), b = new Date(to + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return 0;
  let n = 0;
  for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  if (halfDay && n > 0) n -= 0.5;
  return n;
}

/* Celé jméno pro dovolenou. Google i starší importy uložily do žádosti jen křestní jméno
   nebo jméno bez diakritiky — správné celé jméno má vždy databáze zaměstnanců. */
function vacNorm(x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function vacPlneJmeno(name, email, emps) {
  emps = emps || (getState().employees || []);
  const eml = String(email || '').toLowerCase();
  // 1) podle e-mailu (nejspolehlivější)
  if (eml) { const e = emps.find(x => (x.email || '').toLowerCase() === eml); if (e && e.name && !needsSurname(e.name)) return e.name; }
  const raw = String(name || '').trim();
  if (raw) {
    const k = vacNorm(raw), kSort = k.split(' ').sort().join(' ');
    // 2) shoda celého jména bez ohledu na diakritiku a pořadí (Simona Janeckova → Simona Janečková)
    const shoda = emps.find(x => { const n = vacNorm(x.name); return n && (n === k || n.split(' ').sort().join(' ') === kSort); });
    if (shoda && shoda.name) return shoda.name;
    // 3) jen křestní jméno → doplníme příjmení, pokud takové jméno má v databázi právě jeden člověk
    if (needsSurname(raw)) {
      const kand = emps.filter(x => { const n = vacNorm(x.name).split(' '); return n.length > 1 && n[0] === k; });
      if (kand.length === 1 && kand[0].name) return kand[0].name;
    }
  }
  // 4) poslední záchrana: příjmení z e-mailu
  return displayName(raw, eml) || raw || eml;
}
// Roční nárok zaměstnance (default 20 dní, když není nastaveno).
function vacEntitlement(emp) { const n = Number(emp && emp.vacDays); return isFinite(n) && n > 0 ? n : 20; }

// Čerpáno = součet dnů schválených žádostí v daném roce (podle e-mailu).
function vacUsed(email, year) {
  email = (email || '').toLowerCase();
  return readVac().requests
    .filter(r => r.status === 'approved' && (r.empEmail || '').toLowerCase() === email && new Date(r.from + 'T00:00:00').getFullYear() === year)
    .reduce((s, r) => s + (Number(r.days) || 0), 0);
}
// Zažádáno = součet dnů čekajících (nevyřízených) žádostí v daném roce.
function vacPendingDays(email, year) {
  email = (email || '').toLowerCase();
  return readVac().requests
    .filter(r => r.status === 'pending' && (r.empEmail || '').toLowerCase() === email && new Date(r.from + 'T00:00:00').getFullYear() === year)
    .reduce((s, r) => s + (Number(r.days) || 0), 0);
}

// Kdo schvaluje dovolenou zaměstnance: 1) přiřazený nadřízený (managerId, „pod kým je"),
// 2) vedoucí jeho střediska; jinak null → řeší admin.
function approverFor(emp, emps) {
  emps = emps || (getState().employees || []);
  if (!emp) return null;
  if (emp.noApproval) return null; // jen evidence dovolené (importovaní bez e-maily) – neschvaluje se
  if (emp.managerId) { const m = emps.find(x => x.id === emp.managerId); if (m && m.email) return m; }
  // Superadmin nikomu nepodléhá — kontrola musí být DŘÍV než odvození ze střediska,
  // jinak by mu středisko přiřadilo náhodného vedoucího.
  if ((emp.email || '').toLowerCase() === SUPERADMIN) return null;
  if (emp.stredisko) { const d = emps.find(x => x.vedouci && x.email && (x.stredisko || '') === emp.stredisko && x.id !== emp.id); if (d) return d; }
  const sa = emps.find(x => (x.email || '').toLowerCase() === SUPERADMIN);
  return sa || { email: SUPERADMIN, name: 'David Surý' };
}
// Proč právě tento schvalovatel — vysvětlení pro intranet.
function approverDuvod(emp, emps) {
  emps = emps || (getState().employees || []);
  if (!emp || emp.noApproval) return '';
  if (emp.managerId && emps.find(x => x.id === emp.managerId && x.email)) return 'přímý nadřízený z Organizace';
  if ((emp.email || '').toLowerCase() === SUPERADMIN) return '';
  if (emp.stredisko && emps.find(x => x.vedouci && x.email && (x.stredisko || '') === emp.stredisko && x.id !== emp.id)) return 'vedoucí střediska ' + emp.stredisko + ' (nemáš přiřazeného přímého nadřízeného)';
  return 'administrátor (nemáš přiřazeného nadřízeného ani vedoucího střediska)';
}

/* Jednorázová oprava (2026-08-27): u starších žádostí bylo uložené jen křestní jméno
   nebo jméno bez diakritiky. Přepíšeme je na celé jméno z databáze zaměstnanců. */
(function () {
  try {
    const st = readJson(STATE_F, null);
    if (!st || !Array.isArray(st.employees)) return;
    st.settings = st.settings || {};
    if (st.settings._vacJmena20260827) return;
    st.settings._vacJmena20260827 = 1;
    const v = readJson(VAC_F, { requests: [] });
    let opraveno = 0;
    (v.requests || []).forEach(r => {
      const plne = vacPlneJmeno(r.empName, r.empEmail, st.employees);
      if (plne && plne !== r.empName) { r.empName = plne; opraveno++; }
    });
    if (opraveno) writeJson(VAC_F, v);
    writeJson(STATE_F, st);
    if (opraveno) console.log('[dovolená] doplněna celá jména u ' + opraveno + ' žádostí');
  } catch (e) { console.warn('[dovolená] oprava jmen selhala:', e.message); }
})();

/* ---------- Měsíční report čerpání dovolené ----------
   Jednou za měsíc (výchozí 1. den) jde přehled za předchozí měsíc: kdo dovolenou čerpal
   (schválené žádosti), co je zatím jen schváleno dopředu a jaké je aktuální konto.
   Příjemce lze přidávat/odebírat v Rozesílkách. */
const VACREP_DEFAULT_TO = ['jana.pankova@elkoplast.cz'];
function vacRepCfg() {
  const d = readJson(VACREP_F, null) || {};
  return {
    to: Array.isArray(d.to) && d.to.length ? d.to : VACREP_DEFAULT_TO.slice(),
    day: Math.max(1, Math.min(28, Number(d.day) || 1)),
    enabled: d.enabled !== false,
    lastSentMonth: d.lastSentMonth || '', lastSentAt: d.lastSentAt || null
  };
}
function vacRepWrite(patch) { const cur = vacRepCfg(); writeJson(VACREP_F, Object.assign(cur, patch || {})); return vacRepCfg(); }
// Pracovní dny žádosti, které spadají do zadaného měsíce (žádost může přesahovat přes měsíce).
function vacDaysInMonth(r, y, m) {
  const a = new Date(r.from + 'T00:00:00'), b = new Date(r.to + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  let n = 0;
  for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    if (d.getFullYear() !== y || d.getMonth() !== m) continue;
    const w = d.getDay(); if (w !== 0 && w !== 6) n++;
  }
  if (r.halfDay && n > 0 && n === workingDays(r.from, r.to, false)) n -= 0.5;   // půlden jen když je celá žádost v měsíci
  return n;
}
// Data pro report i pro přehled v intranetu: kdo měl v daném měsíci dovolenou.
function vacMonthData(y, m) {
  const emps = getState().employees || [];
  const rok = new Date().getFullYear();
  const rows = readVac().requests
    .filter(r => r.status === 'approved' || r.status === 'pending')
    .map(r => ({ r, dny: vacDaysInMonth(r, y, m) }))
    .filter(x => x.dny > 0)
    .map(x => {
      const e = emps.find(z => (z.email || '').toLowerCase() === (x.r.empEmail || '').toLowerCase());
      const email = (x.r.empEmail || '').toLowerCase();
      const narok = e ? vacEntitlement(e) : 20;
      const cerpano = vacUsed(email, rok);
      return {
        name: vacPlneJmeno(x.r.empName, email, emps), email, stredisko: e ? (e.stredisko || '') : '',
        from: x.r.from, to: x.r.to, dny: x.dny, stav: x.r.status, halfDay: !!x.r.halfDay,
        narok, cerpanoRok: cerpano, zbyvaRok: Math.round((narok - cerpano) * 10) / 10
      };
    })
    .sort((a, b) => (a.stredisko || 'ZZZ').localeCompare(b.stredisko || 'ZZZ', 'cs') || (a.name || '').localeCompare(b.name || '', 'cs') || a.from.localeCompare(b.from));
  const celkem = Math.round(rows.reduce((n, x) => n + x.dny, 0) * 10) / 10;
  const lidi = new Set(rows.map(x => x.email)).size;
  return { rows, celkem, lidi, rok };
}
const VAC_MESICE = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
function buildVacReportHtml(y, m) {
  const d = vacMonthData(y, m);
  const nadpis = VAC_MESICE[m] + ' ' + y;
  const cell = (t, extra) => '<td style="padding:7px 9px;border-bottom:1px solid #e6e9e4;' + (extra || '') + '">' + t + '</td>';
  let h = '<div style="font-family:system-ui,Arial,sans-serif;color:#16211a;line-height:1.55">' +
    '<h2 style="margin:0 0 4px;font-size:19px">Čerpání dovolené — ' + nadpis + '</h2>' +
    '<p style="margin:0 0 16px;color:#5b6b60;font-size:14px">Celkem <b>' + d.celkem + '</b> dní u <b>' + d.lidi + '</b> zaměstnanců. ' +
    'Sloupec „Stav" rozlišuje již schválené čerpání a dosud neschválené žádosti. Konto je stav k dnešnímu dni za rok ' + d.rok + '.</p>';
  if (!d.rows.length) { h += '<p style="color:#5b6b60">V tomto měsíci nikdo dovolenou nečerpal.</p></div>'; return h; }
  h += '<table style="width:100%;border-collapse:collapse;font-size:13.5px">' +
    '<thead><tr style="background:#f1f5f0;text-align:left">' +
    ['Zaměstnanec', 'Středisko', 'Termín', 'Dní v měsíci', 'Stav', 'Nárok ' + d.rok, 'Čerpáno ' + d.rok, 'Zbývá']
      .map(t => '<th style="padding:7px 9px;border-bottom:2px solid #d7e0d5">' + t + '</th>').join('') + '</tr></thead><tbody>';
  d.rows.forEach(r => {
    const stav = r.stav === 'approved'
      ? '<span style="color:#1f5e22;font-weight:600">schváleno</span>'
      : '<span style="color:#8a6d1f;font-weight:600">čeká na schválení</span>';
    h += '<tr>' + cell('<b>' + esc(r.name) + '</b>') + cell(esc(r.stredisko || '—')) +
      cell(r.from + ' – ' + r.to + (r.halfDay ? ' (půlden)' : '')) + cell('<b>' + r.dny + '</b>') + cell(stav) +
      cell(String(r.narok)) + cell(String(r.cerpanoRok)) + cell('<b>' + r.zbyvaRok + '</b>') + '</tr>';
  });
  h += '</tbody></table><p style="margin-top:16px;color:#8a938a;font-size:12px">Automatický přehled z intranetu ELKOPLAST · dovolená se schvaluje v modulu Dovolená.</p></div>';
  return h;
}
async function sendVacReport(y, m, prijemci) {
  const cfg = vacRepCfg();
  const to = (prijemci && prijemci.length ? prijemci : cfg.to).filter(Boolean);
  if (!to.length) throw new Error('Není nastaven příjemce.');
  const html = buildVacReportHtml(y, m);
  const subject = 'Čerpání dovolené — ' + VAC_MESICE[m] + ' ' + y;
  for (const adr of to) {
    await deliver({ to: adr, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet ELKOPLAST', subject, html, text: subject });
  }
  return to;
}
async function maybeSendVacReport() {
  try {
    const cfg = vacRepCfg();
    if (!cfg.enabled || reportDisabled('dovolena-mesicni')) return;
    if (!emailConfigured()) return;
    const now = new Date();
    if (now.getDate() < cfg.day) return;
    if (cfg.lastSentMonth === ymKey(now)) return;
    // První běh (nebo po ztrátě dat) uprostřed měsíce: jen si poznamenáme měsíc a pošleme až příště,
    // ať nikomu nepřistane starý přehled v nečekanou dobu.
    if (!cfg.lastSentMonth && now.getDate() > cfg.day + 2) {
      vacRepWrite({ lastSentMonth: ymKey(now) });
      console.log('[dovolená] první běh uprostřed měsíce — report se pošle až ' + cfg.day + '. dne příštího měsíce');
      return;
    }
    const p = new Date(now.getFullYear(), now.getMonth() - 1, 1);   // report za předchozí měsíc
    const to = await sendVacReport(p.getFullYear(), p.getMonth());
    vacRepWrite({ lastSentMonth: ymKey(now), lastSentAt: now.toISOString() });
    console.log('[dovolená] měsíční report odeslán na ' + to.join(', '));
  } catch (e) { console.warn('[dovolená] měsíční report selhal: ' + e.message); }
}

/* ---------- Google Calendar (service account, bez závislostí) ---------- */
function calendarConfigured() { return !!(VACATION_CALENDAR_ID && GOOGLE_SA_CLIENT_EMAIL && GOOGLE_SA_PRIVATE_KEY); }

// Získá access token přes signed JWT (RS256) service accountu.
async function calGetToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: GOOGLE_SA_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256'); signer.update(header + '.' + claim);
  const sig = signer.sign(GOOGLE_SA_PRIVATE_KEY).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tok = await httpsPostForm('oauth2.googleapis.com', '/token', { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claim + '.' + sig });
  return tok.access_token;
}
function calApi(method, apiPath, token, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const headers = Object.assign({ 'Authorization': 'Bearer ' + token }, body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {});
    const r = https.request({ method, hostname: 'www.googleapis.com', path: apiPath, headers }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} if (resp.statusCode >= 200 && resp.statusCode < 300) return resolve(j || {}); reject(new Error('Calendar ' + resp.statusCode + ': ' + d.slice(0, 200))); });
    });
    r.on('error', e => reject(new Error('Spojení s kalendářem: ' + e.message)));
    r.setTimeout(20000, () => { try { r.destroy(new Error('Kalendář: časový limit spojení.')); } catch (_) {} });
    if (body) r.write(body); r.end();
  });
}

// ---- Google Drive přes service account (read-only) — pro modul Smlouvy ----
async function driveGetToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: GOOGLE_SA_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256'); signer.update(header + '.' + claim);
  const sig = signer.sign(GOOGLE_SA_PRIVATE_KEY).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tok = await httpsPostForm('oauth2.googleapis.com', '/token', { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claim + '.' + sig });
  return tok.access_token;
}
async function driveList(folderId) {
  const token = await driveGetToken();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const path = `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,webViewLink)&pageSize=500&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await calApi('GET', path, token);
  return (res.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, link: f.webViewLink, isFolder: f.mimeType === 'application/vnd.google-apps.folder' }));
}
function driveAvailable() { return !!(GOOGLE_SA_CLIENT_EMAIL && GOOGLE_SA_PRIVATE_KEY); }

// ---- Google Sheets přes service account (read-only) — pro modul Lodní kontejnery (poptávky + oficiální ceník) ----
async function sheetsGetToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: GOOGLE_SA_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256'); signer.update(header + '.' + claim);
  const sig = signer.sign(GOOGLE_SA_PRIVATE_KEY).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tok = await httpsPostForm('oauth2.googleapis.com', '/token', { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claim + '.' + sig });
  return tok.access_token;
}
async function sheetsGet(spreadsheetId, range) {
  if (!GOOGLE_SA_CLIENT_EMAIL || !GOOGLE_SA_PRIVATE_KEY) throw new Error('Service account (GOOGLE_SA_*) není nastaven.');
  const token = await sheetsGetToken();
  const apiPath = '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent(range);
  return await new Promise((resolve, reject) => {
    const r = https.request({ method: 'GET', hostname: 'sheets.googleapis.com', path: apiPath, headers: { 'Authorization': 'Bearer ' + token } }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} if (resp.statusCode >= 200 && resp.statusCode < 300) return resolve(j || {}); reject(new Error('Sheets ' + resp.statusCode + ': ' + d.slice(0, 200))); });
    });
    r.on('error', e => reject(new Error('Spojení se Sheets: ' + e.message)));
    r.setTimeout(20000, () => { try { r.destroy(new Error('Sheets: časový limit spojení.')); } catch (_) {} });
    r.end();
  });
}
// Názvy všech listů tabulky (aby šly načítat i další listy, ne jen první).
async function sheetsMeta(spreadsheetId) {
  if (!GOOGLE_SA_CLIENT_EMAIL || !GOOGLE_SA_PRIVATE_KEY) throw new Error('Service account (GOOGLE_SA_*) není nastaven.');
  const token = await sheetsGetToken();
  const apiPath = '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '?fields=sheets.properties.title';
  return await new Promise((resolve, reject) => {
    const r = https.request({ method: 'GET', hostname: 'sheets.googleapis.com', path: apiPath, headers: { 'Authorization': 'Bearer ' + token } }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} if (resp.statusCode >= 200 && resp.statusCode < 300) return resolve(((j || {}).sheets || []).map(s => s.properties && s.properties.title).filter(Boolean)); reject(new Error('Sheets meta ' + resp.statusCode + ': ' + d.slice(0, 200))); });
    });
    r.on('error', e => reject(new Error('Spojení se Sheets: ' + e.message)));
    r.setTimeout(20000, () => { try { r.destroy(new Error('Sheets: časový limit spojení.')); } catch (_) {} });
    r.end();
  });
}

/* ---------- Telefonní seznam (firemní kontakty dle středisek) ----------
   Zdroj: „Kontakty Elkoplast.xlsx" na Disku (owner lucie.sedlackova@elkoplast.cz,
   file id 1QT78DM_CyStOe5-iJcB0ihN4Lepd7dOC). Soubor je nahraný .xlsx, ne nativní
   Google Sheet — proto zde držíme ručně udržovaný snímek (jako u modulu Plasty).
   Aktualizace: přepsat řádky níže; při převodu souboru na nativní Sheet lze napojit živě.
   Skupiny = střediska; každý řádek: [role/pozice, jméno, e-mail, telefon]. */
const TELEFON_SKUPINY = [
  { stredisko: 'Bruntál — výroba Abroly', lide: [
    ['Vedoucí výroby Abroly', 'Martin Mádr', 'martin.madr@elkoplast.cz', '777760858'],
    ['Asistentka (vydané objednávky a dodáky)', 'Tereza Mádrová', 'tereza.madrova@elkoplast.cz', '777479059'],
  ] },
  { stredisko: 'Bruntál — výroba Popelnice', lide: [
    ['Vedoucí výroby Popelnice', 'Ladislav Máté', 'ladislav.mate@elkoplast.cz', '771227864'],
  ] },
  { stredisko: 'Bruntál — sklad plasty', lide: [
    ['Vedoucí střediska plasty', 'Oldřich Fiala', 'oldrich.fiala@elkoplast.cz', '777760857'],
    ['Doklady skladu plasty', 'Lada Michenková', 'lada.michenkova@elkoplast.cz', '775295313'],
  ] },
  { stredisko: 'Bruntál — doprava', lide: [
    ['Dispečerka', 'Magda Duhajská', 'magda.duhajska@elkoplast.cz', '775295314'],
    ['Dispečerka', 'Kamila Pechalová', 'kamila.pechalova@elkoplast.cz', '775295305'],
    ['Vedoucí dopravy', 'Patrik Deml', 'patrik.deml@elkoplast.cz', '608660422'],
  ] },
  { stredisko: 'Supíkovice', lide: [
    ['Vedoucí výroby Supíkovice', 'Dominik Burdák', 'dominik.burdik@elkoplast.cz', '778119990'],
    ['Vydané objednávky + doklady', 'Darina Škubalová', 'darina.skubalova@elkoplast.cz', '773757418'],
    ['Vedoucí laser', 'Milan Sedláček', 'milan.sedlacek@elkoplast.cz', '778969976'],
  ] },
  { stredisko: 'Chomutov', lide: [
    ['Vedoucí výroby', 'Jiří Hejda', 'jiri.hejda@elkoplast.cz', '602159087'],
  ] },
  { stredisko: 'Zlín (centrála)', lide: [
    ['Plán výroby a koordinace objednávek', 'Lukáš Pospíšil', 'lukas.pospisil@elkoplast.cz', '777660435'],
    ['Nákupčí zboží', 'Hana Faltýnková', 'hana.faltynkova@elkoplast.cz', '777660427'],
    ['Pomocná účetní', 'Miroslava Vavříková', 'miroslava.vavrikova@elkoplast.cz', '608660425'],
    ['Hlavní účetní (mzdové věci)', 'Jana Pánková', 'jana.pankova@elkoplast.cz', '775760822'],
    ['Asistentka jednatele (pojistky, plné moci)', 'Simona Janečková', 'simona.janeckova@elkoplast.cz', '774385335'],
    ['Jednatel společnosti', 'Tomáš Krajča', 'tomas.krajca@elkoplast.cz', '608660420'],
    ['Správce majetku (zabezpečení areálu)', 'Antonín (Tonda) Srna', 'antonin.srna@elkoplast.cz', '777070077'],
    ['Finanční analytik / IT', 'Lucie Sedláčková', 'lucie.sedlackova@elkoplast.cz', '777660439'],
  ] },
  { stredisko: 'Polsko', lide: [
    ['Vedoucí výroby', 'Anna Czechová', 'anna.czechova@elkoplast.pl', '+48661178056'],
    ['Vedoucí výroby (nástupce Anny)', 'Piotr Buczkowski', 'piotr.buczkowski@elkoplast.pl', ''],
  ] },
  { stredisko: 'Ostrata', lide: [
    ['Vedoucí Rota', 'Ladislav Krajča', 'ladislav.krajca@elkoplast.cz', '777770641'],
    ['Skladník', 'Rasťo Pavlovič', 'roto@elkoplast.cz', '775295299'],
  ] },
  { stredisko: 'Konstrukce', lide: [
    ['Konstrukce (společný e-mail)', '', 'konstrukce@elkoplast.cz', ''],
    ['Konstruktér', 'Andrey Shchedrenkov', 'andrey@elkoplast.cz', '778545698'],
    ['Konstruktér', 'Maksym', 'maksym@elkoplast.cz', ''],
    ['Konstruktér', 'Zdeněk Barcuch', 'zdenek.barcuch@elkoplast.cz', '770396340'],
    ['Konstruktér', 'Pavel Skybík', 'pavel.skybik@elkoplast.cz', '771264466'],
    ['Konstruktér', 'Anatolii Semaško', 'anatolii.semasko@elkoplast.cz', ''],
    ['Konstruktér', 'Valentin Bratuška', 'valentin.bratuska@elkoplast.cz', ''],
  ] },
];
// Obchodníci mají vlastní veřejný rozcestník na webu — nezveřejňujeme je zde jednotlivě.
const TELEFON_ODKAZY = [
  { label: 'Obchodníci (kontakty na webu)', url: 'https://www.elkoplast.cz/kontakty' },
];
/* Telefonní seznam se od 2026-08-14 generuje ŽIVĚ z databáze zaměstnanců (jedno centrum úprav):
   pozice + telefon jsou pole zaměstnance (edituje se v Organizaci), střediska dle číselníku.
   Kontakty mimo zaměstnance (sdílené schránky ap.) žijí v settings.telefonExtra (také Organizace). */
function buildTelefon() {
  const s = getState();
  const emps = (s.employees || []).filter(e => e && (String(e.telefon || '').trim() || String(e.pozice || '').trim()));
  const extra = (s.settings && Array.isArray(s.settings.telefonExtra)) ? s.settings.telefonExtra : [];
  const byStr = {};
  const add = (stredisko, rec) => { const k = String(stredisko || '').trim() || 'Ostatní'; (byStr[k] = byStr[k] || []).push(rec); };
  // Telefonní seznam řadí podle telStredisko (účetní kód z firemního seznamu);
  // organizační stredisko se použije, jen když telefonní chybí.
  emps.forEach(e => add(e.telStredisko || e.stredisko, { role: String(e.pozice || '').trim(), name: e.name || e.email || '', email: (e.email || '').trim(), phone: String(e.telefon || '').trim() }));
  extra.forEach(x => { if (x && (x.name || x.phone || x.email)) add(x.stredisko, { role: String(x.role || '').trim(), name: x.name || '', email: (x.email || '').trim(), phone: String(x.phone || '').trim() }); });
  const groups = Object.keys(byStr)
    .sort((a, b) => (a === 'Ostatní') - (b === 'Ostatní') || a.localeCompare(b, 'cs'))
    .map(k => ({ stredisko: k, lide: byStr[k].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs')) }));
  const total = groups.reduce((n, g) => n + g.lide.length, 0);
  return { groups, odkazy: TELEFON_ODKAZY, total };
}

/* Import firemního telefonního seznamu (2026-08-27): [číslo, středisko, jméno].
   Jména jsou většinou ve tvaru „Příjmení Jméno"; párujeme na zaměstnance oběma směry.
   Co se nespáruje (řidič, skladník, vrátnice…), jde do settings.telefonExtra. */
const TELEFON_IMPORT_2026 = [
  ['+420 608 660 420', 'Zlín-100', 'Krajča Tomáš'],
  ['+420 608 660 421', 'Zlín-100', 'Pšeja Petr'],
  ['+420 608 660 423', 'Zlín-100', 'Janča Petr'],
  ['+420 608 660 425', 'Zlín-100', 'Vlčková Alena'],
  ['+420 608 957 667', 'Zlín-100', 'Szczotka Robin'],
  ['+420 773 498 038', 'Zlín-100', 'Burša Tomáš'],
  ['+420 773 576 610', 'Zlín-100', 'Beránek Josef'],
  ['+420 773 576 613', 'Zlín-100', 'Mokrejš Jan'],
  ['+420 773 772 517', 'Zlín-100', 'Žalčík Vladimír'],
  ['+420 775 760 820', 'Zlín-100', 'Janata Pavel'],
  ['+420 775 760 822', 'Zlín-100', 'Tomaštíková Jana'],
  ['+420 775 760 840', 'Zlín-100', 'Janíková Simona'],
  ['+420 776 636 805', 'Zlín-100', 'Šimová Jarmila'],
  ['+420 777 660 427', 'Zlín-100', 'Kuchařová-Faltýnková Hana'],
  ['+420 777 660 434', 'Zlín-100', 'Šmídová Suzan'],
  ['+420 777 660 435', 'Zlín-100', 'Pospíšil Lukáš'],
  ['+420 778 400 021', 'Zlín-100', 'Šiška Milan'],
  ['+420 778 403 338', 'Zlín-100', 'Kiedroň Roman'],
  ['+420 778 411 662', 'Zlín-100', 'Šibal Petr'],
  ['+420 608 660 424', 'Výroba-200.20', 'Varga Peter'],
  ['+420 775 295 300', 'Výroba-200.20', 'Brada - řidič'],
  ['+420 775 295 304', 'Výroba-200.20', 'řidič'],
  ['+420 775 295 306', 'Výroba-200.20', 'skladník'],
  ['+420 775 295 307', 'Výroba-200.20', 'Mádrová Michaela'],
  ['+420 775 295 308', 'Výroba-200.20', 'Zbořilová Kamila'],
  ['+420 775 295 310', 'Výroba-200.20', 'Vykopal Petr - elektrikář'],
  ['+420 775 295 311', 'Výroba-200.20', 'Dáni Josef - řidič'],
  ['+420 775 760 824', 'Výroba-200.20', 'Sovadina Ladislav-externí konstuktér'],
  ['+420 775 760 833', 'Výroba-200.20', 'Kolář David - řidič'],
  ['+420 775 866 950', 'Výroba-200.20', 'Červenka Martin'],
  ['+420 775 866 951', 'Výroba-200.20', 'destař'],
  ['+420 776 844 924', 'Výroba-200.20', 'Vrátnice'],
  ['+420 777 479 059', 'Výroba-200.20', 'Krautwurst František'],
  ['+420 777 479 476', 'Výroba-200.20', 'Slaný Jiří'],
  ['+420 777 660 429', 'Výroba-200.20', 'Mádr Tomáš'],
  ['+420 777 660 430', 'Výroba-200.20', 'Faulhammer Jaromír'],
  ['+420 777 660 431', 'Výroba-200.20', 'Metelková Pavla'],
  ['+420 777 660 439', 'Výroba-200.20', 'Strachota Jan'],
  ['+420 777 760 851', 'Výroba-200.20', 'Metelka Michal'],
  ['+420 777 760 858', 'Výroba-200.20', 'Mádr Martin'],
  ['+420 773 498 039', 'Slušovice-700.10', 'Krajča L. Samsung'],
  ['+420 777 770 641', 'Slušovice-700.10', 'Krajča Ladislav Nokia'],
  ['+420 777 770 643', 'Slušovice-700.10', 'Bobál Radim'],
  ['+420 777 770 644', 'Slušovice-700.10', 'Halaška Miroslav'],
  ['+420 777 779 520', 'Slušovice-700.10', 'Tomšů Jaroslav'],
  ['+420 775 295 299', 'ROTO-250', 'Bravenec Petr'],
  ['+420 777 760 855', 'ROTO-250', 'Sláma Zdeněk'],
  ['+420 775 295 313', 'Plasty-200.10', 'Michenková Lada'],
  ['+420 775 866 949', 'Plasty-200.10', 'Melichárek Petr'],
  ['+420 777 760 857', 'Plasty-200.10', 'Michenka Stanislav'],
  ['+420 773 576 608', 'GVS-260', 'Vozka Miroslav'],
  ['+420 775 295 097', 'GVS-260', 'Kumpán Milan'],
  ['+420 775 760 826', 'GVS-260', 'Vršecký Luboš'],
  ['+420 775 760 837', 'GVS-260', 'Kakaš Petr'],
  ['+420 775 866 948', 'GVS-260', 'Trešlová Lenka'],
  ['+420 777 705 459', 'GVS-260', 'Steidl Josef'],
  ['+420 777 760 853', 'GVS-260', 'Bidlo Marek'],
  ['+420 608 660 422', 'Doprava-200.30', 'Semotán Pavel'],
  ['+420 773 576 609', 'Doprava-200.30', 'Krajíček František'],
  ['+420 773 576 612', 'Doprava-200.30', 'Křivák Aleš'],
  ['+420 775 295 096', 'Doprava-200.30', 'Nožička Josef'],
  ['+420 775 295 098', 'Doprava-200.30', 'Zifčák František'],
  ['+420 775 295 099', 'Doprava-200.30', 'Krywda Bohuslav'],
  ['+420 775 295 301', 'Doprava-200.30', 'Fiedler  Jan - řidič'],
  ['+420 775 295 305', 'Doprava-200.30', 'Pechalová Kamila'],
  ['+420 775 295 314', 'Doprava-200.30', 'Duhajská Magda'],
  ['+420 775 295 315', 'Doprava-200.30', 'Bína Zbyněk'],
  ['+420 775 760 825', 'Doprava-200.30', 'Vlček Lukáš'],
  ['+420 775 760 834', 'Doprava-200.30', 'Šulc Vlastimil'],
  ['+420 775 760 836', 'Doprava-200.30', 'Tunkl Eduard'],
  ['+420 775 760 839', 'Doprava-200.30', 'Pojsl Radovan'],
  ['+420 775 866 946', 'Doprava-200.30', 'Charvát Milan'],
  ['+420 775 866 947', 'Doprava-200.30', 'Gilg René'],
  ['+420 777 660 432', 'Doprava-200.30', 'Fidler Dušan'],
  ['+420 777 660 433', 'Doprava-200.30', 'Lešniowski Václav'],
  ['+420 777 660 437', 'Doprava-200.30', 'Čech Jaromír'],
  ['+420 777 760 852', 'Doprava-200.30', 'Semotánová Jana'],
  ['+420 777 760 854', 'Doprava-200.30', 'Kutálek Petr'],
  ['+420 777 760 856', 'Doprava-200.30', 'Raida Petr'],
  ['+420 777 760 859', 'Doprava-200.30', 'Duhonský Josef'],
  ['+420 775 304 851', 'Zlín-100', 'David Surý'],
];
// Jednorázová migrace (2026-08-27): naplnění telefonů/středisek z importu výše.
(function () {
  try {
    const s = readJson(STATE_F, null);
    if (!s || !Array.isArray(s.employees)) return;
    s.settings = s.settings || {};
    if (s.settings._telefonImport20260827) return;
    s.settings._telefonImport20260827 = 1;
    if (!Array.isArray(s.settings.telefonExtra)) s.settings.telefonExtra = [];
    const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    const klic = x => norm(x).split(' ').filter(Boolean).sort().join(' ');   // pořadí jméno/příjmení nerozhoduje
    const mapa = {};
    s.employees.forEach(e => { const k = klic(e.name); if (k && !mapa[k]) mapa[k] = e; });
    let spar = 0, extra = 0;
    TELEFON_IMPORT_2026.forEach(r => {
      const [tel, stredisko, jmeno] = r;
      const e = mapa[klic(jmeno)];
      if (e) {
        e.telefon = tel;
        e.telStredisko = stredisko;      // účetní kód jen pro telefonní seznam — nesmí ovlivnit organizaci
        spar++;
      } else {
        // duplicity: stejné číslo NEBO stejné jméno už v „dalších kontaktech" → jen doplníme
        const cis = tel.replace(/\D/g, '');
        const uz = s.settings.telefonExtra.find(x => String(x.phone || '').replace(/\D/g, '') === cis || (klic(x.name) && klic(x.name) === klic(jmeno)));
        if (uz) { uz.phone = tel; if (!String(uz.stredisko || '').trim()) uz.stredisko = stredisko; }
        else { s.settings.telefonExtra.push({ stredisko, role: '', name: jmeno, email: '', phone: tel }); extra++; }
      }
    });
    writeJson(STATE_F, s);
    console.log('[telefon] import 2026-08-27: ' + spar + ' spárováno se zaměstnanci, ' + extra + ' jako další kontakty');
  } catch (e) { console.warn('[telefon] import selhal:', e.message); }
})();

// Jednorázová migrace (2026-08-14): sloučení telefonního seznamu se zaměstnanci.
// Snapshot TELEFON_SKUPINY se propíše do polí zaměstnanců (telefon, pozice; středisko jen když chybí)
// párováním podle e-mailu. Nespárované kontakty (sdílené schránky ap.) → settings.telefonExtra.
(function () {
  try {
    const s = readJson(STATE_F, null);
    if (!s || !Array.isArray(s.employees)) return;
    s.settings = s.settings || {};
    // Pozor: příznak musí být v settings — /api/state ukládá jen známé klíče a top-level příznak by zahodil
    // (kvůli tomu se migrace dřív pouštěla po každém restartu a duplikovala kontakty).
    if (s._telefonMerge20260814 || s.settings._telefonMerge20260814) { s.settings._telefonMerge20260814 = 1; writeJson(STATE_F, s); return; }
    s.settings._telefonMerge20260814 = 1;
    const extra = [];
    let sparovano = 0;
    TELEFON_SKUPINY.forEach(g => (g.lide || []).forEach(r => {
      const role = r[0] || '', name = r[1] || '', email = (r[2] || '').trim().toLowerCase(), phone = (r[3] || '').trim();
      const e = email ? s.employees.find(x => (x.email || '').toLowerCase() === email) : null;
      if (e) {
        if (!String(e.telefon || '').trim()) e.telefon = phone;
        if (!String(e.pozice || '').trim()) e.pozice = role;
        if (!String(e.stredisko || '').trim()) e.stredisko = g.stredisko;
        sparovano++;
      } else {
        extra.push({ stredisko: g.stredisko, role, name, email, phone });
      }
    }));
    if (!Array.isArray(s.settings.telefonExtra)) s.settings.telefonExtra = [];
    s.settings.telefonExtra = s.settings.telefonExtra.concat(extra);
    writeJson(STATE_F, s);
    console.log('[migrace] telefonní seznam sloučen se zaměstnanci: ' + sparovano + ' spárováno, ' + extra.length + ' mimo zaměstnance (telefonExtra).');
  } catch (err) { console.error('[migrace] telefon merge:', err.message); }
})();

/* Naprava (2026-08-27): import telefonu omylem zapsal ucetni kod strediska (Zlin-100, Doprava-200.30...)
   do organizacniho pole stredisko, ze ktereho se odvozuje schvalovatel dovolene.
   Kody presuneme do telStredisko a organizacni stredisko vratime na puvodni (prazdne). */
(function () {
  try {
    const s = readJson(STATE_F, null);
    if (!s || !Array.isArray(s.employees)) return;
    s.settings = s.settings || {};
    if (s.settings._telStredNaprava20260827) return;
    s.settings._telStredNaprava20260827 = 1;
    const kody = new Set(TELEFON_IMPORT_2026.map(r => r[1]));
    let opraveno = 0;
    s.employees.forEach(e => {
      if (e && e.stredisko && kody.has(e.stredisko)) {
        if (!e.telStredisko) e.telStredisko = e.stredisko;
        e.stredisko = '';
        opraveno++;
      }
    });
    writeJson(STATE_F, s);
    if (opraveno) console.log('[telefon] naprava stredisek: u ' + opraveno + ' lidi presunut ucetni kod do telefonniho seznamu');
  } catch (e) { console.warn('[telefon] naprava stredisek selhala:', e.message); }
})();

// Úklid duplicit v „dalších kontaktech" (vznikly opakovaným během staré migrace).
(function () {
  try {
    const s = readJson(STATE_F, null);
    if (!s) return;
    s.settings = s.settings || {};
    if (s.settings._telefonDedup20260827) return;
    s.settings._telefonDedup20260827 = 1;
    const list = Array.isArray(s.settings.telefonExtra) ? s.settings.telefonExtra : [];
    const videno = new Set(), out = [];
    list.forEach(x => {
      const k = String(x && x.name || '').trim().toLowerCase() + '|' + String(x && x.phone || '').replace(/\D/g, '');
      if (k === '|') return;
      if (videno.has(k)) return;
      videno.add(k); out.push(x);
    });
    const smazano = list.length - out.length;
    s.settings.telefonExtra = out;
    writeJson(STATE_F, s);
    if (smazano) console.log('[telefon] úklid duplicit: odebráno ' + smazano + ' opakovaných kontaktů (zbylo ' + out.length + ')');
  } catch (e) { console.warn('[telefon] úklid duplicit selhal:', e.message); }
})();



/* ---------- Obchod: rozdělení obchodníků / zastupitelnost produktových manažerů ----------
   Editovatelná tabulka 1:1 se zdrojovým Google Sheetem „Zastupitelnost_PM_Elkoplast_cisty"
   (list: sekce webu → kategorie → odpovědný PM → zástup → třetí náhradník → stav pokrytí).
   Data žijí v datovém souboru OBCHOD_F; při prvním načtení se předvyplní seedem níže. */
const OBCHOD_SLOUPCE = [
  { key: 'sekce', label: 'Sekce webu' },
  { key: 'kategorie', label: 'Kategorie na webu (elkoplast.cz)' },
  { key: 'stitek', label: 'Štítek' },
  { key: 'pm', label: 'Garant (odpovědný PM)' },
  { key: 'zastup', label: 'Náhradní garant 1 (zástup)' },
  { key: 'nahradnik', label: 'Náhradní garant 2' },
  { key: 'garantSk', label: 'Slovensko' },
  { key: 'garantPl', label: 'Polsko' },
  { key: 'pokryti', label: 'Stav pokrytí' },
  { key: 'poznamka', label: 'Poznámka' }
];
// Řádky = zdrojový list (pořadí sloupců dle OBCHOD_SLOUPCE).
const OBCHOD_SEED_ROWS = [
  ['Odpadové hospodářství', 'Kontejnery ABROLL', '', 'J. Rychlíková (Morava) / J. Horálek (Čechy)', 'vzájemně', 'Lukáš Pospíšil', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Kontejnery CITY', '', 'J. Horálek', '', 'Lukáš Pospíšil', 'Pokryto', 'Přiřadit k VOK (Rychlíková/Horálek)'],
  ['Odpadové hospodářství', 'Vanové kontejnery', '', 'J. Rychlíková / J. Horálek', 'vzájemně', 'Lukáš Pospíšil', 'Pokryto', 'Spadá pod VOK'],
  ['Odpadové hospodářství', 'Třídicí linka na směsný komunální odpad', '', 'J. Šonský', 'Burša / Krajča', 'J. Šonský', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Polyethylenové kontejnery (tříděný sběr)', '', 'P. Janča', 'J. Rychlíková', 'P. Janča', 'Pokryto', 'Přes položku „kontejnery se spodním výsypem" – potvrdit'],
  ['Odpadové hospodářství', 'Kontejner HoReCa', '', 'P. Janča', 'J. Rychlíková', 'P. Janča', 'Nepokryto', 'Návrh: P. Janča (nádoby)'],
  ['Odpadové hospodářství', 'Sklolaminátové kontejnery (tříděný sběr)', '', 'P. Janča', 'J. Rychlíková', '', 'Pokryto', 'Přes „spodní výsyp" – potvrdit'],
  ['Odpadové hospodářství', 'Ocelové kontejnery (tříděný sběr)', '', 'P. Janča', 'J. Rychlíková', '', 'Pokryto', 'Přes „spodní výsyp" – potvrdit'],
  ['Odpadové hospodářství', 'Polopodzemní kontejnery SemiQ', '', 'J. Rychlíková', 'P. Janča', '', 'Pokryto', 'Bez zálohy (vč. staveb)'],
  ['Odpadové hospodářství', 'Kontejnery SemiQ bin', '', 'J. Rychlíková', 'P. Janča', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Podzemní kontejnery', '', 'J. Rychlíková', '—', '', 'Pokryto', 'Bez zálohy (vč. staveb)'],
  ['Odpadové hospodářství', 'Plastové kontejnery (komunální/tříděný) 1100 / 120 /240', '', 'P. Janča', 'J. Rychlíková', '', 'Pokryto', 'Nádoby 120–1100 l'],
  ['Odpadové hospodářství', 'Žárově zinkované kontejnery', '', 'J. Horálek', '', 'Nový obchodní PRŮMYSL', 'Nejasné', 'Návrh: P. Janča'],
  ['Odpadové hospodářství', 'Kontejnery ASP na nebezpečný tuhý odpad', '', 'J. Horálek', '—', 'Nový obchodní PRŮMYSL', 'Nepokryto', 'Návrh: J. Rychlíková (má nemocniční odpad)'],
  ['Odpadové hospodářství', 'Kontejnery ASP na aerosolové nádoby', '', 'J. Horálek', '—', 'Nový obchodní PRŮMYSL', 'Nepokryto', 'Návrh: J. Rychlíková'],
  ['Odpadové hospodářství', 'Venkovní odpadkové koše', 'mobiliář', 'P. Janča', 'J. Mokrejš', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Stojany na odpadkové pytle', 'mobiliář', 'P. Janča', 'J. Mokrejš', '', 'Nepokryto', 'Návrh: P. Janča'],
  ['Odpadové hospodářství', 'Třídění v interiéru', '', 'J. Mokrejš', 'P. Janča', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Mobilní lisovací kontejnery', 'technika', 'J. Horálek', 'J. Šonský', 'LAZY', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Stacionární lisovací jednotky', 'technika', 'J. Horálek', 'J. Šonský', 'LAZY', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Překládací stanice', 'technika', 'J. Šonský', 'J. Horálek', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Balíkovací lisy (Bramidan)', '', 'J. Horálek', 'J. Šonský', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Svozová vozidla', '', 'M. Veselý', 'J. Šonský', '', 'Pokryto', 'Návrh: M. Veselý (komunální technika)'],
  ['Odpadové hospodářství', 'Svozový systém 2AS', '', 'M. Veselý', 'J. Šonský', '', 'Pokryto', 'Návrh: M. Veselý; novinka na webu'],
  ['Odpadové hospodářství', 'Kontejnery na použitý textil', '', 'J. Mokrejš', 'J. Rychlíková', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Kontejnery na nebezpečný nemocniční odpad', '', 'J. Rychlíková', '', 'Nový obchodní PRŮMYSL', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Traktory a traktorové nosiče kontejnerů', '', 'M. Veselý', 'P. Lattner', '', 'Pokryto', 'Návrh: M. Veselý'],
  ['Odpadové hospodářství', 'Kompostárny', '', 'M. Veselý', 'P. Lattner', '', 'Pokryto', 'Kompostovací kontejnery (PL)'],
  ['Odpadové hospodářství', 'Kontejner na znečištěné obaly 1000 l', '', 'J. Rychlíková', '—', 'Nový obchodní PRŮMYSL', 'Pokryto', 'Návrh: J. Rychlíková (nebezpečné odpady)'],
  ['Odpadové hospodářství', 'Nádoby na kuchyňský odpad FATBOXX', '', 'J. Mokrejš', 'P. Janča', '', 'Pokryto', 'Přes „kuchyňské koše" – potvrdit'],
  ['Odpadové hospodářství', 'Nádoby na kuchyňský odpad', '', 'J. Mokrejš', 'P. Janča', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Kontejnerové hutnící válce (Zentex)', '', 'J. Šonský', 'J. Horálek', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Betonové skříně SILENT na kont. 120–1100 l', '', 'P. Janča', 'J. Mokrejš', '', 'Pokryto', 'Zástěny/přístřešky'],
  ['Odpadové hospodářství', 'Ocelové přístřešky na popelnice 120–240 l', '', 'P. Janča', 'J. Mokrejš', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Paddle Depacker (Mavitec)', '', 'M. Veselý', 'J. Šonský', '', 'Pokryto', ''],
  ['Odpadové hospodářství', 'Monitoring naplnění kontejnerů DistSense', '', 'J. Horálek', 'J. Rychlíková', '', 'Pokryto', 'Digitalizace/IoT – chybí vlastník'],
  ['Odpadové hospodářství', 'GPS monitoring pohybu kontejnerů', '', 'J. Horálek', 'J. Rychlíková', '', 'Pokryto', 'Digitalizace/IoT – chybí vlastník'],
  ['Odpadové hospodářství', 'Hydrocity Premium (Baroclean)', '', 'M. Veselý', 'LAZY', '', 'Pokryto', ''],
  ['Dům a zahrada', 'Štěpkovače a drtiče (Timberwolf)', '', 'J. Horálek', 'J. Beránek', 'LAZY', 'Pokryto', ''],
  ['Dům a zahrada', 'Kompostéry', '', 'J. Mokrejš', 'J. Mokrejš', '', 'Pokryto', ''],
  ['Dům a zahrada', 'Nádrže na vodu (designové)', '', 'J. Mokrejš', 'P. Lattner', '', 'Pokryto', 'Mokrejš (dům a zahrada) × Lattner (nadzemní nádrže) – rozhodnout'],
  ['Hospodaření s kapalinami', 'Mobilní nádrže na naftu (plastové)', '', 'J. Mokrejš (B2B) / P. Lattner (zemědělství)', 'vzájemně', '', 'Pokryto', 'Dělení dle segmentu'],
  ['Hospodaření s kapalinami', 'Nádrž na AdBlue', '', 'J. Mokrejš (B2B) / P. Lattner (zemědělství)', 'vzájemně', '', 'Pokryto', ''],
  ['Hospodaření s kapalinami', 'Nádrže na ostatní kapaliny', '', 'P. Lattner', 'J. Mokrejš', '', 'Pokryto', ''],
  ['Hospodaření s kapalinami', 'Podzemní nádrže', '', 'P. Lattner', 'J. Mokrejš', '', 'Pokryto', 'Bez zálohy'],
  ['Hospodaření s kapalinami', 'Vsakovací tunely', '', 'P. Lattner', 'J. Mokrejš', '', 'Pokryto', 'Bez zálohy'],
  ['Hospodaření s kapalinami', 'Vodoměrná šachta 100/140', '', 'P. Lattner', 'J. Mokrejš', '', 'Pokryto', 'Bez zálohy'],
  ['Hospodaření s kapalinami', 'Nádrž na solanku BrineGuard 9000', '', 'M. Veselý', 'J. Beránek', '', 'Pokryto', ''],
  ['Zimní údržba', 'Nádoby na zimní posyp (sklolaminátové)', '', 'P. Janča', 'J. Mokrejš', '', 'Pokryto', ''],
  ['Zimní údržba', 'Nádoby na zimní posyp (polyethylenové)', '', 'P. Janča', 'J. Mokrejš', '', 'Pokryto', ''],
  ['Zimní údržba', 'Posypové vozíky', '', 'P. Janča', 'J. Mokrejš', '', 'Pokryto', 'Návrh: P. Janča (sjednotit zimní údržbu)'],
  ['Skladování', 'Lodní kontejnery', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', ''],
  ['Skladování', 'Kontejnery a boxy pro Li-Ion baterie (ADR)', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', 'Návrh: J. Beránek; rostoucí segment'],
  ['Skladování', 'Skládací skladovací kontejnery', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', ''],
  ['Skladování', 'Záchytné vany, pracovní plošiny', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', ''],
  ['Skladování', 'Plastové přepravky', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', ''],
  ['Skladování', 'Paletové boxy', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', ''],
  ['Skladování', 'Plastové palety', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', 'Návrh: J. Beránek (boxy a přepravky)'],
  ['Skladování', 'Kontejnery USB', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', 'Návrh: J. Beránek'],
  ['Skladování', 'Výklopné kontejnery', '', 'J. Beránek', 'Průmysl', '', 'Pokryto', 'Návrh: J. Beránek'],
  ['', 'Květináče', '', 'nutné obsadit', 'nutné obsadit', '', '', '']
];
// Pořadí hodnot v seedu odpovídá původnímu listu (bez garantů SK/PL — ty se doplňují až v intranetu).
const OBCHOD_SEED_KEYS = ['sekce', 'kategorie', 'stitek', 'pm', 'zastup', 'nahradnik', 'pokryti', 'poznamka'];
const OBCHOD_SEED = OBCHOD_SEED_ROWS.map((r, i) => { const o = { id: 'k' + (i + 1) }; OBCHOD_SLOUPCE.forEach(c => { o[c.key] = ''; }); OBCHOD_SEED_KEYS.forEach((k, j) => { o[k] = r[j] || ''; }); return o; });
// Řádky tabulky (z datového souboru, jinak seed).
function readObchod() {
  const saved = readJson(OBCHOD_F, null);
  if (saved && Array.isArray(saved.rows)) return { rows: saved.rows };
  return { rows: OBCHOD_SEED.map(r => Object.assign({}, r)) };
}
// Uloží celou tabulku (jen správce). Ořízne délky, doplní chybějící id.
function writeObchod(rows) {
  const KEYS = OBCHOD_SLOUPCE.map(c => c.key);
  const clean = (Array.isArray(rows) ? rows : []).slice(0, 300).map((r, i) => {
    const o = { id: (r && r.id && String(r.id).trim()) ? String(r.id).slice(0, 60) : 'r' + Date.now().toString(36) + i };
    KEYS.forEach(k => { o[k] = String((r && r[k]) || '').slice(0, 1000); });
    return o;
  }).filter(r => KEYS.some(k => r[k].trim()));
  writeJson(OBCHOD_F, { rows: clean });
  return { rows: clean };
}
/* ---------- Garanti: veřejná stránka pro kolegy ze SK/PL + jejich návrhy ----------
   Veřejný odkaz /garanti/<token> (token je náhodný, uložený v datech; admin ho může vygenerovat
   znovu nebo stránku vypnout). Kolegové bez přihlášení do intranetu vidí přehled garantů
   a mohou navrhnout člověka za svou zemi ke konkrétní produktové skupině. */
function garantiBaseUrl() { return String(CFG.publicUrl || process.env.PUBLIC_URL || 'https://intranet.elkoplast.cz').replace(/\/$/, ''); }
function readGaranti() {
  const d = readJson(GARANTI_F, null) || {};
  return { token: d.token || '', enabled: d.enabled !== false, navrhy: Array.isArray(d.navrhy) ? d.navrhy : [] };
}
function writeGaranti(d) { writeJson(GARANTI_F, { token: d.token || '', enabled: d.enabled !== false, navrhy: (d.navrhy || []).slice(0, 2000) }); return readGaranti(); }
function garantiEnsureToken() {
  const d = readGaranti();
  if (!d.token) { d.token = crypto.randomBytes(16).toString('hex'); writeGaranti(d); return readGaranti(); }
  return d;
}
function garantiTokenOk(tok) {
  const d = readGaranti();
  if (!d.enabled || !d.token || !tok) return false;
  const a = Buffer.from(String(tok)), b = Buffer.from(d.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const GARANT_ZEME = ['SK', 'PL', 'CZ', 'jiná'];
const GARANT_STAVY = ['zapsáno', 'smazáno'];
// Skupiny produktů pro veřejnou stránku = sekce webu + jejich kategorie (z živé tabulky).
function garantiSkupiny() {
  const rows = readObchod().rows, out = [];
  rows.forEach(r => {
    const sekce = String(r.sekce || '').trim() || 'Ostatní';
    let g = out.find(x => x.sekce === sekce);
    if (!g) { g = { sekce, polozky: [] }; out.push(g); }
    g.polozky.push({
      id: r.id, kategorie: r.kategorie || '', pm: r.pm || '', zastup: r.zastup || '',
      garantSk: r.garantSk || '', garantPl: r.garantPl || ''
    });
  });
  return out;
}
// Normalizace jména (bez diakritiky/velikosti) pro párování na zaměstnance.
function obchodNorm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }
// Rozdělí buňku „Odpovědný PM" / „Zástup" na jednotlivé osoby (odděleno „/", bez závorek).
function obPmListSrv(cell) { return String(cell || '').split('/').map(s => s.replace(/\([^)]*\)/g, '').trim()).filter(Boolean); }
// Vyhodnocení pokrytí (děláme sami z dat): vlastník + záloha → Pokryto; jen vlastník → Bez zálohy; bez vlastníka → Neobsazeno.
function obCellFilled(s) { s = String(s || '').trim(); return (s === '' || s === '—' || s === '-') ? '' : s; }
function obEvalCoverage(r) { const pm = String(r.pm || '').trim(); if (!pm || /nutné obsadit/i.test(pm)) return 'Neobsazeno'; return (obCellFilled(r.zastup) || obCellFilled(r.nahradnik)) ? 'Pokryto' : 'Bez zálohy'; }
// Známí obchodníci (klíč = normalizovaná zkratka z listu → celé jméno). Kontakt se bere ze živé DB, jinak firemní e-mail dle konvence.
const OBCHOD_LIDE = {
  'j. beranek': 'Josef Beránek', 'j. mokrejs': 'Jan Mokrejš', 'm. vesely': 'Martin Veselý',
  'j. rychlikova': 'Jana Rychlíková', 'p. janca': 'Petr Janča', 'p. lattner': 'Petr Lattner',
  'j. horalek': 'Jan Horálek', 'j. sonsky': 'Jan Šonský', 'lukas pospisil': 'Lukáš Pospíšil'
};
function obchodEmail(full) { const p = String(full || '').split(/\s+/).filter(Boolean); if (p.length < 2) return null; const strip = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, ''); return strip(p[0]) + '.' + strip(p[p.length - 1]) + '@elkoplast.cz'; }
// Najde zaměstnance v živé DB dle celého jména (přesně, jinak příjmení + iniciála).
function obMatchEmp(full, emps) {
  const nf = obchodNorm(full); let e = emps.find(x => obchodNorm(x.name) === nf); if (e) return e;
  const p = String(full).split(/\s+/).filter(Boolean); if (p.length < 2) return null;
  const sur = obchodNorm(p[p.length - 1]), ini = obchodNorm(p[0])[0] || '';
  return emps.find(x => { const q = String(x.name || '').split(/\s+/).filter(Boolean); if (q.length < 2) return false; return obchodNorm(q[q.length - 1]) === sur && (obchodNorm(q[0])[0] || '') === ini; }) || null;
}
// Druhý pohled: obchodník → jeho atributy (sekce, kategorie kde je odpovědný / zástup, kontakt ze živé DB).
function buildObchodnici(rows) {
  const emps = getState().employees || [];
  const acc = {};
  Object.keys(OBCHOD_LIDE).forEach(k => { acc[k] = { name: OBCHOD_LIDE[k], owner: [], zastup: [], nahrad: [], sekce: {} }; });
  rows.forEach(r => {
    obPmListSrv(r.pm).forEach(l => { const k = obchodNorm(l); if (acc[k]) { acc[k].owner.push({ sekce: r.sekce || '', kategorie: r.kategorie || '', coverage: obEvalCoverage(r) }); if (r.sekce) acc[k].sekce[r.sekce] = 1; } });
    obPmListSrv(r.zastup).forEach(l => { const k = obchodNorm(l); if (acc[k]) acc[k].zastup.push({ sekce: r.sekce || '', kategorie: r.kategorie || '' }); });
    obPmListSrv(r.nahradnik).forEach(l => { const k = obchodNorm(l); if (acc[k]) acc[k].nahrad.push({ sekce: r.sekce || '', kategorie: r.kategorie || '' }); });
  });
  return Object.keys(acc).map(k => { const o = acc[k]; const e = obMatchEmp(o.name, emps);
    return { name: o.name, email: e ? e.email : obchodEmail(o.name), inDb: !!e, sekce: Object.keys(o.sekce), owner: o.owner, zastup: o.zastup, nahrad: o.nahrad, pocetOdpovedny: o.owner.length, pocetZastup: o.zastup.length, pocetNahrad: o.nahrad.length, bezZalohy: o.owner.filter(x => x.coverage === 'Bez zálohy').length };
  }).filter(o => o.pocetOdpovedny > 0 || o.pocetZastup > 0 || o.pocetNahrad > 0).sort((a, b) => b.pocetOdpovedny - a.pocetOdpovedny);
}
// Mapa kontaktů klíčovaná normalizovanou zkratkou (i celým jménem), pro propojení jmen v tabulce na zaměstnance.
function buildKontakty() {
  const emps = getState().employees || [];
  const out = {};
  Object.keys(OBCHOD_LIDE).forEach(k => {
    const full = OBCHOD_LIDE[k]; const e = obMatchEmp(full, emps);
    const rec = { name: full, email: e ? e.email : obchodEmail(full), inDb: !!e };
    out[k] = rec; out[obchodNorm(full)] = rec;
  });
  return out;
}

// Množina e-mailů obchodníků z „Rozdělení obchodníků" (párováno na živou DB).
function obchodniciEmailSet() {
  const set = new Set();
  try { buildObchodnici(readObchod().rows).forEach(o => { if (o.email) set.add(String(o.email).toLowerCase()); }); } catch (_) {}
  return set;
}
// Je daný e-mail obchodník? = má přístup k modulu „obchod" NEBO je v Rozdělení obchodníků.
// Slouží k implicitnímu přidělení role „obchodník" v modulu Konstrukce (zadávání zakázek).
const OBCHOD_MODULE_KEYS = ['obchod', 'obchodexp']; // Rozdělení obchodníků + Obchod EXP (export)
function isObchodnikEmail(email) {
  email = (email || '').toLowerCase(); if (!email) return false;
  try { const mods = employeeModules(email) || []; if (mods.some(m => OBCHOD_MODULE_KEYS.indexOf(m) >= 0)) return true; } catch (_) {}
  return obchodniciEmailSet().has(email);
}
// Je zaměstnanec „ze Zlína"? — středisko v Organizaci obsahuje „Zlín"
// (Zlín-100, Zlín (centrála), Centrála Zlín + Správa…). Slouží k automatickému
// přístupu do modulu Konstrukce pro celou centrálu.
function jeZlinEmail(email) {
  email = (email || '').toLowerCase(); if (!email) return false;
  try {
    const s = readJson(STATE_F, { employees: [] });
    const e = (s.employees || []).find(x => (x.email || '').toLowerCase() === email);
    return !!(e && /zl[ií]n/i.test(String(e.stredisko || '')));
  } catch (_) { return false; }
}
// Automatický přístup ke Konstrukci (dlaždice v intranetu i vstup do modulu):
// explicitní modul v Přístupech, obchodníci, všichni ze Zlína, nebo role
// v modulu (přiřazený konstruktér, šéf, ředitelé…).
function maKonstrukciEmail(email) {
  email = (email || '').toLowerCase(); if (!email) return false;
  try { if ((employeeModules(email) || []).includes('konstrukce')) return true; } catch (_) {}
  if (isObchodnikEmail(email)) return true;
  if (jeZlinEmail(email)) return true;
  try { if (konstrukceMod && konstrukceMod.hasAccess && konstrukceMod.hasAccess(email)) return true; } catch (_) {}
  return false;
}
// Jmenovitý přehled implicitních obchodníků (pro admin sekci Konstrukce → Role):
// projde zaměstnance s modulem obchod/obchodexp + osoby z Rozdělení obchodníků.
function obchodniciPrehled() {
  const out = new Map();
  const add = (em, zdroj) => { em = (em || '').toLowerCase(); if (!em) return; const r = out.get(em) || { email: em, zdroje: [] }; if (!r.zdroje.includes(zdroj)) r.zdroje.push(zdroj); out.set(em, r); };
  try {
    const s = getState();
    (s.employees || []).forEach(e => {
      const em = (e.email || '').toLowerCase(); if (!em) return;
      try {
        const mods = employeeModules(em) || [];
        if (mods.includes('obchod')) add(em, 'modul Obchod');
        if (mods.includes('obchodexp')) add(em, 'modul Obchod EXP');
      } catch (_) {}
    });
  } catch (_) {}
  try { obchodniciEmailSet().forEach(em => add(em, 'Rozdělení obchodníků')); } catch (_) {}
  return [...out.values()];
}

/* ---------- Obchod → Leady: kontakty z veřejné kalkulačky překladiště ----------
   Lead vzniká odesláním veřejného formuláře na /preklad (mimo přihlašovací závoru).
   Ukládá se do data/preklad-leady.json; obchodník (přístup „obchod" / správce) je vidí v záložce Leady. */
const PREKLAD_LEAD_STAVY = ['novy', 'kontaktovano', 'schuzka', 'nabidka', 'uzavreno', 'zamitnuto'];
function readLeady() { const s = readJson(PREKLAD_LEADY_F, null); return { items: (s && Array.isArray(s.items)) ? s.items : [] }; }
function writeLeady(items) { writeJson(PREKLAD_LEADY_F, { items: (items || []).slice(0, 5000) }); }
function leadStr(v, max) { return String(v == null ? '' : v).slice(0, max || 200); }
function leadNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
// Uloží nový lead z veřejného formuláře. Vrací uložený záznam.
function addLead(b, req) {
  const items = readLeady().items;
  const inp = (b && b.inputs) || {}, rr = (b && b.result) || {};
  const rec = {
    id: 'ld' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    ts: Date.now(),
    email: leadStr(b && b.email, 160).trim(),
    phone: leadStr(b && b.phone, 40).trim(),
    firma: leadStr(b && b.firma, 160).trim(),
    inputs: { Q: leadNum(inp.Q), D: leadNum(inp.D), Pnow: leadNum(inp.Pnow), ckm: leadNum(inp.ckm) },
    result: { saving: leadNum(rr.saving), payback: (rr.payback == null ? null : leadNum(rr.payback)), savedTrips: leadNum(rr.savedTrips), savedKm: leadNum(rr.savedKm), savedHours: leadNum(rr.savedHours), co2t: leadNum(rr.co2t), capexCZK: leadNum(rr.capexCZK) },
    status: 'novy',
    note: '',
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 60),
    source: 'preklad-verejny'
  };
  items.unshift(rec);
  writeLeady(items);
  return rec;
}
// Best-effort notifikace obchodníkovi (neblokuje odpověď klientovi, spadne-li, jen se zaloguje).
function notifyLead(rec) {
  const to = process.env.PREKLAD_LEAD_TO || 'jan.sonsky@elkoplast.cz';
  const uspora = rec.result.saving ? Math.round(rec.result.saving).toLocaleString('cs-CZ') + ' Kč/rok' : 'neuvedeno';
  const pay = rec.result.payback ? (rec.result.payback + ' roku') : 'neuvedeno';
  const text = 'Nový lead z veřejné kalkulačky překladiště\n\n'
    + 'Firma: ' + (rec.firma || '(neuvedeno)') + '\n'
    + 'E-mail: ' + rec.email + '\n'
    + 'Telefon: ' + rec.phone + '\n\n'
    + 'Zadané hodnoty: ' + rec.inputs.Q + ' t/rok · ' + rec.inputs.D + ' km · dnes ' + rec.inputs.Pnow + ' t/jízda · ' + rec.inputs.ckm + ' Kč/km\n'
    + 'Odhad úspory: ' + uspora + ' · návratnost ' + pay + '\n\n'
    + 'Kontakt najdeš v intranetu: Obchod → Leady.';
  try {
    deliver({ to, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet — kalkulačka překladiště', subject: 'Nový lead překladiště: ' + (rec.firma || rec.email), text, html: toHtml(text) })
      .catch(e => { try { console.warn('notifyLead selhalo:', e.message); } catch (_) {} });
  } catch (e) { try { console.warn('notifyLead výjimka:', e.message); } catch (_) {} }
}

/* ---------- Freelo (modul Freelo: projekty přes REST API, basic auth) ---------- */
function freeloConfigured() { return !!(FREELO_EMAIL && FREELO_API_KEY); }
let freeloCache = { at: 0, data: null }; // 5min cache, ať se Freelo nevolá při každém otevření záložky
function freeloApi(apiPath) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(FREELO_EMAIL + ':' + FREELO_API_KEY).toString('base64');
    const r = https.request({ method: 'GET', hostname: 'api.freelo.io', path: apiPath, headers: { 'Authorization': 'Basic ' + auth, 'User-Agent': 'ElkoplastIntranet (' + FREELO_EMAIL + ')' } }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} if (resp.statusCode >= 200 && resp.statusCode < 300) return resolve(j); reject(new Error('Freelo ' + resp.statusCode + ': ' + d.slice(0, 200))); });
    });
    r.on('error', e => reject(new Error('Spojení s Freelem: ' + e.message)));
    r.setTimeout(20000, () => { try { r.destroy(new Error('Freelo: časový limit spojení.')); } catch (_) {} });
    r.end();
  });
}

// Vloží celodenní událost dovolené do sdíleného kalendáře; vrací id události nebo null.
async function calInsertVacation(rq) {
  if (!calendarConfigured()) return null;
  const token = await calGetToken();
  const endEx = new Date(rq.to + 'T00:00:00'); endEx.setDate(endEx.getDate() + 1); // Google end.date je exkluzivní
  const ev = {
    summary: 'Dovolená – ' + (rq.empName || rq.empEmail) + (rq.halfDay ? ' (½ dne)' : ''),
    description: (rq.note ? rq.note + '\n' : '') + 'Schválil: ' + (rq.decidedBy || ''),
    start: { date: rq.from }, end: { date: endEx.toISOString().slice(0, 10) },
    transparency: 'transparent'
  };
  const r = await calApi('POST', '/calendar/v3/calendars/' + encodeURIComponent(VACATION_CALENDAR_ID) + '/events', token, ev);
  return r && r.id ? r.id : null;
}
async function calDeleteVacation(eventId) {
  if (!calendarConfigured() || !eventId) return;
  const token = await calGetToken();
  await calApi('DELETE', '/calendar/v3/calendars/' + encodeURIComponent(VACATION_CALENDAR_ID) + '/events/' + encodeURIComponent(eventId), token);
}
// Notifikační e-mail (tiše přeskočí, když pošta není nastavená).
async function vacMail(to, subject, text) {
  if (!emailConfigured() || !to) return;
  try { await deliver({ to, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet', subject, text, html: toHtml(text, '') }); }
  catch (e) { console.warn('Dovolená: e-mail se nepodařilo odeslat (' + to + '): ' + e.message); }
}

/* ============================================================
   Měsíční vyhodnocení (e-mailem na zodpovědnou osobu)
   ============================================================ */
function reportRecipient() { return (process.env.REPORT_EMAIL || 'tomas.krajca@elkoplast.cz').trim(); }
function reportDay() { return Math.min(28, Math.max(1, Number(process.env.REPORT_DAY) || 1)); }
function reportEnabled() { return (process.env.REPORT_ENABLED || '1') !== '0'; }
function emailConfigured() { return !!(process.env.RESEND_API_KEY || (CFG.host && CFG.user)); }
function ymKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

// Spočítá stav seznámení pro směrnice i dokumenty knihovny vyžadující potvrzení.
function reportData() {
  const s = getState();
  const emps = s.employees || [];
  const audience = (item) => emps.filter(e => assignedTo(item, e));
  const lc = (e) => (e.email || '').toLowerCase();
  const directives = (s.directives || []).map(d => {
    const aud = audience(d); const acks = d.acks || {};
    const missing = aud.filter(e => !acks[lc(e)]);
    return { title: d.title || 'Směrnice', total: aud.length, acked: aud.length - missing.length, missing: missing.map(e => e.name || e.email) };
  });
  const lib = readLibrary(); const lacks = libAcks();
  const libDocs = (lib.docs || []).filter(d => d.requireAck !== false).map(d => {
    const v = curVersion(d); const aud = audience(d);
    const ackedSet = {}; lacks.filter(a => a.docId === d.id && Number(a.v) === v).forEach(a => ackedSet[a.email] = 1);
    const missing = aud.filter(e => !ackedSet[lc(e)]);
    return { title: (d.title || 'Dokument') + ' (verze ' + v + ')', total: aud.length, acked: aud.length - missing.length, missing: missing.map(e => e.name || e.email) };
  });
  const all = directives.concat(libDocs);
  const totAud = all.reduce((s2, x) => s2 + x.total, 0);
  const totAck = all.reduce((s2, x) => s2 + x.acked, 0);
  return { employees: emps.length, directives, libDocs, rate: totAud ? Math.round(100 * totAck / totAud) : 100 };
}
function reportRows(items) {
  if (!items.length) return '<tr><td colspan="3" style="padding:10px;color:#5b635c">Žádné položky.</td></tr>';
  return items.map(x => {
    const pct = x.total ? Math.round(100 * x.acked / x.total) : 100;
    const col = pct >= 100 ? '#0e8a43' : (pct >= 60 ? '#7a5c0e' : '#c23636');
    const miss = x.missing.length ? ('<div style="font-size:12px;color:#5b635c;margin-top:3px">Nepotvrdili: ' + esc(x.missing.slice(0, 12).join(', ')) + (x.missing.length > 12 ? (' +' + (x.missing.length - 12) + ' dalších') : '') + '</div>') : '';
    return '<tr><td style="padding:9px 10px;border-bottom:1px solid #eee">' + esc(x.title) + miss + '</td>' +
      '<td style="padding:9px 10px;border-bottom:1px solid #eee;text-align:center;white-space:nowrap">' + x.acked + ' / ' + x.total + '</td>' +
      '<td style="padding:9px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:700;color:' + col + '">' + pct + ' %</td></tr>';
  }).join('');
}
function buildReportHtml(d, monthLabel) {
  const head = '<tr><th style="text-align:left;padding:8px 10px;font-size:12px;text-transform:uppercase;color:#5b635c;border-bottom:2px solid #e3e7e0">Položka</th>' +
    '<th style="padding:8px 10px;font-size:12px;text-transform:uppercase;color:#5b635c;border-bottom:2px solid #e3e7e0">Potvrzeno</th>' +
    '<th style="padding:8px 10px;font-size:12px;text-transform:uppercase;color:#5b635c;border-bottom:2px solid #e3e7e0;text-align:right">%</th></tr>';
  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f1512;max-width:680px;margin:0 auto">' +
    '<div style="background:linear-gradient(135deg,#15ab57,#0a6b34);color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">' +
    '<div style="font-size:20px;font-weight:700">Měsíční vyhodnocení seznámení</div>' +
    '<div style="opacity:.9;font-size:14px;margin-top:2px">' + esc(monthLabel) + '</div></div>' +
    '<div style="border:1px solid #e3e7e0;border-top:none;border-radius:0 0 12px 12px;padding:22px 24px">' +
    '<p style="margin:0 0 16px">Celková míra potvrzení: <strong style="font-size:18px;color:#0a6b34">' + d.rate + ' %</strong> &nbsp;·&nbsp; zaměstnanců: ' + d.employees + '</p>' +
    '<h3 style="font-size:15px;margin:18px 0 8px">Směrnice</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' + head + reportRows(d.directives) + '</table>' +
    '<h3 style="font-size:15px;margin:22px 0 8px">Knihovna (dokumenty k potvrzení)</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' + head + reportRows(d.libDocs) + '</table>' +
    '<p style="margin:22px 0 0;font-size:12px;color:#5b635c">Automaticky generováno aplikací Seznámení se směrnicemi.</p>' +
    '</div></div>';
}
function buildReportText(d, monthLabel) {
  const lines = ['Měsíční vyhodnocení seznámení – ' + monthLabel, 'Celková míra potvrzení: ' + d.rate + ' %  (zaměstnanců: ' + d.employees + ')', '', 'SMĚRNICE:'];
  d.directives.forEach(x => lines.push('  - ' + x.title + ': ' + x.acked + '/' + x.total + (x.missing.length ? ('  (nepotvrdili: ' + x.missing.join(', ') + ')') : '')));
  lines.push('', 'KNIHOVNA:');
  d.libDocs.forEach(x => lines.push('  - ' + x.title + ': ' + x.acked + '/' + x.total + (x.missing.length ? ('  (nepotvrdili: ' + x.missing.join(', ') + ')') : '')));
  return lines.join('\n');
}
async function sendMonthlyReport(to) {
  const d = reportData();
  const monthLabel = new Date().toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' });
  await deliver({ to: to, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet – směrnice', subject: 'Měsíční vyhodnocení seznámení se směrnicemi – ' + monthLabel, text: buildReportText(d, monthLabel), html: buildReportHtml(d, monthLabel) });
}
async function maybeSendMonthlyReport() {
  try {
    if (!reportEnabled() || !emailConfigured()) return;
    if (reportDisabled('smernice-mesicni')) return;   // zrušeno správcem v přehledu Rozesílky
    const now = new Date();
    if (now.getDate() < reportDay()) return;
    const st = readJson(REPORT_F, {});
    if (st.lastSentMonth === ymKey(now)) return; // tento měsíc už odesláno
    await sendMonthlyReport(reportRecipient());
    writeJson(REPORT_F, { lastSentMonth: ymKey(now), lastSentAt: now.toISOString(), to: reportRecipient() });
    console.log(' Měsíční vyhodnocení odesláno na ' + reportRecipient());
  } catch (e) { console.log(' Měsíční vyhodnocení selhalo: ' + e.message); }
}

/* ============================================================
   HTTP
   ============================================================ */
function send(res, code, obj, headers) { const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}); res.writeHead(code, h); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve, reject) => { let d = ''; req.on('data', c => { d += c; if (d.length > 12e6) req.destroy(); }); req.on('end', () => resolve(d)); req.on('error', reject); }); }
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
/* Český 5. pád (oslovení) pro křestní jméno – jednoduchý pravidlový algoritmus + slovník výjimek */
const VOC_OVERRIDES = {
  'pavel':'Pavle','karel':'Karle','zdeněk':'Zdeňku','zdenek':'Zdeňku',
  'daniel':'Danieli','michael':'Michaeli','marcel':'Marcele',
  'jiří':'Jiří','jiri':'Jiří','hugo':'Hugo','otto':'Otto','leo':'Leo','timo':'Timo',
  'ondřej':'Ondřeji','ondrej':'Ondřeji'
};
/* 5. pád jednoho slova (křestní jméno nebo příjmení) */
function vocWord(w) {
  if (!w) return w;
  const lower = w.toLowerCase();
  const cap = (t) => (w[0] === w[0].toUpperCase()) ? (t.charAt(0).toUpperCase() + t.slice(1)) : t;
  if (VOC_OVERRIDES[lower]) return cap(VOC_OVERRIDES[lower]);
  if (lower.length < 2) return w;
  if (/a$/.test(lower)) return cap(lower.slice(0,-1) + 'o');          // -a → -o (Jana→Jano, Svoboda→Svobodo)
  if (/ie$/.test(lower)) return w;                                    // Marie, Lucie – beze změny
  if (/[eiouyíáéěůúýó]$/.test(lower)) return w;                       // ostatní samohlásky beze změny (Jiří, Černý)
  if (/[jščřžďťňc]$/.test(lower)) return cap(lower + 'i');            // měkké souhlásky → -i (Tomáš→Tomáši)
  if (/ek$/.test(lower) && lower.length > 2) return cap(lower.slice(0,-2) + 'ku'); // -ek: Marek→Marku, Nováček→Nováčku
  if (/ch$/.test(lower)) return cap(lower + 'u');                     // -ch → -chu (Vojtěch→Vojtěchu)
  if (/[khg]$/.test(lower)) return cap(lower + 'u');                  // -k/-h/-g → +u (Menšík→Menšíku, Novák→Nováku)
  if (/r$/.test(lower)) return cap(lower.slice(0,-1) + 'ře');         // -r → -ře (Petr→Petře)
  if (/l$/.test(lower)) return cap(lower + 'e');                      // -l → -le (Michal→Michale)
  if (/[dtnmvbszfp]$/.test(lower)) return cap(lower + 'e');           // tvrdé souhlásky → +e (David→Davide, Jan→Jane)
  return w;
}
function vocCs(name) {
  if (!name) return name;
  const m = String(name).match(/^(\S+)(\s.*)?$/); if (!m) return name;
  return vocWord(m[1]) + (m[2] || '');
}
/* Odhad pohlaví z jména (heuristika: slovník křestních jmen + koncovky). Vrací 'm' / 'f'. */
const FEMALE_FIRST = new Set(['jana','petra','eva','marie','anna','lucie','kateřina','katerina','hana','lenka','veronika','martina','silvie','sylvie','simona','tereza','barbora','michaela','monika','zuzana','alena','ivana','jitka','helena','markéta','marketa','klára','klara','nikola','denisa','pavla','andrea','dagmar','iva','gabriela','renata','vendula','kristýna','kristyna','adéla','adela','natálie','natalie','alice','dana','olga','soňa','sona','vlasta','miroslava','jaroslava','ludmila','božena','bozena','květa','kveta','blanka','emilie','emílie','sylva','ilona','irena','radka','šárka','sarka','dominika','aneta','eliška','eliska','nela','laura','viktorie','johana','magdalena','magdaléna','žaneta','zaneta','pavlína','pavlina','romana','sabina','karolína','karolina','tereza','věra','vera']);
const MALE_FIRST = new Set(['jan','petr','josef','pavel','jiří','jiri','martin','tomáš','tomas','jaroslav','miroslav','zdeněk','zdenek','václav','vaclav','michal','david','lukáš','lukas','jakub','milan','vladimír','vladimir','karel','františek','frantisek','ondřej','ondrej','roman','marek','radek','daniel','filip','stanislav','antonín','antonin','aleš','ales','libor','patrik','adam','matěj','matej','vojtěch','vojtech','dominik','richard','robert','ladislav','oldřich','oldrich','rostislav','bohumil','ivan','luboš','lubos','kamil','denis','štěpán','stepan','šimon','simon','vít','vit','hynek','arnošt','arnost']);
function guessGender(name) {
  if (!name) return 'm';
  const parts = String(name).trim().split(/\s+/).filter(Boolean); if (!parts.length) return 'm';
  const first = parts[0].toLowerCase();
  const last = parts[parts.length - 1].toLowerCase();
  if (FEMALE_FIRST.has(first)) return 'f';
  if (MALE_FIRST.has(first)) return 'm';
  if (/(ová|cká|ská|á)$/.test(last)) return 'f';   // ženská příjmení (Nováková, Malá, Novotná)
  if (/ý$/.test(last)) return 'm';                 // Černý, Novotný
  if (parts.length > 1) return /(a|ie|e)$/.test(first) ? 'f' : 'm'; // dle koncovky křestního jména
  return 'm';                                      // jediný token, nejasné → muž (lze přepsat)
}
/* Formální oslovení „pane Nováku" / „paní Nováková" (5. pád, dle pohlaví). gender: 'm'|'f'|'' (auto). */
function osloveniCs(name, gender) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const surname = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const g = (gender === 'm' || gender === 'f') ? gender : guessGender(name);
  return g === 'f' ? ('paní ' + surname) : ('pane ' + vocWord(surname));
}
function renderTpl(t, v) { return (t || '').replace(/\{(osloveni|jmeno5|jmeno|smernice|odkaz)\}/g, (m, k) => (v[k] != null ? v[k] : m)); }
function toHtml(text, link, btnLabel) { let h = esc(text).replace(/\n/g, '<br>'); if (link) { const s = esc(link); h = h.split(s).join('<a href="' + s + '" style="color:#1f5d3f">' + s + '</a>') + '<div style="margin-top:18px"><a href="' + s + '" style="display:inline-block;background:#1f5d3f;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold">' + esc(btnLabel || 'Otevřít a potvrdit seznámení') + '</a></div>'; } return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1c1d1a;line-height:1.55">' + h + '</div>'; }
function baseUrl(req) { return (CFG.publicUrl || (((req.headers['x-forwarded-proto'] || 'http')) + '://' + req.headers.host)).replace(/\/$/, ''); }
/* Uvítací (pozvánkový) e-mail do intranetu — hezky nastylovaný, firemní barvy. Text (subject+body) je editovatelný. */
const DEFAULT_INVITE_SUBJECT = 'Pozvánka do intranetu ELKOPLAST CZ';
const DEFAULT_INVITE_BODY = 'Dobrý den {jmeno5},\n\nbyli jste pozváni do firemního intranetu ELKOPLAST CZ — jedno místo pro všechno pracovní.';
function intranetInviteMail(name, url, tpl) {
  tpl = tpl || {};
  const fn = (name || '').split(' ')[0] || name || '';
  const vars = { jmeno: fn, jmeno5: vocCs(fn), osloveni: osloveniCs(name), odkaz: url };
  const subject = renderTpl(tpl.subject || DEFAULT_INVITE_SUBJECT, vars);
  const bodyText = renderTpl(tpl.body || DEFAULT_INVITE_BODY, vars);
  const bodyHtml = '<p style="margin:0 0 14px">' + esc(bodyText).replace(/\n\n+/g, '</p><p style="margin:0 0 14px">').replace(/\n/g, '<br>') + '</p>';
  const text = bodyText + '\n\nPřihlášení bez hesla přes firemní Google účet (@elkoplast.cz):\n  1) Otevřete ' + url + '\n  2) Klikněte „Přihlásit se přes Google"\n  3) Vyberte svůj firemní účet.\n\nOtevřít intranet: ' + url + '\n\nELKOPLAST CZ · interní systém';
  const html = '<div style="margin:0;padding:0;background:#eef1ec">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1ec;padding:24px 12px"><tr><td align="center">'
    + '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(15,21,18,.08);font-family:Segoe UI,Arial,sans-serif">'
    + '<tr><td style="background:linear-gradient(135deg,#15ab57,#0a6b34);padding:26px 30px;border-bottom:3px solid #ffd21a">'
    + '<span style="display:inline-block;width:34px;height:34px;background:#ffd21a;border-radius:9px;color:#11271c;font-weight:800;font-size:20px;text-align:center;line-height:34px">&#10003;</span>'
    + '<span style="color:#fff;font-size:20px;font-weight:700;vertical-align:top;line-height:34px;margin-left:10px">Intranet ELKOPLAST CZ</span></td></tr>'
    + '<tr><td style="padding:28px 30px;color:#1c1d1a;font-size:15px;line-height:1.6">'
    + bodyHtml
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 20px">'
    + '<tr><td style="padding:4px 0;font-size:14px">&#128196;&nbsp; Směrnice k seznámení a potvrzení</td></tr>'
    + '<tr><td style="padding:4px 0;font-size:14px">&#128218;&nbsp; Knihovna dokumentů (pracovní řád, SOP, postupy)</td></tr>'
    + '<tr><td style="padding:4px 0;font-size:14px">&#128202;&nbsp; Dotazníky a testy</td></tr>'
    + '<tr><td style="padding:4px 0;font-size:14px">&#129518;&nbsp; Firemní moduly (kalkulace, provozy…)</td></tr></table>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e6f6ec;border:1px solid #cfe9d8;border-radius:12px;margin:0 0 22px"><tr><td style="padding:16px 18px;font-size:14px;color:#0a6b34">'
    + '<b>Přihlášení bez hesla — přes firemní Google účet (@elkoplast.cz):</b>'
    + '<div style="color:#1c1d1a;margin-top:8px;line-height:1.8">1) Otevřete intranet<br>2) Klikněte <b>„Přihlásit se přes Google"</b><br>3) Vyberte svůj firemní účet</div></td></tr></table>'
    + '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:linear-gradient(135deg,#15ab57,#0a6b34)">'
    + '<a href="' + esc(url) + '" style="display:inline-block;padding:13px 30px;color:#fff;font-size:16px;font-weight:700;text-decoration:none">Otevřít intranet &#8594;</a></td></tr></table>'
    + '<p style="margin:20px 0 0;font-size:12px;color:#8a938a">Odkaz: <a href="' + esc(url) + '" style="color:#0e8a43">' + esc(url) + '</a></p></td></tr>'
    + '<tr><td style="background:#11271c;padding:16px 30px;color:#9fd9b6;font-size:12px">ELKOPLAST CZ · interní systém. Pokud jste tento e-mail dostali omylem, ignorujte ho.</td></tr>'
    + '</table></td></tr></table></div>';
  return { subject, text, html };
}

// ---- Modul „Smlouvy" (Hlídač smluv) — samostatná složka ./smlouvy ----
// Načtení je izolované: kdyby modul selhal (např. nedostupné node:sqlite),
// nesmí shodit zbytek intranetu (směrnice, dovolená, knihovna…).
let smlouvyMod = null;
try {
  smlouvyMod = require('./smlouvy').mount({ reportDisabled,
    send, readBody, deliver, empSession, isAdmin, baseUrl, employeeModules, getState,
    dataDir: DATA_DIR,
    eskalaceEmail: SUPERADMIN,
    publicBaseUrl: (CFG.publicUrl || process.env.SMLOUVY_BASE_URL || ''),
    drive: { get available() { return driveAvailable(); }, list: driveList },
    driveRoots: (process.env.SMLOUVY_DRIVE_ROOT || '').split(',').map((x) => x.trim()).filter(Boolean),
    saEmail: GOOGLE_SA_CLIENT_EMAIL,
  });
} catch (e) {
  console.error('[smlouvy] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Adaptace" (onboarding nováčků) — samostatná složka ./adaptace ----
// Nativní přepis aplikace Adaptlink. Izolované načtení (kdyby selhal, běží zbytek).
let adaptaceMod = null;
try {
  adaptaceMod = require('./adaptace').mount({
    send, readBody, deliver, empSession, isAdmin, baseUrl, employeeModules, getState, ensureEmployee,
    dataDir: DATA_DIR,
    publicBaseUrl: (CFG.publicUrl || process.env.PUBLIC_URL || ''),
  });
} catch (e) {
  console.error('[adaptace] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Doprava" (výkony a náklady vozového parku, data z Google Sheets) ----
let dopravaMod = null;
try {
  dopravaMod = require('./doprava').mount({  reportDisabled,send, readBody, deliver, empSession, isAdmin, employeeModules, dataDir: DATA_DIR, publicBaseUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') });
} catch (e) {
  console.error('[doprava] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Konstrukce" (workflow zadání a schválení výkresů) ----
let konstrukceMod = null;
try {
  konstrukceMod = require('./konstrukce').mount({ reportDisabled,
    send, readBody, deliver, empSession, isAdmin, baseUrl, employeeModules, getState,
    isObchodnik: isObchodnikEmail,
    obchodniciList: obchodniciPrehled,
    jeZlin: jeZlinEmail,
    dataDir: DATA_DIR,
    mailFrom: { user: CFG.user, name: CFG.fromName || 'Intranet – konstrukce', publicUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') },
    // Archiv výkresů: čtení sdíleného Disku výroby Bruntál přes service account
    drive: { available: driveAvailable, token: driveGetToken },
    vykresyRoot: process.env.VYKRESY_DRIVE_ROOT || '1Fk92-QvkDyhdBWl2lnj2zdaw5wShviJV',
  });
} catch (e) {
  console.error('[konstrukce] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

let reklamaceMod = null;
try {
  reklamaceMod = require('./reklamace').mount({
    send, readBody, deliver, empSession, isAdmin, baseUrl, employeeModules, getState, logActivity,
    dataDir: DATA_DIR,
    mailFrom: { user: CFG.user, name: CFG.fromName || 'Intranet – reklamace', publicUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') },
  });
} catch (e) {
  console.error('[reklamace] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Zápisy z interních jednání" — samostatná složka ./zapisy ----
let zapisyMod = null;
try {
  zapisyMod = require('./zapisy').mount({ send, readBody, empSession, isAdmin, logActivity, dataDir: DATA_DIR });
} catch (e) {
  console.error('[zapisy] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Požadavky nákupu" (E-shop → nákupčí) — samostatná složka ./pozadavky ----
let pozadavkyMod = null;
try {
  pozadavkyMod = require('./pozadavky').mount({
    send, readBody, deliver, empSession, isAdmin, baseUrl, employeeModules, getState, logActivity,
    dataDir: DATA_DIR,
    mailFrom: { user: CFG.user, name: CFG.fromName || 'Intranet – požadavky', publicUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') },
  });
} catch (e) {
  console.error('[pozadavky] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Lodní kontejnery" (veřejný web + poptávky) — samostatná složka ./kontejnery ----
let kontejneryMod = null;
try {
  kontejneryMod = require('./kontejnery').mount({ reportDisabled,
    send, readBody, deliver, empSession, isAdmin, baseUrl, employeeModules, getState, logActivity,
    dataDir: DATA_DIR, ssoSecret: SSO_SHARED_SECRET, sheetsGet, sheetsMeta,
    mailFrom: { user: CFG.user, name: CFG.fromName || 'ELKOPLAST — kontejnery', publicUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') },
  });
} catch (e) {
  console.error('[kontejnery] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Mobilní lisy" (mobilní-lisy.cz — veřejný web + dotazník → přihlášky) ----
let mobilniLisyMod = null;
try {
  mobilniLisyMod = require('./mobilni-lisy').mount({ reportDisabled,
    send, readBody, deliver, empSession, isAdmin, baseUrl, employeeModules, getState, logActivity,
    dataDir: DATA_DIR,
    mailFrom: { user: CFG.user, name: CFG.fromName || 'ELKOPLAST — mobilní lisy', publicUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') },
  });
} catch (e) {
  console.error('[mobilni-lisy] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Týdenní reporty nákupu" (co zlevnit / co nakoupit — e-maily z dat SMI) ----
let nakupReportMod = null;
try {
  nakupReportMod = require('./nakup-report').mount({ reportDisabled,
    send, readBody, deliver, isAdmin, empSession, employeeModules,
    dataDir: DATA_DIR,
    mailFrom: { user: CFG.user, name: CFG.fromName || 'Intranet ELKOPLAST — nákup', publicUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') },
  });
} catch (e) {
  console.error('[nakup-report] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Qooling" (stav závad kvality — Drive sync + pondělní report) ----
let qoolingMod = null;
try {
  qoolingMod = require('./qooling').mount({ reportDisabled,
    send, readBody, deliver, isAdmin, empSession, employeeModules, getState,
    dataDir: DATA_DIR,
    mailFrom: { user: CFG.user, name: CFG.fromName || 'Intranet ELKOPLAST — Qooling', publicUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') },
  });
} catch (e) {
  console.error('[qooling] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true); const p = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });

  // Klientská doména mobilní-lisy.cz (alias na tuto app) — jen prezentace + dotazník, PŘED závorou.
  if (mobilniLisyMod && await mobilniLisyMod.handleClientHost(req, res)) return;

  // Veřejná sběrná doména zákaznických průzkumů (vyzkum.elkoplast.cz) — obsluha PŘED závorou.
  // Průzkum se otevře jen na neuhodnutelné cestě ze SURVEY_SLUGS; kořen = neutrální rozcestník;
  // fotky a příjem hlasů propadnou níže (jsou veřejné); vše ostatní přesměruje na kořen,
  // takže intranet na této adrese není dostupný (ani přihlášení — roli si tu respondent volí ručně).
  const surveyHost = SURVEY_HOSTS.indexOf((req.headers.host || '').toLowerCase().replace(/:\d+$/, '')) >= 0;
  if (surveyHost) {
    const slugFile = SURVEY_SLUGS[p.slice(1)] && SURVEY_SLUGS[p.slice(1)]();
    if (slugFile) {
      if (!fs.existsSync(slugFile)) return send(res, 404, '<h1>Průzkum není k dispozici.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(slugFile, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/' || p === '/index.html')
      return send(res, 200, SURVEY_LANDING, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    const surveyOk = p.indexOf('/mobiliar-foto/') === 0 || (p === '/api/mobiliar/vote' && req.method === 'POST') || p === '/healthz' || p === '/api/version';
    if (!surveyOk) { res.writeHead(302, { 'Location': '/' }); return res.end(); }
  }

  // pozvánkový hash: podepsaný odkaz ?i=... pustí NEzaměstnance na dotazník bez přihlášení
  const invite = inviteVerify(u.query.i || '');
  const INVITE_ROUTES = ['/grit', '/grit.html', '/jss', '/jss.html', '/tw44', '/tw44.html', '/vykresy', '/vykresy.html', '/logika', '/logika.html', '/api/grit', '/api/jss', '/api/tw44', '/api/vykresy', '/api/logika', '/api/logika-zadani'];
  const inviteOk = !!(invite && INVITE_ROUTES.indexOf(p) >= 0);
  // Veřejné cesty modulu Smlouvy (mimo SSO závoru): potvrzení termínu tokenem + Resend webhook.
  const smlouvyPublic = p.startsWith('/smlouvy/potvrdit') || p === '/api/smlouvy/webhook/resend';
  // Veřejné cesty modulu Adaptace: magic-link pozvánka, guest plnění, import z náboru.
  const adaptacePublic = p.startsWith('/adaptace/uvod/') || p === '/api/adaptace/guest' || p === '/api/adaptace/guest-flag' || p === '/api/adaptace/import-user';
  // Veřejné cesty modulu Konstrukce: klientský náhled výkresu (token, bez přihlášení).
  const konstrukcePublic = p.startsWith('/konstrukce/nahled/') || p.startsWith('/api/konstrukce/nahled/');
  // Veřejné cesty modulu Reklamace: klientský reklamační formulář na token (bez přihlášení).
  const reklamacePublic = p.startsWith('/reklamace/r/') || p.startsWith('/api/reklamace/verejny/');
  // Veřejné cesty klientské kalkulačky překladiště (lead-gen mimo přihlašovací závoru): stránka + odeslání leadu.
  const prekladPublic = p === '/preklad' || p === '/preklad.html' || (p === '/api/preklad-lead' && req.method === 'POST');
  // Server-to-server cesty modulu Lodní kontejnery (Bearer = SSO tajemství) z aplikace lodni-kontejnery.
  const kontejneryPublic = (p === '/api/kontejnery/ingest' && req.method === 'POST') || (p === '/api/kontejnery/detail' && req.method === 'GET') || (p === '/api/kontejnery/nabidka-ext' && req.method === 'POST') || (p === '/api/kontejnery/nastaveni-ext') || (p === '/api/kontejnery/cenik-ext' && req.method === 'GET') || (p === '/api/kontejnery/list-ext' && req.method === 'GET') || (p === '/api/kontejnery/update-ext' && req.method === 'POST') || (p === '/api/kontejnery/potvrdit-ext' && req.method === 'POST');
  const libraryIngestPublic = (p === '/api/library/ingest-ext' && req.method === 'POST');
  // Veřejná stránka garantů (odkaz s tokenem pro kolegy ze SK/PL) + její API.
  const garantiPublic = p.indexOf('/garanti/') === 0 || p.indexOf('/api/garanti/verejne') === 0 || (p === '/api/garanti/zapis' && req.method === 'POST');   // Bearer SSO_SHARED_SECRET (vkládání dokumentů přes chat)
  // Veřejné cesty modulu Mobilní lisy: prezentační web + odeslání dotazníku (bez přihlášení).
  const mobilniLisyPublic = p === '/mobilni-lisy' || (p === '/api/mobilni-lisy/prihlaska' && req.method === 'POST') || (p === '/api/mobilni-lisy/pozadi' && req.method === 'GET');
  // Veřejné cesty hodnocení mobiliáře (obrázkový průzkum pro obchodníky i zákazníky): stránka + fotky + hlasy.
  const mobiliarPublic = p === '/mobiliar' || p === '/mobiliar.html' || p.indexOf('/mobiliar-foto/') === 0 || (p === '/api/mobiliar/vote' && req.method === 'POST');

  // Verze běžícího serveru – klient si podle ní pozná, že běží na staré verzi z cache (mimo závoru, bez cache).
  if (p === '/api/version') return send(res, 200, { commit: GIT_COMMIT, built: BUILD_TIME, deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null }, { 'Cache-Control': 'no-store' });

  // Veřejná stránka „Garanti produktů" — /garanti/<token>, bez přihlášení.
  if (p.indexOf('/garanti/') === 0 && req.method === 'GET') {
    const tok = p.split('/')[2] || '';
    if (!garantiTokenOk(tok)) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<meta charset="utf-8"><p style="font:16px system-ui;padding:40px">Tento odkaz už neplatí.</p>'); }
    return fs.readFile(path.join(ROOT, 'garanti.html'), (e, d) => {
      if (e) { res.writeHead(404); return res.end('Chybí garanti.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      res.end(d);
    });
  }

  // Starý odkaz /kontejnery → přesměruj na samostatnou aplikaci (klientský web). Veřejné, mimo závoru.
  if (p === '/kontejnery' && req.method === 'GET') { const t = LODAKY_APP_URL || 'https://lodak.elkoplast.cz'; res.writeHead(302, { 'Location': t + (u.hash || '') }); return res.end(); }

  // ---- Jednorázový import směrnic (server-to-server; Bearer = SSO_SHARED_SECRET) ----
  // Tělo: { items: [{ title, html, kategorie?, zdrojUrl? }] }. Dedupe dle názvu; publikuje ihned.
  if (p === '/api/smernice-import' && req.method === 'POST') {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let okAuth = false;
    try { okAuth = auth.length > 0 && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(SSO_SHARED_SECRET)); } catch (_) { okAuth = false; }
    if (!okAuth) return send(res, 401, { error: 'Neplatné tajemství.' });
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
    const items = Array.isArray(b.items) ? b.items : [];
    const s = getState(); s.directives = s.directives || []; s.settings = s.settings || {};
    const { buildPublished } = require('./smernice-pub');
    let pridano = 0, preskoceno = 0; const chyby = [];
    for (const it of items) {
      if (!it || !it.title || !it.html) { chyby.push('položka bez title/html'); continue; }
      if (s.directives.some(d => (d.title || '').trim().toLowerCase() === String(it.title).trim().toLowerCase())) { preskoceno++; continue; }
      const id = 'imp' + crypto.randomBytes(5).toString('hex');
      const html = String(it.html) + (it.zdrojUrl ? '<p style="margin-top:2.5em;font-size:12px;color:#8a8d86">Originál dokumentu: <a href="' + esc(it.zdrojUrl) + '" target="_blank" rel="noopener">soubor na Disku</a></p>' : '');
      const d = { id, title: String(it.title).trim(), html, createdAt: Date.now(), assignAll: true, assignCats: [], assignTags: [], kategorie: it.kategorie || null, verze: 1, acks: {} };
      s.directives.push(d);
      try {
        const aud = (s.employees || []).filter(e => assignedTo(d, e)).map(e => ({ email: e.email, name: e.name }));
        const pub = buildPublished(d, { audience: aud, hrEmail: s.settings.hrEmail || '', apiUrl: s.settings.apiUrl || '', baseUrl: s.settings.baseUrl || baseUrl(req) });
        fs.writeFileSync(path.join(PUB_DIR, id + '.html'), pub, 'utf8');
      } catch (e) { chyby.push(d.title + ': publikace selhala — ' + e.message); }
      pridano++;
    }
    writeJson(STATE_F, s);
    logActivity('import', { email: '', name: 'server' }, 'Import směrnic z Disku: +' + pridano + ' (přeskočeno ' + preskoceno + ')');
    return send(res, 200, { ok: true, pridano, preskoceno, chyby });
  }

  // ---- Registr termínů z wiki: hostovaný na NAŠÍ infrastruktuře (žádný GitHub) ----
  // Nahrání (po ingestu wiki) i čtení jinou službou chrání sdílené tajemství (Bearer = SSO_SHARED_SECRET).
  if (p === '/api/wiki-registr') {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let okAuth = false;
    try { okAuth = auth.length > 0 && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(SSO_SHARED_SECRET)); } catch (_) { okAuth = false; }
    if (!okAuth) return send(res, 401, { error: 'Neplatné tajemství.' });
    const regFile = path.join(DATA_DIR, 'wiki-terminy.md');
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.length < 10 || body.indexOf('|') < 0) return send(res, 400, { error: 'Tělo nevypadá jako registr (markdown tabulka).' });
      fs.writeFileSync(regFile, body, 'utf8');
      const radku = (body.match(/^\|\s*\d{4}-\d{2}-\d{2}/gm) || []).length;
      return send(res, 200, { ok: true, radku, ulozeno: new Date().toISOString() });
    }
    if (req.method === 'GET') {
      if (!fs.existsSync(regFile)) return send(res, 404, { error: 'Registr zatím nebyl nahrán.' });
      return send(res, 200, fs.readFileSync(regFile, 'utf8'), { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    return send(res, 405, { error: 'Jen GET/POST.' });
  }

  // Healthcheck (veřejný, vždy 200) – pro Railway healthcheck a jednoznačnou identifikaci běžícího nasazení.
  if (p === '/healthz') return send(res, 200, { ok: true, commit: GIT_COMMIT, deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null, uptimeS: Math.round(process.uptime()) }, { 'Cache-Control': 'no-store' });

  // sdílená závora celého webu (Google SSO nebo sdílené heslo; aktivní jen když je aspoň jedno nastaveno)
  if (!gatePassed(req) && !inviteOk && !smlouvyPublic && !adaptacePublic && !konstrukcePublic && !reklamacePublic && !prekladPublic && !kontejneryPublic && !mobilniLisyPublic && !mobiliarPublic && !libraryIngestPublic && !garantiPublic) {
    // přihlášení sdíleným heslem
    if (p === '/gate-login' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) {}
      if (SITE_PASSWORD && (b.password || '') === SITE_PASSWORD) {
        const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sm_gate=' + gateToken() + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000' + secure });
      }
      return send(res, 401, { error: 'Nesprávné heslo.' });
    }
    // Google SSO přihlašovací tok propustíme (jinak by se nešlo přihlásit)
    const authFlow = (p === '/auth/google/login' || p === '/auth/google/callback' || p === '/auth/logout' || p === '/auth/dev');
    if (!authFlow) {
      if (req.method === 'GET' && (req.headers.accept || '').indexOf('text/html') >= 0)
        return send(res, 200, gatePage(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return send(res, 401, { error: 'Vyžadováno přihlášení.' });
    }
    // authFlow → propadne do běžného routingu níže
  }

  // chráněné cesty (správa)
  const PROTECTED = ['/api/state', '/api/send', '/api/publish', '/api/test', '/api/config', '/api/library', '/api/report/preview', '/api/report/send', '/api/grit-results', '/api/jss-results', '/api/tw44-results', '/api/vykresy-results', '/api/logika-results', '/api/mobiliar-results'];
  if (PROTECTED.indexOf(p) >= 0 && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });

  try {
    // Modul „Smlouvy" si obslouží vlastní cesty (/smlouvy*, /api/smlouvy*).
    if (smlouvyMod && await smlouvyMod.handle(req, res)) return;
    // Modul „Adaptace" si obslouží vlastní cesty (/adaptace*, /api/adaptace*).
    if (adaptaceMod && await adaptaceMod.handle(req, res)) return;
    // Modul „Doprava" si obslouží vlastní cesty (/doprava*, /api/doprava*).
    if (dopravaMod && await dopravaMod.handle(req, res)) return;
    // Modul „Konstrukce" si obslouží vlastní cesty (/konstrukce*, /api/konstrukce*).
    if (konstrukceMod && await konstrukceMod.handle(req, res)) return;
    // Modul „Reklamace" si obslouží vlastní cesty (/reklamace*, /api/reklamace*).
    if (reklamaceMod && await reklamaceMod.handle(req, res)) return;
    // Modul „Zápisy z interních jednání" si obslouží vlastní cesty (/api/zapisy*).
    if (zapisyMod && await zapisyMod.handle(req, res)) return;
    // Modul „Požadavky nákupu" si obslouží vlastní cesty (/pozadavky*, /api/pozadavky*).
    if (pozadavkyMod && await pozadavkyMod.handle(req, res)) return;
    // Modul „Lodní kontejnery" si obslouží vlastní cesty (/kontejnery*, /api/kontejnery*).
    if (kontejneryMod && await kontejneryMod.handle(req, res)) return;
    // Modul „Mobilní lisy" si obslouží vlastní cesty (/mobilni-lisy*, /api/mobilni-lisy*).
    if (mobilniLisyMod && await mobilniLisyMod.handle(req, res)) return;
    if (nakupReportMod && await nakupReportMod.handle(req, res)) return;
    // Modul „Qooling" si obslouží vlastní cesty (/api/qooling*).
    if (qoolingMod && await qoolingMod.handle(req, res)) return;

    // Centrální přehled rozesílek (správce) — agreguje descriptory z modulů, které je vystavují.
    if (p === '/api/admin/reports' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Jen pro správce.' });
      const mods = [nakupReportMod, dopravaMod, mobilniLisyMod, smlouvyMod, konstrukceMod, reklamaceMod, kontejneryMod, pozadavkyMod, qoolingMod];
      let out = [];
      // Jádro intranetu: měsíční vyhodnocení seznámení se směrnicemi.
      try {
        const st = readJson(REPORT_F, {});
        out.push({ key: 'smernice-mesicni', module: 'Směrnice', name: 'Měsíční vyhodnocení seznámení se směrnicemi', to: [reportRecipient()], enabled: reportEnabled() && emailConfigured(), schedule: 'měsíčně (' + reportDay() + '. den)', lastAt: st.lastSentAt || null, preview: null, readOnly: true, configHint: 'nastavuje se v proměnných prostředí (REPORT_EMAIL / REPORT_DAY / REPORT_ENABLED); tady lze jen zrušit odesílání' });
      } catch (_) {}
      // Jádro intranetu: měsíční přehled čerpání dovolené (příjemce lze měnit tady).
      try {
        const vc = vacRepCfg();
        out.push({ key: 'dovolena-mesicni', module: 'Dovolená', name: 'Měsíční přehled čerpání dovolené', to: vc.to,
          enabled: vc.enabled && emailConfigured(), schedule: 'měsíčně (' + vc.day + '. den, za předchozí měsíc)',
          lastAt: vc.lastSentAt || null, den: vc.day, preview: '/api/vacation/report-preview', readOnly: false,
          configHint: 'kdo v měsíci čerpal dovolenou, co je schválené dopředu a jaké má kdo konto' });
      } catch (_) {}
      for (const m of mods) { if (m && typeof m.reports === 'function') { try { const rs = m.reports() || []; rs.forEach(r => out.push(r)); } catch (_) {} } }
      // Centrální vypínač: zrušené rozesílky jsou vypnuté bez ohledu na nastavení modulu.
      const off = rozesilkyOff();
      out.forEach(r => { r.vypnutoCentralne = !!off[r.key]; if (r.vypnutoCentralne) r.enabled = false; });
      // Historie VŠECH odeslaných e-mailů (i jednorázových notifikací) — centrální evidence z deliver().
      return send(res, 200, { reports: out, maily: mailLogRead(200) });
    }
    // Plná editace rozesílky přímo v přehledu: zapnout/vypnout, příjemci, den, hodina.
    if (p === '/api/admin/reports/edit' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Jen pro správce.' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const key = String(b.key || '').trim();
      if (!key) return send(res, 400, { error: 'Chybí klíč rozesílky.' });
      // Měsíční přehled dovolené je v jádru — obsloužíme ho tady.
      if (key === 'dovolena-mesicni') {
        const patch = {};
        if (Array.isArray(b.to)) patch.to = b.to.map(x => String(x || '').trim().toLowerCase()).filter(x => x.indexOf('@') > 0);
        if (b.den != null || b.day != null) patch.day = Math.max(1, Math.min(28, Number(b.den != null ? b.den : b.day) || 1));
        if (b.enabled != null) patch.enabled = !!b.enabled;
        const vc = vacRepWrite(patch);
        const off = rozesilkyOff();
        if (b.enabled === true && off[key]) { delete off[key]; rozesilkyOffWrite(off); }
        else if (b.enabled === false) { off[key] = true; rozesilkyOffWrite(off); }
        return send(res, 200, { ok: true, report: { key, module: 'Dovolená', name: 'Měsíční přehled čerpání dovolené', to: vc.to, enabled: vc.enabled, den: vc.day, schedule: 'měsíčně (' + vc.day + '. den, za předchozí měsíc)' } });
      }
      const mods = [nakupReportMod, dopravaMod, mobilniLisyMod, smlouvyMod, konstrukceMod, reklamaceMod, kontejneryMod, pozadavkyMod, qoolingMod];
      for (const m of mods) {
        if (!m || typeof m.setReport !== 'function') continue;
        let r = null; try { r = m.setReport(key, b); } catch (e) { return send(res, 500, { error: e.message }); }
        if (!r) continue;
        // Zapnutí v přehledu zruší i centrální vypnutí, ať to nedělá zmatek.
        const off = rozesilkyOff();
        if (b.enabled === true && off[key]) { delete off[key]; rozesilkyOffWrite(off); }
        else if (b.enabled === false) { off[key] = true; rozesilkyOffWrite(off); }
        r.vypnutoCentralne = !!rozesilkyOff()[key];
        const aktor = empSession(req) || { email: '', name: 'správce' };
        logActivity('rozesilka', { email: aktor.email, name: aktor.name }, 'Upravena rozesílka „' + r.name + '": ' + (r.enabled ? 'zapnuta' : 'vypnuta') + ' · ' + (r.to || []).join(', '));
        return send(res, 200, { ok: true, report: r });
      }
      return send(res, 404, { error: 'Rozesílku „' + key + '" nelze upravit odsud (nastavuje se jinde).' });
    }
    if (p === '/api/admin/reports/toggle' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Jen pro správce.' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const key = String(b.key || '').trim();
      if (!key) return send(res, 400, { error: 'Chybí klíč rozesílky.' });
      const off = rozesilkyOff();
      if (b.vypnout) off[key] = true; else delete off[key];
      rozesilkyOffWrite(off);
      const aktor = empSession(req) || { email: '', name: 'správce' };
      logActivity('rozesilka', { email: aktor.email, name: aktor.name }, (b.vypnout ? 'ZRUŠENO odesílání rozesílky: ' : 'Obnoveno odesílání rozesílky: ') + key);
      return send(res, 200, { ok: true, vypnute: Object.keys(off) });
    }

    // Kořen = zaměstnanecký intranet, /admin = administrace. Obě cesty servírují stejnou SPA;
    // režim se rozhodne v prohlížeči podle cesty. Přístup do správy hlídá /api/state (jinak přihlašovací okno).
    if (p === '/' || p === '/index.html' || p === '/admin' || p === '/admin/') {
      if (!fs.existsSync(APP_FILE)) return send(res, 404, '<h1>Chybí seznameni-se-smernicemi.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, injectViewAsUI(injectVersion(fs.readFileSync(APP_FILE, 'utf8')), req), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/grit' || p === '/grit.html') {
      if (!fs.existsSync(GRIT_FILE)) return send(res, 404, '<h1>Chybí grit.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(GRIT_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/tw44' || p === '/tw44.html') {
      if (!fs.existsSync(TW44_FILE)) return send(res, 404, '<h1>Chybí tw44.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(TW44_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/jss' || p === '/jss.html') {
      if (!fs.existsSync(JSS_FILE)) return send(res, 404, '<h1>Chybí jss.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(JSS_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/vykresy' || p === '/vykresy.html') {
      if (!fs.existsSync(VYKRESY_FILE)) return send(res, 404, '<h1>Chybí vykresy.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(VYKRESY_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/logika' || p === '/logika.html') {
      if (!fs.existsSync(LOGIKA_FILE)) return send(res, 404, '<h1>Chybí logika.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      let html = fs.readFileSync(LOGIKA_FILE, 'utf8');
      // Režim náhledu (?preview=1) smí zapnout jen skutečný správce — kandidát s pozvánkou
      // by si jinak přidáním parametru zobrazil správné odpovědi bez uložení výsledku.
      if (isRealAdmin(req)) html = html.replace('/*__LOGIKA_ADMIN__*/', 'window.LOGIKA_ADMIN=1;');
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    // Veřejné hodnocení venkovního mobiliáře — přihlášenému zaměstnanci předvybere roli obchodníka.
    if (p === '/mobiliar' || p === '/mobiliar.html') {
      if (!fs.existsSync(MOBILIAR_FILE)) return send(res, 404, '<h1>Chybí mobiliar.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      let html = fs.readFileSync(MOBILIAR_FILE, 'utf8');
      const e = empSession(req);
      if (e) html = html.replace('/*__MJ_EMP__*/', 'window.MJ_EMP=' + JSON.stringify({ name: e.name || '', email: e.email || '' }) + ';');
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    // Fotky mobiliáře (assets/mobiliar) — vlastní veřejná cesta, /assets/ podadresáře neumí a je za závorou.
    if (p.indexOf('/mobiliar-foto/') === 0) {
      const rel = p.slice('/mobiliar-foto/'.length).replace(/[^a-z0-9.-]/g, '');
      const f = path.join(ROOT, 'assets', 'mobiliar', rel);
      if (!rel.endsWith('.jpg') || rel.indexOf('..') >= 0 || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nenalezeno'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
      return res.end(fs.readFileSync(f));
    }
    if (p === '/koncept' || p === '/koncept.html') {
      if (!fs.existsSync(KONCEPT_FILE)) return send(res, 404, '<h1>Chybí intranet-koncept.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(KONCEPT_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    // „Zobrazit jako zaměstnanec" — výběrová stránka pro skutečného admina.
    if (p === '/view-as') {
      if (!isRealAdmin(req)) return send(res, 403, '<!doctype html><meta charset="utf-8"><body style="font:15px Segoe UI,Arial;padding:40px;color:#333">Tato stránka je jen pro správce. <a href="/">Zpět na intranet</a></body>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, VIEW_AS_PAGE, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    // Veřejná klientská kalkulačka překladiště (lead-gen; bez přihlášení) — vč. příjmu leadu.
    if (p === '/preklad' || p === '/preklad.html') {
      if (!fs.existsSync(PREKLAD_VEREJNY_FILE)) return send(res, 404, '<h1>Chybí preklad-verejny.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(PREKLAD_VEREJNY_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/api/preklad-lead' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const email = String(b.email || '').trim(), phone = String(b.phone || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Zadejte platný e-mail.' });
      if (phone.replace(/[^0-9]/g, '').length < 9) return send(res, 400, { error: 'Zadejte platné telefonní číslo.' });
      const rec = addLead(b, req);
      try { logActivity('preklad-lead', { email: '', name: 'veřejná kalkulačka' }, 'Nový lead překladiště: ' + (rec.firma || rec.email)); } catch (_) {}
      notifyLead(rec);
      return send(res, 200, { ok: true });
    }
    // Statické obrázky/ikony intranetu (např. hero fotka) z adresáře ./assets. Binárně, s cache.
    if (p.indexOf('/assets/') === 0) {
      const rel = p.slice(8).replace(/[^a-zA-Z0-9._-]/g, '');
      const f = path.join(ROOT, 'assets', rel);
      if (!f.startsWith(path.join(ROOT, 'assets') + path.sep) || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nenalezeno'); }
      const ext = path.extname(f).toLowerCase();
      const CT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif' };
      res.writeHead(200, { 'Content-Type': CT[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(f));
    }
    // Nahrané obrázky (aktuality, banner) z persistentního DATA_DIR/uploads.
    if (p.indexOf('/uploads/') === 0) {
      const rel = p.slice(9).replace(/[^a-zA-Z0-9._-]/g, '');
      const f = path.join(UPLOADS_DIR, rel);
      if (!f.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nenalezeno'); }
      const ext = path.extname(f).toLowerCase();
      const CT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
      const uhdrs = { 'Content-Type': CT[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' };
      if (ext === '.svg') uhdrs['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
      res.writeHead(200, uhdrs);
      return res.end(fs.readFileSync(f));
    }
    // Logo v hlavičce intranetu (veřejné čtení — hlavička ho načítá v adminu i intranetu).
    if (p === '/api/site/logo' && req.method === 'GET') {
      return send(res, 200, { logo: (readJson(SITE_F, {}).logoImage) || null });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      if ((b.password || '') === SEC.password) { const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''; logActivity('admin-login', { email: '', name: 'Správce (heslo)' }, ''); return send(res, 200, { ok: true }, { 'Set-Cookie': 'sm_auth=' + token() + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000' + secure }); }
      return send(res, 401, { error: 'Nesprávné heslo.' });
    }
    if (p === '/api/activity' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); const log = readJson(ACTLOG_F, []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 200); return send(res, 200, { events: log }); }
    if (p === '/api/invites' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, { invites: readInvites() }); }
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, getState());
    // Příloha směrnice: nahrání PDF (jen správce). Vrací veřejnou cestu, kterou si klient uloží k směrnici.
    if (p === '/api/smernice/pdf' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nahrávat může jen správce.' });
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Soubor je moc velký nebo poškozený (max 8 MB).' }); }
      try {
        const url = saveDataUrlPdf(b.dataUrl);
        if (!url) return send(res, 400, { error: 'Nahrajte prosím soubor ve formátu PDF.' });
        let orient = '';
        try { orient = pdfOrientation(fs.readFileSync(path.join(UPLOADS_DIR, url.slice(9)))); } catch (_) {}
        return send(res, 200, { ok: true, url, name: String(b.name || '').slice(0, 200), orient });
      } catch (e) { return send(res, 400, { error: e.message || 'Nahrání selhalo.' }); }
    }

    if (p === '/api/state' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); writeJson(STATE_F, { categories: b.categories || [], employees: b.employees || [], directives: b.directives || [], profiles: b.profiles || [], candidates: b.candidates || [], settings: b.settings || {} }); return send(res, 200, { ok: true }); }
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, configStatus());
    if (p === '/api/config' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); writeConfig({ host: (b.host || '').trim(), port: Number(b.port) || 587, secure: !!b.secure, user: (b.user || '').trim(), pass: b.pass, fromName: (b.fromName || '').trim() }); return send(res, 200, { ok: true, status: configStatus() }); }
    if (p === '/api/test' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      if (!process.env.RESEND_API_KEY && (!CFG.host || !CFG.user)) return send(res, 400, { error: 'Pošta není nastavená.' });
      try { const tSubj = b.subject || 'Zkušební e-mail – Seznámení se směrnicemi'; const tBody = b.body || 'Toto je zkušební e-mail.\nPokud jste ho dostali, odesílání funguje.'; await deliver({ to: (b.to || CFG.user || '').trim(), fromAddr: b.fromEmail || CFG.user, fromEmail: b.fromEmail || undefined, fromName: b.fromName || CFG.fromName, subject: tSubj, text: tBody, html: toHtml(tBody) }); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (p === '/api/publish' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req)); const id = (b.id || '').replace(/[^a-z0-9]/gi, '');
      if (!id || !b.html) return send(res, 400, { error: 'Chybí id nebo html.' });
      fs.writeFileSync(path.join(PUB_DIR, id + '.html'), b.html, 'utf8');
      return send(res, 200, { url: baseUrl(req) + '/s/' + id });
    }
    if (p === '/api/send' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      if (!process.env.RESEND_API_KEY && (!CFG.host || !CFG.user)) return send(res, 500, { error: 'Pošta není nastavená — vyplň ji v záložce Nastavení.' });
      const recipients = b.recipients || []; const results = []; const queue = recipients.slice();
      const useResend = !!process.env.RESEND_API_KEY;
      async function worker() { while (queue.length) { const r = queue.shift(); const fn = ((r.name || '').split(' ')[0] || r.name || ''); const vars = { jmeno: fn, jmeno5: vocCs(fn), osloveni: osloveniCs(r.name, r.gender), smernice: b.dirTitle || '', odkaz: r.link || '' }; const subject = renderTpl(b.subject, vars), text = renderTpl(b.body, vars); try { await deliver({ to: r.email, fromAddr: b.fromEmail || CFG.user, fromEmail: b.fromEmail || undefined, fromName: b.fromName || CFG.fromName, subject, text, html: toHtml(text, r.link, b.btnLabel) }); results.push({ email: r.email, ok: true }); } catch (e) { results.push({ email: r.email, ok: false, error: e.message }); } if (useResend) await sleep(550); } }
      await Promise.all(Array.from({ length: useResend ? 1 : Math.min(3, recipients.length || 1) }, worker));
      return send(res, 200, { results });
    }
    // veřejné cesty
    if (p.indexOf('/s/') === 0) {
      const id = p.slice(3).replace(/[^a-z0-9]/gi, ''); const f = path.join(PUB_DIR, id + '.html');
      if (!fs.existsSync(f)) {
        // Stránka zatím nebyla publikována (správce jen uložil) → vygenerovat na serveru z aktuálního stavu.
        const s = getState(); const d = (s.directives || []).find(x => String(x.id) === id);
        if (!d || (!d.html && !d.pdf)) return send(res, 404, '<h1>Směrnice nenalezena</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
        try {
          const { buildPublished } = require('./smernice-pub');
          const aud = (s.employees || []).filter(e => assignedTo(d, e)).map(e => ({ email: e.email, name: e.name }));
          const pub = buildPublished(d, { audience: aud, hrEmail: (s.settings || {}).hrEmail || '', apiUrl: '', baseUrl: baseUrl(req) });
          fs.writeFileSync(f, pub, 'utf8');
        } catch (e) { return send(res, 500, '<h1>Stránku se nepodařilo vygenerovat</h1>', { 'Content-Type': 'text/html; charset=utf-8' }); }
      }
      // Přihlášený zaměstnanec potvrzuje bez e-mailového odkazu: vložený skript doplní identitu
      // ze session (/api/me) do globálů stránky (who/emp) a překreslí potvrzení. Kdo v systému
      // není přihlášen, vidí původní chování (ruční e-mail / odkaz z e-mailu).
      const boot = '<script>(function(){try{if(typeof DATA==="object"&&DATA)DATA.api="";}catch(e){}try{if(typeof who==="undefined"||who)return;fetch("/api/me",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(!(j&&j.employee))return;try{who=j.employee.email;emp=null;for(var i=0;i<DATA.aud.length;i++){if(DATA.aud[i].email.toLowerCase()===who.toLowerCase()){emp=DATA.aud[i];}}if(!emp){emp={name:j.employee.name||who,email:who};}if(document.readyState==="complete"){render();}else{window.addEventListener("load",render);}}catch(e){}}).catch(function(){});}catch(e){}})();</script>';
      const html = fs.readFileSync(f, 'utf8').replace('</body>', boot + '</body>');
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (p === '/api/ack' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      // Přihlášený zaměstnanec může potvrdit i bez e-mailu v těle — identita ze session.
      const e = empSession(req);
      if (!b.email && e) { b.email = e.email; b.name = b.name || e.name; }
      if (!b.dirId || !b.email) return send(res, 400, { error: 'Chybí data.' });
      recordAck(b);
      return send(res, 200, { ok: true }, { 'Access-Control-Allow-Origin': '*' });
    }
    // Vynulování potvrzení směrnice (nová verze) — smaže i řádky v acks.json, jinak by je getState() přimíchal zpět.
    if (p === '/api/ack-reset' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req));
      if (!b.dirId) return send(res, 400, { error: 'Chybí dirId.' });
      const acks = readJson(ACKS_F, []);
      const zbyva = acks.filter(x => x.dirId !== b.dirId);
      writeJson(ACKS_F, zbyva);
      return send(res, 200, { ok: true, smazano: acks.length - zbyva.length });
    }
    // ---- test houževnatosti (Grit) ----
    if (p === '/api/grit' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (invite) { b.email = invite.e; b.name = invite.n; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const rec = recordGrit(b); if (rec.blocked) return send(res, 200, { ok: false, blocked: true, nextAt: rec.nextAt }, { 'Access-Control-Allow-Origin': '*' }); poslatHrVysledek('grit', rec); return send(res, 200, { ok: true, name: rec.name, dept: rec.dept, hs: rec.hs, pct: rec.pct }, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/grit-results' && req.method === 'GET') return send(res, 200, readJson(GRIT_F, []));
    // ---- dotazník pracovní spokojenosti (JSS) ----
    if (p === '/api/jss' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (invite) { b.email = invite.e; b.name = invite.n; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const rec = recordJss(b); if (rec.blocked) return send(res, 200, { ok: false, blocked: true, nextAt: rec.nextAt }, { 'Access-Control-Allow-Origin': '*' }); poslatHrVysledek('jss', rec); return send(res, 200, { ok: true, name: rec.name, dept: rec.dept, total: rec.total, pct: rec.pct }, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/jss-results' && req.method === 'GET') return send(res, 200, readJson(JSS_F, []));
    // ---- test kognitivní zátěže (TW44) ----
    if (p === '/api/tw44' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (invite) { b.email = invite.e; b.name = invite.n; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const rec = recordTw44(b); if (rec.blocked) return send(res, 200, { ok: false, blocked: true, nextAt: rec.nextAt }, { 'Access-Control-Allow-Origin': '*' }); poslatHrVysledek('tw44', rec); return send(res, 200, { ok: true, name: rec.name, dept: rec.dept }, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/tw44-results' && req.method === 'GET') return send(res, 200, readJson(TW44_F, []));

    if (p === '/api/vykresy' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (invite) { b.email = invite.e; b.name = invite.n; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const rec = recordVykresy(b); if (rec.blocked) return send(res, 200, { ok: false, blocked: true, nextAt: rec.nextAt }, { 'Access-Control-Allow-Origin': '*' }); poslatHrVysledek('vykresy', rec); return send(res, 200, { ok: true, name: rec.name, dept: rec.dept, skore: rec.skore, procenta: rec.procenta }, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/vykresy-results' && req.method === 'GET') return send(res, 200, readJson(VYKRESY_F, []));
    if (p === '/api/logika' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (invite) { b.email = invite.e; b.name = invite.n; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const rec = recordLogika(b); if (rec.blocked) return send(res, 200, { ok: false, blocked: true, nextAt: rec.nextAt }, { 'Access-Control-Allow-Origin': '*' }); poslatHrVysledek('logika', rec); return send(res, 200, { ok: true, name: rec.name, dept: rec.dept, skore: rec.skore, procenta: rec.procenta }, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/logika-results' && req.method === 'GET') return send(res, 200, readJson(LOGIKA_F, []));
    // Zadání testu (vč. správných odpovědí — klient hodnotí sám; stejná expozice jako dřívější embed v HTML).
    if (p === '/api/logika-zadani' && req.method === 'GET') {
      const d = loadLogikaOtazky();
      if (!d) return send(res, 200, { ok: false }, { 'Access-Control-Allow-Origin': '*' });
      return send(res, 200, { ok: true, limitMin: d.limitMin || 35, cats: d.cats, questions: d.questions }, { 'Access-Control-Allow-Origin': '*' });
    }
    // Editace otázek — jen správce. Uloží se na volume; seed v repu zůstává jako záloha.
    if (p === '/api/logika-otazky' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const d = loadLogikaOtazky() || { limitMin: 35, cats: [], questions: [] };
      return send(res, 200, Object.assign({ upraveno: fs.existsSync(LOGIKA_OT_F) }, d));
    }
    if (p === '/api/logika-otazky' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req));
      const doc = { limitMin: Math.round(+b.limitMin || 35), cats: (b.cats || []).map(x => String(x).slice(0, 60)),
        questions: (b.questions || []).map(q => ({ cat: Math.round(+q.cat || 0), text: String(q.text || '').slice(0, 2000),
          options: (q.options || []).map(o => String(o).slice(0, 300)), correct: Math.round(+q.correct || 0),
          correctText: String(q.correctText || '').slice(0, 500) })) };
      const chyba = validLogikaOtazky(doc);
      if (chyba) return send(res, 400, { error: chyba });
      writeJson(LOGIKA_OT_F, doc);
      logActivity('admin', { email: '', name: 'Správce' }, 'Test logiky: uloženy otázky (' + doc.questions.length + ' úloh)');
      return send(res, 200, { ok: true, questions: doc.questions.length });
    }

    // Hodnocení mobiliáře: příjem hlasů (veřejné, upsert dle rid) + výsledky pro admin.
    if (p === '/api/mobiliar/vote' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const r = recordMobiliar(b);
      if (r.error) return send(res, 400, r);
      return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' });
    }
    if (p === '/api/mobiliar-results' && req.method === 'GET') return send(res, 200, { kategorie: MOBILIAR_KATEGORIE, zaznamy: readJson(MOBILIAR_F, []), verejnyOdkaz: MOBILIAR_PUBLIC_URL });
    // ABROLL test: GET = stav pokusů dané osoby, POST = odeslání pokusu (max 3)
    if (p === '/api/abroll' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, abrollStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/abroll' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordAbroll(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/abroll-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(ABROLL_F, [])); }
    // Test znalosti produktů (školení obchodníků): GET = stav pokusů, POST = odeslání pokusu (max 3)
    if (p === '/api/produkty' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, produktyStatus(eml, u.query.type), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/produkty' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordProdukty(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/produkty-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(produktyFile(u.query.type), [])); }
    // Školení Průmysl: GET = stav pokusů dané osoby, POST = odeslání pokusu (max 3)
    if (p === '/api/prumysl' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, prumyslStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/prumysl' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordPrumysl(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/prumysl-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(PRUMYSL_F, [])); }
    if (p === '/api/loxxer-skoleni' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, loxxerSkoleniStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/loxxer-skoleni' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordLoxxerSkoleni(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/loxxer-skoleni-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(LOXXER_SKOLENI_F, [])); }
    if (p === '/api/acts-skoleni' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, actsSkoleniStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/acts-skoleni' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordActsSkoleni(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/acts-skoleni-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(ACTS_SKOLENI_F, [])); }
    if (p === '/api/zentex-skoleni' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, zentexSkoleniStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/zentex-skoleni' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordZentexSkoleni(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/zentex-skoleni-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(ZENTEX_SKOLENI_F, [])); }
    if (p === '/api/tridici-linky-skoleni' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, tridiciSkoleniStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/tridici-linky-skoleni' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordTridiciSkoleni(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/tridici-linky-skoleni-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(TRIDICI_SKOLENI_F, [])); }
    // Školení Čtení technických výkresů: GET = stav pokusů dané osoby, POST = odeslání pokusu (max 3)
    if (p === '/api/vykresy-skoleni' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, vykresySkoleniStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/vykresy-skoleni' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordVykresySkoleni(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/vykresy-skoleni-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(VYKRESY_SKOLENI_F, [])); }
    // Školení Průvodce svařováním: GET = stav pokusů dané osoby, POST = odeslání pokusu (max 3)
    if (p === '/api/svarovani-skoleni' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, svarovaniSkoleniStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/svarovani-skoleni' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordSvarovaniSkoleni(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/svarovani-skoleni-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(SVAROVANI_SKOLENI_F, [])); }
    // ---- Odeslání reportu průzkumu e-mailem (z detailu; jen správce) ----
    if (p === '/api/survey-report/send' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!emailConfigured()) return send(res, 500, { error: 'Pošta není nastavená — vyplň ji v záložce Nastavení.' });
      const b = JSON.parse(await readBody(req));
      const kind = (b.kind || '').toLowerCase();
      if (['grit', 'jss', 'tw44', 'vykresy', 'logika'].indexOf(kind) < 0) return send(res, 400, { error: 'Neznámý typ testu.' });
      const to = String(b.to || '').trim();
      if (to.indexOf('@') < 0) return send(res, 400, { error: 'Neplatný e-mail příjemce.' });
      const rec = surveyRec(kind, b.email);
      if (!rec) return send(res, 404, { error: 'Výsledek nenalezen.' });
      const nazev = SURVEY_NAZVY[kind] || kind;
      const html = surveyReportHtml(kind, rec, b.poznamka);
      const text = nazev + ' — ' + (rec.name || rec.email) + '\n\n' + surveyVysledekRadky(kind, rec).map(x => x[0] + ': ' + x[1]).join('\n');
      try {
        await deliver({ to, subject: 'Report: ' + (rec.name || rec.email) + ' — ' + nazev, text, html });
        logActivity('survey-report', { email: rec.email, name: rec.name }, 'Report (' + nazev + ') odeslán na ' + to);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 500, { error: e.message }); }
    }
    // podepsané pozvánkové odkazy (hash) pro dávku příjemců — jen pro správce
    // ---- Cenový monitoring (ESHOP × MEVA) — čtení i pro modul E-shop, zápisy jen správce ----
    if (p === '/api/cenmon' && req.method === 'GET') {
      const eCm = empSession(req);
      if (!isAdmin(req) && !(eCm && employeeModules(eCm.email).indexOf('eshop') >= 0)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const d = cenmonRead();
      return send(res, 200, { polozkyMeta: d.polozkyMeta, polozek: d.polozky.length, mevaMeta: d.mevaMeta, mevaPolozek: d.meva.length, scan: CENMON_SCAN, srovnani: cenmonSrovnani() });
    }
    if (p === '/api/cenmon/meva-katalog' && req.method === 'GET') {
      // Vrátí stažený katalog MEVA (pro vyhledávací náhled v SMI aplikaci).
      const eCm = empSession(req);
      if (!isAdmin(req) && !(eCm && employeeModules(eCm.email).indexOf('eshop') >= 0)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const d = cenmonRead();
      return send(res, 200, { mevaMeta: d.mevaMeta, mevaPolozek: d.meva.length, meva: d.meva });
    }
    if (p === '/api/cenmon/srovnej' && req.method === 'POST') {
      // Spáruje položky poslané z klienta (SMI aplikace) proti staženému katalogu MEVA — bez ukládání na server.
      const eCm = empSession(req);
      if (!isAdmin(req) && !(eCm && employeeModules(eCm.email).indexOf('eshop') >= 0)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req));
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 5000)
        .map(x => ({ kod: String(x.kod || '').trim(), nazev: String(x.nazev || '').trim(), cena: (x.cena == null || x.cena === '') ? null : (Number(x.cena) || null) }))
        .filter(x => x.nazev);
      const d = cenmonRead();
      return send(res, 200, { mevaMeta: d.mevaMeta, mevaPolozek: d.meva.length, polozek: items.length, srovnani: cenmonSrovnani(items) });
    }
    if (p === '/api/cenmon/polozky' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req));
      const items = (Array.isArray(b.items) ? b.items : []).map(x => ({ kod: String(x.kod || '').trim(), nazev: String(x.nazev || '').trim(), cena: Number(x.cena) || null })).filter(x => x.nazev);
      if (!items.length) return send(res, 400, { error: 'Žádné položky (zkontroluj mapování sloupců).' });
      const d = cenmonRead();
      d.polozky = items;
      d.polozkyMeta = { soubor: String(b.soubor || ''), kdy: Date.now(), radku: items.length };
      cenmonWrite(d);
      logActivity('cenmon', { email: '', name: 'admin' }, 'Nahrán export položek: ' + items.length + ' (' + (b.soubor || '') + ')');
      return send(res, 200, { ok: true, polozek: items.length });
    }
    if (p === '/api/cenmon/meva-scan' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (CENMON_SCAN.bezi) return send(res, 200, { ok: true, uzBezi: true, scan: CENMON_SCAN });
      cenmonMevaScan();   // běží na pozadí
      return send(res, 200, { ok: true, scan: CENMON_SCAN });
    }
    if (p === '/api/cenmon/scan-stav' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      return send(res, 200, { scan: CENMON_SCAN, mevaMeta: cenmonRead().mevaMeta });
    }
    if (p === '/api/cenmon/par' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req));
      if (!b.klic) return send(res, 400, { error: 'Chybí klíč položky.' });
      const d = cenmonRead();
      if (b.stav === 'reset') delete d.pary[b.klic];
      else d.pary[b.klic] = { mevaUrl: b.mevaUrl || null, stav: b.stav || 'potvrzeno' };
      cenmonWrite(d);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/invite-links' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req));
      const kind = (b.kind || '').replace(/[^a-z0-9]/gi, '');
      const base = baseUrl(req); const links = {};
      (b.list || []).forEach(r => { const e = (r.email || '').toLowerCase(); if (e && kind) links[e] = base + '/' + kind + '?i=' + encodeURIComponent(inviteSign(e, r.name || '')); });
      return send(res, 200, { links });
    }
    // pozvánka do intranetu (uvítací e-mail s návodem na přihlášení) — jen pro správce
    if (p === '/api/invite-intranet' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!emailConfigured()) return send(res, 500, { error: 'Pošta není nastavená — vyplň ji v záložce Nastavení.' });
      const b = JSON.parse(await readBody(req));
      const recipients = (b.recipients || []).filter(r => r.email);
      const url = baseUrl(req); const results = []; const useResend = !!process.env.RESEND_API_KEY;
      const queue = recipients.slice();
      async function worker() { while (queue.length) { const r = queue.shift(); const m = intranetInviteMail(r.name, url, b.tpl);
        try { await deliver({ to: r.email, fromAddr: b.fromEmail || CFG.user, fromEmail: b.fromEmail || undefined, fromName: b.fromName || CFG.fromName || 'Intranet ELKOPLAST', subject: m.subject, text: m.text, html: m.html }); markInvited(r.email, r.name); results.push({ email: r.email, ok: true }); }
        catch (e) { results.push({ email: r.email, ok: false, error: e.message }); } if (useResend) await sleep(550); } }
      await Promise.all(Array.from({ length: useResend ? 1 : Math.min(3, recipients.length || 1) }, worker));
      return send(res, 200, { results });
    }
    // náhled uvítacího e-mailu (pro zobrazení před odesláním) — jen pro správce
    if (p === '/api/invite-preview' && (req.method === 'GET' || req.method === 'POST')) {
      if (!isAuthed(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      let b = {}; if (req.method === 'POST') { try { b = JSON.parse(await readBody(req)); } catch (_) {} }
      const m = intranetInviteMail(b.name || u.query.name || '', baseUrl(req), { subject: b.subject, body: b.body });
      return send(res, 200, { subject: m.subject, html: m.html, mailReady: emailConfigured(), defaults: { subject: DEFAULT_INVITE_SUBJECT, body: DEFAULT_INVITE_BODY } });
    }
    // náhled hromadného rozeslání (směrnice/průzkumy) i zkušebního e-mailu — jen pro správce
    if (p === '/api/send-preview' && req.method === 'POST') {
      if (!isAuthed(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req));
      const fn = ((b.name || '').split(' ')[0]) || b.name || '';
      const link = b.link || '';
      const vars = { jmeno: fn, jmeno5: vocCs(fn), osloveni: osloveniCs(b.name, b.gender), smernice: b.dirTitle || '', odkaz: link };
      return send(res, 200, { subject: renderTpl(b.subject || '', vars), html: toHtml(renderTpl(b.body || '', vars), link, b.btnLabel), mailReady: emailConfigured() });
    }

    // ---- intranet zaměstnanců: přihlášení přes Google (SSO) ----
    if (p === '/api/me' && req.method === 'GET') { const e = empSession(req); const ra = empSessionReal(req); const va = viewAsActive(req); return send(res, 200, { sso: ssoEnabled(), dev: devAllowed(req), employee: e ? { email: e.email, name: e.name } : null, admin: isAdmin(req), superadmin: isSuperadmin(req), realAdmin: isRealAdmin(req), viewAs: va, real: (va && ra) ? { email: ra.email, name: ra.name } : (va ? { email: '', name: 'Správce' } : null), poptavkyNew: _poptavkyCache.n }); }

    // Nativní výpis poptávek v intranetu (data z nabídkové app). Gating jako /poptavky-app.
    if (p === '/api/poptavky' && req.method === 'GET') {
      const e = empSession(req);
      const mods = e ? (employeeModules(e.email) || []) : [];
      const allowed = isAdmin(req) || mods.indexOf('kalkulace') >= 0 || mods.indexOf('obchod') >= 0 || mods.indexOf('obchodexp') >= 0;
      if (!allowed) return send(res, 403, { error: 'Nemáte přístup k poptávkám.' });
      return fetchPoptavkyList((err, leads) => {
        if (err) return send(res, 200, { leads: [], error: err.message });
        _poptavkyCache = { n: (leads || []).length, at: Date.now() };
        return send(res, 200, { leads: leads });
      });
    }
    // ---- „Zobrazit jako zaměstnanec" (impersonace, jen skutečný admin) ----
    // ---- Školení: pozvánky k absolvování (jen správce) ----
    if (p === '/api/skoleni/lide' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Jen správce.' });
      const s = readJson(STATE_F, { employees: [] });
      const list = (s.employees || []).filter(x => x && x.email).map(x => ({ email: x.email, name: x.name || x.email }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
      return send(res, 200, { lide: list });
    }
    if (p === '/api/skoleni/pozvat' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Jen správce.' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const SKOLENI_NAZVY = {
        prumysl: 'Průmysl — obchodník segmentu Skladování',
        loxxer: 'LOXXER — protipožární skříně na Li-Ion baterie',
        kovo: 'Produkty KOVO — kovové výrobky',
        roto: 'Produkty ROTO — plastové výrobky',
        abroll: 'ABROLL — kódování a konfigurace',
        acts: 'ACTS — železniční abroll kontejnery',
        'vykresy-skoleni': 'Čtení technických výkresů (ČSN/ISO)',
        svarovani: 'Průvodce svařováním — hodnocení svarů (ISO 5817)',
        zentex: 'ZENTEX — lisovací kontejnery (výběr vhodného lisu)',
        'tridici-linky': 'Třídicí linky — technologie, trh a ekonomika dotřídění',
      };
      const nazev = SKOLENI_NAZVY[String(b.skoleni || '')];
      if (!nazev) return send(res, 400, { error: 'Neznámé školení.' });
      const emails = (Array.isArray(b.emails) ? b.emails : []).map(e => String(e || '').trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+$/.test(e));
      if (!emails.length) return send(res, 400, { error: 'Vyberte alespoň jednoho příjemce.' });
      const poznamka = String(b.poznamka || '').trim().slice(0, 1000);
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
      const link = proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host || 'intranet.elkoplast.cz') + '/#modul=skoleni';
      const me = empSession(req) || { email: '', name: 'správce' };
      const text = 'Dobrý den,\n\nzveme vás k absolvování školení v intranetu ELKOPLAST:\n\n  ' + nazev + '\n\n'
        + (poznamka ? 'Poznámka od správce: ' + poznamka + '\n\n' : '')
        + 'Školení otevřete v intranetu v sekci Školení:\n' + link + '\n\n'
        + (String(b.skoleni) === 'svarovani'
          ? 'Na konci školení je jednorázový závěrečný test — hranice splnění 80 %, jediný pokus.\n\nDěkujeme.\nIntranet ELKOPLAST'
          : 'Na konci školení je závěrečný test — hranice splnění 80 %, max. 3 pokusy.\n\nDěkujeme.\nIntranet ELKOPLAST');
      const chyby = []; let sent = 0;
      for (const to of emails) {
        try { await deliver({ to, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet ELKOPLAST', subject: 'Pozvánka ke školení: ' + nazev, text, html: toHtml(text, '') }); sent++; }
        catch (e) { chyby.push(to + ': ' + String(e.message || e)); }
      }
      logActivity('skoleni-pozvanka', { email: me.email, name: me.name }, 'Pozvánka ke školení „' + nazev + '" → ' + sent + '/' + emails.length + ' příjemců' + (chyby.length ? ' (chyby: ' + chyby.length + ')' : ''));
      return send(res, 200, { ok: true, sent, chyby });
    }
    if (p === '/api/view-as/employees' && req.method === 'GET') {
      if (!isRealAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const s = readJson(STATE_F, { employees: [] });
      const list = (s.employees || []).map(x => ({ email: x.email, name: x.name || x.email, admin: !!x.admin, modules: Array.isArray(x.modules) ? x.modules.length : 0 }))
        .filter(x => x.email).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
      return send(res, 200, { employees: list });
    }
    if (p === '/api/view-as' && req.method === 'POST') {
      if (!isRealAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const target = findEmployeeByEmail(b.email);
      if (!target) return send(res, 400, { error: 'Zaměstnanec nenalezen.' });
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      try { logActivity('view-as', empSessionReal(req) || { email: '', name: 'Správce' }, 'náhled jako ' + target.email); } catch (_) {}
      return send(res, 200, { ok: true, email: target.email, name: target.name || target.email }, { 'Set-Cookie': 'sm_view_as=' + encodeURIComponent(viewAsSign(target.email)) + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400' + secure });
    }
    if (p === '/api/view-as/stop' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sm_view_as=; Path=/; Max-Age=0' });
    }
    // ---- SSO do nabídkového kalkulátoru: přihlášený zaměstnanec → redirect s krátkodobým tokenem ----
    if (p === '/sso/nabidky') {
      const e = empSession(req);
      if (!e) { res.writeHead(302, { 'Location': '/' }); return res.end(); }
      const tok = ssoSign({ email: e.email, name: e.name, exp: Date.now() + 5 * 60 * 1000 });
      res.writeHead(302, { 'Location': NABIDKY_URL + '/?sso=' + encodeURIComponent(tok) });
      return res.end();
    }
    if (p === '/auth/dev') {
      if (!devAllowed(req)) return send(res, 403, '<h1>Demo přihlášení není dostupné.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      const emps = (getState().employees || []);
      const wanted = (u.query.email || '').toLowerCase().trim();
      if (wanted) {
        // Přihlášení za konkrétního zaměstnance (kvůli testování schvalování apod.).
        const emp = emps.find(x => (x.email || '').toLowerCase() === wanted) || { email: wanted, name: u.query.name || wanted };
        markLogin(emp.email, emp.name, 'demo');
        const sess = empSign({ email: emp.email, name: emp.name });
        res.writeHead(302, { 'Set-Cookie': 'sm_emp=' + encodeURIComponent(sess) + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400', 'Location': '/' });
        return res.end();
      }
      // Výběr identity (bez hesla) – testovací přihlášení.
      const rows = emps.length
        ? emps.map(e => '<a class="b" href="/auth/dev?email=' + encodeURIComponent(e.email) + '">' + esc(e.name || e.email) + '<small>' + esc(e.email || '') + (e.admin ? ' · admin' : '') + '</small></a>').join('')
        : '<a class="b" href="/auth/dev?email=demo@elkoplast.cz">Demo Zaměstnanec<small>demo@elkoplast.cz</small></a>';
      const page = '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Testovací přihlášení</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#eef1ec;color:#0f1512;display:grid;place-items:center;min-height:100vh;padding:24px}'
        + '.c{max-width:460px;width:100%;background:#fff;border:1px solid #e3e7e0;border-radius:16px;padding:28px 26px;box-shadow:0 10px 30px rgba(15,21,18,.07)}'
        + 'h1{font-size:20px;margin:0 0 6px}p{color:#5b635c;margin:0 0 18px;font-size:14px;line-height:1.5}'
        + '.b{display:flex;flex-direction:column;gap:2px;padding:11px 14px;border:1px solid #e3e7e0;border-radius:10px;text-decoration:none;color:#0f1512;font-weight:600;margin-bottom:8px}'
        + '.b:hover{border-color:#1f5d3f;background:#f4f8f5}.b small{font-weight:400;color:#8a938b;font-size:12px}</style></head>'
        + '<body><div class="c"><h1>Testovací přihlášení</h1><p>Bez hesla — vyber, za koho se chceš přihlásit. (Dostupné jen v testovacím prostředí; v produkci se přihlašuje přes Google.)</p>'
        + rows + '</div></body></html>';
      return send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    // BOZP termíny z wiki registru (doména bozp) — pro modul BOZP v intranetu, seskupeno dle pracoviště.
    if (p === '/api/bozp-terminy' && req.method === 'GET') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const lokalniRegistr = path.join(DATA_DIR, 'wiki-terminy.md');
      const src = process.env.WIKI_TERMINY_URL || (fs.existsSync(lokalniRegistr) ? lokalniRegistr : '');
      if (!src) return send(res, 200, { configured: false, items: [] });
      try {
        const wt = require('./smlouvy/lib/wikiTerminy');
        const rows = await wt.nacti(src, { force: u.query.force === '1' });
        const dnes = new Date().toISOString().slice(0, 10);
        const items = rows.filter((r) => (r.domena || '').toLowerCase() === 'bozp' && (r.stav === 'aktivni' || !r.stav))
          .map((r) => { const dny = Math.round((new Date(r.termin) - new Date(dnes)) / 86400e3); return { ...r, dny }; })
          .sort((a, b) => a.dny - b.dny);
        return send(res, 200, { configured: true, dnes, items });
      } catch (err) { return send(res, 200, { configured: true, chyba: err.message, items: [] }); }
    }

    // Telefonní seznam — firemní kontakty dle středisek (dostupné všem přihlášeným zaměstnancům).
    if (p === '/api/telefon' && req.method === 'GET') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      return send(res, 200, buildTelefon(), { 'Cache-Control': 'no-store' });
    }

    // Úkoly ze směrnic — závazky vytažené ze směrnic na Disku (záložka „Úkoly ze směrnic").
    if (p === '/api/smernice-ukoly' && req.method === 'GET') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      return send(res, 200, Object.assign({ dnes: new Date().toISOString().slice(0, 10), canEdit: isAdmin(req) }, readUkoly()));
    }
    if (p === '/api/smernice-ukoly' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Stav úkolů může měnit jen správce.' });
      const b = JSON.parse(await readBody(req));
      const it = updateUkol(b.id, b);
      if (!it) return send(res, 404, { error: 'Úkol nenalezen.' });
      return send(res, 200, { ok: true, item: it });
    }

    // ---- Obchod: rozdělení obchodníků / zastupitelnost PM (editovatelná tabulka, párováno na živou DB) ----
    // ---- Garanti: veřejná stránka (bez přihlášení, na token) ----
    if (p.indexOf('/api/garanti/verejne') === 0 && req.method === 'GET') {
      const tok = (u.query && u.query.t) || '';
      if (!garantiTokenOk(tok)) return send(res, 403, { error: 'Odkaz už neplatí. Vyžádejte si prosím nový.' });
      return send(res, 200, {
        skupiny: garantiSkupiny(), zeme: GARANT_ZEME,
        pocetNavrhu: readGaranti().navrhy.length
      }, { 'Cache-Control': 'no-store' });
    }
    // Zápis jména přímo do sloupce Slovensko / Polsko z veřejné stránky (bez přihlášení, na token).
    if (p === '/api/garanti/zapis' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      if (!garantiTokenOk(b.t)) return send(res, 403, { error: 'Odkaz už neplatí.' });
      const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
      const zeme = txt(b.zeme, 4) === 'PL' ? 'PL' : 'SK';
      const key = zeme === 'PL' ? 'garantPl' : 'garantSk';
      const jmeno = txt(b.jmeno, 120), kdo = txt(b.kdo, 120);
      const t = readObchod();
      const row = t.rows.find(r => r.id === txt(b.rowId, 60));
      if (!row) return send(res, 404, { error: 'Řádek nenalezen — obnovte prosím stránku.' });
      const puvodni = String(row[key] || '');
      if (puvodni === jmeno) return send(res, 200, { ok: true, beze_zmeny: true });
      row[key] = jmeno;
      writeObchod(t.rows);
      const d = readGaranti();
      d.navrhy.unshift({
        id: 'z' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: new Date().toISOString(), zeme, rowId: row.id, sekce: row.sekce || '', kategorie: row.kategorie || '',
        jmeno, puvodni, autor: kdo, stav: jmeno ? 'zapsáno' : 'smazáno'
      });
      writeGaranti(d);
      try {
        Promise.resolve(deliver({
          to: SUPERADMIN, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet — garanti',
          subject: 'Garanti ' + zeme + ': ' + (row.kategorie || '—') + ' → ' + (jmeno || '(smazáno)'),
          html: '<p>Na veřejné stránce garantů byl upraven sloupec <b>' + (zeme === 'PL' ? 'Polsko' : 'Slovensko') + '</b>.</p>' +
            '<p>Kategorie: <b>' + esc(row.kategorie || '—') + '</b><br>' +
            'Nově: <b>' + esc(jmeno || '(prázdné)') + '</b>' + (puvodni ? ' (dřív: ' + esc(puvodni) + ')' : '') + '</p>' +
            (kdo ? '<p>Zapsal: ' + esc(kdo) + '</p>' : '') +
            '<p>Přehled je v intranetu → Obchod → Garanti SK/PL.</p>'
        })).catch(e => console.warn('[garanti] notifikace neodešla:', (e && e.message) || e));
      } catch (_) {}
      return send(res, 200, { ok: true });
    }

    // ---- Garanti: správa z intranetu (modul obchod / správce) ----
    if (p === '/api/garanti' && req.method === 'GET') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!isAdmin(req) && employeeModules(e.email).indexOf('obchod') < 0) return send(res, 403, { error: 'K modulu Obchod nemáte přístup.' });
      const d = isAdmin(req) ? garantiEnsureToken() : readGaranti();
      return send(res, 200, {
        enabled: d.enabled, token: isAdmin(req) ? d.token : '',
        url: (isAdmin(req) && d.token) ? (garantiBaseUrl() + '/garanti/' + d.token) : '',
        navrhy: d.navrhy, stavy: GARANT_STAVY, canEdit: isAdmin(req)
      }, { 'Cache-Control': 'no-store' });
    }
    if (p === '/api/garanti' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Spravovat může jen správce.' });
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      let d = garantiEnsureToken();
      if (b.akce === 'novyToken') { d.token = crypto.randomBytes(16).toString('hex'); d = writeGaranti(d); }
      else if (b.akce === 'zapnout') { d.enabled = !!b.hodnota; d = writeGaranti(d); }
      else if (b.akce === 'smazat') { d.navrhy = d.navrhy.filter(x => x.id !== b.id); d = writeGaranti(d); }
      else if (b.akce === 'vymazatHistorii') { d.navrhy = []; d = writeGaranti(d); }
      return send(res, 200, { ok: true, enabled: d.enabled, token: d.token, url: garantiBaseUrl() + '/garanti/' + d.token, navrhy: d.navrhy, stavy: GARANT_STAVY, canEdit: true });
    }

    if (p === '/api/obchod' && req.method === 'GET') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!isAdmin(req) && employeeModules(e.email).indexOf('obchod') < 0) return send(res, 403, { error: 'K modulu Obchod nemáte přístup.' });
      const rows = readObchod().rows;
      return send(res, 200, { columns: OBCHOD_SLOUPCE, rows, obchodnici: buildObchodnici(rows), kontakty: buildKontakty(), total: rows.length, canEdit: isAdmin(req) }, { 'Cache-Control': 'no-store' });
    }
    if (p === '/api/obchod' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Tabulku může upravovat jen správce.' });
      const b = JSON.parse(await readBody(req));
      const saved = writeObchod(b.rows);
      return send(res, 200, { ok: true, columns: OBCHOD_SLOUPCE, rows: saved.rows, obchodnici: buildObchodnici(saved.rows), kontakty: buildKontakty(), total: saved.rows.length, canEdit: true });
    }

    // ---- Obchod → Leady: kontakty z veřejné kalkulačky překladiště (čte i edituje obchod/správce) ----
    if (p === '/api/obchod/leady' && req.method === 'GET') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!isAdmin(req) && employeeModules(e.email).indexOf('obchod') < 0) return send(res, 403, { error: 'K modulu Obchod nemáte přístup.' });
      const items = readLeady().items;
      return send(res, 200, { items, stavy: PREKLAD_LEAD_STAVY, total: items.length }, { 'Cache-Control': 'no-store' });
    }
    if (p === '/api/obchod/leady' && req.method === 'POST') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!isAdmin(req) && employeeModules(e.email).indexOf('obchod') < 0) return send(res, 403, { error: 'K modulu Obchod nemáte přístup.' });
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const items = readLeady().items;
      const it = items.find(x => x.id === b.id);
      if (!it) return send(res, 404, { error: 'Lead nenalezen.' });
      if (b.delete) { const next = items.filter(x => x.id !== b.id); writeLeady(next); return send(res, 200, { ok: true, deleted: true }); }
      if (b.status != null) it.status = PREKLAD_LEAD_STAVY.indexOf(String(b.status)) >= 0 ? String(b.status) : it.status;
      if (b.note != null) it.note = String(b.note).slice(0, 2000);
      it.updatedAt = Date.now();
      writeLeady(items);
      return send(res, 200, { ok: true, item: it });
    }

    // ---- Kovo: přehled výroby ze 4 závodů (Google Sheets přes service account) ----
    if (p === '/api/kovo-vyroba' && req.method === 'GET') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!isAdmin(req) && employeeModules(e.email).indexOf('kovo') < 0 && employeeModules(e.email).indexOf('kovokalk') < 0) return send(res, 403, { error: 'K modulu Kovo nemáte přístup.' });
      try { return send(res, 200, await require('./kovo-vyroba').fetchVyroba({ force: u.query.force === '1' && isAdmin(req) }), { 'Cache-Control': 'no-store' }); }
      catch (err) { return send(res, 500, { error: String(err.message || err).slice(0, 200) }); }
    }

    // ---- Kalkulace KOVO: parametry + výrobky + denní kurz ČNB (modul „kovokalk") ----
    if (p === '/api/kovo-kalk' && req.method === 'GET') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      // kalkulačka je součástí modulu Kovo (starší klíč „kovokalk" zůstává platný)
      if (!isAdmin(req) && employeeModules(e.email).indexOf('kovo') < 0 && employeeModules(e.email).indexOf('kovokalk') < 0) return send(res, 403, { error: 'K modulu Kovo nemáte přístup.' });
      const d = readKovoKalk();
      const cnb = await fetchCnbKurz();
      return send(res, 200, { params: d.params, products: d.products, cnb, canEdit: isAdmin(req) });
    }
    if (p === '/api/kovo-kalk' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Parametry a výrobky může měnit jen správce.' });
      const b = JSON.parse(await readBody(req));
      const who = (empSession(req) || {}).email || 'admin';
      const cur = saveKovoKalk(b, who);
      return send(res, 200, { ok: true, params: cur.params, products: cur.products });
    }

    // ---- Freelo: projekty (živě z Freelo API, pro zaměstnance s modulem „freelo") ----
    if (p === '/api/freelo/projects' && req.method === 'GET') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!isAdmin(req) && employeeModules(e.email).indexOf('freelo') < 0) return send(res, 403, { error: 'K modulu Freelo nemáte přístup.' });
      if (!freeloConfigured()) return send(res, 200, { configured: false, projects: [] });
      if (freeloCache.data && Date.now() - freeloCache.at < 5 * 60 * 1000) return send(res, 200, freeloCache.data);
      try {
        const list = await freeloApi('/v1/projects');
        const projects = (Array.isArray(list) ? list : []).map(pr => ({
          id: pr.id, name: pr.name, editedAt: pr.date_edited_at || pr.date_add || null,
          tasklists: (pr.tasklists || []).map(t => ({ id: t.id, name: t.name }))
        }));
        const out = { configured: true, projects };
        freeloCache = { at: Date.now(), data: out };
        return send(res, 200, out);
      } catch (err) { return send(res, 502, { error: err.message }); }
    }

    if (p === '/api/my' && req.method === 'GET') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const emps = getState().employees || []; const eml = e.email.toLowerCase();
      const me = emps.find(x => (x.email || '').toLowerCase() === eml);
      // Je schvalovatelem? = je něčí přímý nadřízený, ředitel střediska, nebo jednatel.
      const isApprover = isAdmin(req) || emps.some(x => x.id !== (me && me.id) && (x.email || '').toLowerCase() !== eml && (approverFor(x, emps) || {}).id === (me && me.id));
      const vacPending = readVac().requests.filter(r => r.status === 'pending' && (isAdmin(req) || (r.approverEmail || '').toLowerCase() === eml)).length;
      const isNakupci = !!(pozadavkyMod && pozadavkyMod.isConfiguredBuyer && pozadavkyMod.isConfiguredBuyer(e.email));
      const isKontejnery = !!(kontejneryMod && kontejneryMod.isHandler && kontejneryMod.isHandler(e.email));
      const isLisy = !!(mobilniLisyMod && mobilniLisyMod.isHandler && mobilniLisyMod.isHandler(e.email));
      // Nepřečtené aktuality — pro oznámení „je tam něco nového" na přehledu.
      const aktualityNew = (readJson(AKTUALITY_F, { posts: [] }).posts || []).filter(x => !(x.reads && x.reads[eml])).length;
      // moduly uživatele + automatický přístup ke Konstrukci (obchodníci, Zlín, role v modulu)
      const modsUser = (employeeModules(e.email) || []).slice();
      if (maKonstrukciEmail(e.email)) {
        if (!modsUser.includes('konstrukce')) modsUser.push('konstrukce');
        if (!modsUser.includes('zadanikonstrukce')) modsUser.push('zadanikonstrukce');
      }
      return send(res, 200, { employee: { email: e.email, name: e.name }, directives: myDirectives(e.email), library: myLibrary(e.email), modules: modsUser, surveys: mySurveys(e.email), surveyToken: inviteSign(e.email, e.name), isApprover: !!isApprover, vacPending: vacPending, canPostAktuality: canPostAktuality(req), isNakupci: isNakupci, isKontejnery: isKontejnery, isLisy: isLisy, aktualityNew: aktualityNew, heroImage: (readJson(SITE_F, {}).heroImage) || null });
    }

    // ---- Aktuality (novinky na intranetu) ----
    if (p === '/api/aktuality' && req.method === 'GET') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const eml = e.email.toLowerCase();
      const posts = (readJson(AKTUALITY_F, { posts: [] }).posts || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(x => ({
        id: x.id, title: x.title, body: x.body || '', image: x.image || null, author: x.author || '', ts: x.ts || 0,
        likes: Object.keys(x.likes || {}).length, liked: !!(x.likes && x.likes[eml]), mine: (x.authorEmail || '').toLowerCase() === eml,
        read: !!(x.reads && x.reads[eml])
      }));
      return send(res, 200, { posts, canPost: canPostAktuality(req) });
    }
    if (p === '/api/aktuality' && req.method === 'POST') {
      if (!canPostAktuality(req)) return send(res, 403, { error: 'Nemáte oprávnění zadávat aktuality.' });
      const e = empSession(req);
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const title = (b.title || '').trim(); if (!title) return send(res, 400, { error: 'Chybí titulek.' });
      let image = null; try { if (b.image) image = saveDataUrlImage(b.image); } catch (err) { return send(res, 400, { error: err.message }); }
      const st = readJson(AKTUALITY_F, { posts: [] }); st.posts = st.posts || [];
      const post = { id: crypto.randomBytes(6).toString('hex'), title, body: (b.body || '').trim(), image, author: e.name || e.email, authorEmail: e.email, ts: Date.now(), likes: {} };
      st.posts.push(post); writeJson(AKTUALITY_F, st);
      logActivity('aktuality', { email: e.email, name: e.name }, 'Přidal aktualitu: ' + title);
      // OZNÁMENÍ: nová aktualita se e-mailem rozešle všem zaměstnancům (kromě autora), na pozadí.
      // Autor může e-mail vypnout checkboxem „Neposílat e-mail" (bezEmailu) — pak jde novinka jen na nástěnku.
      if (emailConfigured() && !b.bezEmailu) {
        const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
        const link = proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host || 'intranet.elkoplast.cz') + '/#modul=dash';
        const uryvek = (post.body || '').slice(0, 300) + ((post.body || '').length > 300 ? '…' : '');
        const text = 'Dobrý den,\n\nna intranetu je nová aktualita od ' + (e.name || e.email) + ':\n\n„' + title + '"\n' + (uryvek ? '\n' + uryvek + '\n' : '')
          + '\nOtevřít intranet: ' + link + '\n\nIntranet ELKOPLAST';
        const prijemci = (getState().employees || []).map(x => (x.email || '').toLowerCase()).filter(em => em && em !== e.email.toLowerCase());
        (async () => {
          let poslano = 0;
          for (const to of prijemci) { try { await deliver({ to, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet ELKOPLAST', subject: '🆕 Nová aktualita: ' + title, text, html: toHtml(text, '') }); poslano++; } catch (_) {} }
          logActivity('aktuality', { email: e.email, name: e.name }, 'Aktualita „' + title + '" oznámena e-mailem ' + poslano + '/' + prijemci.length + ' zaměstnancům');
        })();
      }
      return send(res, 200, { ok: true, id: post.id });
    }
    if (p === '/api/aktuality/delete' && req.method === 'POST') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const st = readJson(AKTUALITY_F, { posts: [] }); const post = (st.posts || []).find(x => x.id === b.id);
      if (!post) return send(res, 404, { error: 'Aktualita nenalezena.' });
      if (!isAdmin(req) && (post.authorEmail || '').toLowerCase() !== e.email.toLowerCase()) return send(res, 403, { error: 'Můžete mazat jen své aktuality.' });
      st.posts = st.posts.filter(x => x.id !== b.id); deleteUpload(post.image); writeJson(AKTUALITY_F, st);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/aktuality/like' && req.method === 'POST') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const eml = e.email.toLowerCase();
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const st = readJson(AKTUALITY_F, { posts: [] }); const post = (st.posts || []).find(x => x.id === b.id);
      if (!post) return send(res, 404, { error: 'Aktualita nenalezena.' });
      post.likes = post.likes || {};
      if (post.likes[eml]) delete post.likes[eml]; else post.likes[eml] = Date.now();
      writeJson(AKTUALITY_F, st);
      return send(res, 200, { ok: true, likes: Object.keys(post.likes).length, liked: !!post.likes[eml] });
    }
    // Označení aktuality za přečtenou (klik zaměstnance) — zaznamená se čas prvního přečtení.
    if (p === '/api/aktuality/read' && req.method === 'POST') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const eml = e.email.toLowerCase();
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) {}
      const st = readJson(AKTUALITY_F, { posts: [] }); const post = (st.posts || []).find(x => x.id === b.id);
      if (!post) return send(res, 404, { error: 'Aktualita nenalezena.' });
      post.reads = post.reads || {};
      if (!post.reads[eml]) { post.reads[eml] = { ts: Date.now(), name: e.name || e.email }; writeJson(AKTUALITY_F, st); }
      return send(res, 200, { ok: true, reads: Object.keys(post.reads).length });
    }
    // Přehled aktualit pro administraci — kdo co četl a lajkoval (jen správce).
    if (p === '/api/aktuality/admin' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const nameFor = (em) => { const emp = (getState().employees || []).find(x => (x.email || '').toLowerCase() === (em || '').toLowerCase()); return (emp && emp.name) || em; };
      const posts = (readJson(AKTUALITY_F, { posts: [] }).posts || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(x => {
        const reads = x.reads || {};
        const readers = Object.keys(reads).map(em => ({ email: em, name: (reads[em] && reads[em].name) || nameFor(em), ts: (reads[em] && reads[em].ts) || 0 })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const likers = Object.keys(x.likes || {}).map(em => ({ email: em, name: nameFor(em) }));
        return { id: x.id, title: x.title, image: x.image || null, author: x.author || '', ts: x.ts || 0, reads: readers.length, readers, likes: likers.length, likers };
      });
      return send(res, 200, { posts });
    }
    // ---- Fotky nových produktů z Disku (widget „Fotka týdne") ----
    if (p === '/api/produkty-fotky' && req.method === 'GET') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!produktyFotky.configured()) return send(res, 200, { configured: false, photos: [] });
      try { const items = await produktyFotky.list(); return send(res, 200, { configured: true, photos: items.map(x => ({ id: x.id, name: x.name })) }); }
      catch (err) { return send(res, 200, { configured: true, photos: [], error: err.message }); }
    }
    if (p === '/api/produkty-fotky/img' && req.method === 'GET') {
      const e = empSession(req); if (!e) { res.writeHead(401); return res.end(); }
      const id = (u.query.id || '').trim(); if (!id) { res.writeHead(400); return res.end(); }
      try { const { buf, ct } = await produktyFotky.media(id); res.writeHead(200, { 'Content-Type': ct || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }); return res.end(buf); }
      catch (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nenalezeno'); }
    }
    // ---- Banner (hero) intranetu ----
    if (p === '/api/site/hero' && req.method === 'POST') {
      if (!canPostAktuality(req)) return send(res, 403, { error: 'Nemáte oprávnění měnit banner.' });
      const e = empSession(req);
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const site = readJson(SITE_F, {});
      if (b.reset) { deleteUpload(site.heroImage); site.heroImage = null; }
      else {
        let img = null; try { img = saveDataUrlImage(b.image); } catch (err) { return send(res, 400, { error: err.message }); }
        if (!img) return send(res, 400, { error: 'Chybí platný obrázek.' });
        deleteUpload(site.heroImage); site.heroImage = img;
      }
      writeJson(SITE_F, site);
      logActivity('aktuality', { email: e.email, name: e.name }, b.reset ? 'Obnovil výchozí banner' : 'Změnil banner intranetu');
      return send(res, 200, { ok: true, hero: site.heroImage || null });
    }

    // Logo v hlavičce — nahrání / reset (jen správce).
    if (p === '/api/site/logo' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Logo v hlavičce může měnit jen správce.' });
      const e = empSession(req);
      let b = {}; try { b = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const site = readJson(SITE_F, {});
      if (b.reset) { deleteUpload(site.logoImage); site.logoImage = null; }
      else {
        let img = null; try { img = saveDataUrlImage(b.image); } catch (err) { return send(res, 400, { error: err.message }); }
        if (!img) return send(res, 400, { error: 'Chybí platný obrázek.' });
        deleteUpload(site.logoImage); site.logoImage = img;
      }
      writeJson(SITE_F, site);
      logActivity('nastaveni', { email: (e && e.email) || '', name: (e && e.name) || 'Správce' }, b.reset ? 'Obnovil výchozí logo' : 'Změnil logo v hlavičce');
      return send(res, 200, { ok: true, logo: site.logoImage || null });
    }

    // ---- Dovolená: moje konto + žádosti (zaměstnanec) ----
    if (p === '/api/vacation/my' && req.method === 'GET') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const emps = getState().employees || [];
      const me = emps.find(x => (x.email || '').toLowerCase() === e.email.toLowerCase()) || { email: e.email, name: e.name };
      const ap = approverFor(me, emps);
      const year = new Date().getFullYear();
      const ent = vacEntitlement(me), used = Math.round(((Number(me.vacUsedInit) || 0) + vacUsed(e.email, year)) * 10) / 10;
      const mine = readVac().requests.filter(r => (r.empEmail || '').toLowerCase() === e.email.toLowerCase()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(res, 200, { year, entitlement: ent, used, balance: Math.round((ent - used) * 10) / 10, approver: ap ? { name: ap.name, email: ap.email } : null, approverDuvod: ap ? approverDuvod(me, emps) : '', requests: mine });
    }
    if (p === '/api/vacation/request' && req.method === 'POST') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.from || !b.to) return send(res, 400, { error: 'Zadej datum od a do.' });
      const days = workingDays(b.from, b.to, !!b.halfDay);
      if (days <= 0) return send(res, 400, { error: 'Neplatný rozsah (žádné pracovní dny).' });
      const emps = getState().employees || [];
      const me = emps.find(x => (x.email || '').toLowerCase() === e.email.toLowerCase()) || { email: e.email, name: e.name };
      const ap = approverFor(me, emps);
      const v = readVac();
      const rq = { id: 'v' + crypto.randomBytes(6).toString('hex'), empEmail: e.email, empName: vacPlneJmeno(e.name, e.email, emps), approverEmail: ap ? ap.email : '', from: b.from, to: b.to, halfDay: !!b.halfDay, days, type: b.type || 'dovolena', note: (b.note || '').slice(0, 500), status: 'pending', createdAt: Date.now() };
      v.requests.push(rq); writeVac(v);
      // Komu poslat notifikaci: přiřazenému schvalovateli; když žádného nemá, administrátorům (+ superadmin), kteří žádost vyřídí.
      let recips;
      if (ap && ap.email) recips = [ap.email];
      else { recips = emps.filter(x => x.admin && x.email).map(x => x.email); recips.push(SUPERADMIN); if (!recips.filter(Boolean).length) recips = [reportRecipient()]; }
      recips = [...new Set(recips.filter(Boolean).map(x => x.toLowerCase()))];
      const mailBody = e.name + ' žádá o dovolenou ' + b.from + ' – ' + b.to + ' (' + days + ' dní).' + (rq.note ? '\nPoznámka: ' + rq.note : '') + '\n\nSchval v intranetu: ' + baseUrl(req) + '/';
      recips.forEach(to => vacMail(to, 'Nová žádost o dovolenou – ' + e.name, mailBody));
      return send(res, 200, { ok: true, request: rq });
    }
    // ---- Dovolená: ke schválení (schvalovatel/admin) ----
    if (p === '/api/vacation/pending' && req.method === 'GET') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const admin = isAdmin(req);
      const empsAll = getState().employees || [];
      const list = readVac().requests.filter(r => r.status === 'pending' && (admin || (r.approverEmail || '').toLowerCase() === e.email.toLowerCase()))
        .map(r => Object.assign({}, r, { empName: vacPlneJmeno(r.empName, r.empEmail, empsAll) }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return send(res, 200, { admin, requests: list });
    }
    // ---- Dovolená: konto zaměstnanců, které daný vedoucí schvaluje (jeho tým) ----
    if (p === '/api/vacation/team' && req.method === 'GET') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const emps = getState().employees || []; const eml = e.email.toLowerCase(); const year = new Date().getFullYear();
      const members = emps
        .filter(x => (x.email || '').toLowerCase() !== eml)
        .filter(x => { const ap = approverFor(x, emps); return ap && (ap.email || '').toLowerCase() === eml; })
        .map(x => { const ent = vacEntitlement(x), used = Math.round(((Number(x.vacUsedInit) || 0) + vacUsed(x.email, year)) * 10) / 10, pending = vacPendingDays(x.email, year); return { name: x.name, email: x.email, stredisko: x.stredisko || '', entitlement: ent, used, pending, remaining: Math.round((ent - used - pending) * 10) / 10 }; })
        .sort((a, b) => (a.stredisko || '').localeCompare(b.stredisko || '', 'cs') || (a.name || '').localeCompare(b.name || '', 'cs'));
      return send(res, 200, { year, members });
    }
    if (p === '/api/vacation/decide' && req.method === 'POST') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req) || '{}');
      const v = readVac(); const rq = v.requests.find(x => x.id === b.id);
      if (!rq) return send(res, 404, { error: 'Žádost nenalezena.' });
      if (!(isAdmin(req) || (rq.approverEmail || '').toLowerCase() === e.email.toLowerCase())) return send(res, 403, { error: 'Tuto žádost nemůžeš schválit.' });
      if (rq.status !== 'pending') return send(res, 400, { error: 'Žádost už je vyřízená.' });
      rq.decidedAt = Date.now(); rq.decidedBy = e.name; rq.reason = (b.reason || '').slice(0, 300);
      if (b.action === 'approve') {
        rq.status = 'approved';
        try { const evId = await calInsertVacation(rq); if (evId) rq.calendarEventId = evId; } catch (err) { console.warn('Kalendář: ' + err.message); }
        vacMail(rq.empEmail, 'Dovolená schválena', 'Tvá dovolená ' + rq.from + ' – ' + rq.to + ' byla schválena (' + e.name + ').' + (calendarConfigured() ? '\nUdálost byla přidána do firemního kalendáře.' : ''));
      } else {
        rq.status = 'rejected';
        vacMail(rq.empEmail, 'Dovolená zamítnuta', 'Tvá dovolená ' + rq.from + ' – ' + rq.to + ' byla zamítnuta (' + e.name + ').' + (rq.reason ? '\nDůvod: ' + rq.reason : ''));
      }
      writeVac(v);
      return send(res, 200, { ok: true, request: rq });
    }
    // ---- Dovolená: zrušení vlastní žádosti (příp. odebrání z kalendáře) ----
    if (p === '/api/vacation/cancel' && req.method === 'POST') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req) || '{}');
      const v = readVac(); const rq = v.requests.find(x => x.id === b.id);
      if (!rq) return send(res, 404, { error: 'Žádost nenalezena.' });
      if (!((rq.empEmail || '').toLowerCase() === e.email.toLowerCase() || isAdmin(req))) return send(res, 403, { error: 'Nelze zrušit.' });
      if (rq.calendarEventId) { try { await calDeleteVacation(rq.calendarEventId); } catch (err) { console.warn('Kalendář: ' + err.message); } delete rq.calendarEventId; }
      rq.status = 'cancelled'; rq.decidedAt = Date.now();
      writeVac(v);
      return send(res, 200, { ok: true });
    }
    // ---- Dovolená: přehled všech + konto (admin) ----
    // Náhled měsíčního reportu (správce) + ruční odeslání
    if (p === '/api/vacation/report-preview' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Jen pro správce.' });
      const now = new Date();
      const ym = String(u.query.ym || '');
      let y, m;
      if (/^\d{4}-\d{2}$/.test(ym)) { y = Number(ym.slice(0, 4)); m = Number(ym.slice(5, 7)) - 1; }
      else { const p0 = new Date(now.getFullYear(), now.getMonth() - 1, 1); y = p0.getFullYear(); m = p0.getMonth(); }
      return send(res, 200, buildVacReportHtml(y, m), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (p === '/api/vacation/report-send' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Jen pro správce.' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (_) {}
      const now = new Date();
      const ym = String(b.ym || '');
      let y, m;
      if (/^\d{4}-\d{2}$/.test(ym)) { y = Number(ym.slice(0, 4)); m = Number(ym.slice(5, 7)) - 1; }
      else { const p0 = new Date(now.getFullYear(), now.getMonth() - 1, 1); y = p0.getFullYear(); m = p0.getMonth(); }
      try { const to = await sendVacReport(y, m, Array.isArray(b.to) ? b.to : null); return send(res, 200, { ok: true, to }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    // Přehled čerpání dovolené za měsíc (pro intranet). Zaměstnanec vidí sebe,
    // schvalovatel svůj tým, správce všechny.
    // ---- Přístup z ostatních firemních domén: přehled a schvalování (jen správce) ----
    if (p === '/api/pristup-domeny' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Jen pro správce.' });
      const cfg = authDomCfg();
      const inv = readInvites();
      const emps = getState().employees || [];
      const povoleni = cfg.povoleni.map(e => {
        const k = String(e).toLowerCase(), r = inv[k] || {};
        const emp = emps.find(x => (x.email || '').toLowerCase() === k);
        return { email: e, name: (emp && emp.name) || r.name || '', prvni: r.acceptedAt || null, posledni: r.lastLoginAt || null };
      });
      return send(res, 200, { hlavni: authHlavniDomena(), domeny: cfg.domeny, povoleni, zadosti: cfg.zadosti }, { 'Cache-Control': 'no-store' });
    }
    if (p === '/api/pristup-domeny' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Jen pro správce.' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const cfg = authDomCfg();
      const eml = String(b.email || '').trim().toLowerCase();
      if (b.akce === 'schvalit' || b.akce === 'povolit') {
        if (eml.indexOf('@') < 1) return send(res, 400, { error: 'Zadejte platnou e-mailovou adresu.' });
        const dom = authDomain(eml);
        if (dom === authHlavniDomena()) return send(res, 400, { error: 'Adresa z hlavní domény se schvalovat nemusí — přihlásí se rovnou.' });
        if (cfg.domeny.indexOf(dom) < 0) cfg.domeny.push(dom);   // schválením adresy rovnou povolíme i doménu
        if (cfg.povoleni.map(x => x.toLowerCase()).indexOf(eml) < 0) cfg.povoleni.push(eml);
        const z = cfg.zadosti.find(x => String(x.email || '').toLowerCase() === eml);
        if (z) z.stav = 'schváleno';
        authDomWrite(cfg);
        // ať má rovnou kartu zaměstnance (jinak vznikne až prvním přihlášením)
        try { ensureEmployee(eml, (z && z.name) || ''); } catch (_) {}
        try {
          Promise.resolve(deliver({ to: eml, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet ELKOPLAST',
            subject: 'Přístup do intranetu ELKOPLAST je povolen',
            html: '<p>Dobrý den,</p><p>váš účet <b>' + esc(eml) + '</b> byl schválen pro přihlášení do firemního intranetu.</p>' +
              '<p><a href="' + esc(garantiBaseUrl()) + '/" style="background:#2f7d32;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Přihlásit se přes Google</a></p>' })).catch(() => {});
        } catch (_) {}
        return send(res, 200, { ok: true, reload: true });
      }
      if (b.akce === 'odebrat') {
        cfg.povoleni = cfg.povoleni.filter(x => String(x).toLowerCase() !== eml);
        authDomWrite(cfg);
        return send(res, 200, { ok: true, reload: true });
      }
      if (b.akce === 'zamitnout') {
        const z = cfg.zadosti.find(x => String(x.email || '').toLowerCase() === eml);
        if (z) z.stav = 'zamítnuto';
        cfg.povoleni = cfg.povoleni.filter(x => String(x).toLowerCase() !== eml);
        authDomWrite(cfg);
        return send(res, 200, { ok: true, reload: true });
      }
      if (b.akce === 'smazatZadost') {
        cfg.zadosti = cfg.zadosti.filter(x => String(x.email || '').toLowerCase() !== eml);
        authDomWrite(cfg);
        return send(res, 200, { ok: true, reload: true });
      }
      if (b.akce === 'domeny' && Array.isArray(b.domeny)) {
        cfg.domeny = b.domeny.map(x => String(x || '').trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
        authDomWrite(cfg);
        return send(res, 200, { ok: true, domeny: authDomCfg().domeny });
      }
      return send(res, 400, { error: 'Neznámá akce.' });
    }
    if (p === '/api/vacation/mesic' && req.method === 'GET') {
      const e = empSession(req); if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const now = new Date();
      const ym = String(u.query.ym || '');
      let y = now.getFullYear(), m = now.getMonth();
      if (/^\d{4}-\d{2}$/.test(ym)) { y = Number(ym.slice(0, 4)); m = Number(ym.slice(5, 7)) - 1; }
      const d = vacMonthData(y, m);
      const admin = isAdmin(req);
      const eml = e ? (e.email || '').toLowerCase() : '';
      let rows = d.rows, rozsah = 'vse';
      if (!admin) {
        const emps = getState().employees || [];
        const me = emps.find(x => (x.email || '').toLowerCase() === eml);
        const tym = new Set(emps.filter(x => me && x.managerId === me.id).map(x => (x.email || '').toLowerCase()));
        const jeSchvalovatel = tym.size > 0;
        rows = d.rows.filter(r => r.email === eml || tym.has(r.email));
        rozsah = jeSchvalovatel ? 'tym' : 'ja';
      }
      const celkem = Math.round(rows.reduce((n, x) => n + x.dny, 0) * 10) / 10;
      return send(res, 200, { ym: y + '-' + String(m + 1).padStart(2, '0'), mesic: VAC_MESICE[m] + ' ' + y, rows, celkem, lidi: new Set(rows.map(r => r.email)).size, rozsah }, { 'Cache-Control': 'no-store' });
    }
    if (p === '/api/vacation/all' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const emps = getState().employees || []; const year = new Date().getFullYear();
      const konto = emps.map(x => { const ent = vacEntitlement(x); const used = Math.round(((Number(x.vacUsedInit) || 0) + vacUsed(x.email, year)) * 10) / 10; return { name: x.name, email: x.email, stredisko: x.stredisko || '', entitlement: ent, used, balance: Math.round((ent - used) * 10) / 10 }; });
      const empsAll2 = getState().employees || [];
      return send(res, 200, { year, konto, requests: readVac().requests
        .map(r => Object.assign({}, r, { empName: vacPlneJmeno(r.empName, r.empEmail, empsAll2) }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) });
    }

    // ---- knihovna: správa (admin) ----
    // Vkládání dokumentů do Knihovny přes chat (Bearer SSO_SHARED_SECRET) — dokument se založí
    // jako běžný verzovaný dokument, stejně jako by ho správce nahrál ručně. Stejný název ve
    // stejné složce = nová verze místo duplicity.
    if (p === '/api/library/ingest-ext' && req.method === 'POST') {
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      let bearerOk = false;
      try { bearerOk = !!SSO_SHARED_SECRET && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(String(SSO_SHARED_SECRET))); } catch (_) {}
      if (!bearerOk) return send(res, 401, { error: 'Neplatné tajemství.' });
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (_) { return send(res, 400, { error: 'Neplatné tělo.' }); }
      const title = String(b.title || '').trim().slice(0, 200);
      const html = String(b.html || '').trim();
      if (!title || !html) return send(res, 400, { error: 'Chybí title nebo html.' });
      const lib = readLibrary();
      let folderId = null;
      const folderName = String(b.folder || '').trim();
      if (folderName) {
        let f = lib.folders.find(x => (x.parentId || null) === null && (x.name || '').toLowerCase() === folderName.toLowerCase());
        if (!f) { f = { id: 'f' + crypto.randomBytes(5).toString('hex'), name: folderName, parentId: null }; lib.folders.push(f); }
        folderId = f.id;
      }
      const note = String(b.note || '').trim().slice(0, 200) || 'vloženo přes chat';
      let doc = lib.docs.find(d => (d.folderId || null) === folderId && (d.title || '').toLowerCase() === title.toLowerCase());
      let akce;
      if (doc) {
        const nv = (doc.cur || (doc.versions && doc.versions.length ? doc.versions[doc.versions.length - 1].v : 1)) + 1;
        doc.versions = doc.versions || [];
        doc.versions.push({ v: nv, html, note, ts: Date.now() });
        doc.cur = nv; akce = 'nova-verze';
      } else {
        doc = { id: 'd' + crypto.randomBytes(5).toString('hex'), title, kind: String(b.kind || '').trim().slice(0, 80), folderId, requireAck: !!b.requireAck, assignAll: b.assignAll !== false, assignCats: [], assignTags: [], cur: 1, versions: [{ v: 1, html, note, ts: Date.now() }] };
        lib.docs.push(doc); akce = 'novy';
      }
      writeJson(LIB_F, lib);
      logActivity('library', { email: '', name: 'Claude (chat)' }, (akce === 'novy' ? 'Do Knihovny vložen dokument: ' : 'Nová verze dokumentu v Knihovně: ') + title + (folderName ? ' (složka ' + folderName + ')' : '') + ' — v' + doc.cur);
      return send(res, 200, { ok: true, id: doc.id, verze: doc.cur, akce });
    }
    if (p === '/api/library' && req.method === 'GET') return send(res, 200, readLibrary());
    if (p === '/api/library' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); writeJson(LIB_F, { docs: Array.isArray(b.docs) ? b.docs : [], folders: Array.isArray(b.folders) ? b.folders : [] }); return send(res, 200, { ok: true }); }
    // ---- knihovna: čtení a potvrzení zaměstnancem (session) ----
    if (p === '/api/library-doc' && req.method === 'GET') {
      const e = empSession(req); if (!e && !isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const d = (readLibrary().docs || []).find(x => x.id === u.query.id); if (!d) return send(res, 404, { error: 'Dokument nenalezen.' });
      const v = Number(u.query.v) || curVersion(d);
      const ver = (d.versions || []).find(x => Number(x.v) === v) || (d.versions || [])[(d.versions || []).length - 1];
      if (!ver) return send(res, 404, { error: 'Verze nenalezena.' });
      const email = e ? e.email : '';
      return send(res, 200, { id: d.id, title: d.title, kind: d.kind || 'dokument', v: ver.v, note: ver.note || '', html: ver.html || '', pdf: ver.pdf || '', pdfName: ver.pdfName || '', pdfOrient: ver.pdfOrient || '', requireAck: d.requireAck !== false, acked: email ? libAcked(d.id, ver.v, email) : false });
    }
    if (p === '/api/library-ack' && req.method === 'POST') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const b = JSON.parse(await readBody(req)); if (!b.docId || !b.v) return send(res, 400, { error: 'Chybí data.' });
      recordLibAck({ docId: b.docId, v: Number(b.v), email: e.email, name: e.name }); return send(res, 200, { ok: true });
    }
    if (p === '/auth/google/login') {
      if (!ssoEnabled()) return send(res, 503, '<h1>Přihlášení přes Google není nastavené.</h1><p>Doplňte GOOGLE_CLIENT_ID a GOOGLE_CLIENT_SECRET.</p>', { 'Content-Type': 'text/html; charset=utf-8' });
      const state = crypto.randomBytes(16).toString('hex');
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      const params = new URLSearchParams({ client_id: GOOGLE.clientId, redirect_uri: baseUrl(req) + '/auth/google/callback', response_type: 'code', scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account' });
      // hd (nápověda pro výběr účtu) záměrně neposíláme — kolegové z elkoplast.de/sk/ro se musí
      // dostat na obrazovku výběru účtu; doménu i schválení kontrolujeme sami v callbacku.
      // Volitelný návrat po přihlášení — jen bezpečné interní cesty /sso/... (proti open-redirectu)
      const nextPath = /^\/sso\/[a-z0-9-]+$/.test(u.query.next || '') ? u.query.next : '';
      const cookies = ['sm_oauth=' + state + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=600' + secure];
      if (nextPath) cookies.push('sm_next=' + encodeURIComponent(nextPath) + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=600' + secure);
      res.writeHead(302, { 'Set-Cookie': cookies, 'Location': 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
      return res.end();
    }
    if (p === '/auth/google/callback') {
      if (u.query.error) return send(res, 400, '<h1>Přihlášení zrušeno.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      const want = cookieVal(req, 'sm_oauth');
      if (!want || want !== u.query.state) return send(res, 400, '<h1>Neplatný stav přihlášení.</h1><p>Zkuste to prosím znovu.</p>', { 'Content-Type': 'text/html; charset=utf-8' });
      try {
        const tok = await httpsPostForm('oauth2.googleapis.com', '/token', { code: u.query.code || '', client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret, redirect_uri: baseUrl(req) + '/auth/google/callback', grant_type: 'authorization_code' });
        if (!tok.id_token) throw new Error('Google nevrátil id_token.');
        const pl = JSON.parse(b64urlDecode(tok.id_token.split('.')[1]));
        // Token přišel back-channel přímo od Google přes TLS → ověřujeme nároky (claims).
        if (pl.aud !== GOOGLE.clientId) throw new Error('Neplatné publikum tokenu.');
        if (['accounts.google.com', 'https://accounts.google.com'].indexOf(pl.iss) < 0) throw new Error('Neplatný vydavatel tokenu.');
        if (pl.exp && (Date.now() / 1000) > pl.exp) throw new Error('Token vypršel.');
        if (pl.email_verified === false) throw new Error('E-mail účtu není ověřený.');
        const email = (pl.email || '').toLowerCase();
        if (!email) throw new Error('Token neobsahuje e-mail.');
        const stav = authStav(email);
        if (stav === 'cizi') throw new Error('Účet není z firemní domény ELKOPLAST.');
        if (stav === 'ceka') {
          authZadost(email, pl.name || '');
          return send(res, 200, '<!doctype html><meta charset="utf-8"><title>Čeká na schválení</title>' +
            '<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:60px auto;padding:26px 28px;border:1px solid #e2e8e0;border-radius:14px;line-height:1.6">' +
            '<h1 style="font-size:20px;margin:0 0 8px">Žádost o přístup jsme přijali</h1>' +
            '<p style="color:#5b6b60;margin:0 0 10px">Účet <b>' + esc(email) + '</b> je z domény, kterou schvaluje správce intranetu. Dali jsme mu vědět — jakmile přístup povolí, stačí se přihlásit znovu.</p>' +
            '<p style="margin:0"><a href="/" style="color:#2f7d32">Zpět na úvod</a></p></div>',
            { 'Content-Type': 'text/html; charset=utf-8' });
        }
        const emp = ensureEmployee(email, pl.name || email);
        const ml = markLogin(emp.email, emp.name, 'Google') || {};
        // Účet z jiné firemní domény: dej správci vědět, že se poprvé přihlásil
        // (u předschválených adres žádná žádost nevzniká, tak by o tom jinak nevěděl).
        if (ml.prvni && authDomain(email) !== authHlavniDomena()) {
          try {
            Promise.resolve(deliver({
              to: SUPERADMIN, fromAddr: CFG.user, fromName: CFG.fromName || 'Intranet ELKOPLAST',
              subject: 'První přihlášení do intranetu: ' + email,
              html: '<p><b>' + esc(emp.name || email) + '</b> (' + esc(email) + ') se právě poprvé přihlásil do intranetu.</p>' +
                '<p>Doména <b>' + esc(authDomain(email)) + '</b> — přístup byl schválen dřív.</p>' +
                '<p>Moduly mu nastavíte ve Správa → Přístupy.</p>'
            })).catch(() => {});
          } catch (_) {}
        }
        const sess = empSign({ email: emp.email, name: emp.name });
        const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
        const nx = cookieVal(req, 'sm_next');
        const dest = /^\/sso\/[a-z0-9-]+$/.test(nx || '') ? nx : '/';
        res.writeHead(302, { 'Set-Cookie': ['sm_emp=' + encodeURIComponent(sess) + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000' + secure, 'sm_oauth=; Path=/; Max-Age=0', 'sm_next=; Path=/; Max-Age=0'], 'Location': dest });
        return res.end();
      } catch (e) { return send(res, 400, '<h1>Přihlášení selhalo</h1><p>' + esc(e.message) + '</p><p><a href="/">Zpět</a></p>', { 'Content-Type': 'text/html; charset=utf-8' }); }
    }
    if (p === '/auth/logout') { res.writeHead(302, { 'Set-Cookie': ['sm_emp=; Path=/; Max-Age=0', 'sm_view_as=; Path=/; Max-Age=0'], 'Location': '/' }); return res.end(); }

    // ---- ABROLL školení (interaktivní): za přihlášením (zaměstnanec nebo správce) ----
    if (p === '/abroll-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení ABROLL je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(ABROLL_FILE)) return send(res, 404, '<h1>Chybí abroll-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(ABROLL_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }

    // ---- Sdílená data produktového katalogu (společná pro knihovnu i školení) ----
    if (p === '/produkty-data.js') {
      const f = path.join(ROOT, 'produkty-data.js');
      if (!fs.existsSync(f)) return send(res, 200, 'window.PRODUKTY_SEED=[];', { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return send(res, 200, fs.readFileSync(f, 'utf8'), { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }

    // ---- Školení Produkty (interaktivní, znalosti obchodníků): za přihlášením (zaměstnanec nebo správce) ----
    if (p === '/produkty-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení Produkty je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(PRODUKTY_FILE)) return send(res, 404, '<h1>Chybí produkty-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(PRODUKTY_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }

    // ---- Školení Průmysl (obchodník: skladování, Li-Ion, ADR): za přihlášením (zaměstnanec nebo správce) ----
    if (p === '/prumysl-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení Průmysl je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(PRUMYSL_FILE)) return send(res, 404, '<h1>Chybí prumysl-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(PRUMYSL_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }

    // ---- Školení LOXXER (obchodník: protipožární skříně na Li-Ion baterie): za přihlášením (zaměstnanec nebo správce) ----
    if (p === '/loxxer-skoleni-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení LOXXER je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(LOXXER_SKOLENI_FILE)) return send(res, 404, '<h1>Chybí loxxer-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(LOXXER_SKOLENI_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }

    // ---- Školení ACTS (železniční abroll kontejnery): za přihlášením (zaměstnanec nebo správce) ----
    if (p === '/acts-skoleni-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení ACTS je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(ACTS_SKOLENI_FILE)) return send(res, 404, '<h1>Chybí acts-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(ACTS_SKOLENI_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/vykresy-skoleni-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení Čtení výkresů je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(VYKRESY_SKOLENI_FILE)) return send(res, 404, '<h1>Chybí vykresy-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(VYKRESY_SKOLENI_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/svarovani-skoleni-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení Průvodce svařováním je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(SVAROVANI_SKOLENI_FILE)) return send(res, 404, '<h1>Chybí svarovani-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(SVAROVANI_SKOLENI_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/zentex-skoleni-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení ZENTEX je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(ZENTEX_SKOLENI_FILE)) return send(res, 404, '<h1>Chybí zentex-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(ZENTEX_SKOLENI_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }
    if (p === '/tridici-linky-skoleni-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení Třídicí linky je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(TRIDICI_SKOLENI_FILE)) return send(res, 404, '<h1>Chybí tridici-linky-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(TRIDICI_SKOLENI_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    }

    // ---- SMI aplikace (modul E-shop): servírovaná z našeho serveru, za přihlášením ----
    if (p === '/smi-app') {
      const e = empSession(req);
      const allowed = (e && employeeModules(e.email).indexOf('eshop') >= 0) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup k SMI aplikaci nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(SMI_APP_FILE)) return send(res, 404, '<h1>Chybí SMI_aplikace.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(SMI_APP_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // ---- Aplikace modulu Kalkulace-lisy: za přihlášením, přístup řídí správce ----
    if (p === '/kalkulace-app') {
      const e = empSession(req);
      const allowed = (e && employeeModules(e.email).indexOf('kalkulace') >= 0) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup ke Kalkulaci-lisy nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (KALK_APP_URL) {
        // Přihlášený zaměstnanec → přidej krátkodobý SSO token, aby se kalkulačka v iframu přihlásila SAMA
        // (Google login v iframu Google odmítá; tímhle se mu vyhneme úplně).
        let target = KALK_APP_URL;
        if (e) { const tok = ssoSign({ email: e.email, name: e.name, exp: Date.now() + 5 * 60 * 1000 }); target += (KALK_APP_URL.indexOf('?') >= 0 ? '&' : '?') + 'sso=' + encodeURIComponent(tok); }
        res.writeHead(302, { 'Location': target }); return res.end();
      }
      if (fs.existsSync(KALK_APP_FILE)) return send(res, 200, fs.readFileSync(KALK_APP_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
      // aplikace zatím nenapojena – přátelský placeholder
      const ph = '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Kalkulace-lisy</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#eef1ec;color:#0f1512;display:grid;place-items:center;min-height:100vh}'
        + '.c{max-width:520px;text-align:center;background:#fff;border:1px solid #e3e7e0;border-radius:16px;padding:34px 30px;box-shadow:0 10px 30px rgba(15,21,18,.07)}'
        + 'h1{font-size:20px;margin:0 0 8px}p{color:#5b635c;margin:0 0 6px;line-height:1.55}code{background:#eef1ec;padding:2px 6px;border-radius:6px;font-size:13px}</style></head>'
        + '<body><div class="c"><h1>🧮 Kalkulace-lisy</h1><p>Máte k modulu přístup. Aplikace se sem teprve napojí.</p>'
        + '<p style="margin-top:12px;font-size:13px">Pro napojení vlož soubor <code>kalkulace-lisy.html</code> do projektu, nebo nastav proměnnou <code>KALKULACE_APP_URL</code> na adresu existující aplikace.</p></div></body></html>';
      return send(res, 200, ph, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // ---- LOXXER — kalkulace (interní nástroj obchodníka na nabídky LOXXER; iframe + SSO, jako Kalkulace-lisy) ----
    if (p === '/loxxerkalk-app') {
      const e = empSession(req);
      const allowed = (e && employeeModules(e.email).indexOf('loxxerkalk') >= 0) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup k LOXXER — kalkulace nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      let target = LOXXER_KALK_APP_URL;
      if (e) { const tok = ssoSign({ email: e.email, name: e.name, admin: isAdmin(req), exp: Date.now() + 5 * 60 * 1000 }); target += (LOXXER_KALK_APP_URL.indexOf('?') >= 0 ? '&' : '?') + 'sso=' + encodeURIComponent(tok); }
      res.writeHead(302, { 'Location': target }); return res.end();
    }

    // ---- LOXXER — správa prezentace (fotka/texty na veřejném webu); bezešvě přes SSO, jen správce nebo osoba s modulem LOXXER-kalkulace ----
    if (p === '/loxxer-web-admin') {
      const e = empSession(req);
      const allowed = isAdmin(req) || (e && employeeModules(e.email).indexOf('loxxerkalk') >= 0);
      if (!allowed) return send(res, 403, '<h1>Ke správě prezentace LOXXER nemáte přístup.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      let target = LOXXER_WEB_URL.replace(/\/$/, '') + '/admin';
      if (e) { const tok = ssoSign({ email: e.email, name: e.name, admin: isAdmin(req), exp: Date.now() + 5 * 60 * 1000 }); target += '?sso=' + encodeURIComponent(tok); }
      res.writeHead(302, { 'Location': target }); return res.end();
    }

    // ---- Poptávky (nabídková app „Kalkulátor lisů"): otevře konkrétní nabídku podle parametrů,
    //      nebo (bez parametrů) frontu „Nabídky k vyřízení" (inbox). Parametry z URL propíšeme dál. ----
    if (p === '/poptavky-app') {
      const e = empSession(req);
      const mods = e ? (employeeModules(e.email) || []) : [];
      const allowed = isAdmin(req) || mods.indexOf('kalkulace') >= 0 || mods.indexOf('obchod') >= 0 || mods.indexOf('obchodexp') >= 0;
      if (!allowed) return send(res, 403, '<h1>Přístup k Poptávkám nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      // Předej průchozí parametry (lead/product/mode/tons/company/…) do nabídkové app; bez nich otevři inbox.
      const inQ = new URL(req.url, 'http://x').searchParams;
      inQ.delete('sso');
      let qs = inQ.toString();
      if (!qs) qs = 'tab=inbox';
      let target = NABIDKY_URL.replace(/\/$/, '') + '/?' + qs;
      if (e) { const tok = ssoSign({ email: e.email, name: e.name, exp: Date.now() + 5 * 60 * 1000 }); target += '&sso=' + encodeURIComponent(tok); }
      res.writeHead(302, { 'Location': target }); return res.end();
    }

    // ---- Kalkulačka svoz ESA (modul): za přihlášením, přístup řídí správce, Google identita přes SSO token ----
    if (p === '/svoz-esa-app') {
      const e = empSession(req);
      const allowed = (e && employeeModules(e.email).indexOf('svozesa') >= 0) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup ke Kalkulačce svoz ESA nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (SVOZ_ESA_URL) {
        let target = SVOZ_ESA_URL;
        if (e) { const tok = ssoSign({ email: e.email, name: e.name, exp: Date.now() + 5 * 60 * 1000 }); target += (SVOZ_ESA_URL.indexOf('?') >= 0 ? '&' : '?') + 'sso=' + encodeURIComponent(tok); }
        res.writeHead(302, { 'Location': target }); return res.end();
      }
      if (fs.existsSync(SVOZ_ESA_FILE)) return send(res, 200, fs.readFileSync(SVOZ_ESA_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
      // (placeholder níže)
      const ph = '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Kalkulačka svoz ESA</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#eef1ec;color:#0f1512;display:grid;place-items:center;min-height:100vh}'
        + '.c{max-width:520px;text-align:center;background:#fff;border:1px solid #e3e7e0;border-radius:16px;padding:34px 30px;box-shadow:0 10px 30px rgba(15,21,18,.07)}'
        + 'h1{font-size:20px;margin:0 0 8px}p{color:#5b635c;margin:0 0 6px;line-height:1.55}code{background:#eef1ec;padding:2px 6px;border-radius:6px;font-size:13px}</style></head>'
        + '<body><div class="c"><h1>🚛 Kalkulačka svoz ESA</h1><p>Máte k modulu přístup. Aplikace se sem teprve napojí.</p>'
        + '<p style="margin-top:12px;font-size:13px">Pro napojení nastav proměnnou <code>SVOZ_ESA_URL</code> na adresu nasazené aplikace, nebo vlož soubor <code>kalkulacka-svoz-esa.html</code> do projektu.</p></div></body></html>';
      return send(res, 200, ph, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // ---- Hlídač sortimentu (modul): za přihlášením, přístup řídí správce, Google identita přes SSO token ----
    if (p === '/sortiment-app') {
      const e = empSession(req);
      const allowed = (e && employeeModules(e.email).indexOf('sortiment') >= 0) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup k Hlídači sortimentu nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (RANGES_WATCHDOG_URL) {
        let target = RANGES_WATCHDOG_URL;
        if (e) { const tok = ssoSign({ email: e.email, name: e.name, exp: Date.now() + 5 * 60 * 1000 }); target += (RANGES_WATCHDOG_URL.indexOf('?') >= 0 ? '&' : '?') + 'sso=' + encodeURIComponent(tok); }
        res.writeHead(302, { 'Location': target }); return res.end();
      }
      return send(res, 200, '<!doctype html><meta charset="utf-8"><div style="font-family:system-ui;max-width:520px;margin:60px auto;text-align:center"><h1>🛰️ Hlídač sortimentu</h1><p>Pro napojení nastav proměnnou <code>RANGES_WATCHDOG_URL</code>.</p></div>', { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // ---- Aplikace modulu Design třídicí linky: za přihlášením, přístup řídí správce (vzor Kalkulace-lisy) ----
    if (p === '/tridici-linka-app') {
      const e = empSession(req);
      const allowed = (e && employeeModules(e.email).indexOf('tridicilinka') >= 0) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup k Designu třídicí linky nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (TRIDICI_LINKA_APP_URL) {
        // Přihlášený zaměstnanec → přidej krátkodobý SSO token, aby se dvojče v iframu přihlásilo SAMO
        // (Google login v iframu Google odmítá; tímhle se mu vyhneme úplně).
        let target = TRIDICI_LINKA_APP_URL;
        if (e) { const tok = ssoSign({ email: e.email, name: e.name, exp: Date.now() + 5 * 60 * 1000 }); target += (TRIDICI_LINKA_APP_URL.indexOf('?') >= 0 ? '&' : '?') + 'sso=' + encodeURIComponent(tok); }
        res.writeHead(302, { 'Location': target }); return res.end();
      }
      if (fs.existsSync(TRIDICI_LINKA_APP_FILE)) return send(res, 200, fs.readFileSync(TRIDICI_LINKA_APP_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
      // aplikace zatím nenapojena – přátelský placeholder
      const ph = '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Design třídicí linky</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#eef1ec;color:#0f1512;display:grid;place-items:center;min-height:100vh}'
        + '.c{max-width:520px;text-align:center;background:#fff;border:1px solid #e3e7e0;border-radius:16px;padding:34px 30px;box-shadow:0 10px 30px rgba(15,21,18,.07)}'
        + 'h1{font-size:20px;margin:0 0 8px}p{color:#5b635c;margin:0 0 6px;line-height:1.55}code{background:#eef1ec;padding:2px 6px;border-radius:6px;font-size:13px}</style></head>'
        + '<body><div class="c"><h1>🏭 Design třídicí linky</h1><p>Máte k modulu přístup. Aplikace se sem teprve napojí.</p>'
        + '<p style="margin-top:12px;font-size:13px">Pro napojení nastav proměnnou <code>TRIDICI_LINKA_APP_URL</code> na adresu nasazené aplikace (třídicí linka), nebo vlož soubor <code>design-tridici-linky.html</code> do projektu.</p></div></body></html>';
      return send(res, 200, ph, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // ---- Aplikace modulu Kalkulačka překladiště: za přihlášením, přístup řídí správce (vzor Kalkulace-lisy) ----
    // Správa fotek na klientský web: přesměruje obchodníka/správce do aplikace (SSO) na stránku nahrávání fotek.
    if (p === '/kontejnery-fotky') {
      const e = empSession(req);
      const allowed = (e && (employeeModules(e.email).indexOf('obchod') >= 0 || employeeModules(e.email).indexOf('obchodexp') >= 0)) || isAdmin(req)
        || (e && kontejneryMod && kontejneryMod.isHandler && kontejneryMod.isHandler(e.email));
      if (!allowed) return send(res, 403, '<h1>Přístup nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!LODAKY_APP_URL) return send(res, 200, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">Aplikace lodních kontejnerů zatím není napojena (LODAKY_APP_URL).</p>', { 'Content-Type': 'text/html; charset=utf-8' });
      let target = LODAKY_APP_URL + '/spravce';
      if (e) { const tok = ssoSign({ email: e.email, name: e.name, admin: isAdmin(req), exp: Date.now() + 5 * 60 * 1000 }); target += '?sso=' + encodeURIComponent(tok); }
      res.writeHead(302, { 'Location': target }); return res.end();
    }
    // Nacenění lodního kontejneru: přesměruje obchodníka do samostatné aplikace se SSO tokenem + id poptávky.
    if (p === '/kontejnery-nacenit') {
      const e = empSession(req);
      const allowed = (e && (employeeModules(e.email).indexOf('obchod') >= 0 || employeeModules(e.email).indexOf('obchodexp') >= 0 || employeeModules(e.email).indexOf('kontejnerykalk') >= 0)) || isAdmin(req)
        || (e && kontejneryMod && kontejneryMod.isHandler && kontejneryMod.isHandler(e.email));
      if (!allowed) return send(res, 403, '<h1>Přístup k nacenění nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!LODAKY_APP_URL) return send(res, 200, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">Aplikace lodních kontejnerů zatím není napojena. Nastavte proměnnou <code>LODAKY_APP_URL</code> na adresu nasazené aplikace.</p>', { 'Content-Type': 'text/html; charset=utf-8' });
      const id = encodeURIComponent(u.query.id || '');
      let target = LODAKY_APP_URL + '/kalkulacka?id=' + id;
      if (e) { const tok = ssoSign({ email: e.email, name: e.name, admin: isAdmin(req), exp: Date.now() + 5 * 60 * 1000 }); target += '&sso=' + encodeURIComponent(tok); }
      res.writeHead(302, { 'Location': target }); return res.end();
    }
    if (p === '/prekladiste-app') {
      const e = empSession(req);
      const allowed = (e && employeeModules(e.email).indexOf('prekladiste') >= 0) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup ke Kalkulačce překladiště nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (PREKLADISTE_APP_URL) {
        // Přihlášený zaměstnanec → přidej krátkodobý SSO token, aby se kalkulačka v iframu přihlásila SAMA
        // (Google login v iframu Google odmítá; tímhle se mu vyhneme úplně).
        let target = PREKLADISTE_APP_URL;
        if (e) { const tok = ssoSign({ email: e.email, name: e.name, exp: Date.now() + 5 * 60 * 1000 }); target += (PREKLADISTE_APP_URL.indexOf('?') >= 0 ? '&' : '?') + 'sso=' + encodeURIComponent(tok); }
        res.writeHead(302, { 'Location': target }); return res.end();
      }
      if (fs.existsSync(PREKLADISTE_APP_FILE)) return send(res, 200, fs.readFileSync(PREKLADISTE_APP_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
      // aplikace zatím nenapojena – přátelský placeholder
      const ph2 = '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Kalkulačka překladiště</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#eef1ec;color:#0f1512;display:grid;place-items:center;min-height:100vh}'
        + '.c{max-width:520px;text-align:center;background:#fff;border:1px solid #e3e7e0;border-radius:16px;padding:34px 30px;box-shadow:0 10px 30px rgba(15,21,18,.07)}'
        + 'h1{font-size:20px;margin:0 0 8px}p{color:#5b635c;margin:0 0 6px;line-height:1.55}code{background:#eef1ec;padding:2px 6px;border-radius:6px;font-size:13px}</style></head>'
        + '<body><div class="c"><h1>♻️ Kalkulačka překladiště</h1><p>Máte k modulu přístup. Aplikace se sem teprve napojí.</p>'
        + '<p style="margin-top:12px;font-size:13px">Pro napojení nastav proměnnou <code>PREKLADISTE_APP_URL</code> na adresu nasazené aplikace (kalkulačka překladiště), nebo vlož soubor <code>kalkulacka-prekladiste.html</code> do projektu.</p></div></body></html>';
      return send(res, 200, ph2, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // ---- Modul Ložný plán: plánování nakládky vozidel (samostatná app na Railway, SSO) ----
    if (p === '/loznyplan-app') {
      const e = empSession(req);
      const allowed = (e && employeeModules(e.email).indexOf('loznyplan') >= 0) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup k Ložnému plánu nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      // Přihlášený zaměstnanec → krátkodobý SSO token, aby se aplikace v iframu přihlásila SAMA
      let target = LOZNYPLAN_APP_URL;
      if (e) { const tok = ssoSign({ email: e.email, name: e.name, exp: Date.now() + 5 * 60 * 1000 }); target += (target.indexOf('?') >= 0 ? '&' : '?') + 'sso=' + encodeURIComponent(tok); }
      res.writeHead(302, { 'Location': target }); return res.end();
    }

    // ---- Aplikace modulu Kalkulace KOVO: lokální variabilní kalkulačka nacenění ----
    if (p === '/kovokalk-app') {
      const e = empSession(req);
      const allowed = (e && (employeeModules(e.email).indexOf('kovo') >= 0 || employeeModules(e.email).indexOf('kovokalk') >= 0)) || isAdmin(req);
      if (!allowed) return send(res, 403, '<h1>Přístup k modulu Kovo nemáte.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (fs.existsSync(KOVOKALK_APP_FILE)) return send(res, 200, fs.readFileSync(KOVOKALK_APP_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 404, { error: 'Soubor kalkulacka-kovo.html chybí v projektu.' });
    }

    // ---- měsíční vyhodnocení (admin) ----
    if (p === '/api/report/preview' && req.method === 'GET') {
      const monthLabel = new Date().toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' });
      return send(res, 200, buildReportHtml(reportData(), monthLabel), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (p === '/api/report/send' && req.method === 'POST') {
      if (!emailConfigured()) return send(res, 400, { error: 'Pošta není nastavená — vyplň ji v záložce Nastavení nebo nastav RESEND_API_KEY.' });
      const b = JSON.parse(await readBody(req) || '{}');
      const to = (b.to || reportRecipient()).trim();
      try { await sendMonthlyReport(to); return send(res, 200, { ok: true, to: to }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) { return send(res, 500, { error: e.message }); }
});

if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  runVacImport(); // jednorázový import zůstatků dovolené (idempotentní)
  server.listen(PORT, () => {
    console.log('====================================================');
    console.log(' Seznámení se směrnicemi – ONLINE server');
    console.log(' Adresa:  ' + (CFG.publicUrl || ('http://localhost:' + PORT)));
    console.log(' Data:    ' + DATA_DIR);
    console.log(' Heslo do správy: ' + (process.env.ADMIN_PASSWORD ? '(z proměnné ADMIN_PASSWORD)' : SEC.password));
    console.log(' Odesílání pošty: ' + (process.env.RESEND_API_KEY ? ('Resend (HTTPS), odesílatel: ' + (process.env.RESEND_FROM || 'onboarding@resend.dev')) : 'SMTP'));
    console.log(' Intranet (Google SSO): ' + (ssoEnabled() ? ('zapnuto' + (GOOGLE.hd ? (', doména: ' + GOOGLE.hd) : '')) : 'vypnuto – doplňte GOOGLE_CLIENT_ID/SECRET'));
    console.log(' Měsíční vyhodnocení: ' + (reportEnabled() ? ((emailConfigured() ? 'aktivní' : 'čeká na nastavení pošty') + ', příjemce: ' + reportRecipient() + ', den v měsíci: ' + reportDay()) : 'vypnuto'));
    console.log('====================================================');
    if (!CFG.host) console.log(' i Poštu nastavíte v aplikaci: záložka Nastavení.');
    // měsíční vyhodnocení – kontrola při startu a pak periodicky (každých 6 h)
    maybeSendMonthlyReport();
    setInterval(maybeSendMonthlyReport, 6 * 3600 * 1000);
    maybeSendVacReport(); setInterval(maybeSendVacReport, 6 * 3600 * 1000);   // měsíční přehled čerpání dovolené
    // Reporty nákupu — kontrola při startu a pak KAŽDOU HODINU (kvůli ranní bilanci; guardy 1×/den, 1×/týden, 1×/14 dní)
    if (nakupReportMod) {
      nakupReportMod.tick(); setInterval(() => nakupReportMod.tick(), 3600 * 1000);
      // Drive sync objednávek kontrolovat každou hodinu (nový soubor tam bývá ~7:00) — vezme ho hned, jak se objeví
      if (nakupReportMod.sync) setInterval(() => nakupReportMod.sync().catch(() => {}), 3600 * 1000);
    }
    // Týdenní report přihlášek mobilních lisů (souhrn nových přihlášek z dotazníku) — 1×/ISO-týden.
    if (mobilniLisyMod) { mobilniLisyMod.tick(); setInterval(() => mobilniLisyMod.tick(), 6 * 3600 * 1000); }
    // Lodní kontejnery: import poptávek z Google tabulky (Meta) každých 15 min + týdenní report (pojistka 1×/ISO-týden).
    if (kontejneryMod) {
      if (kontejneryMod.syncSheet) { kontejneryMod.syncSheet().catch(() => {}); setInterval(() => kontejneryMod.syncSheet().catch(() => {}), 15 * 60 * 1000); }
      if (kontejneryMod.tick) { kontejneryMod.tick(); setInterval(() => kontejneryMod.tick(), 6 * 3600 * 1000); }
    }
    // Hlídač smluv: denní notifikační běh (stejný 6h interval, vnitřní pojistka na 1×/den)
    if (smlouvyMod) {
      smlouvyMod.tick();
      setInterval(() => smlouvyMod.tick(), 6 * 3600 * 1000);
    }
    // Adaptace: deadline notifikace úkolů (stejný 6h interval).
    if (adaptaceMod) {
      adaptaceMod.tick();
      setInterval(() => adaptaceMod.tick(), 6 * 3600 * 1000);
    }
    // Doprava: předehřátí dat z Google Sheets (stejný 6h interval).
    if (dopravaMod) {
      dopravaMod.tick();
      setInterval(() => dopravaMod.tick(), 6 * 3600 * 1000);
    }
    // Konstrukce: hlídání termínů, semaforů a eskalací (30min — kvůli 80% a překročení lhůt).
    if (konstrukceMod) {
      konstrukceMod.tick();
      setInterval(() => konstrukceMod.tick(), 30 * 60 * 1000);
    }
    // Qooling: Drive sync exportů závad + pondělní report (hodinová kontrola, pojistka 1×/ISO-týden).
    if (qoolingMod) {
      qoolingMod.tick();
      setInterval(() => qoolingMod.tick(), 3600 * 1000);
    }
  });
}
module.exports = { smtpSend, loadConfig, getState };

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
const SMI_APP_FILE = path.join(ROOT, 'SMI_aplikace.html');   // hotová SMI aplikace (modul E-shop)
const KALK_APP_FILE = path.join(ROOT, 'kalkulace-lisy.html'); // aplikace modulu Kalkulace-lisy (napojí se později)
const KALK_APP_URL = process.env.KALKULACE_APP_URL || 'https://lisy-production.up.railway.app/'; // aplikace Kalkulace-lisy (Railway); lze přepsat proměnnou
const SVOZ_ESA_URL = process.env.SVOZ_ESA_URL || ''; // aplikace „Kalkulačka svoz ESA" (repo kalkulacka-svoz-esa) — doplň URL nasazení
const RANGES_WATCHDOG_URL = process.env.RANGES_WATCHDOG_URL || ''; // aplikace „Hlídač sortimentu" (repo ranges-watchdog)
const TRIDICI_LINKA_APP_URL = process.env.TRIDICI_LINKA_APP_URL || 'https://tridici-linka-production.up.railway.app'; // aplikace „Design třídicí linky" — digitální dvojče (repo tridici-linka-railway); lze přepsat proměnnou
const TRIDICI_LINKA_APP_FILE = path.join(ROOT, 'design-tridici-linky.html'); // alternativně lokální soubor (stejně jako u Kalkulace-lisy)
const PREKLADISTE_APP_URL = process.env.PREKLADISTE_APP_URL || ''; // aplikace „Kalkulačka překladiště" — prodejní kalkulačka (repo prekladiste-kalkulacka); doplň URL nasazení
const PREKLADISTE_APP_FILE = path.join(ROOT, 'kalkulacka-prekladiste.html'); // alternativně lokální soubor
const KOVOKALK_APP_FILE = path.join(ROOT, 'kalkulacka-kovo.html'); // modul „Kalkulace KOVO" — variabilní kalkulačka nacenění výrobků kovovýroby
const FREELO_EMAIL = process.env.FREELO_EMAIL || '';     // modul Freelo: e-mail účtu (basic auth)
const FREELO_API_KEY = process.env.FREELO_API_KEY || ''; // modul Freelo: API klíč (Freelo → Nastavení profilu → API)
const SVOZ_ESA_FILE = path.join(ROOT, 'kalkulacka-svoz-esa.html'); // alternativně lokální soubor
// Dovolená: úložiště žádostí + (volitelně) zápis do sdíleného Google kalendáře přes service account
const VAC_F = path.join(DATA_DIR, 'vacation.json');
const VACATION_CALENDAR_ID = process.env.VACATION_CALENDAR_ID || '';       // ID sdíleného kalendáře „Dovolené"
const GOOGLE_SA_CLIENT_EMAIL = process.env.GOOGLE_SA_CLIENT_EMAIL || '';   // client_email ze service-account JSON
const GOOGLE_SA_PRIVATE_KEY = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'); // private_key (PEM; \n → nové řádky)
const GRIT_FILE = path.join(ROOT, 'grit.html');              // test houževnatosti (Grit)
const JSS_FILE  = path.join(ROOT, 'jss.html');               // dotazník pracovní spokojenosti (JSS)
const TW44_FILE = path.join(ROOT, 'tw44.html');              // test kognitivní zátěže (TW44)
const ABROLL_FILE = path.join(ROOT, 'abroll-skoleni.html');  // interaktivní školení ABROLL + závěrečný test
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
const ABROLL_F = path.join(DATA_DIR, 'abroll-results.json'); // výsledky testu ABROLL (max 3 pokusy na osobu)
const CFG_F    = path.join(DATA_DIR, 'mail.config.json');
const SECRET_F = path.join(DATA_DIR, 'secret.json');
const ACTLOG_F  = path.join(DATA_DIR, 'activity.json');   // jednoduchý log aktivity (přihlášení, pozvánky, průzkumy)
const CENMON_F  = path.join(DATA_DIR, 'cenmon.json');     // cenový monitoring: naše položky (export SMI), katalog MEVA, ruční páry
const INVITES_F = path.join(DATA_DIR, 'invites.json');    // stav pozvánek dle e-mailu: {invitedAt, acceptedAt, lastLoginAt}
const UKOLY_F   = path.join(DATA_DIR, 'smernice-ukoly.json'); // úkoly vyplývající ze směrnic (záložka „Úkoly ze směrnic")
const KOVOKALK_F = path.join(DATA_DIR, 'kovo-kalkulace.json'); // Kalkulace KOVO: parametry (s historií změn) + výrobky
const OBCHOD_F   = path.join(DATA_DIR, 'obchod-zastupitelnost.json'); // Obchod: rozdělení obchodníků / zastupitelnost PM (editovatelná tabulka)
const AKTUALITY_F = path.join(DATA_DIR, 'aktuality.json');    // aktuality (novinky) na intranetu: {posts:[{id,title,body,image,author,authorEmail,ts,likes:{email:ts}}]}
const SITE_F      = path.join(DATA_DIR, 'site.json');         // nastavení vzhledu intranetu (např. vlastní hero banner)
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');           // nahrané obrázky (aktuality, banner) — persistentní volume
for (const d of [DATA_DIR, PUB_DIR, UPLOADS_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

/* ---------- malé util ---------- */
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function writeJson(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); }

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
function isAdmin(req) { if (isAuthed(req)) return true; const e = empSession(req); return !!(e && isAdminEmp(e.email)); }

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
function empSession(req) { return empVerify(cookieVal(req, 'sm_emp')); }
/* ---------- SSO do externích aplikací (nabídkový kalkulátor) ---------- */
// Token = b64url(JSON{email,name,exp}) + "." + HMAC-SHA256("sso:"+data, SEC.secret)[0..32]. Krátká platnost.
const SSO_SHARED_SECRET = process.env.SSO_SHARED_SECRET || SEC.secret; // nastav stejně jako INTRANET_SSO_SECRET v nabídkové app
function ssoSign(payload) { const data = b64url(JSON.stringify(payload)); const sig = crypto.createHmac('sha256', SSO_SHARED_SECRET).update('sso:' + data).digest('hex').slice(0, 32); return data + '.' + sig; }
const NABIDKY_URL = process.env.NABIDKY_URL || 'https://lisy-production.up.railway.app';
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
      await cmd('MAIL FROM:<' + fromAddr + '>', [250]);
      await cmd('RCPT TO:<' + mail.to + '>', [250, 251]);
      await cmd('DATA', [354]);
      const boundary = 'b_' + crypto.randomBytes(8).toString('hex');
      const fromHeader = mail.fromName ? (rfc2047(mail.fromName) + ' <' + fromAddr + '>') : fromAddr;
      const headers = ['From: ' + fromHeader, 'To: <' + mail.to + '>', 'Subject: ' + rfc2047(mail.subject || ''), 'Date: ' + new Date().toUTCString(), 'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@' + host + '>', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' + boundary + '"'].join('\r\n');
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
    const payload = JSON.stringify({ from: from, to: [mail.to], subject: mail.subject || '', html: mail.html || undefined, text: mail.text || undefined });
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
function deliver(mail) { return process.env.RESEND_API_KEY ? resendSend(mail) : smtpSend(CFG, mail); }

/* ============================================================
   stav (směrnice/zaměstnanci) + potvrzení
   ============================================================ */
function getState() {
  const s = readJson(STATE_F, { categories: [], employees: [], directives: [], profiles: [] });
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
function ensureEmployee(email, name) {
  email = (email || '').toLowerCase();
  const s = readJson(STATE_F, { categories: [], employees: [], directives: [], profiles: [] });
  s.employees = s.employees || [];
  let e = s.employees.find(x => (x.email || '').toLowerCase() === email);
  if (!e) { e = { id: 'g' + crypto.randomBytes(6).toString('hex'), name: name || email, email, cats: [] }; s.employees.push(e); writeJson(STATE_F, s); }
  return e;
}
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
/* ---- Automatické odeslání výsledku testu na HR manažera (settings.hrEmail) + interpretace ---- */
const SURVEY_NAZVY = { grit: 'Test houževnatosti (Grit)', jss: 'Dotazník pracovní spokojenosti (JSS)', tw44: 'Test kognitivní zátěže (TW44)' };
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
  const f = kind === 'jss' ? JSS_F : kind === 'tw44' ? TW44_F : GRIT_F;
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

// Počet pracovních dnů (po–pá) v rozsahu; celý půlden odečte 0.5. Státní svátky zatím neřešíme.
function workingDays(from, to, halfDay) {
  const a = new Date(from + 'T00:00:00'), b = new Date(to + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return 0;
  let n = 0;
  for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  if (halfDay && n > 0) n -= 0.5;
  return n;
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

// Kdo schvaluje dovolenou zaměstnance: 1) přiřazený nadřízený (managerId, „pod kým je"),
// 2) vedoucí jeho střediska; jinak null → řeší admin.
function approverFor(emp, emps) {
  emps = emps || (getState().employees || []);
  if (!emp) return null;
  if (emp.managerId) { const m = emps.find(x => x.id === emp.managerId); if (m && m.email) return m; }
  if (emp.stredisko) { const d = emps.find(x => x.vedouci && (x.stredisko || '') === emp.stredisko && x.id !== emp.id); if (d) return d; }
  // Bez přiřazeného vedoucího schvaluje superadmin (SUPERADMIN) – kromě jeho vlastní žádosti.
  if ((emp.email || '').toLowerCase() === SUPERADMIN) return null;
  const sa = emps.find(x => (x.email || '').toLowerCase() === SUPERADMIN);
  return sa || { email: SUPERADMIN, name: 'David Surý' };
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
function buildTelefon() {
  const groups = TELEFON_SKUPINY.map((g) => ({
    stredisko: g.stredisko,
    lide: g.lide.map((r) => ({ role: r[0] || '', name: r[1] || '', email: (r[2] || '').trim(), phone: (r[3] || '').trim() })),
  }));
  const total = groups.reduce((n, g) => n + g.lide.length, 0);
  return { groups, odkazy: TELEFON_ODKAZY, total };
}

/* ---------- Obchod: rozdělení obchodníků / zastupitelnost produktových manažerů ----------
   Editovatelná tabulka 1:1 se zdrojovým Google Sheetem „Zastupitelnost_PM_Elkoplast_cisty"
   (list: sekce webu → kategorie → odpovědný PM → zástup → třetí náhradník → stav pokrytí).
   Data žijí v datovém souboru OBCHOD_F; při prvním načtení se předvyplní seedem níže. */
const OBCHOD_SLOUPCE = [
  { key: 'sekce', label: 'Sekce webu' },
  { key: 'kategorie', label: 'Kategorie na webu (elkoplast.cz)' },
  { key: 'stitek', label: 'Štítek' },
  { key: 'pm', label: 'Odpovědný PM (dle návrhu)' },
  { key: 'zastup', label: 'Zástup / překryv' },
  { key: 'nahradnik', label: 'Třetí náhradník' },
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
const OBCHOD_SEED = OBCHOD_SEED_ROWS.map((r, i) => { const o = { id: 'k' + (i + 1) }; OBCHOD_SLOUPCE.forEach((c, j) => { o[c.key] = r[j] || ''; }); return o; });
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
  Object.keys(OBCHOD_LIDE).forEach(k => { acc[k] = { name: OBCHOD_LIDE[k], owner: [], zastup: [], sekce: {} }; });
  rows.forEach(r => {
    obPmListSrv(r.pm).forEach(l => { const k = obchodNorm(l); if (acc[k]) { acc[k].owner.push({ sekce: r.sekce || '', kategorie: r.kategorie || '', coverage: obEvalCoverage(r) }); if (r.sekce) acc[k].sekce[r.sekce] = 1; } });
    obPmListSrv(r.zastup).forEach(l => { const k = obchodNorm(l); if (acc[k]) acc[k].zastup.push({ sekce: r.sekce || '', kategorie: r.kategorie || '' }); });
  });
  return Object.keys(acc).map(k => { const o = acc[k]; const e = obMatchEmp(o.name, emps);
    return { name: o.name, email: e ? e.email : obchodEmail(o.name), inDb: !!e, sekce: Object.keys(o.sekce), owner: o.owner, zastup: o.zastup, pocetOdpovedny: o.owner.length, pocetZastup: o.zastup.length, bezZalohy: o.owner.filter(x => x.coverage === 'Bez zálohy').length };
  }).filter(o => o.pocetOdpovedny > 0 || o.pocetZastup > 0).sort((a, b) => b.pocetOdpovedny - a.pocetOdpovedny);
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
function vocCs(name) {
  if (!name) return name;
  const m = String(name).match(/^(\S+)(\s.*)?$/); if (!m) return name;
  const first = m[1], rest = m[2] || '', lower = first.toLowerCase();
  const cap = (t) => (first[0] === first[0].toUpperCase()) ? (t.charAt(0).toUpperCase() + t.slice(1)) : t;
  if (VOC_OVERRIDES[lower]) return cap(VOC_OVERRIDES[lower]) + rest;
  if (lower.length < 2) return name;
  if (/a$/.test(lower)) return cap(lower.slice(0,-1) + 'o') + rest;          // -a → -o (Jana→Jano, Honza→Honzo)
  if (/ie$/.test(lower)) return name;                                         // Marie, Lucie – beze změny
  if (/[eiouyíáéěůúýó]$/.test(lower)) return name;                            // ostatní samohlásky beze změny (Jiří, Hugo)
  if (/[jščřžďťňc]$/.test(lower)) return cap(lower + 'i') + rest;             // měkké souhlásky → -i (Tomáš→Tomáši)
  if (/ek$/.test(lower) && lower.length > 2) return cap(lower.slice(0,-2) + 'ku') + rest; // -ek (mizící e): Marek→Marku, Radek→Radku
  if (/ch$/.test(lower)) return cap(lower + 'u') + rest;                      // -ch → -chu (Vojtěch→Vojtěchu)
  if (/[khg]$/.test(lower)) return cap(lower + 'u') + rest;                   // -k/-h/-g → +u (Patrik→Patriku)
  if (/r$/.test(lower)) return cap(lower.slice(0,-1) + 'ře') + rest;          // -r → -ře (Petr→Petře)
  if (/l$/.test(lower)) return cap(lower + 'e') + rest;                       // -l → -le (Michal→Michale)
  if (/[dtnmvbszfp]$/.test(lower)) return cap(lower + 'e') + rest;            // tvrdé souhlásky → +e (David→Davide, Jan→Jane)
  return name;
}
function renderTpl(t, v) { return (t || '').replace(/\{(jmeno5|jmeno|smernice|odkaz)\}/g, (m, k) => (v[k] != null ? v[k] : m)); }
function toHtml(text, link, btnLabel) { let h = esc(text).replace(/\n/g, '<br>'); if (link) { const s = esc(link); h = h.split(s).join('<a href="' + s + '" style="color:#1f5d3f">' + s + '</a>') + '<div style="margin-top:18px"><a href="' + s + '" style="display:inline-block;background:#1f5d3f;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold">' + esc(btnLabel || 'Otevřít a potvrdit seznámení') + '</a></div>'; } return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1c1d1a;line-height:1.55">' + h + '</div>'; }
function baseUrl(req) { return (CFG.publicUrl || (((req.headers['x-forwarded-proto'] || 'http')) + '://' + req.headers.host)).replace(/\/$/, ''); }
/* Uvítací (pozvánkový) e-mail do intranetu — hezky nastylovaný, firemní barvy. Text (subject+body) je editovatelný. */
const DEFAULT_INVITE_SUBJECT = 'Pozvánka do intranetu ELKOPLAST CZ';
const DEFAULT_INVITE_BODY = 'Dobrý den {jmeno5},\n\nbyli jste pozváni do firemního intranetu ELKOPLAST CZ — jedno místo pro všechno pracovní.';
function intranetInviteMail(name, url, tpl) {
  tpl = tpl || {};
  const fn = (name || '').split(' ')[0] || name || '';
  const vars = { jmeno: fn, jmeno5: vocCs(fn), odkaz: url };
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
  smlouvyMod = require('./smlouvy').mount({
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
  dopravaMod = require('./doprava').mount({ send, readBody, empSession, isAdmin, employeeModules, dataDir: DATA_DIR });
} catch (e) {
  console.error('[doprava] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

// ---- Modul „Konstrukce" (workflow zadání a schválení výkresů) ----
let konstrukceMod = null;
try {
  konstrukceMod = require('./konstrukce').mount({
    send, readBody, deliver, empSession, isAdmin, baseUrl, employeeModules, getState,
    dataDir: DATA_DIR,
    mailFrom: { user: CFG.user, name: CFG.fromName || 'Intranet – konstrukce', publicUrl: (CFG.publicUrl || process.env.PUBLIC_URL || '') },
  });
} catch (e) {
  console.error('[konstrukce] modul se nenačetl, intranet pokračuje bez něj:', e.message);
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true); const p = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });

  // pozvánkový hash: podepsaný odkaz ?i=... pustí NEzaměstnance na dotazník bez přihlášení
  const invite = inviteVerify(u.query.i || '');
  const INVITE_ROUTES = ['/grit', '/grit.html', '/jss', '/jss.html', '/tw44', '/tw44.html', '/api/grit', '/api/jss', '/api/tw44'];
  const inviteOk = !!(invite && INVITE_ROUTES.indexOf(p) >= 0);
  // Veřejné cesty modulu Smlouvy (mimo SSO závoru): potvrzení termínu tokenem + Resend webhook.
  const smlouvyPublic = p.startsWith('/smlouvy/potvrdit') || p === '/api/smlouvy/webhook/resend';
  // Veřejné cesty modulu Adaptace: magic-link pozvánka, guest plnění, import z náboru.
  const adaptacePublic = p.startsWith('/adaptace/uvod/') || p === '/api/adaptace/guest' || p === '/api/adaptace/guest-flag' || p === '/api/adaptace/import-user';
  // Veřejné cesty modulu Konstrukce: klientský náhled výkresu (token, bez přihlášení).
  const konstrukcePublic = p.startsWith('/konstrukce/nahled/') || p.startsWith('/api/konstrukce/nahled/');

  // Verze běžícího serveru – klient si podle ní pozná, že běží na staré verzi z cache (mimo závoru, bez cache).
  if (p === '/api/version') return send(res, 200, { commit: GIT_COMMIT, built: BUILD_TIME, deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null }, { 'Cache-Control': 'no-store' });

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
  if (!gatePassed(req) && !inviteOk && !smlouvyPublic && !adaptacePublic && !konstrukcePublic) {
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
  const PROTECTED = ['/api/state', '/api/send', '/api/publish', '/api/test', '/api/config', '/api/library', '/api/report/preview', '/api/report/send', '/api/grit-results', '/api/jss-results', '/api/tw44-results'];
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

    // Kořen = zaměstnanecký intranet, /admin = administrace. Obě cesty servírují stejnou SPA;
    // režim se rozhodne v prohlížeči podle cesty. Přístup do správy hlídá /api/state (jinak přihlašovací okno).
    if (p === '/' || p === '/index.html' || p === '/admin' || p === '/admin/') {
      if (!fs.existsSync(APP_FILE)) return send(res, 404, '<h1>Chybí seznameni-se-smernicemi.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, injectVersion(fs.readFileSync(APP_FILE, 'utf8')), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
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
    if (p === '/koncept' || p === '/koncept.html') {
      if (!fs.existsSync(KONCEPT_FILE)) return send(res, 404, '<h1>Chybí intranet-koncept.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(KONCEPT_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
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
      const CT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
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
      async function worker() { while (queue.length) { const r = queue.shift(); const fn = ((r.name || '').split(' ')[0] || r.name || ''); const vars = { jmeno: fn, jmeno5: vocCs(fn), smernice: b.dirTitle || '', odkaz: r.link || '' }; const subject = renderTpl(b.subject, vars), text = renderTpl(b.body, vars); try { await deliver({ to: r.email, fromAddr: b.fromEmail || CFG.user, fromEmail: b.fromEmail || undefined, fromName: b.fromName || CFG.fromName, subject, text, html: toHtml(text, r.link, b.btnLabel) }); results.push({ email: r.email, ok: true }); } catch (e) { results.push({ email: r.email, ok: false, error: e.message }); } if (useResend) await sleep(550); } }
      await Promise.all(Array.from({ length: useResend ? 1 : Math.min(3, recipients.length || 1) }, worker));
      return send(res, 200, { results });
    }
    // veřejné cesty
    if (p.indexOf('/s/') === 0) {
      const id = p.slice(3).replace(/[^a-z0-9]/gi, ''); const f = path.join(PUB_DIR, id + '.html');
      if (!fs.existsSync(f)) {
        // Stránka zatím nebyla publikována (správce jen uložil) → vygenerovat na serveru z aktuálního stavu.
        const s = getState(); const d = (s.directives || []).find(x => String(x.id) === id);
        if (!d || !d.html) return send(res, 404, '<h1>Směrnice nenalezena</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
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
    // ABROLL test: GET = stav pokusů dané osoby, POST = odeslání pokusu (max 3)
    if (p === '/api/abroll' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, abrollStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/abroll' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordAbroll(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/abroll-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(ABROLL_F, [])); }
    // ---- Odeslání reportu průzkumu e-mailem (z detailu; jen správce) ----
    if (p === '/api/survey-report/send' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      if (!emailConfigured()) return send(res, 500, { error: 'Pošta není nastavená — vyplň ji v záložce Nastavení.' });
      const b = JSON.parse(await readBody(req));
      const kind = (b.kind || '').toLowerCase();
      if (['grit', 'jss', 'tw44'].indexOf(kind) < 0) return send(res, 400, { error: 'Neznámý typ testu.' });
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
      const vars = { jmeno: fn, jmeno5: vocCs(fn), smernice: b.dirTitle || '', odkaz: link };
      return send(res, 200, { subject: renderTpl(b.subject || '', vars), html: toHtml(renderTpl(b.body || '', vars), link, b.btnLabel), mailReady: emailConfigured() });
    }

    // ---- intranet zaměstnanců: přihlášení přes Google (SSO) ----
    if (p === '/api/me' && req.method === 'GET') { const e = empSession(req); return send(res, 200, { sso: ssoEnabled(), dev: devAllowed(req), employee: e ? { email: e.email, name: e.name } : null, admin: isAdmin(req), superadmin: isSuperadmin(req) }); }
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
      return send(res, 200, { employee: { email: e.email, name: e.name }, directives: myDirectives(e.email), library: myLibrary(e.email), modules: employeeModules(e.email), surveys: mySurveys(e.email), surveyToken: inviteSign(e.email, e.name), isApprover: !!isApprover, vacPending: vacPending, canPostAktuality: canPostAktuality(req), heroImage: (readJson(SITE_F, {}).heroImage) || null });
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
      const ent = vacEntitlement(me), used = vacUsed(e.email, year);
      const mine = readVac().requests.filter(r => (r.empEmail || '').toLowerCase() === e.email.toLowerCase()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(res, 200, { year, entitlement: ent, used, balance: Math.round((ent - used) * 10) / 10, approver: ap ? { name: ap.name, email: ap.email } : null, requests: mine });
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
      const rq = { id: 'v' + crypto.randomBytes(6).toString('hex'), empEmail: e.email, empName: e.name, approverEmail: ap ? ap.email : '', from: b.from, to: b.to, halfDay: !!b.halfDay, days, type: b.type || 'dovolena', note: (b.note || '').slice(0, 500), status: 'pending', createdAt: Date.now() };
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
      const list = readVac().requests.filter(r => r.status === 'pending' && (admin || (r.approverEmail || '').toLowerCase() === e.email.toLowerCase())).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return send(res, 200, { admin, requests: list });
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
    if (p === '/api/vacation/all' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' });
      const emps = getState().employees || []; const year = new Date().getFullYear();
      const konto = emps.map(x => { const ent = vacEntitlement(x); const used = vacUsed(x.email, year); return { name: x.name, email: x.email, stredisko: x.stredisko || '', entitlement: ent, used, balance: Math.round((ent - used) * 10) / 10 }; });
      return send(res, 200, { year, konto, requests: readVac().requests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) });
    }

    // ---- knihovna: správa (admin) ----
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
      return send(res, 200, { id: d.id, title: d.title, kind: d.kind || 'dokument', v: ver.v, note: ver.note || '', html: ver.html || '', requireAck: d.requireAck !== false, acked: email ? libAcked(d.id, ver.v, email) : false });
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
      if (GOOGLE.hd) params.set('hd', GOOGLE.hd);
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
        if (GOOGLE.hd && pl.hd !== GOOGLE.hd) throw new Error('Účet není z povolené firemní domény (' + GOOGLE.hd + ').');
        const email = (pl.email || '').toLowerCase();
        if (!email) throw new Error('Token neobsahuje e-mail.');
        const emp = ensureEmployee(email, pl.name || email);
        markLogin(emp.email, emp.name, 'Google');
        const sess = empSign({ email: emp.email, name: emp.name });
        const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
        const nx = cookieVal(req, 'sm_next');
        const dest = /^\/sso\/[a-z0-9-]+$/.test(nx || '') ? nx : '/';
        res.writeHead(302, { 'Set-Cookie': ['sm_emp=' + encodeURIComponent(sess) + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000' + secure, 'sm_oauth=; Path=/; Max-Age=0', 'sm_next=; Path=/; Max-Age=0'], 'Location': dest });
        return res.end();
      } catch (e) { return send(res, 400, '<h1>Přihlášení selhalo</h1><p>' + esc(e.message) + '</p><p><a href="/">Zpět</a></p>', { 'Content-Type': 'text/html; charset=utf-8' }); }
    }
    if (p === '/auth/logout') { res.writeHead(302, { 'Set-Cookie': 'sm_emp=; Path=/; Max-Age=0', 'Location': '/' }); return res.end(); }

    // ---- ABROLL školení (interaktivní): za přihlášením (zaměstnanec nebo správce) ----
    if (p === '/abroll-app') {
      const e = empSession(req);
      if (!e && !isAdmin(req)) return send(res, 403, '<h1>Školení ABROLL je dostupné po přihlášení.</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (!fs.existsSync(ABROLL_FILE)) return send(res, 404, '<h1>Chybí abroll-skoleni.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(ABROLL_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
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
  });
}
module.exports = { smtpSend, loadConfig, getState };

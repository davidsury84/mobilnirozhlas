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
let BUILD_TIME; try { BUILD_TIME = require('fs').statSync(APP_FILE).mtimeMs; } catch (_) { BUILD_TIME = Date.now(); }
function injectVersion(html) { return html.replace('<!--VERSION-->', '<script>window.__VER__=' + JSON.stringify({ commit: GIT_COMMIT, built: BUILD_TIME }) + ';<\/script>'); }
const SMI_APP_FILE = path.join(ROOT, 'SMI_aplikace.html');   // hotová SMI aplikace (modul E-shop)
const KALK_APP_FILE = path.join(ROOT, 'kalkulace-lisy.html'); // aplikace modulu Kalkulace-lisy (napojí se později)
const KALK_APP_URL = process.env.KALKULACE_APP_URL || 'https://lisy-production.up.railway.app/'; // aplikace Kalkulace-lisy (Railway); lze přepsat proměnnou
const SVOZ_ESA_URL = process.env.SVOZ_ESA_URL || ''; // aplikace „Kalkulačka svoz ESA" (repo kalkulacka-svoz-esa) — doplň URL nasazení
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
const INVITES_F = path.join(DATA_DIR, 'invites.json');    // stav pozvánek dle e-mailu: {invitedAt, acceptedAt, lastLoginAt}
for (const d of [DATA_DIR, PUB_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

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
      return { id: d.id, title: d.title, ack: !!ack, ackTs: ack ? ack.ts : null, published: fs.existsSync(path.join(PUB_DIR, String(d.id).replace(/[^a-z0-9]/gi, '') + '.html')) };
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
  const rec = { email, name, dept, hs, pct: gritPct(hs), ts: Date.now() };
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
function toHtml(text, link) { let h = esc(text).replace(/\n/g, '<br>'); if (link) { const s = esc(link); h = h.split(s).join('<a href="' + s + '" style="color:#1f5d3f">' + s + '</a>') + '<div style="margin-top:18px"><a href="' + s + '" style="display:inline-block;background:#1f5d3f;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold">Otevřít a potvrdit seznámení</a></div>'; } return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1c1d1a;line-height:1.55">' + h + '</div>'; }
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

  // Verze běžícího serveru – klient si podle ní pozná, že běží na staré verzi z cache (mimo závoru, bez cache).
  if (p === '/api/version') return send(res, 200, { commit: GIT_COMMIT, built: BUILD_TIME, deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null }, { 'Cache-Control': 'no-store' });

  // Healthcheck (veřejný, vždy 200) – pro Railway healthcheck a jednoznačnou identifikaci běžícího nasazení.
  if (p === '/healthz') return send(res, 200, { ok: true, commit: GIT_COMMIT, deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null, uptimeS: Math.round(process.uptime()) }, { 'Cache-Control': 'no-store' });

  // sdílená závora celého webu (Google SSO nebo sdílené heslo; aktivní jen když je aspoň jedno nastaveno)
  if (!gatePassed(req) && !inviteOk && !smlouvyPublic && !adaptacePublic) {
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
      async function worker() { while (queue.length) { const r = queue.shift(); const fn = ((r.name || '').split(' ')[0] || r.name || ''); const vars = { jmeno: fn, jmeno5: vocCs(fn), smernice: b.dirTitle || '', odkaz: r.link || '' }; const subject = renderTpl(b.subject, vars), text = renderTpl(b.body, vars); try { await deliver({ to: r.email, fromAddr: b.fromEmail || CFG.user, fromEmail: b.fromEmail || undefined, fromName: b.fromName || CFG.fromName, subject, text, html: toHtml(text, r.link) }); results.push({ email: r.email, ok: true }); } catch (e) { results.push({ email: r.email, ok: false, error: e.message }); } if (useResend) await sleep(550); } }
      await Promise.all(Array.from({ length: useResend ? 1 : Math.min(3, recipients.length || 1) }, worker));
      return send(res, 200, { results });
    }
    // veřejné cesty
    if (p.indexOf('/s/') === 0) { const id = p.slice(3).replace(/[^a-z0-9]/gi, ''); const f = path.join(PUB_DIR, id + '.html'); if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' }); return send(res, 404, '<h1>Směrnice nenalezena</h1>', { 'Content-Type': 'text/html; charset=utf-8' }); }
    if (p === '/api/ack' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (!b.dirId || !b.email) return send(res, 400, { error: 'Chybí data.' }); recordAck(b); return send(res, 200, { ok: true }, { 'Access-Control-Allow-Origin': '*' }); }
    // ---- test houževnatosti (Grit) ----
    if (p === '/api/grit' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (invite) { b.email = invite.e; b.name = invite.n; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const rec = recordGrit(b); if (rec.blocked) return send(res, 200, { ok: false, blocked: true, nextAt: rec.nextAt }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, { ok: true, name: rec.name, dept: rec.dept, hs: rec.hs, pct: rec.pct }, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/grit-results' && req.method === 'GET') return send(res, 200, readJson(GRIT_F, []));
    // ---- dotazník pracovní spokojenosti (JSS) ----
    if (p === '/api/jss' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (invite) { b.email = invite.e; b.name = invite.n; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const rec = recordJss(b); if (rec.blocked) return send(res, 200, { ok: false, blocked: true, nextAt: rec.nextAt }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, { ok: true, name: rec.name, dept: rec.dept, total: rec.total, pct: rec.pct }, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/jss-results' && req.method === 'GET') return send(res, 200, readJson(JSS_F, []));
    // ---- test kognitivní zátěže (TW44) ----
    if (p === '/api/tw44' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (invite) { b.email = invite.e; b.name = invite.n; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const rec = recordTw44(b); if (rec.blocked) return send(res, 200, { ok: false, blocked: true, nextAt: rec.nextAt }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, { ok: true, name: rec.name, dept: rec.dept }, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/tw44-results' && req.method === 'GET') return send(res, 200, readJson(TW44_F, []));
    // ABROLL test: GET = stav pokusů dané osoby, POST = odeslání pokusu (max 3)
    if (p === '/api/abroll' && req.method === 'GET') { const eml = (u.query.email || (empSession(req) || {}).email || ''); return send(res, 200, abrollStatus(eml), { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/abroll' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const e = empSession(req); if (e) { b.email = e.email; b.name = b.name || e.name; } if (!b.email) return send(res, 400, { error: 'Chybí e-mail.' }); const r = recordAbroll(b); if (r.blocked) return send(res, 200, { ok: false, blocked: true, attemptsUsed: r.attemptsUsed }, { 'Access-Control-Allow-Origin': '*' }); return send(res, 200, r, { 'Access-Control-Allow-Origin': '*' }); }
    if (p === '/api/abroll-results' && req.method === 'GET') { if (!isAdmin(req)) return send(res, 401, { error: 'Nepřihlášeno.' }); return send(res, 200, readJson(ABROLL_F, [])); }
    // podepsané pozvánkové odkazy (hash) pro dávku příjemců — jen pro správce
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
      return send(res, 200, { subject: renderTpl(b.subject || '', vars), html: toHtml(renderTpl(b.body || '', vars), link), mailReady: emailConfigured() });
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
    if (p === '/api/my' && req.method === 'GET') {
      const e = empSession(req); if (!e) return send(res, 401, { error: 'Nepřihlášeno.' });
      const emps = getState().employees || []; const eml = e.email.toLowerCase();
      const me = emps.find(x => (x.email || '').toLowerCase() === eml);
      // Je schvalovatelem? = je něčí přímý nadřízený, ředitel střediska, nebo jednatel.
      const isApprover = isAdmin(req) || emps.some(x => x.id !== (me && me.id) && (x.email || '').toLowerCase() !== eml && (approverFor(x, emps) || {}).id === (me && me.id));
      const vacPending = readVac().requests.filter(r => r.status === 'pending' && (isAdmin(req) || (r.approverEmail || '').toLowerCase() === eml)).length;
      return send(res, 200, { employee: { email: e.email, name: e.name }, directives: myDirectives(e.email), library: myLibrary(e.email), modules: employeeModules(e.email), surveys: mySurveys(e.email), isApprover: !!isApprover, vacPending: vacPending });
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
      const ph = '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Kalkulačka svoz ESA</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#eef1ec;color:#0f1512;display:grid;place-items:center;min-height:100vh}'
        + '.c{max-width:520px;text-align:center;background:#fff;border:1px solid #e3e7e0;border-radius:16px;padding:34px 30px;box-shadow:0 10px 30px rgba(15,21,18,.07)}'
        + 'h1{font-size:20px;margin:0 0 8px}p{color:#5b635c;margin:0 0 6px;line-height:1.55}code{background:#eef1ec;padding:2px 6px;border-radius:6px;font-size:13px}</style></head>'
        + '<body><div class="c"><h1>🚛 Kalkulačka svoz ESA</h1><p>Máte k modulu přístup. Aplikace se sem teprve napojí.</p>'
        + '<p style="margin-top:12px;font-size:13px">Pro napojení nastav proměnnou <code>SVOZ_ESA_URL</code> na adresu nasazené aplikace, nebo vlož soubor <code>kalkulacka-svoz-esa.html</code> do projektu.</p></div></body></html>';
      return send(res, 200, ph, { 'Content-Type': 'text/html; charset=utf-8' });
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
  });
}
module.exports = { smtpSend, loadConfig, getState };

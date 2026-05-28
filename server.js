/* ============================================================
   Seznámení se směrnicemi – ONLINE server (bez závislostí)
   ------------------------------------------------------------
   Spuštění:   node server.js
   Proměnné prostředí (volitelné):
     PORT            port (výchozí 8080)
     ADMIN_PASSWORD  heslo do správy (jinak se vygeneruje a vypíše)
     PUBLIC_URL      veřejná adresa, např. https://smernice.elkoplast.cz
     DATA_DIR        kam ukládat data (výchozí ./data)
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

const ROOT     = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const APP_FILE = path.join(ROOT, 'seznameni-se-smernicemi.html');
const PUB_DIR  = path.join(DATA_DIR, 'published');
const STATE_F  = path.join(DATA_DIR, 'state.json');
const ACKS_F   = path.join(DATA_DIR, 'acks.json');
const CFG_F    = path.join(DATA_DIR, 'mail.config.json');
const SECRET_F = path.join(DATA_DIR, 'secret.json');
for (const d of [DATA_DIR, PUB_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

/* ---------- malé util ---------- */
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function writeJson(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); }

/* ---------- bezpečnost / přihlášení ---------- */
let SEC = readJson(SECRET_F, null);
if (!SEC) { SEC = { secret: crypto.randomBytes(24).toString('hex'), password: process.env.ADMIN_PASSWORD || crypto.randomBytes(5).toString('hex') }; writeJson(SECRET_F, SEC); }
if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== SEC.password) { SEC.password = process.env.ADMIN_PASSWORD; writeJson(SECRET_F, SEC); }
function token() { return crypto.createHmac('sha256', SEC.secret).update('admin-v1').digest('hex'); }
function isAuthed(req) { const c = req.headers.cookie || ''; const m = c.match(/sm_auth=([a-f0-9]+)/); return m && m[1] === token(); }

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
    const fromEmail = (process.env.RESEND_FROM || 'onboarding@resend.dev').trim();
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
  const s = readJson(STATE_F, { categories: [], employees: [], directives: [] });
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

/* ============================================================
   HTTP
   ============================================================ */
function send(res, code, obj, headers) { const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}); res.writeHead(code, h); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve, reject) => { let d = ''; req.on('data', c => { d += c; if (d.length > 12e6) req.destroy(); }); req.on('end', () => resolve(d)); req.on('error', reject); }); }
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderTpl(t, v) { return (t || '').replace(/\{(jmeno|smernice|odkaz)\}/g, (m, k) => (v[k] != null ? v[k] : m)); }
function toHtml(text, link) { let h = esc(text).replace(/\n/g, '<br>'); if (link) { const s = esc(link); h = h.split(s).join('<a href="' + s + '" style="color:#1f5d3f">' + s + '</a>') + '<div style="margin-top:18px"><a href="' + s + '" style="display:inline-block;background:#1f5d3f;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold">Otevřít a potvrdit seznámení</a></div>'; } return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1c1d1a;line-height:1.55">' + h + '</div>'; }
function baseUrl(req) { return (CFG.publicUrl || (((req.headers['x-forwarded-proto'] || 'http')) + '://' + req.headers.host)).replace(/\/$/, ''); }

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true); const p = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });

  // chráněné cesty (správa)
  const PROTECTED = ['/api/state', '/api/send', '/api/publish', '/api/test', '/api/config'];
  if (PROTECTED.indexOf(p) >= 0 && !isAuthed(req)) return send(res, 401, { error: 'Nepřihlášeno.' });

  try {
    if (p === '/' || p === '/index.html') {
      if (!fs.existsSync(APP_FILE)) return send(res, 404, '<h1>Chybí seznameni-se-smernicemi.html</h1>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 200, fs.readFileSync(APP_FILE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      if ((b.password || '') === SEC.password) { const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''; return send(res, 200, { ok: true }, { 'Set-Cookie': 'sm_auth=' + token() + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000' + secure }); }
      return send(res, 401, { error: 'Nesprávné heslo.' });
    }
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, getState());
    if (p === '/api/state' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); writeJson(STATE_F, { categories: b.categories || [], employees: b.employees || [], directives: b.directives || [] }); return send(res, 200, { ok: true }); }
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, configStatus());
    if (p === '/api/config' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); writeConfig({ host: (b.host || '').trim(), port: Number(b.port) || 587, secure: !!b.secure, user: (b.user || '').trim(), pass: b.pass, fromName: (b.fromName || '').trim() }); return send(res, 200, { ok: true, status: configStatus() }); }
    if (p === '/api/test' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      if (!process.env.RESEND_API_KEY && (!CFG.host || !CFG.user)) return send(res, 400, { error: 'Pošta není nastavená.' });
      try { await deliver({ to: (b.to || CFG.user).trim(), fromAddr: CFG.user, fromName: CFG.fromName, subject: 'Zkušební e-mail – Seznámení se směrnicemi', text: 'Toto je zkušební e-mail. Pokud jste ho dostali, odesílání funguje.', html: toHtml('Toto je zkušební e-mail.\nPokud jste ho dostali, odesílání funguje.') }); return send(res, 200, { ok: true }); }
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
      async function worker() { while (queue.length) { const r = queue.shift(); const vars = { jmeno: ((r.name || '').split(' ')[0] || r.name || ''), smernice: b.dirTitle || '', odkaz: r.link || '' }; const subject = renderTpl(b.subject, vars), text = renderTpl(b.body, vars); try { await deliver({ to: r.email, fromAddr: CFG.user, fromName: CFG.fromName, subject, text, html: toHtml(text, r.link) }); results.push({ email: r.email, ok: true }); } catch (e) { results.push({ email: r.email, ok: false, error: e.message }); } if (useResend) await sleep(550); } }
      await Promise.all(Array.from({ length: useResend ? 1 : Math.min(3, recipients.length || 1) }, worker));
      return send(res, 200, { results });
    }
    // veřejné cesty
    if (p.indexOf('/s/') === 0) { const id = p.slice(3).replace(/[^a-z0-9]/gi, ''); const f = path.join(PUB_DIR, id + '.html'); if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' }); return send(res, 404, '<h1>Směrnice nenalezena</h1>', { 'Content-Type': 'text/html; charset=utf-8' }); }
    if (p === '/api/ack' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (!b.dirId || !b.email) return send(res, 400, { error: 'Chybí data.' }); recordAck(b); return send(res, 200, { ok: true }, { 'Access-Control-Allow-Origin': '*' }); }
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
    console.log('====================================================');
    if (!CFG.host) console.log(' i Poštu nastavíte v aplikaci: záložka Nastavení.');
  });
}
module.exports = { smtpSend, loadConfig, getState };

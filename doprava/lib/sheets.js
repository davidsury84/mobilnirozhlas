'use strict';
// Čtení Google Sheets přes service account (jen čtení).
// Vyžaduje env: GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY (PEM; \n → nové řádky).
// Tabulky je nutné service accountu nasdílet (role Prohlížející).

const https = require('https');
const crypto = require('crypto');

function saEmail() { return process.env.GOOGLE_SA_CLIENT_EMAIL || ''; }
function saKey() { return (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'); }
function configured() { return !!(saEmail() && saKey()); }

function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function httpsJson(method, host, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, host, path, headers }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j; try { j = JSON.parse(d); } catch { j = { raw: d }; }
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + (j.error && (j.error.message || j.error) || d.slice(0, 160))));
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Časový limit spojení.')));
    if (body) req.write(body);
    req.end();
  });
}

// Access token přes podepsaný JWT (RS256) — cache ~50 minut.
let _tok = { val: '', exp: 0 };
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_tok.val && now < _tok.exp - 120) return _tok.val;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: saEmail(), scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256'); signer.update(header + '.' + claim);
  const sig = signer.sign(saKey()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(header + '.' + claim + '.' + sig);
  const j = await httpsJson('POST', 'oauth2.googleapis.com', '/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, body: form });
  if (!j.access_token) throw new Error('Google nevrátil access_token.');
  _tok = { val: j.access_token, exp: now + (j.expires_in || 3600) };
  return _tok.val;
}

// Vrátí hodnoty prvního listu tabulky jako pole řádků (formátované řetězce, jak je vidí uživatel).
async function readValues(spreadsheetId, range) {
  const tok = await accessToken();
  const r = encodeURIComponent(range || 'A1:Z300');
  const j = await httpsJson('GET', 'sheets.googleapis.com', `/v4/spreadsheets/${spreadsheetId}/values/${r}?valueRenderOption=FORMATTED_VALUE`, { headers: { Authorization: 'Bearer ' + tok } });
  return j.values || [];
}

module.exports = { configured, saEmail, readValues };

'use strict';
// Zápis (append) do Google Sheets přes service account.
// Vyžaduje env: GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY (PEM; \n → nové řádky).
// Cílovou tabulku je nutné service accountu nasdílet jako EDITORA (ne jen Prohlížející)
// a v Google Cloud povolit Google Sheets API.
// ID tabulky a název listu se předávají voláním (z nastavení modulu v intranetu),
// s fallbackem na env REKLAMACE_SHEET_ID / REKLAMACE_SHEET_TAB.

const https = require('https');
const crypto = require('crypto');

function saEmail() { return process.env.GOOGLE_SA_CLIENT_EMAIL || ''; }
function saKey() { return (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'); }
function envSheetId() { return process.env.REKLAMACE_SHEET_ID || ''; }
function envSheetTab() { return process.env.REKLAMACE_SHEET_TAB || ''; }
// Service account je připraven (má identitu i klíč). Samotné ID tabulky řeší volající.
function saReady() { return !!(saEmail() && saKey()); }
// Zpětná kompatibilita: „nakonfigurováno" = SA + nějaké ID z env.
function configured() { return !!(saReady() && envSheetId()); }

function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function httpsJson(method, host, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, host, path, headers }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j; try { j = JSON.parse(d); } catch { j = { raw: d }; }
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + ((j.error && (j.error.message || j.error)) || d.slice(0, 200))));
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Časový limit spojení s Google Sheets.')));
    if (body) req.write(body);
    req.end();
  });
}

// Access token přes podepsaný JWT (RS256). Scope „spreadsheets" (čtení i zápis). Cache ~50 min.
let _tok = { val: '', exp: 0 };
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_tok.val && now < _tok.exp - 120) return _tok.val;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: saEmail(), scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256'); signer.update(header + '.' + claim);
  const sig = signer.sign(saKey()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(header + '.' + claim + '.' + sig);
  const j = await httpsJson('POST', 'oauth2.googleapis.com', '/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, body: form });
  if (!j.access_token) throw new Error('Google nevrátil access_token.');
  _tok = { val: j.access_token, exp: now + (j.expires_in || 3600) };
  return _tok.val;
}

function rangeA1(tab) { const t = String(tab || 'Reklamace').replace(/'/g, "''"); return "'" + t + "'!A1"; }

function resolveId(spreadsheetId) { return String(spreadsheetId || envSheetId() || '').trim(); }
function resolveTab(tab) { return String(tab || envSheetTab() || 'Reklamace').trim(); }

// Zajistí hlavičku (řádek 1). Když je list prázdný, zapíše zadané názvy sloupců.
async function ensureHeader(spreadsheetId, tab, header) {
  const id = resolveId(spreadsheetId); tab = resolveTab(tab);
  const tok = await accessToken();
  const r = encodeURIComponent("'" + tab.replace(/'/g, "''") + "'!A1:A1");
  let first = [];
  try {
    const j = await httpsJson('GET', 'sheets.googleapis.com', `/v4/spreadsheets/${id}/values/${r}`, { headers: { Authorization: 'Bearer ' + tok } });
    first = j.values || [];
  } catch (_) { /* list nemusí existovat – append ho případně nezaloží; hlavičku řeší admin */ }
  if (first.length && first[0] && first[0][0]) return false; // hlavička už je
  const body = JSON.stringify({ values: [header] });
  await httpsJson('PUT', 'sheets.googleapis.com',
    `/v4/spreadsheets/${id}/values/${encodeURIComponent(rangeA1(tab))}?valueInputOption=USER_ENTERED`,
    { headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
  return true;
}

// Připojí jeden řádek na konec listu. `row` = pole hodnot (řetězce/čísla).
async function appendRow(spreadsheetId, tab, row, header) {
  if (!saReady()) throw new Error('Service account není nastaven (chybí GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY).');
  const id = resolveId(spreadsheetId); tab = resolveTab(tab);
  if (!id) throw new Error('Není zadané ID Google tabulky (doplňte v Nastavení modulu).');
  if (header) { try { await ensureHeader(id, tab, header); } catch (_) {} }
  const tok = await accessToken();
  const range = encodeURIComponent(rangeA1(tab));
  const body = JSON.stringify({ values: [row] });
  const j = await httpsJson('POST', 'sheets.googleapis.com',
    `/v4/spreadsheets/${id}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
  return j.updates || {};
}

module.exports = { configured, saReady, saEmail, envSheetId, envSheetTab, appendRow, ensureHeader };

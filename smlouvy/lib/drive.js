'use strict';
// Čtení složky na Google Disku přes service account (jen čtení).
// Vyžaduje env: GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY (PEM; \n → nové řádky).
// Složku je nutné service accountu nasdílet (role Prohlížející).

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
    req.setTimeout(10000, () => req.destroy(new Error('Časový limit spojení.')));
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
  const claim = b64url(JSON.stringify({ iss: saEmail(), scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256'); signer.update(header + '.' + claim);
  const sig = signer.sign(saKey()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(header + '.' + claim + '.' + sig);
  const j = await httpsJson('POST', 'oauth2.googleapis.com', '/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, body: form });
  if (!j.access_token) throw new Error('Google nevrátil access_token.');
  _tok = { val: j.access_token, exp: now + (j.expires_in || 3600) };
  return _tok.val;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function listOne(tok, folderId) {
  const out = []; let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,webViewLink,createdTime)');
    const path = `/drive/v3/files?q=${q}&fields=${fields}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true` + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const j = await httpsJson('GET', 'www.googleapis.com', path, { headers: { Authorization: 'Bearer ' + tok } });
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Vypíše soubory ve složce VČETNĚ podsložek (do hloubky 3). U každého souboru přidá
// `folder` = relativní cesta podsložek (např. "Dodavatelské/2026"; kořen = '').
// Vrací {id,name,mimeType,webViewLink,createdTime,folder}.
async function listFolder(folderId) {
  const tok = await accessToken();
  const files = [];
  async function walk(id, cesta, depth) {
    const items = await listOne(tok, id);
    for (const f of items) {
      if (f.mimeType === FOLDER_MIME) { if (depth < 3) await walk(f.id, cesta ? cesta + '/' + f.name : f.name, depth + 1); }
      else files.push({ ...f, folder: cesta });
    }
  }
  await walk(folderId, '', 0);
  return files;
}

// Binární stažení obsahu souboru (pro AI extrakci). Vrací Buffer.
function httpsBuffer(method, host, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, host, path, headers }, (res) => {
      if (res.statusCode >= 400) {
        let d = ''; res.on('data', (c) => (d += c));
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ': ' + d.slice(0, 160))));
        return;
      }
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Časový limit stahování souboru.')));
    req.end();
  });
}

// Stáhne soubor z Disku a vrátí { base64, bytes }. Nad maxBytes vyhodí chybu.
async function downloadFileBase64(fileId, maxBytes = 15 * 1024 * 1024) {
  const tok = await accessToken();
  const buf = await httpsBuffer('GET', 'www.googleapis.com',
    `/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { Authorization: 'Bearer ' + tok });
  if (buf.length > maxBytes) throw new Error('Soubor je příliš velký (' + Math.round(buf.length / 1048576) + ' MB) pro AI extrakci.');
  return { base64: buf.toString('base64'), bytes: buf.length };
}

module.exports = { configured, listFolder, downloadFileBase64, saEmail };

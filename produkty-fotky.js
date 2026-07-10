'use strict';
// Fotky nových produktů z Google Disku (jen čtení, přes service account) — pro widget „Fotka týdne".
// Env:
//   GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY  (stejné jako u ostatních Google modulů; PEM, \n → nové řádky)
//   PRODUKTY_DRIVE_FOLDER_ID                        (ID složky na Disku s fotkami produktů)
// Složku je nutné service accountu nasdílet (role Prohlížející). Bez konfigurace se widget chová jako dřív (statická fotka).

const https = require('https');
const crypto = require('crypto');

function saEmail() { return process.env.GOOGLE_SA_CLIENT_EMAIL || ''; }
function saKey() { return (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'); }
function folderId() { return (process.env.PRODUKTY_DRIVE_FOLDER_ID || '').trim(); }
function configured() { return !!(saEmail() && saKey() && folderId()); }

function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function httpsReq(method, host, reqPath, { headers = {}, body = null, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({ method, host, path: reqPath, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + buf.toString('utf8').slice(0, 160)));
        resolve(binary ? { buf, ct: res.headers['content-type'] } : (() => { try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { return {}; } })());
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('Časový limit spojení s Google.')));
    if (body) r.write(body);
    r.end();
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
  const j = await httpsReq('POST', 'oauth2.googleapis.com', '/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, body: form });
  if (!j.access_token) throw new Error('Google nevrátil access_token.');
  _tok = { val: j.access_token, exp: now + (j.expires_in || 3600) };
  return _tok.val;
}

// Seznam obrázků ve složce (rekurzivně do hloubky 2), nejnovější první. Cache ~10 minut.
let _cache = { ts: 0, list: [] };
async function list() {
  if (!configured()) return [];
  const now = Date.now();
  if (_cache.ts && now - _cache.ts < 600000) return _cache.list;
  const tok = await accessToken();
  const out = [];
  async function walk(id, depth) {
    let pageToken = '';
    do {
      const q = encodeURIComponent("'" + id + "' in parents and trashed=false");
      const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime)');
      const reqPath = '/drive/v3/files?q=' + q + '&fields=' + fields + '&pageSize=200&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const j = await httpsReq('GET', 'www.googleapis.com', reqPath, { headers: { Authorization: 'Bearer ' + tok } });
      for (const f of (j.files || [])) {
        if (f.mimeType === 'application/vnd.google-apps.folder') { if (depth < 2) await walk(f.id, depth + 1); }
        else if (/^image\//.test(f.mimeType || '')) out.push({ id: f.id, name: f.name, mime: f.mimeType, modified: f.modifiedTime || '' });
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken);
  }
  await walk(folderId(), 0);
  _cache = { ts: now, list: out };
  return out;
}

// Stažení bajtů obrázku — jen pro soubory, které jsou v povolené složce (proti otevřenému proxy).
async function media(fileId) {
  const items = await list();
  if (!items.some((x) => x.id === fileId)) throw new Error('Soubor není v povolené složce produktů.');
  const tok = await accessToken();
  return httpsReq('GET', 'www.googleapis.com', '/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + tok }, binary: true });
}

module.exports = { configured, list, media, folderId, saEmail };

'use strict';
// Čtečka strojově čitelného registru lhůt z LLM-wiki (wiki/registry/terminy.md).
// Zdroj = WIKI_TERMINY_URL: buď https(s) (typicky raw.githubusercontent.com), nebo lokální cesta/file://.
// Formát řádku (dle WIKI_SCHEMA §5.1):
//   | id | domena | subjekt | popis | termin(YYYY-MM-DD) | perioda | odpovedny | stav | zdroj |

const https = require('https');
const http = require('http');
const fs = require('fs');

let _cache = { at: 0, rows: [], src: '' };
const TTL_MS = 30 * 60 * 1000; // 30 min

function fetchText(src, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (!src) return resolve('');
    if (/^https?:\/\//i.test(src)) {
      if (redirects > 4) return reject(new Error('Příliš mnoho přesměrování.'));
      const mod = src.toLowerCase().startsWith('https') ? https : http;
      const req = mod.get(src, { headers: { 'User-Agent': 'elko-intranet', 'Accept': 'text/plain' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return fetchText(new URL(res.headers.location, src).toString(), redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('Časový limit spojení.')));
    } else {
      fs.readFile(src.replace(/^file:\/\//, ''), 'utf8', (e, d) => (e ? reject(e) : resolve(d)));
    }
  });
}

// Rozparsuje markdown tabulku na pole řádků. Ignoruje hlavičku, oddělovač a nekompletní řádky.
function parse(md) {
  const out = [];
  for (const ln of String(md || '').split(/\r?\n/)) {
    const s = ln.trim();
    if (!s.startsWith('|')) continue;
    const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 9) continue;
    const [id, domena, subjekt, popis, termin, perioda, odpovedny, stav, zdroj] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(termin)) continue; // jen řádky s reálným datem (přeskočí hlavičku/oddělovač)
    out.push({ id, domena, subjekt, popis, termin, perioda, odpovedny, stav: (stav || '').toLowerCase(), zdroj });
  }
  return out;
}

// Vrátí řádky (s cache). force=true obejde cache. Při chybě vrátí poslední cache, jinak vyhodí.
async function nacti(src, { force = false } = {}) {
  const now = Date.now();
  if (!force && _cache.src === src && _cache.rows.length && (now - _cache.at) < TTL_MS) return _cache.rows;
  try {
    const rows = parse(await fetchText(src));
    _cache = { at: now, rows, src };
    return rows;
  } catch (e) {
    if (_cache.src === src && _cache.rows.length) return _cache.rows; // raději stará data než nic
    throw e;
  }
}

module.exports = { nacti, parse, fetchText };

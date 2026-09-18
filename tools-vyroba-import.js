// Spuštění importů modulu Výroba Popelnice na produkci bez přihlášení v prohlížeči.
// Ověření: Bearer = SSO_SHARED_SECRET (tajemství se nikdy nevypisuje).
// Spouštět: railway run --service mobilnirozhlas node tools-vyroba-import.js <akce> [--force] [--rok-od=2026]
//   akce: stav | sheet | drive | xlsx <soubor.xlsx> | pdf <soubor.pdf>…
const fs = require('fs');
const SECRET = (process.env.SSO_SHARED_SECRET || '').trim();
const BASE = (process.env.VYROBA_IMPORT_URL || process.env.PUBLIC_URL || 'https://intranet.elkoplast.cz').replace(/\/$/, '');
if (!SECRET) { console.error('Chybí SSO_SHARED_SECRET v env — spusť přes `railway run --service mobilnirozhlas`.'); process.exit(1); }
const args = process.argv.slice(2); const akce = args[0];
if (!akce) { console.error('Použití: node tools-vyroba-import.js stav | sheet [ostatni|vse] | drive [--force] [--rok-od=RRRR] | xlsx <soubor> | pdf <soubor>…'); process.exit(1); }
const body = { akce };
if (akce === 'sheet') body.list = args[1] || 'boxy';
if (akce === 'drive') { body.force = args.includes('--force'); const r = args.find(a => a.startsWith('--rok-od=')); if (r) body.rokOd = Number(r.split('=')[1]); }
if (akce === 'xlsx') { if (!args[1]) { console.error('Chybí soubor.'); process.exit(1); } body.base64 = fs.readFileSync(args[1]).toString('base64'); body.nazev = args[1]; }
if (akce === 'text') { if (!args[1]) { console.error('Chybí JSON se seznamem dokumentů.'); process.exit(1); } body.dokumenty = JSON.parse(fs.readFileSync(args[1], 'utf8')); }
if (akce === 'pdf') { body.soubory = args.slice(1).filter(a => !a.startsWith('--')).map(f => ({ nazev: require('path').basename(f), base64: fs.readFileSync(f).toString('base64') })); }
(async () => {
  const res = await fetch(BASE + '/api/vyroba/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SECRET }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.chyba) { console.error('HTTP', res.status, j.chyba || j); process.exit(1); }
  console.log(JSON.stringify(j, null, 1));
})().catch(e => { console.error('Chyba:', e.message); process.exit(1); });

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
if (akce === 'plan') body.archiv = args.includes('--archiv');
if (akce === 'smazat') { body.ids = args.slice(1).filter(a => !a.startsWith('--')); body.osirele = args.includes('--osirele'); }
if (akce === 'text') { if (!args[1]) { console.error('Chybí JSON se seznamem dokumentů.'); process.exit(1); } body.dokumenty = JSON.parse(fs.readFileSync(args[1], 'utf8')); }
if (akce === 'pdf') { body.soubory = args.slice(1).filter(a => !a.startsWith('--')).map(f => ({ nazev: require('path').basename(f), base64: fs.readFileSync(f).toString('base64') })); }
const call = async (b) => { const res = await fetch(BASE + '/api/vyroba/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SECRET }, body: JSON.stringify(b) }); const j = await res.json().catch(() => ({})); if (!res.ok || j.chyba) { throw new Error('HTTP ' + res.status + ' ' + (j.chyba || JSON.stringify(j))); } return j; };
(async () => {
  const j = await call(body);
  if (akce === 'drive' && j.bezi) {
    // import z Disku běží na serveru na pozadí → sledovat průběh
    for (;;) {
      await new Promise(r => setTimeout(r, 8000));
      const s = await call({ akce: 'drive', stav: true }); const job = s.job || {};
      process.stdout.write((job.hotovo ? 'HOTOVO ' : 'běží… ') + (job.stat ? job.stat.slozek : 0) + '/' + (job.celkemSlozek || '?') + ' složek · ' + (job.faze || '') + '\n');
      if (!s.bezi) { console.log(JSON.stringify(job, null, 1)); break; }
    }
    return;
  }
  console.log(JSON.stringify(j, null, 1));
})().catch(e => { console.error('Chyba:', e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * Lokální náhled SMI aplikace (modul E-shop) BEZ SSO a bez produkčního serveru.
 *
 * Namountuje skutečný modul nakup-report s falešným hostem (každý je admin, pošta se
 * neodesílá) nad SAMOSTATNÝM datovým adresářem, takže se nesahá na produkční volume.
 * ERP snímky a bilance si stáhne z Disku — proto spouštět s Railway proměnnými:
 *
 *   railway run --service mobilnirozhlas node tools-smi-preview.js
 *
 * (railway run sice nastaví DATA_DIR=/data, ale tenhle skript ho záměrně ignoruje.)
 * Otevři http://localhost:3378 — v .claude/launch.json je konfigurace „smi-preview".
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = __dirname, PORT = +process.env.SMI_PREVIEW_PORT || 3378;
const DATA = process.env.SMI_PREVIEW_DATA || path.join(os.tmpdir(), 'smi-preview-data');
fs.mkdirSync(DATA, { recursive: true });
process.env.MAIL_DRY_RUN = '1';

function send(res, code, obj, headers) { const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}); res.writeHead(code, h); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve, reject) => { let d = ''; req.on('data', c => { d += c; if (d.length > 12e6) req.destroy(); }); req.on('end', () => resolve(d)); req.on('error', reject); }); }

const host = {
  reportDisabled: () => true,                       // žádné rozesílky
  send, readBody,
  deliver: async () => ({ ok: true, dryRun: true }), // pošta = no-op
  isAdmin: () => true,
  empSession: () => ({ jmeno: 'Náhled (lokálně)', email: 'nahled@local' }),
  employeeModules: () => ['eshop', 'nakupci'],
  dataDir: DATA,
  mailFrom: { user: '', name: 'SMI náhled', publicUrl: '' },
};
const mod = require('./nakup-report').mount(host);

http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    if (p === '/' || p === '/smi-app') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(path.join(ROOT, 'SMI_aplikace.html'))); }
    if (p === '/api/version') return send(res, 200, { commit: 'preview', dataDir: DATA });
    if (p === '/api/pozadavky/me') return send(res, 200, { ok: true, buyerList: [] });
    if (await mod.handle(req, res)) return;
    send(res, 404, { error: 'v náhledu není: ' + p });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log('[smi-preview] http://localhost:' + PORT + '  data: ' + DATA));

// Data: stáhnout ERP snímky z Disku a dopočítat bilanci (běží na pozadí, appka zatím jede)
(async () => {
  try { const r = await mod.sync(true); console.log('[smi-preview] sync:', JSON.stringify(r)); } catch (e) { console.log('[smi-preview] sync selhal:', e.message); }
  try { await mod.tick(); } catch (e) { console.log('[smi-preview] tick:', e.message); }
  console.log('[smi-preview] data připravena');
})();

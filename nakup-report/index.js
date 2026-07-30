// Modul „Týdenní reporty nákupu" — dva pravidelné e-maily z dat SMI (obrat plasty):
//   A) ZLEVNĚNÍ / mrtvé zásoby — co zlevnit (stárnoucí/mrtvá/přeskladněná zásoba)
//   B) NÁKUP — co objednat (sezónní ROP od aktuálního měsíce)
// Příjemci jsou editovatelní (config v data/nakup-report.json). Plánováno týdně (pojistka 1×/ISO-týden).
// Data čte z kořenového smi-nakup-data.json (generováno při aktualizaci obrat plasty; data/ je gitignored).
const fs = require('fs');
const path = require('path');
const urlLib = require('url');

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = n => Math.round(+n || 0).toLocaleString('cs-CZ');
const kc = n => fmt(n) + ' Kč';

function mount(host) {
  const CFG_F = path.join(host.dataDir || __dirname, 'nakup-report.json');          // config (writable)
  const STATE_F = path.join(host.dataDir || __dirname, 'nakup-report-state.json');  // stav odeslání (writable)
  const SRC_F = path.join(__dirname, '..', 'smi-nakup-data.json');                  // data SMI (commitnuto v kořeni)

  const DEF_MD = ['michaela.lizancova@elkoplast.cz', 'jan.benicek@elkoplast.cz'];
  const DEF_PU = ['hana.faltynkova@elkoplast.cz', 'david.sury@elkoplast.cz'];

  const json = (res, code, obj) => host.send(res, code, obj, { 'Cache-Control': 'no-store' });
  const htmlOut = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  // ---------- config ----------
  function loadCfg() {
    let c = {}; try { c = JSON.parse(fs.readFileSync(CFG_F, 'utf8')) || {}; } catch (_) {}
    return {
      markdownTo: Array.isArray(c.markdownTo) ? c.markdownTo : DEF_MD.slice(),
      purchaseTo: Array.isArray(c.purchaseTo) ? c.purchaseTo : DEF_PU.slice(),
      enabled: c.enabled !== undefined ? !!c.enabled : false,   // bezpečně vypnuto — zapne správce po náhledu
      weekday: (c.weekday >= 0 && c.weekday <= 6) ? c.weekday : 1, // 1 = pondělí
      // parametry modelu (výchozí = jako v appce)
      lead: +c.lead || 30, slow: +c.slow || 4, aging: +c.aging || 7, dead: +c.dead || 10,
      covslow: +c.covslow || 12, covaging: +c.covaging || 24, covdead: +c.covdead || 48,
      d1: c.d1 != null ? +c.d1 : 0.15, d2: c.d2 != null ? +c.d2 : 0.25,
      cover: +c.cover || 2, Z: +c.Z || 1.65, MOQ: +c.MOQ || 1, topN: +c.topN || 40
    };
  }
  function saveCfg(c) { try { fs.writeFileSync(CFG_F, JSON.stringify(c, null, 2)); } catch (e) { console.error('[nakup-report] zápis config:', e.message); } }
  const loadData = () => { try { return JSON.parse(fs.readFileSync(SRC_F, 'utf8')); } catch (_) { return { rows: [], period: '' }; } };
  const cleanEmails = a => (Array.isArray(a) ? a : String(a || '').split(/[;,\n]/)).map(x => String(x).trim().toLowerCase()).filter(x => /@/.test(x));

  // ---------- výpočet (port klasifikace + markdown + nákup z klientské appky) ----------
  function analyze(cfg) {
    const data = loadData(), rows = data.rows || [], m0 = new Date().getMonth();
    const sd = (sales, months) => { let s = 0; for (let k = 0; k < Math.ceil(months); k++) { const fr = Math.min(1, months - k); s += (sales[(m0 + k) % 12] || 0) * fr; } return s; };
    const items = rows.map(r => {
      const sales = (r.sales || []).map(x => +x || 0);
      const D = sales.reduce((s, x) => s + x, 0), avgM = D / 12;
      let gap = 0, lastMo = 0;
      for (let k = 0; k < 12; k++) { const ci = ((m0 - k) % 12 + 12) % 12; if (sales[ci] > 0) { lastMo = ci + 1; break; } gap++; }
      const monthsNoSale = lastMo === 0 ? 12 : gap;
      const AZ = +r.AZ || 0, nd = /náhradní díly/i.test(r.name || '');
      const cover = AZ <= 0 ? 0 : (avgM > 0 ? AZ / avgM : Infinity);
      const sevR = monthsNoSale >= cfg.dead ? 3 : monthsNoSale >= cfg.aging ? 2 : monthsNoSale >= cfg.slow ? 1 : 0;
      const sevC = cover >= cfg.covdead ? 3 : cover >= cfg.covaging ? 2 : cover >= cfg.covslow ? 1 : 0;
      const sev = Math.max(sevR, sevC);
      const cat = AZ <= 0 ? 'Není skladem' : ['Zdravá obrátka', 'Pomalá obrátka', 'Stárnoucí zásoba', 'Mrtvá zásoba'][sev];
      const disc = (AZ <= 0 || nd) ? 0 : (sev >= 2 ? cfg.d2 : sev >= 1 ? cfg.d1 : 0);
      const unit = (r.BB && r.BA) ? r.BB / r.BA : 0, tied = +r.BB || 0;
      const overBy = sevC > sevR ? 'krytí' : 'obrátka';
      // nákup — sezónní ROP od aktuálního měsíce
      const Lm = cfg.lead / 30, coverM = Math.max(0.5, cfg.cover), windowM = Lm + coverM;
      const leadDem = sd(sales, Lm), windowDem = sd(sales, windowM);
      const rop = Math.round(leadDem + cfg.Z * Math.sqrt(Math.max(0, leadDem)));
      const target = Math.round(windowDem + cfg.Z * Math.sqrt(Math.max(0, windowDem)));
      let rec = 0, status = 'OK';
      if (D <= 0) status = 'Nenakupovat';
      else if (windowDem < 0.5) status = 'Mimo sezónu';
      else if (AZ <= rop) { rec = Math.max(cfg.MOQ, Math.round(target - AZ)); status = 'Objednat teď'; }
      const orderVal = unit > 0 ? unit * rec : 0;
      const siCur = avgM > 0 ? sales[m0] / avgM : 0;
      return { sk: r.sk, ident: r.ident, name: r.name, cat, sev, disc, monthsNoSale, cover, AZ, tied, unit, D, rec, status, orderVal, siCur, overBy };
    });
    return { items, period: data.period || '', periodInfo: data.periodInfo || '', generated: data.generated || '' };
  }

  // ---------- e-mailové sestavy ----------
  const coverTxt = c => !isFinite(c) ? 'bez prodeje' : c >= 24 ? (c / 12).toFixed(c >= 120 ? 0 : 1) + ' let' : Math.round(c) + ' měs.';
  const wrap = (title, intro, bodyHtml, period) =>
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#1c1d1a;line-height:1.55;max-width:860px">' +
    '<h2 style="margin:0 0 4px">' + esc(title) + '</h2>' +
    '<p style="color:#6b736c;margin:0 0 14px;font-size:13px">' + esc(intro) + ' · Data: ' + esc(period) + '</p>' +
    bodyHtml +
    '<hr style="border:0;border-top:1px solid #e6e9e3;margin:20px 0"><div style="font-size:12px;color:#8a938a">Automatický týdenní report · Intranet ELKOPLAST CZ → E-shop → Optimalizace nákupu. Příjemce a zapnutí spravuje správce v aplikaci.</div></div>';
  const th = t => '<th style="text-align:' + (/[⌀%KčksČ]|množ|Sklad|Krytí|Sleva|Hodnota|Doporuč|Obrátka|Prodej/.test(t) ? 'right' : 'left') + ';border-bottom:2px solid #d8dee7;padding:6px 8px;font-size:12px;color:#55605a">' + esc(t) + '</th>';
  const td = (v, r) => '<td style="text-align:' + (r ? 'right' : 'left') + ';border-bottom:1px solid #eef1ec;padding:5px 8px">' + v + '</td>';

  function buildMarkdown(cfg) {
    const a = analyze(cfg);
    let list = a.items.filter(x => x.AZ > 0 && !x.nd && x.sev >= 2 && x.disc > 0);
    list.sort((x, y) => y.tied - x.tied);
    const totTied = list.reduce((s, x) => s + x.tied, 0);
    const top = list.slice(0, cfg.topN);
    const rowsHtml = top.map(x =>
      '<tr>' + td(esc(x.name)) + td('<span style="color:#8a938a">' + esc(x.ident) + '</span>') +
      td(x.cat === 'Mrtvá zásoba' ? '<b style="color:#b23">Mrtvá</b>' : 'Stárnoucí') +
      td(fmt(x.AZ), 1) + td(coverTxt(x.cover) + (x.overBy === 'krytí' ? ' ⚠' : ''), 1) +
      td('<b>' + Math.round(x.disc * 100) + ' %</b>', 1) + td(kc(x.tied), 1) + '</tr>').join('');
    const body =
      '<div style="background:#fbeaea;border:1px solid #f0c9c9;border-radius:10px;padding:12px 14px;margin:0 0 14px">' +
      '<b>' + fmt(list.length) + '</b> položek k zlevnění · vázaný kapitál <b>' + kc(totTied) + '</b>. Doporučená sleva: pomalá ' + Math.round(cfg.d1 * 100) + ' %, stárnoucí/mrtvá ' + Math.round(cfg.d2 * 100) + ' %. „⚠" = přeskladněno (drží se roky zásoby).</div>' +
      '<table style="border-collapse:collapse;width:100%"><thead><tr>' +
      [th('Položka'), th('Identifikátor'), th('Kategorie'), th('Sklad ks'), th('Krytí'), th('Sleva'), th('Hodnota zásoby')].join('') +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      (list.length > top.length ? '<p style="color:#8a938a;font-size:12px">… zobrazeno ' + top.length + ' z ' + list.length + ' (dle vázaného kapitálu). Kompletní přehled v aplikaci.</p>' : '');
    return { subject: 'Týdenní report — co zlevnit (mrtvé/přeskladněné zásoby) · ' + a.period, html: wrap('Co zlevnit — optimalizace mrtvých zásob', 'Stárnoucí, mrtvé a přeskladněné položky seřazené dle vázaného kapitálu', body, a.period), count: list.length, totTied };
  }

  function buildPurchase(cfg) {
    const a = analyze(cfg);
    let list = a.items.filter(x => x.status === 'Objednat teď' && x.rec > 0);
    list.sort((x, y) => y.orderVal - x.orderVal || y.rec - x.rec);
    const totVal = list.reduce((s, x) => s + x.orderVal, 0), totKs = list.reduce((s, x) => s + x.rec, 0);
    const top = list.slice(0, cfg.topN);
    const rowsHtml = top.map(x =>
      '<tr>' + td(esc(x.name)) + td('<span style="color:#8a938a">' + esc(x.ident) + '</span>') +
      td(fmt(x.D), 1) + td(fmt(x.siCur, 1) + '×', 1) + td(fmt(x.AZ), 1) +
      td('<b>' + fmt(x.rec) + '</b>', 1) + td(x.orderVal ? kc(x.orderVal) : '—', 1) + '</tr>').join('');
    const body =
      '<div style="background:#e7f0fb;border:1px solid #c9dcf0;border-radius:10px;padding:12px 14px;margin:0 0 14px">' +
      '<b>' + fmt(list.length) + '</b> položek k objednání teď · celkem <b>' + fmt(totKs) + ' ks</b>' + (totVal ? ' (~' + kc(totVal) + ')' : '') + '. Objednává se štíhle na dodací lhůtu + ' + cfg.cover + ' měs. dopředu (sezónně, ne rok dopředu).</div>' +
      '<table style="border-collapse:collapse;width:100%"><thead><tr>' +
      [th('Položka'), th('Identifikátor'), th('Roční prodej'), th('Sez. index'), th('Sklad ks'), th('Objednat ks'), th('Hodnota obj.')].join('') +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      (list.length > top.length ? '<p style="color:#8a938a;font-size:12px">… zobrazeno ' + top.length + ' z ' + list.length + ' (dle hodnoty objednávky). Kompletní seznam v aplikaci.</p>' : '');
    return { subject: 'Týdenní report — co nakoupit · ' + a.period, html: wrap('Co nakoupit tento týden', 'Položky pod bodem objednání, které se prodávají v nejbližším sezónním okně', body, a.period), count: list.length, totVal, totKs };
  }

  // ---------- odeslání ----------
  async function sendReport(kind, toList, cfg) {
    const to = cleanEmails(toList);
    if (!to.length) return { ok: false, error: 'žádný příjemce' };
    const rep = kind === 'markdown' ? buildMarkdown(cfg) : buildPurchase(cfg);
    const from = (host.mailFrom && host.mailFrom.user) || '';
    const name = (host.mailFrom && host.mailFrom.name) || 'Intranet ELKOPLAST — nákup';
    try {
      await host.deliver({ to: to.join(', '), fromAddr: from, fromName: name, subject: rep.subject, text: rep.subject, html: rep.html });
      return { ok: true, to, count: rep.count };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ---------- plánovač (týdně, pojistka 1×/ISO-týden) ----------
  function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const wk = 1 + Math.round(((t - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0'); }
  async function tick() {
    try {
      const cfg = loadCfg(); if (!cfg.enabled) return;
      const now = new Date(); const wk = isoWeek(now);
      // pošli v den >= zvolený weekday, jednou za ISO-týden
      if (now.getDay() < cfg.weekday) return;
      let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
      if (st.lastWeek === wk) return;
      const rM = await sendReport('markdown', cfg.markdownTo, cfg);
      const rP = await sendReport('purchase', cfg.purchaseTo, cfg);
      st.lastWeek = wk; st.lastAt = now.toISOString(); st.markdown = rM; st.purchase = rP;
      try { fs.writeFileSync(STATE_F, JSON.stringify(st, null, 2)); } catch (_) {}
      console.log('[nakup-report] týdenní report ' + wk + ': zlevnění ' + (rM.ok ? rM.count + ' pol.' : 'CHYBA ' + rM.error) + ', nákup ' + (rP.ok ? rP.count + ' pol.' : 'CHYBA ' + rP.error));
    } catch (e) { console.error('[nakup-report] tick:', e.message); }
  }

  // ---------- router ----------
  async function handle(req, res) {
    const u = urlLib.parse(req.url, true), p = u.pathname;
    if (!p.startsWith('/api/nakup-report')) return false;
    if (!host.isAdmin(req)) { json(res, 403, { error: 'Jen pro správce.' }); return true; }

    if (p === '/api/nakup-report/config' && req.method === 'GET') {
      let st = {}; try { st = JSON.parse(fs.readFileSync(STATE_F, 'utf8')) || {}; } catch (_) {}
      const d = loadData();
      return json(res, 200, { config: loadCfg(), state: st, dataPeriod: d.period || '', dataRows: (d.rows || []).length }), true;
    }
    if (p === '/api/nakup-report/config' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) { json(res, 400, { error: 'Neplatné tělo.' }); return true; }
      const cur = loadCfg();
      const next = Object.assign({}, cur);
      if (b.markdownTo != null) next.markdownTo = cleanEmails(b.markdownTo);
      if (b.purchaseTo != null) next.purchaseTo = cleanEmails(b.purchaseTo);
      if (b.enabled != null) next.enabled = !!b.enabled;
      if (b.weekday != null && b.weekday >= 0 && b.weekday <= 6) next.weekday = +b.weekday;
      saveCfg(next);
      return json(res, 200, { ok: true, config: next }), true;
    }
    if (p === '/api/nakup-report/preview' && req.method === 'GET') {
      const cfg = loadCfg(); const kind = (u.query.type === 'purchase') ? 'purchase' : 'markdown';
      const rep = kind === 'purchase' ? buildPurchase(cfg) : buildMarkdown(cfg);
      return htmlOut(res, 200, rep.html), true;
    }
    if (p === '/api/nakup-report/send' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req) || '{}'); } catch (_) {}
      const cfg = loadCfg();
      const kind = (b.type === 'purchase') ? 'purchase' : 'markdown';
      const to = b.to ? cleanEmails(b.to) : (kind === 'markdown' ? cfg.markdownTo : cfg.purchaseTo);
      const r = await sendReport(kind, to, cfg);
      return json(res, r.ok ? 200 : 500, r), true;
    }
    json(res, 404, { error: 'Not found' }); return true;
  }

  return { handle, tick };
}

module.exports = { mount };

'use strict';
// Modul „Klientské stránky" — tvorba interaktivních stránek pro potenciální klienty.
// Zapojení v server.js:
//   const klienti = require('./klienti').mount({ send, readBody, empSession, isAdmin, employeeModules, baseUrl, dataDir, mail });
//   ...v handleru: if (await klienti.handle(req, res)) return;
// Cesty:
//   /klienti            editor stránek a přehled poptávek (za přihlášením, modul 'klienti')
//   /k/<slug>           veřejná stránka pro klienta (bez přihlášení)
//   /api/klienti/*      API editoru; POST /api/klienti/lead je veřejné (odeslání poptávky)
const path = require('path');
const fs = require('fs');
const urlLib = require('url');
const crypto = require('crypto');
const { renderStranka } = require('./stranka');

const HTML_FILE = path.join(__dirname, 'klienti.html');

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
// (rozsah v regexu výše = kombinující diakritika U+0300–U+036F)
const oriz = (s, n) => String(s == null ? '' : s).slice(0, n);

// Vyčistí uloženou stránku: ořeže délky a počty položek, dopočítá slug.
function sanitizePage(b, existing) {
  const p = existing || {};
  const arr = (a, max, fn) => (Array.isArray(a) ? a.slice(0, max).map(fn) : []);
  return {
    id: p.id, createdBy: p.createdBy || '', createdAt: p.createdAt || Date.now(),
    updatedAt: Date.now(), views: p.views || 0, lastViewAt: p.lastViewAt || null,
    nazev: oriz(b.nazev, 120) || 'Nová stránka',
    slug: slugify(b.slug || b.nazev) || ('stranka-' + crypto.randomBytes(3).toString('hex')),
    publikovano: !!b.publikovano,
    klientFirma: oriz(b.klientFirma, 120),
    barva: /^#[0-9a-f]{6}$/i.test(b.barva || '') ? b.barva : '#0a6b34',
    hero: {
      titulek: oriz(b.hero && b.hero.titulek, 160) || 'Řešení pro vaši firmu',
      podtitulek: oriz(b.hero && b.hero.podtitulek, 400),
      cta: oriz(b.hero && b.hero.cta, 60) || 'Nezávazná poptávka',
    },
    oNas: oriz(b.oNas, 3000),
    vyhody: arr(b.vyhody, 8, v => ({ titulek: oriz(v.titulek, 100), text: oriz(v.text, 400) })).filter(v => v.titulek),
    produkty: arr(b.produkty, 12, v => ({ nazev: oriz(v.nazev, 120), popis: oriz(v.popis, 500), cena: oriz(v.cena, 60) })).filter(v => v.nazev),
    faq: arr(b.faq, 10, v => ({ q: oriz(v.q, 200), a: oriz(v.a, 1000) })).filter(v => v.q),
    kontakt: {
      jmeno: oriz(b.kontakt && b.kontakt.jmeno, 100),
      email: oriz(b.kontakt && b.kontakt.email, 120).toLowerCase(),
      telefon: oriz(b.kontakt && b.kontakt.telefon, 40),
    },
  };
}

function mount(host) {
  const PAGES_F = path.join(host.dataDir, 'klient-stranky.json');
  const LEADS_F = path.join(host.dataDir, 'klient-leads.json');
  const readPages = () => { try { const j = JSON.parse(fs.readFileSync(PAGES_F, 'utf8')); return Array.isArray(j.pages) ? j.pages : []; } catch (_) { return []; } };
  const writePages = (pages) => fs.writeFileSync(PAGES_F, JSON.stringify({ pages }, null, 2), 'utf8');
  const readLeads = () => { try { const j = JSON.parse(fs.readFileSync(LEADS_F, 'utf8')); return Array.isArray(j.leads) ? j.leads : []; } catch (_) { return []; } };
  const writeLeads = (leads) => fs.writeFileSync(LEADS_F, JSON.stringify({ leads }, null, 2), 'utf8');

  const json = (res, code, obj) => host.send(res, code, obj);
  const html = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

  function maModul(req) {
    if (host.isAdmin(req)) return true;
    const e = host.empSession(req); if (!e) return false;
    try { return (host.employeeModules(e.email) || []).includes('klienti'); } catch (_) { return false; }
  }
  const jeStaff = (req) => !!(host.empSession(req) || host.isAdmin(req));

  // Poptávka dorazila → e-mail kontaktní osobě stránky (tiše přeskočí bez nastavené pošty).
  async function notifikuj(page, lead, base) {
    const to = (page.kontakt && page.kontakt.email) || page.createdBy;
    if (!to || !host.mail || !host.mail.ready()) return;
    const radky = [
      'Nová poptávka ze stránky „' + page.nazev + '" (' + base + '/k/' + page.slug + ')', '',
      'Jméno:    ' + lead.jmeno,
      lead.firma ? 'Firma:    ' + lead.firma : null,
      lead.email ? 'E-mail:   ' + lead.email : null,
      lead.telefon ? 'Telefon:  ' + lead.telefon : null,
      lead.zajem && lead.zajem.length ? 'Zájem o:  ' + lead.zajem.join(', ') : null,
      lead.objem ? 'Objem:    ' + lead.objem : null,
      lead.termin ? 'Termín:   ' + lead.termin : null,
      lead.zprava ? ('Zpráva:\n' + lead.zprava) : null, '',
      'Poptávky najdete v intranetu → Klientské stránky.',
    ].filter(x => x != null);
    try { await host.mail.posli(to, '🟢 Nová poptávka — ' + (lead.firma || lead.jmeno), radky.join('\n')); }
    catch (e) { console.warn('[klienti] notifikace se neodeslala (' + to + '): ' + e.message); }
  }

  async function handle(req, res) {
    const u = urlLib.parse(req.url, true); const p = u.pathname;
    const jeModul = p === '/klienti' || p === '/klienti/' || p.startsWith('/api/klienti');
    const jeVerejna = p.startsWith('/k/');
    if (!jeModul && !jeVerejna) return false;

    // ---- veřejná stránka pro klienta ----
    if (jeVerejna && req.method === 'GET') {
      const slug = slugify(p.slice(3));
      const pages = readPages();
      const page = pages.find(x => x.slug === slug);
      const staff = jeStaff(req);
      if (!page || (!page.publikovano && !staff)) {
        html(res, 404, '<!doctype html><meta charset="utf-8"><title>Stránka nenalezena</title><div style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center"><h1 style="font-size:22px">Stránka nenalezena</h1><p style="color:#666">Odkaz už neplatí, nebo stránka zatím nebyla zveřejněna.</p></div>');
        return true;
      }
      const nahled = !page.publikovano || u.query.nahled === '1';
      if (page.publikovano && !staff) { page.views = (page.views || 0) + 1; page.lastViewAt = Date.now(); try { writePages(pages); } catch (_) {} }
      html(res, 200, renderStranka(page, { nahled }));
      return true;
    }

    // ---- veřejné odeslání poptávky ----
    if (p === '/api/klienti/lead' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { error: 'Neplatná data.' }); return true; }
      const pages = readPages();
      const page = pages.find(x => x.slug === slugify(b.slug || ''));
      if (!page || (!page.publikovano && !jeStaff(req))) { json(res, 404, { error: 'Stránka nenalezena.' }); return true; }
      const jmeno = oriz(b.jmeno, 100).trim();
      const email = oriz(b.email, 120).trim().toLowerCase();
      const telefon = oriz(b.telefon, 40).trim();
      if (!jmeno) { json(res, 400, { error: 'Vyplňte prosím jméno.' }); return true; }
      if (!email && !telefon) { json(res, 400, { error: 'Vyplňte e-mail nebo telefon, ať se vám můžeme ozvat.' }); return true; }
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { json(res, 400, { error: 'E-mail nevypadá platně.' }); return true; }
      const lead = {
        id: 'ld' + crypto.randomBytes(6).toString('hex'), pageId: page.id, slug: page.slug, ts: Date.now(),
        jmeno, firma: oriz(b.firma, 120).trim(), email, telefon,
        zajem: (Array.isArray(b.zajem) ? b.zajem.slice(0, 12) : []).map(x => oriz(x, 120)),
        objem: oriz(b.objem, 120), termin: oriz(b.termin, 120), zprava: oriz(b.zprava, 2000),
      };
      const leads = readLeads(); leads.push(lead); writeLeads(leads);
      notifikuj(page, lead, host.baseUrl(req));   // fire-and-forget, ať klient nečeká na SMTP
      json(res, 200, { ok: true });
      return true;
    }

    // ---- vše ostatní jen pro zaměstnance s modulem ----
    if (!maModul(req)) {
      if (p.startsWith('/api/')) json(res, 403, { error: 'Nemáte přístup k modulu Klientské stránky.' });
      else html(res, 403, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:40px">K modulu Klientské stránky nemáte přístup. Přístupy přiděluje správce intranetu.</p>');
      return true;
    }

    if ((p === '/klienti' || p === '/klienti/') && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { html(res, 404, '<h1>Chybí klienti.html</h1>'); return true; }
      html(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }

    if (p === '/api/klienti/pages' && req.method === 'GET') {
      const leads = readLeads();
      const pages = readPages().map(x => Object.assign({}, x, { leadCount: leads.filter(l => l.pageId === x.id).length }));
      const e = host.empSession(req);
      json(res, 200, { pages, base: host.baseUrl(req), me: e ? e.email : '', admin: host.isAdmin(req), mailReady: !!(host.mail && host.mail.ready()) });
      return true;
    }

    if (p === '/api/klienti/pages' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) { json(res, 400, { error: 'Neplatná data.' }); return true; }
      const pages = readPages();
      let existing = b.id ? pages.find(x => x.id === b.id) : null;
      if (b.id && !existing) { json(res, 404, { error: 'Stránka nenalezena.' }); return true; }
      const page = sanitizePage(b, existing);
      if (!existing) {
        page.id = 'kp' + crypto.randomBytes(6).toString('hex');
        const e = host.empSession(req); page.createdBy = e ? e.email : '';
      }
      // slug musí být unikátní — při kolizi přidej krátký suffix
      while (pages.some(x => x.id !== page.id && x.slug === page.slug)) page.slug += '-' + crypto.randomBytes(2).toString('hex');
      if (existing) pages[pages.indexOf(existing)] = page; else pages.push(page);
      writePages(pages);
      json(res, 200, { ok: true, page });
      return true;
    }

    if (p === '/api/klienti/pages/smazat' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
      const pages = readPages();
      const page = pages.find(x => x.id === b.id);
      if (!page) { json(res, 404, { error: 'Stránka nenalezena.' }); return true; }
      const e = host.empSession(req);
      if (!host.isAdmin(req) && (!e || (page.createdBy || '').toLowerCase() !== e.email.toLowerCase())) { json(res, 403, { error: 'Smazat může jen autor nebo správce.' }); return true; }
      writePages(pages.filter(x => x.id !== b.id));
      writeLeads(readLeads().filter(l => l.pageId !== b.id));
      json(res, 200, { ok: true });
      return true;
    }

    if (p === '/api/klienti/leads' && req.method === 'GET') {
      let leads = readLeads().slice().sort((a, b2) => (b2.ts || 0) - (a.ts || 0));
      if (u.query.pageId) leads = leads.filter(l => l.pageId === u.query.pageId);
      json(res, 200, { leads });
      return true;
    }

    if (p === '/api/klienti/lead-smazat' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await host.readBody(req)); } catch (_) {}
      const leads = readLeads();
      if (!leads.some(l => l.id === b.id)) { json(res, 404, { error: 'Poptávka nenalezena.' }); return true; }
      writeLeads(leads.filter(l => l.id !== b.id));
      json(res, 200, { ok: true });
      return true;
    }

    json(res, 404, { error: 'Neznámá cesta modulu.' });
    return true;
  }

  return { handle };
}

module.exports = { mount };

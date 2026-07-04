'use strict';
// Modul „Adaptace" (onboarding nováčků) — nativní přepis aplikace Adaptlink
// do stacku intranetu. Zapojení v server.js:
//   const adaptaceMod = require('./adaptace').mount({ send, readBody, deliver,
//       empSession, isAdmin, baseUrl, employeeModules, getState,
//       dataDir: DATA_DIR, publicBaseUrl });
//   ...v handleru: if (adaptaceMod && await adaptaceMod.handle(req, res)) return;
//   ...ve startu:  adaptaceMod.tick(); setInterval(adaptaceMod.tick, 6*3600*1000);
//
// Autentizace: Google SSO intranetu (žádná hesla). Role: admin (isAdmin) spravuje
// vše; přihlášený zaměstnanec vidí/plní SVOU adaptaci; mentor potvrzuje úkoly
// u adaptací, kde je veden jako mentor.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const urlLib = require('url');

const { openDb } = require('./db');
const engine = require('./engine');
const { todayPrague } = require('./lib/datum');

const HTML_FILE = path.join(__dirname, 'adaptace.html');

function mount(host) {
  const dbFile = path.join(host.dataDir || __dirname, 'adaptace.db');
  const M = openDb(dbFile);

  const json = (res, code, obj) => host.send(res, code, obj);
  const html = (res, code, s) => host.send(res, code, s, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  async function body(req) { try { return JSON.parse(await host.readBody(req)); } catch { return {}; } }

  const emailOf = (req) => { const e = host.empSession(req); return e ? (e.email || '').toLowerCase() : null; };
  const isMentor = (email) => !!(email && M.db.prepare('SELECT 1 FROM assignment WHERE mentor_email=? LIMIT 1').get(email));

  // Seznam zaměstnanců intranetu (pro přiřazení / výběr mentora).
  function employees() {
    try {
      const s = host.getState ? host.getState() : { employees: [] };
      return (s.employees || []).map((e) => ({ email: (e.email || '').toLowerCase(), name: e.name || e.email }))
        .filter((e) => e.email).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
    } catch { return []; }
  }

  async function handle(req, res) {
    const u = urlLib.parse(req.url, true); const p = u.pathname;
    if (p !== '/adaptace' && !p.startsWith('/adaptace/') && !p.startsWith('/api/adaptace')) return false;

    // UI stránka (SSO závoru řeší server; sem se dostane jen přihlášený).
    // Magic-link `/adaptace/uvod/<hash>` je veřejný — servíruje stejné SPA (guest režim).
    if (((p === '/adaptace' || p === '/adaptace/') || /^\/adaptace\/uvod\/[a-f0-9]+$/.test(p)) && req.method === 'GET') {
      if (!fs.existsSync(HTML_FILE)) { html(res, 404, '<h1>Chybí adaptace.html</h1>'); return true; }
      html(res, 200, fs.readFileSync(HTML_FILE, 'utf8')); return true;
    }

    // ---- VEŘEJNÉ API (magic-link / import) — bez přihlášení ----
    try {
      // guest: načtení adaptace podle hashe z pozvánky
      if (p === '/api/adaptace/guest' && req.method === 'GET') {
        const a = M.assignment.byHash(u.query.hash || '');
        if (!a) { json(res, 404, { chyba: 'Neplatný odkaz.' }); return true; }
        json(res, 200, { ...a, tasks: M.progress.forAssignment(a.id) }); return true;
      }
      // guest: plnění úkolu přes hash (jen nováčkovy brány, ne mentor)
      if (p === '/api/adaptace/guest-flag' && req.method === 'POST') {
        const bd = await body(req);
        const a = M.assignment.byHash(bd.hash || '');
        if (!a) { json(res, 404, { chyba: 'Neplatný odkaz.' }); return true; }
        const row = M.progress.getById(Number(bd.progressId));
        if (!row || row.assignment_id !== a.id) { json(res, 403, { chyba: 'Úkol nepatří k této pozvánce.' }); return true; }
        if (bd.flag !== 'understood' && bd.flag !== 'acquainted') { json(res, 400, { chyba: 'Nepovolený příznak.' }); return true; }
        engine.setProgressFlag(M, row.id, bd.flag, !!bd.value, a.emp_email);
        await engine.maybeNotifyMentor(M, host.deliver, host.publicBaseUrl || host.baseUrl(req), row.id);
        json(res, 200, M.progress.getById(row.id)); return true;
      }
      // F4: import zaměstnance z externího systému (náhrada import-user-from-doolister)
      if (p === '/api/adaptace/import-user' && req.method === 'POST') {
        const tok = req.headers['x-api-token'] || u.query.api_token;
        const expected = process.env.ADAPTACE_API_TOKEN;
        if (!expected || tok !== expected) { json(res, 401, { chyba: 'Neplatný token.' }); return true; }
        const bd = await body(req);
        const email = (bd.email || '').toLowerCase();
        if (!email) { json(res, 400, { chyba: 'Chybí e-mail.' }); return true; }
        const name = [bd.firstName, bd.surname].filter(Boolean).join(' ') || bd.name || email;
        if (host.ensureEmployee) host.ensureEmployee(email, name);
        let assignment = null;
        if (bd.scenarioId) {
          assignment = engine.startAdaptation(M, {
            empEmail: email, empName: name, scenarioId: Number(bd.scenarioId),
            mentorEmail: bd.mentorEmail, startDate: bd.startDate || todayPrague(),
            inviteHash: crypto.randomBytes(16).toString('hex'),
          }, 'api:import');
          if (bd.sendEmail !== false) await engine.mailNewAssignment(host.deliver, host.publicBaseUrl || host.baseUrl(req), assignment);
        }
        json(res, 201, { ok: true, email, assignmentId: assignment ? assignment.id : null }); return true;
      }
    } catch (e) { json(res, 500, { chyba: e.message }); return true; }

    try {
      const me = emailOf(req);
      const admin = host.isAdmin(req);

      // ---- kdo jsem -------------------------------------------------
      if (p === '/api/adaptace/me' && req.method === 'GET') {
        json(res, 200, { email: me, admin, isMentor: isMentor(me) }); return true;
      }

      // ---- ZAMĚSTNANEC: moje adaptace ------------------------------
      if (p === '/api/adaptace/my' && req.method === 'GET') {
        if (!me) { json(res, 401, { chyba: 'Nepřihlášeno.' }); return true; }
        const list = M.assignment.forEmployee(me).map((a) => ({ ...a, tasks: M.progress.forAssignment(a.id) }));
        json(res, 200, list); return true;
      }

      // ---- MENTOR: moji svěřenci -----------------------------------
      if (p === '/api/adaptace/mentees' && req.method === 'GET') {
        if (!me) { json(res, 401, { chyba: 'Nepřihlášeno.' }); return true; }
        const list = M.assignment.forMentor(me).map((a) => ({ ...a, tasks: M.progress.forAssignment(a.id) }));
        json(res, 200, list); return true;
      }

      // ---- plnění úkolu (nováček i mentor) -------------------------
      if (p === '/api/adaptace/progress-flag' && req.method === 'POST') {
        const b = await body(req);
        const row = M.progress.getById(Number(b.progressId));
        if (!row) { json(res, 404, { chyba: 'Úkol nenalezen.' }); return true; }
        const flag = b.flag; const val = !!b.value;
        if (flag === 'understood' || flag === 'acquainted') {
          if (!admin && me !== row.emp_email) { json(res, 403, { chyba: 'Cizí adaptace.' }); return true; }
        } else if (flag === 'mentor_ok') {
          if (!admin && me !== row.mentor_email) { json(res, 403, { chyba: 'Nejste mentor tohoto nováčka.' }); return true; }
        } else { json(res, 400, { chyba: 'Neznámý příznak.' }); return true; }
        const updated = engine.setProgressFlag(M, row.id, flag, val, me);
        if (flag !== 'mentor_ok') await engine.maybeNotifyMentor(M, host.deliver, host.publicBaseUrl || host.baseUrl(req), row.id);
        json(res, 200, updated); return true;
      }

      // ---- DISKUZE u úkolu (nováček / mentor / admin) --------------
      if (p === '/api/adaptace/discussion' && req.method === 'GET') {
        const row = M.progress.getById(Number(u.query.progressId));
        if (!row) { json(res, 404, { chyba: 'Úkol nenalezen.' }); return true; }
        if (!admin && me !== row.emp_email && me !== row.mentor_email) { json(res, 403, { chyba: 'Nemáte přístup.' }); return true; }
        json(res, 200, M.discussion.forProgress(row.id)); return true;
      }
      if (p === '/api/adaptace/discussion' && req.method === 'POST') {
        const bd = await body(req);
        const row = M.progress.getById(Number(bd.progressId));
        if (!row) { json(res, 404, { chyba: 'Úkol nenalezen.' }); return true; }
        if (!admin && me !== row.emp_email && me !== row.mentor_email) { json(res, 403, { chyba: 'Nemáte přístup.' }); return true; }
        if (!bd.text || !bd.text.trim()) { json(res, 400, { chyba: 'Prázdný komentář.' }); return true; }
        const who = host.empSession(req) || {};
        json(res, 201, M.discussion.add({ progress_id: row.id, parent_id: bd.parentId, author_email: me, author_name: who.name, text: bd.text.trim() })); return true;
      }

      // ---- ZPRÁVY (moje schránka + potvrzení) ----------------------
      if (p === '/api/adaptace/my-messages' && req.method === 'GET') {
        if (!me) { json(res, 401, { chyba: 'Nepřihlášeno.' }); return true; }
        json(res, 200, M.message.forEmployee(me)); return true;
      }
      if (p === '/api/adaptace/message-read' && req.method === 'POST') {
        if (!me) { json(res, 401, { chyba: 'Nepřihlášeno.' }); return true; }
        const bd = await body(req);
        M.message.markRead(Number(bd.messageId), me, !!bd.understood);
        json(res, 200, { ok: true }); return true;
      }

      // ---- od sem níž jen ADMIN ------------------------------------
      if (!admin) { json(res, 403, { chyba: 'Jen správce.' }); return true; }

      // seznam zaměstnanců (pro formuláře)
      if (p === '/api/adaptace/employees' && req.method === 'GET') { json(res, 200, employees()); return true; }

      // --- scénáře (šablony) ---
      if (p === '/api/adaptace/scenarios' && req.method === 'GET') { json(res, 200, M.scenario.all()); return true; }
      if (p === '/api/adaptace/scenario' && req.method === 'GET') {
        const full = M.scenarioFull(Number(u.query.id));
        if (!full) { json(res, 404, { chyba: 'Nenalezeno.' }); return true; }
        json(res, 200, full); return true;
      }

      if (req.method === 'POST') {
        const b = await body(req);
        const by = me || 'admin';
        const id = Number(u.query.id);

        // scénář
        if (p === '/api/adaptace/scenario-create') { json(res, 201, M.scenario.create(b, by)); return true; }
        if (p === '/api/adaptace/scenario-update') { json(res, 200, M.scenario.update(id, b)); return true; }
        if (p === '/api/adaptace/scenario-delete') { M.scenario.remove(id); json(res, 200, { ok: true }); return true; }
        // fáze
        if (p === '/api/adaptace/phase-create') { json(res, 201, M.phase.create(b)); return true; }
        if (p === '/api/adaptace/phase-update') { json(res, 200, M.phase.update(id, b)); return true; }
        if (p === '/api/adaptace/phase-delete') { M.phase.remove(id); json(res, 200, { ok: true }); return true; }
        // úkol
        if (p === '/api/adaptace/task-create') { json(res, 201, M.task.create(b)); return true; }
        if (p === '/api/adaptace/task-update') { json(res, 200, M.task.update(id, b)); return true; }
        if (p === '/api/adaptace/task-delete') { M.task.remove(id); json(res, 200, { ok: true }); return true; }

        // spuštění adaptace
        if (p === '/api/adaptace/assign') {
          if (!b.empEmail || !b.scenarioId) { json(res, 400, { chyba: 'Chybí zaměstnanec nebo scénář.' }); return true; }
          const emp = employees().find((e) => e.email === (b.empEmail || '').toLowerCase());
          const a = engine.startAdaptation(M, {
            empEmail: b.empEmail, empName: (emp && emp.name) || b.empName,
            scenarioId: Number(b.scenarioId), mentorEmail: b.mentorEmail,
            startDate: b.startDate || todayPrague(),
            inviteHash: crypto.randomBytes(16).toString('hex'),
          }, by);
          if (b.sendEmail !== false) await engine.mailNewAssignment(host.deliver, host.publicBaseUrl || host.baseUrl(req), a);
          json(res, 201, a); return true;
        }
        if (p === '/api/adaptace/assignment-delete') { M.assignment.remove(id); json(res, 200, { ok: true }); return true; }

        // rozeslání zprávy (audience 'all' = všem zaměstnancům, jinak seznam e-mailů)
        if (p === '/api/adaptace/message-create') {
          if (!b.label) { json(res, 400, { chyba: 'Chybí předmět.' }); return true; }
          const recips = (b.audience === 'list' && Array.isArray(b.recipients) && b.recipients.length)
            ? b.recipients : employees().map((e) => e.email);
          const msg = M.message.create({ label: b.label, body: b.body, needs_understanding: b.needs_understanding, audience: b.audience || 'all' }, recips, by);
          if (b.sendEmail !== false) for (const em of recips) await engine.mailMessage(host.deliver, host.publicBaseUrl || host.baseUrl(req), msg, em);
          json(res, 201, { ...msg, sent: recips.length }); return true;
        }
        if (p === '/api/adaptace/message-delete') { M.message.remove(id); json(res, 200, { ok: true }); return true; }
      }

      if (p === '/api/adaptace/messages' && req.method === 'GET') { json(res, 200, M.message.all()); return true; }

      // dashboard přehled adaptací
      if (p === '/api/adaptace/assignments' && req.method === 'GET') { json(res, 200, M.assignment.listWithProgress()); return true; }
      if (p === '/api/adaptace/assignment' && req.method === 'GET') {
        const a = M.assignment.getById(Number(u.query.id));
        if (!a) { json(res, 404, { chyba: 'Nenalezeno.' }); return true; }
        json(res, 200, { ...a, tasks: M.progress.forAssignment(a.id) }); return true;
      }
    } catch (e) { json(res, 500, { chyba: e.message }); return true; }

    json(res, 404, { chyba: 'Neznámá cesta modulu Adaptace.' }); return true;
  }

  async function tick() {
    try { await engine.tick(M, { deliver: host.deliver, baseUrl: host.publicBaseUrl || '' }); }
    catch (e) { console.error('[adaptace] tick chyba:', e.message); }
  }

  return { handle, tick, _models: M };
}

module.exports = { mount };

'use strict';
// Úložiště modulu „Adaptace" (onboarding nováčků) — node:sqlite, single-file
// data/adaptace.db, bez závislostí (stejný vzor jako modul Smlouvy).
//
// Doménová hierarchie (přepis Adaptlinku, zjednodušený jednofiremní model):
//   scenario  (scénář adaptace, např. „CNC operátor")
//     └ phase   (fáze / kapitola)
//         └ task   (úkol — sloučené sub_item + sub_item_data z Adaptlinku)
//   assignment (přiřazení nováčka ke scénáři = spuštěná adaptace)
//     └ progress (plnění jednoho úkolu konkrétním nováčkem)
//
// Lidé (nováček, mentor) se klíčují E-MAILEM proti zaměstnancům intranetu
// (state.json) — žádná vlastní tabulka uživatelů, žádná hesla (řeší Google SSO).
//
// Návrhové rozhodnutí (oproti Adaptlinku): obsah i požadavky úkolu se čtou
// ŽIVĚ z tabulky `task` (join), ne snapshotem do `progress`. Úprava scénáře se
// tak promítne i do běžících adaptací. Snapshotují se jen věci, které se měnit
// nesmí: emp_email, scenario_label a spočtený deadline_date u progressu.

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scenario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  category TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS phase (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_phase_scenario ON phase(scenario_id);

CREATE TABLE IF NOT EXISTS task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id INTEGER NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  description TEXT,
  mentor_default_email TEXT,
  needs_understanding INTEGER NOT NULL DEFAULT 1,
  needs_acquaintance INTEGER NOT NULL DEFAULT 0,
  needs_mentor_ok INTEGER NOT NULL DEFAULT 0,
  deadline_days INTEGER,            -- počet dnů od startu adaptace; NULL = bez termínu
  email_employee INTEGER NOT NULL DEFAULT 0,
  email_mentor INTEGER NOT NULL DEFAULT 0,
  links_json TEXT,                  -- JSON pole [{label,url}] (videa/wiki/odkazy)
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_task_phase ON task(phase_id);

CREATE TABLE IF NOT EXISTS assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_email TEXT NOT NULL,
  emp_name TEXT,
  scenario_id INTEGER REFERENCES scenario(id) ON DELETE SET NULL,
  scenario_label TEXT,              -- snapshot názvu scénáře (kvůli historii)
  mentor_email TEXT,
  start_date TEXT NOT NULL,         -- YYYY-MM-DD
  invite_hash TEXT UNIQUE,          -- token pro magic-link pozvánku (F2)
  complete INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_assign_emp ON assignment(emp_email);
CREATE INDEX IF NOT EXISTS ix_assign_mentor ON assignment(mentor_email);

CREATE TABLE IF NOT EXISTS progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignment(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  understood INTEGER NOT NULL DEFAULT 0,
  understood_at TEXT,
  acquainted INTEGER NOT NULL DEFAULT 0,
  acquainted_at TEXT,
  mentor_ok INTEGER NOT NULL DEFAULT 0,
  mentor_ok_at TEXT,
  mentor_ok_by TEXT,
  complete INTEGER NOT NULL DEFAULT 0,
  deadline_date TEXT,               -- YYYY-MM-DD spočteno při přiřazení
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (assignment_id, task_id)
);
CREATE INDEX IF NOT EXISTS ix_progress_assign ON progress(assignment_id);

CREATE TABLE IF NOT EXISTS notification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  progress_id INTEGER NOT NULL REFERENCES progress(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- 'deadline' | 'mentor'
  komu_email TEXT,
  notify_date TEXT NOT NULL,        -- YYYY-MM-DD kdy odeslat
  sent_at TEXT,
  UNIQUE (progress_id, kind, notify_date)
);
CREATE INDEX IF NOT EXISTS ix_notif_date ON notification(notify_date, sent_at);

-- F3: zprávy (broadcast admina zaměstnancům) + potvrzení přečtení
CREATE TABLE IF NOT EXISTS message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  body TEXT,
  needs_understanding INTEGER NOT NULL DEFAULT 0,
  audience TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'list'
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS message_recipient (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  emp_email TEXT NOT NULL,
  read_at TEXT,
  understood_at TEXT,
  UNIQUE (message_id, emp_email)
);
CREATE INDEX IF NOT EXISTS ix_msgrec_emp ON message_recipient(emp_email);

-- F3: diskuze (vlákna komentářů u úkolu)
CREATE TABLE IF NOT EXISTS discussion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  progress_id INTEGER NOT NULL REFERENCES progress(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES discussion(id) ON DELETE CASCADE,
  author_email TEXT,
  author_name TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_disc_progress ON discussion(progress_id);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

function b(v) { return v ? 1 : 0; }

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  // ---- SCENÁŘE / FÁZE / ÚKOLY (šablony) ---------------------------
  const scenario = {
    all() { return db.prepare('SELECT * FROM scenario ORDER BY active DESC, label').all(); },
    getById(id) { return db.prepare('SELECT * FROM scenario WHERE id=?').get(id) || null; },
    create(d, by) {
      const info = db.prepare('INSERT INTO scenario (label,category,active,created_by) VALUES (?,?,?,?)')
        .run(d.label, d.category || null, b(d.active === undefined ? 1 : d.active), by || null);
      return scenario.getById(Number(info.lastInsertRowid));
    },
    update(id, d) {
      db.prepare("UPDATE scenario SET label=COALESCE(?,label), category=?, active=? WHERE id=?")
        .run(d.label ?? null, d.category ?? null, b(d.active === undefined ? 1 : d.active), id);
      return scenario.getById(id);
    },
    remove(id) { db.prepare('DELETE FROM scenario WHERE id=?').run(id); },
    // Počet běžících adaptací pro daný scénář (kvůli varování před smazáním).
    assignmentCount(id) { return db.prepare('SELECT COUNT(*) n FROM assignment WHERE scenario_id=?').get(id).n; },
  };

  const phase = {
    listByScenario(sid) { return db.prepare('SELECT * FROM phase WHERE scenario_id=? ORDER BY position, id').all(sid); },
    getById(id) { return db.prepare('SELECT * FROM phase WHERE id=?').get(id) || null; },
    create(d) {
      const pos = d.position ?? db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM phase WHERE scenario_id=?').get(d.scenario_id).n;
      const info = db.prepare('INSERT INTO phase (scenario_id,label,description,position) VALUES (?,?,?,?)')
        .run(d.scenario_id, d.label, d.description || null, pos);
      return phase.getById(Number(info.lastInsertRowid));
    },
    update(id, d) {
      db.prepare('UPDATE phase SET label=COALESCE(?,label), description=?, position=COALESCE(?,position) WHERE id=?')
        .run(d.label ?? null, d.description ?? null, d.position ?? null, id);
      return phase.getById(id);
    },
    remove(id) { db.prepare('DELETE FROM phase WHERE id=?').run(id); },
  };

  const TASK_COLS = ['label', 'description', 'mentor_default_email', 'needs_understanding',
    'needs_acquaintance', 'needs_mentor_ok', 'deadline_days', 'email_employee', 'email_mentor', 'links_json'];
  const BOOL_TASK = new Set(['needs_understanding', 'needs_acquaintance', 'needs_mentor_ok', 'email_employee', 'email_mentor']);
  const task = {
    listByPhase(pid) { return db.prepare('SELECT * FROM task WHERE phase_id=? ORDER BY position, id').all(pid); },
    getById(id) { return db.prepare('SELECT * FROM task WHERE id=?').get(id) || null; },
    create(d) {
      const pos = d.position ?? db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM task WHERE phase_id=?').get(d.phase_id).n;
      const info = db.prepare(`INSERT INTO task
        (phase_id,label,description,mentor_default_email,needs_understanding,needs_acquaintance,
         needs_mentor_ok,deadline_days,email_employee,email_mentor,links_json,position)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        d.phase_id, d.label, d.description || null, d.mentor_default_email || null,
        b(d.needs_understanding === undefined ? 1 : d.needs_understanding),
        b(d.needs_acquaintance), b(d.needs_mentor_ok),
        (d.deadline_days === '' || d.deadline_days == null) ? null : Number(d.deadline_days),
        b(d.email_employee), b(d.email_mentor),
        d.links_json || null, pos);
      return task.getById(Number(info.lastInsertRowid));
    },
    update(id, d) {
      const cols = TASK_COLS.filter((c) => d[c] !== undefined);
      if (!cols.length) return task.getById(id);
      const set = cols.map((c) => `${c}=?`).join(',');
      const vals = cols.map((c) => {
        if (BOOL_TASK.has(c)) return b(d[c]);
        if (c === 'deadline_days') return (d[c] === '' || d[c] == null) ? null : Number(d[c]);
        return d[c] ?? null;
      });
      db.prepare(`UPDATE task SET ${set} WHERE id=?`).run(...vals, id);
      return task.getById(id);
    },
    remove(id) { db.prepare('DELETE FROM task WHERE id=?').run(id); },
  };

  // Celý scénář s fázemi a úkoly (pro editor).
  function scenarioFull(id) {
    const s = scenario.getById(id);
    if (!s) return null;
    const phases = phase.listByScenario(id).map((ph) => ({ ...ph, tasks: task.listByPhase(ph.id) }));
    return { ...s, phases };
  }

  // ---- PŘIŘAZENÍ / PLNĚNÍ -----------------------------------------
  const assignment = {
    getById(id) { return db.prepare('SELECT * FROM assignment WHERE id=?').get(id) || null; },
    byHash(h) { return db.prepare('SELECT * FROM assignment WHERE invite_hash=?').get(h) || null; },
    forEmployee(email) { return db.prepare('SELECT * FROM assignment WHERE emp_email=? ORDER BY created_at DESC').all((email || '').toLowerCase()); },
    forMentor(email) { return db.prepare('SELECT * FROM assignment WHERE mentor_email=? ORDER BY complete, start_date').all((email || '').toLowerCase()); },
    create(d, by) {
      const info = db.prepare(`INSERT INTO assignment
        (emp_email,emp_name,scenario_id,scenario_label,mentor_email,start_date,invite_hash,created_by)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        (d.emp_email || '').toLowerCase(), d.emp_name || null, d.scenario_id,
        d.scenario_label || null, (d.mentor_email || '').toLowerCase() || null,
        d.start_date, d.invite_hash || null, by || null);
      return assignment.getById(Number(info.lastInsertRowid));
    },
    setComplete(id, done) {
      db.prepare("UPDATE assignment SET complete=?, completed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id=?")
        .run(b(done), b(done), id);
    },
    remove(id) { db.prepare('DELETE FROM assignment WHERE id=?').run(id); },
    // Přehled se spočteným procentem (dashboard).
    listWithProgress() {
      return db.prepare(`
        SELECT a.*,
          (SELECT COUNT(*) FROM progress p WHERE p.assignment_id=a.id) AS total,
          (SELECT COUNT(*) FROM progress p WHERE p.assignment_id=a.id AND p.complete=1) AS done
        FROM assignment a ORDER BY a.complete, a.start_date DESC`).all()
        .map((r) => ({ ...r, percentage: r.total ? Math.round((r.done / r.total) * 100) : 0 }));
    },
  };

  const progress = {
    // Vytvoří progress řádek pro každý úkol daného scénáře. Idempotentní přes UNIQUE.
    seedForAssignment(assignmentId, scenarioId, deadlineFor) {
      const rows = db.prepare(`SELECT t.id AS task_id, t.deadline_days
        FROM task t JOIN phase ph ON ph.id=t.phase_id WHERE ph.scenario_id=? ORDER BY ph.position, t.position`).all(scenarioId);
      const ins = db.prepare(`INSERT INTO progress (assignment_id,task_id,deadline_date)
        VALUES (?,?,?) ON CONFLICT(assignment_id,task_id) DO NOTHING`);
      for (const r of rows) {
        const dd = (r.deadline_days == null) ? null : deadlineFor(r.deadline_days);
        ins.run(assignmentId, r.task_id, dd);
      }
      return rows.length;
    },
    // Plnění nováčka: úkoly seskupené po fázích + živý obsah z task.
    forAssignment(assignmentId) {
      return db.prepare(`
        SELECT p.*, t.label, t.description, t.needs_understanding, t.needs_acquaintance,
               t.needs_mentor_ok, t.links_json, t.mentor_default_email,
               ph.id AS phase_id, ph.label AS phase_label, ph.position AS phase_pos, t.position AS task_pos
        FROM progress p
        JOIN task t ON t.id=p.task_id
        JOIN phase ph ON ph.id=t.phase_id
        WHERE p.assignment_id=?
        ORDER BY ph.position, t.position`).all(assignmentId);
    },
    getById(id) {
      return db.prepare(`SELECT p.*, t.needs_understanding, t.needs_acquaintance, t.needs_mentor_ok,
               a.emp_email, a.mentor_email, a.id AS assignment_id
        FROM progress p JOIN task t ON t.id=p.task_id JOIN assignment a ON a.id=p.assignment_id
        WHERE p.id=?`).get(id) || null;
    },
    setFlag(id, flag, val, who) {
      const now = new Date().toISOString();
      if (flag === 'understood') db.prepare('UPDATE progress SET understood=?, understood_at=? WHERE id=?').run(b(val), val ? now : null, id);
      else if (flag === 'acquainted') db.prepare('UPDATE progress SET acquainted=?, acquainted_at=? WHERE id=?').run(b(val), val ? now : null, id);
      else if (flag === 'mentor_ok') db.prepare('UPDATE progress SET mentor_ok=?, mentor_ok_at=?, mentor_ok_by=? WHERE id=?').run(b(val), val ? now : null, val ? (who || null) : null, id);
    },
    // Přepočet complete podle požadovaných bran úkolu (řeší riziko „stale percentage").
    recompute(id) {
      const r = progress.getById(id);
      if (!r) return;
      const ok = (!r.needs_understanding || r.understood)
        && (!r.needs_acquaintance || r.acquainted)
        && (!r.needs_mentor_ok || r.mentor_ok);
      db.prepare('UPDATE progress SET complete=? WHERE id=?').run(b(ok), id);
      // Dokončení celé adaptace, když jsou hotové všechny úkoly.
      const agg = db.prepare('SELECT COUNT(*) t, SUM(complete) d FROM progress WHERE assignment_id=?').get(r.assignment_id);
      assignment.setComplete(r.assignment_id, agg.t > 0 && agg.d === agg.t);
    },
    dueOn(dateStr) {
      return db.prepare(`SELECT p.*, a.emp_email, a.mentor_email, t.label
        FROM progress p JOIN assignment a ON a.id=p.assignment_id JOIN task t ON t.id=p.task_id
        WHERE p.complete=0 AND p.deadline_date=?`).all(dateStr);
    },
  };

  // ---- F3: ZPRÁVY --------------------------------------------------
  const message = {
    all() {
      return db.prepare(`SELECT m.*,
          (SELECT COUNT(*) FROM message_recipient r WHERE r.message_id=m.id) AS total,
          (SELECT COUNT(*) FROM message_recipient r WHERE r.message_id=m.id AND r.read_at IS NOT NULL) AS read_cnt
        FROM message m ORDER BY m.created_at DESC`).all();
    },
    create(d, recipients, by) {
      const info = db.prepare('INSERT INTO message (label,body,needs_understanding,audience,created_by) VALUES (?,?,?,?,?)')
        .run(d.label, d.body || null, b(d.needs_understanding), d.audience || 'all', by || null);
      const id = Number(info.lastInsertRowid);
      const ins = db.prepare('INSERT INTO message_recipient (message_id,emp_email) VALUES (?,?) ON CONFLICT DO NOTHING');
      for (const em of (recipients || [])) ins.run(id, (em || '').toLowerCase());
      return db.prepare('SELECT * FROM message WHERE id=?').get(id);
    },
    remove(id) { db.prepare('DELETE FROM message WHERE id=?').run(id); },
    forEmployee(email) {
      return db.prepare(`SELECT m.id,m.label,m.body,m.needs_understanding,m.created_at,
          r.read_at, r.understood_at
        FROM message_recipient r JOIN message m ON m.id=r.message_id
        WHERE r.emp_email=? ORDER BY m.created_at DESC`).all((email || '').toLowerCase());
    },
    markRead(messageId, email, understood) {
      db.prepare(`UPDATE message_recipient SET read_at=COALESCE(read_at,datetime('now')),
          understood_at=CASE WHEN ? THEN datetime('now') ELSE understood_at END
        WHERE message_id=? AND emp_email=?`).run(b(understood), messageId, (email || '').toLowerCase());
    },
  };

  // ---- F3: DISKUZE (komentáře u úkolu) ----------------------------
  const discussion = {
    forProgress(progressId) { return db.prepare('SELECT * FROM discussion WHERE progress_id=? ORDER BY created_at').all(progressId); },
    add(d) {
      const info = db.prepare('INSERT INTO discussion (progress_id,parent_id,author_email,author_name,text) VALUES (?,?,?,?,?)')
        .run(d.progress_id, d.parent_id || null, (d.author_email || '').toLowerCase() || null, d.author_name || null, d.text);
      return db.prepare('SELECT * FROM discussion WHERE id=?').get(Number(info.lastInsertRowid));
    },
  };

  const meta = {
    get(k) { const r = db.prepare('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; },
    set(k, v) { db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)); },
  };

  return { db, scenario, phase, task, scenarioFull, assignment, progress, message, discussion, meta };
}

module.exports = { openDb, SCHEMA };

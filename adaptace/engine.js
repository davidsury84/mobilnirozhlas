'use strict';
// Business logika modulu Adaptace: spuštění adaptace, plnění úkolů a
// deadline notifikace (cron `tick`). Odesílání e-mailů jde přes host.deliver.

const { todayPrague, addDays, daysUntil, formatCz } = require('./lib/datum');

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Spuštění adaptace: založí assignment + progress řádky s dopočtenými deadliny.
function startAdaptation(M, { empEmail, empName, scenarioId, mentorEmail, startDate, inviteHash }, by) {
  const s = M.scenario.getById(scenarioId);
  if (!s) throw new Error('Scénář neexistuje.');
  const start = startDate || todayPrague();
  const a = M.assignment.create({
    emp_email: empEmail, emp_name: empName, scenario_id: scenarioId, scenario_label: s.label,
    mentor_email: mentorEmail, start_date: start, invite_hash: inviteHash,
  }, by);
  M.progress.seedForAssignment(a.id, scenarioId, (days) => addDays(start, days));
  return a;
}

// Změna stavu úkolu nováčkem/mentorem + přepočet dokončení.
function setProgressFlag(M, progressId, flag, val, who) {
  M.progress.setFlag(progressId, flag, val, who);
  M.progress.recompute(progressId);
  return M.progress.getById(progressId);
}

// ---- e-maily -----------------------------------------------------
function taskUrl(base, assignmentId) { return `${(base || '').replace(/\/$/, '')}/adaptace#a=${assignmentId}`; }
// Magic-link (bez přihlášení) — pro nováčky bez firemního Google účtu (pre-boarding).
function inviteUrl(base, hash) { return `${(base || '').replace(/\/$/, '')}/adaptace/uvod/${hash}`; }

function btn(url, label) {
  return `<a href="${esc(url)}" style="background:#2d6cdf;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block;font-weight:600">${esc(label)}</a>`;
}

// Pozvánka nováčkovi — magic-link funguje i bez SSO.
function mailNewAssignment(deliver, base, a) {
  if (!a.emp_email) return Promise.resolve();
  const url = a.invite_hash ? inviteUrl(base, a.invite_hash) : taskUrl(base, a.id);
  return deliver({
    to: a.emp_email,
    subject: `Adaptační plán: ${a.scenario_label || ''}`,
    text: `Byl ti přiřazen adaptační plán „${a.scenario_label || ''}". Otevři si ho zde: ${url}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222">
      <p>Ahoj${a.emp_name ? ' ' + esc(a.emp_name.split(' ')[0]) : ''},</p>
      <p>byl ti přiřazen adaptační plán <strong>${esc(a.scenario_label || '')}</strong>.</p>
      <p>${btn(url, 'Otevřít adaptaci')}</p>
    </div>`,
  }).catch(() => {});
}

// Notifikace mentorovi, že nováček dokončil svou část a čeká na potvrzení.
// Idempotentní: 1× na (progress, kind='mentor'). Volá se po setProgressFlag.
function maybeNotifyMentor(M, deliver, base, progressId) {
  const r = M.progress.getById(progressId);
  if (!r || !r.needs_mentor_ok || r.mentor_ok) return Promise.resolve();
  // nováček musí mít hotové své brány
  const empDone = (!r.needs_understanding || r.understood) && (!r.needs_acquaintance || r.acquainted);
  if (!empDone) return Promise.resolve();
  const a = M.assignment.getById(r.assignment_id);
  const mentor = a && a.mentor_email;
  if (!mentor) return Promise.resolve();
  const already = M.db.prepare("SELECT 1 FROM notification WHERE progress_id=? AND kind='mentor'").get(progressId);
  if (already) return Promise.resolve();
  M.db.prepare("INSERT INTO notification (progress_id,kind,komu_email,notify_date,sent_at) VALUES (?,?,?,date('now'),datetime('now'))")
    .run(progressId, 'mentor', mentor);
  return deliver({
    to: mentor,
    subject: `K potvrzení: ${r.label} — ${a.emp_name || a.emp_email}`,
    text: `${a.emp_name || a.emp_email} dokončil úkol „${r.label}" a čeká na tvé potvrzení. Otevři: ${taskUrl(base, a.id)}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222">
      <p><strong>${esc(a.emp_name || a.emp_email)}</strong> dokončil úkol <strong>${esc(r.label)}</strong> a čeká na tvé potvrzení.</p>
      <p>${btn(taskUrl(base, a.id), 'Otevřít a potvrdit')}</p></div>`,
  }).catch(() => {});
}

// E-mail o nové zprávě (F3 broadcast).
function mailMessage(deliver, base, msg, email) {
  if (!email) return Promise.resolve();
  return deliver({
    to: email,
    subject: msg.label,
    text: `${msg.body || ''}\n\nOtevři v intranetu: ${(base || '').replace(/\/$/, '')}/adaptace`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222">
      <h3 style="margin:0 0 8px">${esc(msg.label)}</h3>
      <div>${esc(msg.body || '').replace(/\n/g, '<br>')}</div>
      <p style="margin-top:14px">${btn((base || '').replace(/\/$/, '') + '/adaptace', 'Otevřít v intranetu')}</p></div>`,
  }).catch(() => {});
}

function mailDeadline(deliver, base, row, dny) {
  if (!row.emp_email) return Promise.resolve();
  const kdy = dny < 0 ? `je ${-dny} dní po termínu` : dny === 0 ? 'má termín dnes' : `zbývá ${dny} dní`;
  return deliver({
    to: row.emp_email,
    subject: `Připomínka úkolu: ${row.label}`,
    text: `Úkol „${row.label}" ${kdy} (termín ${formatCz(row.deadline_date)}). Otevři: ${taskUrl(base, row.assignment_id)}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222">
      <p>Úkol <strong>${esc(row.label)}</strong> ${esc(kdy)} (termín ${esc(formatCz(row.deadline_date))}).</p>
      <p><a href="${esc(taskUrl(base, row.assignment_id))}">Otevřít adaptaci</a></p></div>`,
  }).catch(() => {});
}

// ---- cron tick: deadline notifikace ------------------------------
// Notifikuje 7 a 1 den před termínem, v den termínu a den po. Idempotentní
// přes tabulku notification (UNIQUE progress_id+kind+notify_date).
const NOTIFY_OFFSETS = [-7, -1, 0, 1]; // dnů vůči deadline_date

async function tick(M, ctx = {}) {
  const dnes = todayPrague();
  const deliver = ctx.deliver || (() => Promise.resolve());
  const base = ctx.baseUrl || '';
  // Splatné dnes = deadline_date + offset === dnes  →  deadline_date === dnes - offset
  for (const off of NOTIFY_OFFSETS) {
    const cil = addDays(dnes, -off);
    const rows = M.progress.dueOn(cil);
    for (const r of rows) {
      const already = M.db.prepare('SELECT 1 FROM notification WHERE progress_id=? AND kind=? AND notify_date=?')
        .get(r.id, 'deadline', dnes);
      if (already) continue;
      M.db.prepare('INSERT INTO notification (progress_id,kind,komu_email,notify_date,sent_at) VALUES (?,?,?,?,datetime(\'now\'))')
        .run(r.id, 'deadline', r.emp_email || null, dnes);
      await mailDeadline(deliver, base, { ...r, assignment_id: r.assignment_id }, daysUntil(r.deadline_date, dnes));
    }
  }
}

module.exports = { startAdaptation, setProgressFlag, mailNewAssignment, maybeNotifyMentor, mailMessage, inviteUrl, tick, esc };

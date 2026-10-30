const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { canSeeAllProjects, assignedProjectIds } = require('../scope');
const { logAudit } = require('../changeLog');
const { getDerivedCellAlerts, getDerivedPbgAlerts, sortEarliestDueFirst } = require('../derivedAlerts');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const activeOnly = req.query.activeOnly !== 'false';
  let rows = activeOnly
    ? db.prepare('SELECT * FROM alerts WHERE dismissed_at IS NULL ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM alerts ORDER BY created_at DESC').all();
  if (!canSeeAllProjects(req.user)) {
    const ids = new Set(assignedProjectIds(req.user.username));
    rows = rows.filter((a) => a.project_id == null || ids.has(a.project_id));
  }
  // Derived, un-dismissable: a cell nearing its tentative date, or a
  // Submitted cell nearing its SUB_APPROVAL_DAYS SLA -- resolves itself once
  // the status moves on, or escalates to a pending action if missed.
  let derived = [];
  if (activeOnly) {
    derived = getDerivedCellAlerts(req.user).upcoming.map((u) => ({
      id: u.id, project_id: u.projectId, derived: true, sort_date: u.dueDate,
      tab: u.tab, corridor: u.corridor, column: u.column,
      message: `${u.projectName} (${u.projectCode}) — ${u.corridor} / ${u.column}: due ${u.dueDate}`,
      reason: u.reason,
      created_at: null, dismissed_by: null, dismissed_at: null,
    }));
    derived.push(...getDerivedPbgAlerts(req.user).upcoming.map((u) => ({
      id: u.id, project_id: u.projectId, derived: true, due_date: u.dueDate,
      message: `${u.projectName} (${u.projectCode}) — PBG valid up to ${u.dueDate}`,
      reason: u.reason,
      created_at: null, dismissed_by: null, dismissed_at: null,
    })));
  }
  res.json({ alerts: sortEarliestDueFirst([...derived, ...rows]) });
});

router.post('/', requireAnyRole('pmo'), (req, res) => {
  const { message, dueDate, projectId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  const info = db.prepare(
    'INSERT INTO alerts (project_id, message, due_date, created_by) VALUES (?,?,?,?)'
  ).run(projectId || null, message, dueDate || null, req.user.username);
  logAudit(req.user, { projectId: projectId || null, area: 'alert', action: 'create', subject: message, detail: dueDate ? `Due: ${dueDate}` : null });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/:id/dismiss', requireAnyRole('pmo'), (req, res) => {
  const alert = db.prepare('SELECT project_id AS projectId, message FROM alerts WHERE id = ?').get(req.params.id);
  db.prepare(
    "UPDATE alerts SET dismissed_by = ?, dismissed_at = datetime('now') WHERE id = ?"
  ).run(req.user.username, req.params.id);
  if (alert) logAudit(req.user, { projectId: alert.projectId, area: 'alert', action: 'update', subject: alert.message, detail: 'Dismissed' });
  res.json({ ok: true });
});

module.exports = router;

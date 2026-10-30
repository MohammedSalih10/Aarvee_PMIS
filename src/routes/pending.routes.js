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
    ? db.prepare('SELECT * FROM pending_actions WHERE done_at IS NULL ORDER BY due_date').all()
    : db.prepare('SELECT * FROM pending_actions ORDER BY created_at DESC').all();
  if (!canSeeAllProjects(req.user)) {
    const ids = new Set(assignedProjectIds(req.user.username));
    rows = rows.filter((a) => a.project_id == null || ids.has(a.project_id));
  }
  // Derived, un-dismissable: an activity cell still Yet to Start/In Progress
  // after its tentative start/finish date has passed, or still Submitted more
  // than SUB_APPROVAL_DAYS after submission -- resolves itself once the
  // status moves on.
  let derived = [];
  if (activeOnly) {
    derived = getDerivedCellAlerts(req.user).overdue.map((u) => ({
      id: u.id, project_id: u.projectId, derived: true, due_date: u.dueDate,
      tab: u.tab, corridor: u.corridor, column: u.column,
      title: `${u.projectName} (${u.projectCode}) — ${u.corridor} / ${u.column}`,
      reason: u.reason,
      created_by: null, created_at: null, done_by: null, done_at: null,
    }));
    derived.push(...getDerivedPbgAlerts(req.user).overdue.map((u) => ({
      id: u.id, project_id: u.projectId, derived: true, due_date: u.dueDate,
      title: `${u.projectName} (${u.projectCode}) — PBG renewal`,
      reason: u.reason,
      created_by: null, created_at: null, done_by: null, done_at: null,
    })));
  }
  res.json({ pending: sortEarliestDueFirst([...derived, ...rows]) });
});

router.post('/', requireAnyRole('pmo'), (req, res) => {
  const { title, dueDate, projectId } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const info = db.prepare(
    'INSERT INTO pending_actions (project_id, title, due_date, created_by) VALUES (?,?,?,?)'
  ).run(projectId || null, title, dueDate || null, req.user.username);
  logAudit(req.user, { projectId: projectId || null, area: 'pending', action: 'create', subject: title, detail: dueDate ? `Due: ${dueDate}` : null });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/:id/done', requireAnyRole('pmo'), (req, res) => {
  const item = db.prepare('SELECT project_id AS projectId, title FROM pending_actions WHERE id = ?').get(req.params.id);
  db.prepare(
    "UPDATE pending_actions SET done_by = ?, done_at = datetime('now') WHERE id = ?"
  ).run(req.user.username, req.params.id);
  if (item) logAudit(req.user, { projectId: item.projectId, area: 'pending', action: 'update', subject: item.title, detail: 'Marked done' });
  res.json({ ok: true });
});

module.exports = router;

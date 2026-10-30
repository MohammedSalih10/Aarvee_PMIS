const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

// Admin-only "who changed what" view across the whole app: audit_log plus the
// activity-grid panel edits from activity_change_log (shown here as area
// 'activity'). ?projectId= narrows to one project (global activity-column
// edits, which belong to no project, still show), ?area= takes a
// comma-separated subset of areas.
const router = express.Router();

const AREAS = ['project', 'details', 'financial', 'contract_end', 'deliverable', 'access', 'schedule', 'alert', 'pending', 'user', 'activity', 'undo'];
const LIMIT = 500;

router.get('/audit-log', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can view the audit log' });
  const areas = String(req.query.area || '').split(',').filter((a) => AREAS.includes(a));
  const projectId = Number(req.query.projectId) || null;
  const want = (a) => !areas.length || areas.includes(a);

  let history = [];
  const auditAreas = areas.filter((a) => a !== 'activity');
  if (!areas.length || auditAreas.length) {
    const where = [], params = [];
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (auditAreas.length) { where.push(`area IN (${auditAreas.map(() => '?').join(',')})`); params.push(...auditAreas); }
    history = db.prepare(
      `SELECT a.id, a.area, a.action, a.project_id AS projectId, a.project_code AS projectCode, a.subject, a.detail,
              a.changed_by AS changedBy, u.display_name AS changedByName, a.changed_at AS changedAt
       FROM audit_log a LEFT JOIN users u ON u.username = a.changed_by
       ${where.length ? 'WHERE ' + where.map((w) => 'a.' + w).join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${LIMIT}`
    ).all(...params);
  }
  if (want('activity')) {
    const where = [], params = [];
    if (projectId) { where.push('(l.project_id = ? OR l.project_id IS NULL)'); params.push(projectId); }
    const rows = db.prepare(
      `SELECT l.id, l.panel, l.tab, l.action, l.project_id AS projectId, p.code AS projectCode, l.subject, l.detail,
              l.changed_by AS changedBy, u.display_name AS changedByName, l.changed_at AS changedAt
       FROM activity_change_log l LEFT JOIN projects p ON p.id = l.project_id LEFT JOIN users u ON u.username = l.changed_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ${LIMIT}`
    ).all(...params);
    rows.forEach((r) => history.push({
      id: `a${r.id}`, area: 'activity', action: r.action, projectId: r.projectId, projectCode: r.projectCode,
      subject: `${r.tab === 'office' ? 'Office' : 'Field'} · ${r.subject}`, detail: r.detail, changedBy: r.changedBy, changedByName: r.changedByName, changedAt: r.changedAt,
    }));
  }
  history.sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : 0));
  res.json({ history: history.slice(0, LIMIT) });
});

module.exports = router;

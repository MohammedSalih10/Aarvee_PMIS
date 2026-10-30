const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { requireProjectAccess } = require('../scope');
const { logAudit } = require('../changeLog');

// Contractual end date change requests. The date is frozen once set (enforced in
// PATCH /projects/:id/details); a pmo raises a request here and admin/mgmt decide it.
// Mirrors the ABP change-request flow in financials.routes.js.
const router = express.Router();

const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

const requestSelect = `
  SELECT r.id, r.project_id AS projectId, p.code AS projectCode, p.name AS projectName,
         r.old_value AS oldValue, r.new_value AS newValue, r.reason, r.status,
         r.requested_by AS requestedBy, r.requested_at AS requestedAt,
         r.decided_by AS decidedBy, r.decided_at AS decidedAt, r.decision_note AS decisionNote
  FROM contract_end_change_requests r JOIN projects p ON p.id = r.project_id`;

function requireApprover(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'mgmt') {
    return res.status(403).json({ error: 'Only management or admin can decide change requests' });
  }
  next();
}

// Pending + approved requests for one project, so the details modal can flag the field.
router.get('/projects/:id/contract-end/change-requests', requireAuth, requireProjectAccess(), (req, res) => {
  const requests = db.prepare(`${requestSelect} WHERE r.project_id = ? AND r.status = 'pending'`).all(req.params.id);
  const approved = db.prepare(`${requestSelect} WHERE r.project_id = ? AND r.status = 'approved' ORDER BY r.decided_at, r.id`)
    .all(req.params.id);
  res.json({ requests, approved });
});

router.post(
  '/projects/:id/contract-end/change-requests',
  requireAuth,
  requireProjectAccess(),
  requireAnyRole('pmo'),
  (req, res) => {
    const { newValue, reason } = req.body || {};
    if (!isValidDate(newValue)) return res.status(400).json({ error: 'newValue must be a date (YYYY-MM-DD)' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is required' });

    const project = db.prepare('SELECT contract_end AS value FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.value) return res.status(400).json({ error: 'Contractual end date is not frozen yet — edit it directly' });
    if (newValue === project.value) return res.status(400).json({ error: 'New date is the same as the current date' });

    const dup = db.prepare("SELECT 1 FROM contract_end_change_requests WHERE project_id = ? AND status = 'pending'").get(req.params.id);
    if (dup) return res.status(409).json({ error: 'A change request for the contractual end date is already pending' });

    const info = db.prepare(`
      INSERT INTO contract_end_change_requests (project_id, old_value, new_value, reason, requested_by)
      VALUES (?,?,?,?,?)
    `).run(req.params.id, project.value, newValue, String(reason).trim(), req.user.username);
    logAudit(req.user, {
      projectId: Number(req.params.id), area: 'contract_end', action: 'request', subject: 'Contractual end date',
      detail: `Change requested: ${project.value} → ${newValue} — ${String(reason).trim()}`,
    });
    res.status(201).json({ id: info.lastInsertRowid });
  }
);

// Approvers (admin/mgmt) see every request; pmo sees the ones they raised.
router.get('/contract-end-change-requests', requireAuth, (req, res) => {
  const approver = req.user.role === 'admin' || req.user.role === 'mgmt';
  if (!approver && req.user.role !== 'pmo') return res.status(403).json({ error: 'Not permitted for your role' });
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const where = [];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (!approver) { where.push('r.requested_by = ?'); params.push(req.user.username); }
  const requests = db.prepare(
    `${requestSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (r.status = 'pending') DESC, COALESCE(r.decided_at, r.requested_at) DESC, r.id DESC LIMIT 200`
  ).all(...params);
  res.json({ requests });
});

// A still-pending request can be withdrawn by whoever raised it, or by an admin.
router.delete('/contract-end-change-requests/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT id, status, requested_by AS requestedBy, project_id AS projectId FROM contract_end_change_requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (req.user.role !== 'admin' && r.requestedBy !== req.user.username) {
    return res.status(403).json({ error: 'Only the person who raised this request (or an admin) can delete it' });
  }
  const info = db.prepare("DELETE FROM contract_end_change_requests WHERE id = ? AND status = 'pending'").run(r.id);
  if (!info.changes) return res.status(409).json({ error: `Request was already ${r.status} and can no longer be deleted` });
  logAudit(req.user, { projectId: r.projectId, area: 'contract_end', action: 'withdraw', subject: 'Contractual end date', detail: `Pending change request (raised by ${r.requestedBy}) withdrawn` });
  res.json({ ok: true });
});

function decide(status) {
  return (req, res) => {
    const note = String((req.body && req.body.note) || '').trim() || null;
    const outcome = db.transaction(() => {
      const r = db.prepare('SELECT * FROM contract_end_change_requests WHERE id = ?').get(req.params.id);
      if (!r) return { code: 404, error: 'Request not found' };
      if (r.status !== 'pending') return { code: 409, error: `Request was already ${r.status}` };
      if (status === 'approved') {
        db.prepare('UPDATE projects SET contract_end = ? WHERE id = ?').run(r.new_value, r.project_id);
      }
      db.prepare(
        "UPDATE contract_end_change_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?"
      ).run(status, req.user.username, note, r.id);
      logAudit(req.user, {
        projectId: r.project_id, area: 'contract_end', action: status === 'approved' ? 'approve' : 'reject', subject: 'Contractual end date',
        detail: `Change request (raised by ${r.requested_by}): ${r.old_value} → ${r.new_value}${note ? ` — ${note}` : ''}`,
      });
      return { code: 200 };
    })();
    if (outcome.error) return res.status(outcome.code).json({ error: outcome.error });
    res.json({ ok: true });
  };
}
router.post('/contract-end-change-requests/:id/approve', requireAuth, requireApprover, decide('approved'));
router.post('/contract-end-change-requests/:id/reject', requireAuth, requireApprover, decide('rejected'));

module.exports = router;

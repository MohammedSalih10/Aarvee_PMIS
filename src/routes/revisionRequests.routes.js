const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { requireProjectAccess, canEditCorridor } = require('../scope');
const { MAX_FREE_REVISION } = require('../activityConstants');

// Comment Compliance revisions beyond MAX_FREE_REVISION. Whoever can edit the
// cell raises a request; admin/mgmt approve (the cell is moved to Comment
// Compliance at the new revision) or reject. Mirrors the change-request flow in
// contractEnd.routes.js / financials.routes.js.
const router = express.Router();

const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isApprover = (user) => user.role === 'admin' || user.role === 'mgmt';

const requestSelect = `
  SELECT r.id, pa.project_id AS projectId, p.code AS projectCode, p.name AS projectName,
         pa.corridor AS corridor, pa.tab AS tab, r.column_key AS columnKey,
         r.from_revision AS fromRevision, r.to_revision AS toRevision, r.approval_date AS approvalDate,
         r.reason, r.status, r.requested_by AS requestedBy, r.requested_at AS requestedAt,
         r.decided_by AS decidedBy, r.decided_at AS decidedAt, r.decision_note AS decisionNote
  FROM activity_revision_requests r
  JOIN project_activities pa ON pa.id = r.activity_id
  JOIN projects p ON p.id = pa.project_id`;

function requireApprover(req, res, next) {
  if (!isApprover(req.user)) return res.status(403).json({ error: 'Only management or admin can decide revision requests' });
  next();
}

router.post(
  '/projects/:id/activities/:activityId/cells/:column/revision-requests',
  requireAuth,
  requireProjectAccess(),
  (req, res) => {
    const activity = db.prepare('SELECT id, corridor FROM project_activities WHERE id = ? AND project_id = ?')
      .get(req.params.activityId, req.params.id);
    if (!activity) return res.status(404).json({ error: 'Activity row not found' });
    if (!canEditCorridor(req.user, req.params.id, activity.corridor)) {
      return res.status(403).json({ error: 'You do not have edit access to this corridor' });
    }
    const { approvalDate, reason } = req.body || {};
    if (!isValidDate(approvalDate)) return res.status(400).json({ error: 'Approval date is required (YYYY-MM-DD)' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is required' });

    const cell = db.prepare('SELECT status, revision FROM activity_cells WHERE activity_id = ? AND column_key = ?')
      .get(activity.id, req.params.column);
    const current = (cell && cell.revision) || 0;
    if (current < MAX_FREE_REVISION) {
      return res.status(400).json({ error: `Revisions up to ${MAX_FREE_REVISION} don't need approval — update the status directly` });
    }
    const dup = db.prepare("SELECT 1 FROM activity_revision_requests WHERE activity_id = ? AND column_key = ? AND status = 'pending'")
      .get(activity.id, req.params.column);
    if (dup) return res.status(409).json({ error: 'A revision request for this activity is already pending' });

    const cleanReason = String(reason).trim();
    const info = db.transaction(() => {
      const created = db.prepare(`
        INSERT INTO activity_revision_requests (activity_id, column_key, from_revision, to_revision, approval_date, reason, requested_by)
        VALUES (?,?,?,?,?,?,?)
      `).run(activity.id, req.params.column, current, current + 1, approvalDate, cleanReason, req.user.username);
      // Logged on the activity right away (to_status 'CCQ' = revision
      // requested), so the cell's and the corridor's history show the request
      // as well as its later approval/rejection.
      db.prepare(`
        INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, revision, remarks, updated_by, updated_at)
        VALUES (?,?,?,'CCQ',?,?,?,?)
      `).run(activity.id, req.params.column, cell ? cell.status : null, current + 1,
        `Revision ${current + 1} requested — approval date ${approvalDate}: ${cleanReason}`, req.user.username, new Date().toISOString());
      return created;
    })();
    res.status(201).json({ id: info.lastInsertRowid, toRevision: current + 1 });
  }
);

// Approvers see every request; everyone else sees the ones they raised.
router.get('/revision-requests', requireAuth, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const where = [];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (!isApprover(req.user)) { where.push('r.requested_by = ?'); params.push(req.user.username); }
  const requests = db.prepare(
    `${requestSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (r.status = 'pending') DESC, COALESCE(r.decided_at, r.requested_at) DESC, r.id DESC LIMIT 200`
  ).all(...params);
  res.json({ requests });
});

router.delete('/revision-requests/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT id, status, requested_by AS requestedBy FROM activity_revision_requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (req.user.role !== 'admin' && r.requestedBy !== req.user.username) {
    return res.status(403).json({ error: 'Only the person who raised this request (or an admin) can delete it' });
  }
  const info = db.prepare("DELETE FROM activity_revision_requests WHERE id = ? AND status = 'pending'").run(r.id);
  if (!info.changes) return res.status(409).json({ error: `Request was already ${r.status} and can no longer be deleted` });
  res.json({ ok: true });
});

function decide(status) {
  return (req, res) => {
    const note = String((req.body && req.body.note) || '').trim() || null;
    const outcome = db.transaction(() => {
      const r = db.prepare('SELECT * FROM activity_revision_requests WHERE id = ?').get(req.params.id);
      if (!r) return { code: 404, error: 'Request not found' };
      if (r.status !== 'pending') return { code: 409, error: `Request was already ${r.status}` };
      if (status === 'approved') {
        const cell = db.prepare('SELECT status, revision FROM activity_cells WHERE activity_id = ? AND column_key = ?')
          .get(r.activity_id, r.column_key);
        if (((cell && cell.revision) || 0) !== r.from_revision) {
          return { code: 409, error: 'The activity moved to a different revision since this was requested — reject it and ask for a new request' };
        }
        const now = new Date().toISOString();
        const remarks = `Revision ${r.to_revision} request approved by ${req.user.username} (${req.user.role === 'mgmt' ? 'management' : 'admin'}) `
          + `(requested by ${r.requested_by}: ${r.reason})${note ? ` — ${note}` : ''}`;
        db.prepare(`
          INSERT INTO activity_cells (activity_id, column_key, status, tentative_date, revision, remarks, signed, updated_by, updated_at)
          VALUES (?,?, 'CC', ?, ?, ?, 1, ?, ?)
          ON CONFLICT(activity_id, column_key) DO UPDATE SET
            status = 'CC', tentative_date = excluded.tentative_date, planned_finish_date = NULL, revision = excluded.revision,
            remarks = excluded.remarks, signed = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        `).run(r.activity_id, r.column_key, r.approval_date, r.to_revision, remarks, req.user.username, now);
        db.prepare(`
          INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, revision, remarks, updated_by, updated_at)
          VALUES (?,?,?,'CCA',?,?,?,?)
        `).run(r.activity_id, r.column_key, cell ? cell.status : null, r.to_revision, remarks, req.user.username, now);
      }
      if (status === 'rejected') {
        // Logged on the activity so the rejection shows in the cell's and the
        // corridor's history, like the approval above (to_status 'CCR' =
        // Comment Compliance rejected; the cell itself stays on its current
        // revision).
        const cell = db.prepare('SELECT status FROM activity_cells WHERE activity_id = ? AND column_key = ?')
          .get(r.activity_id, r.column_key);
        const remarks = `Revision ${r.to_revision} request rejected by ${req.user.username} (${req.user.role === 'mgmt' ? 'management' : 'admin'}) `
          + `(requested by ${r.requested_by}: ${r.reason})${note ? ` — ${note}` : ''}`;
        db.prepare(`
          INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, revision, remarks, updated_by, updated_at)
          VALUES (?,?,?,'CCR',?,?,?,?)
        `).run(r.activity_id, r.column_key, cell ? cell.status : null, r.to_revision, remarks, req.user.username, new Date().toISOString());
      }
      db.prepare(
        "UPDATE activity_revision_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?"
      ).run(status, req.user.username, note, r.id);
      return { code: 200 };
    })();
    if (outcome.error) return res.status(outcome.code).json({ error: outcome.error });
    res.json({ ok: true });
  };
}
router.post('/revision-requests/:id/approve', requireAuth, requireApprover, decide('approved'));
router.post('/revision-requests/:id/reject', requireAuth, requireApprover, decide('rejected'));

module.exports = router;

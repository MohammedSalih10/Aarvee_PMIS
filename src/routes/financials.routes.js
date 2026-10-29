const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { canSeeAllProjects, assignedProjectIds, requireProjectAccess } = require('../scope');

const router = express.Router();

const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
// Request/body key -> financial_entries column. Doubles as the whitelist for the dynamic UPDATE below.
const FROZEN_FIELDS = { planBilling: 'plan_billing', planCollection: 'plan_collection' };
const FIELD_LABELS = { planBilling: 'ABP billing', planCollection: 'ABP collection' };
const isFrozen = (value) => Number(value) !== 0;

function monthRows(projectId, fiscalYear) {
  const rows = db.prepare(
    `SELECT month_index AS monthIndex, plan_billing AS planBilling, actual_billing AS actualBilling,
            plan_collection AS planCollection, actual_collection AS actualCollection, expenditure,
            forecast_billing AS forecastBilling, forecast_collection AS forecastCollection
     FROM financial_entries WHERE project_id = ? AND fiscal_year = ?`
  ).all(projectId, fiscalYear);
  const byMonth = new Map(rows.map((r) => [r.monthIndex, r]));
  return Array.from({ length: 12 }, (_, i) => byMonth.get(i) || {
    monthIndex: i, planBilling: 0, actualBilling: 0, planCollection: 0, actualCollection: 0, expenditure: 0,
    forecastBilling: 0, forecastCollection: 0,
  });
}

router.get('/projects/:id/financials', requireAuth, requireProjectAccess(), (req, res) => {
  const fiscalYear = Number(req.query.fiscalYear) || new Date().getFullYear();
  res.json({ fiscalYear, months: monthRows(req.params.id, fiscalYear) });
});

router.put(
  '/projects/:id/financials/:fiscalYear/:monthIndex',
  requireAuth,
  requireProjectAccess(),
  requireAnyRole('pmo'),
  (req, res) => {
    const mi = Number(req.params.monthIndex);
    const fiscalYear = Number(req.params.fiscalYear);
    if (!Number.isInteger(mi) || mi < 0 || mi > 11) {
      return res.status(400).json({ error: 'monthIndex must be an integer 0-11' });
    }
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const {
      planBilling = 0, actualBilling = 0, planCollection = 0, actualCollection = 0, expenditure = 0,
      forecastBilling = 0, forecastCollection = 0,
    } = req.body || {};

    // ABP figures are frozen once saved with a non-zero value; only an approved
    // change request (or an admin) may alter them afterwards.
    if (req.user.role !== 'admin') {
      const existing = db.prepare(
        'SELECT plan_billing, plan_collection FROM financial_entries WHERE project_id = ? AND fiscal_year = ? AND month_index = ?'
      ).get(req.params.id, fiscalYear, mi);
      const changed = existing && Object.entries(FROZEN_FIELDS).filter(([key, col]) =>
        isFrozen(existing[col]) && Math.abs(Number(req.body && req.body[key] || 0) - existing[col]) > 1e-9);
      if (changed && changed.length) {
        return res.status(409).json({
          error: `${changed.map(([key]) => FIELD_LABELS[key]).join(' and ')} for ${MONTHS[mi]} is frozen — request a change for management approval`,
          frozen: changed.map(([key]) => key),
        });
      }
    }

    db.prepare(`
      INSERT INTO financial_entries
        (project_id, fiscal_year, month_index, plan_billing, actual_billing, plan_collection, actual_collection, expenditure,
         forecast_billing, forecast_collection, updated_by, updated_at)
      VALUES (@projectId, @fiscalYear, @monthIndex, @planBilling, @actualBilling, @planCollection, @actualCollection, @expenditure,
         @forecastBilling, @forecastCollection, @updatedBy, datetime('now'))
      ON CONFLICT(project_id, fiscal_year, month_index) DO UPDATE SET
        plan_billing = excluded.plan_billing,
        actual_billing = excluded.actual_billing,
        plan_collection = excluded.plan_collection,
        actual_collection = excluded.actual_collection,
        expenditure = excluded.expenditure,
        forecast_billing = excluded.forecast_billing,
        forecast_collection = excluded.forecast_collection,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run({
      projectId: req.params.id,
      fiscalYear,
      monthIndex: mi,
      planBilling,
      actualBilling,
      planCollection,
      actualCollection,
      expenditure,
      forecastBilling,
      forecastCollection,
      updatedBy: req.user.username,
    });
    res.json({ ok: true });
  }
);

// --- Change requests for frozen ABP figures ---------------------------------

const requestSelect = `
  SELECT r.id, r.project_id AS projectId, p.code AS projectCode, p.name AS projectName,
         r.fiscal_year AS fiscalYear, r.month_index AS monthIndex, r.field,
         r.old_value AS oldValue, r.new_value AS newValue, r.reason, r.status,
         r.requested_by AS requestedBy, r.requested_at AS requestedAt,
         r.decided_by AS decidedBy, r.decided_at AS decidedAt, r.decision_note AS decisionNote
  FROM financial_change_requests r JOIN projects p ON p.id = r.project_id`;

// Only management/admin decide requests; unlike requireAnyRole, pmo is not let through.
function requireApprover(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'mgmt') {
    return res.status(403).json({ error: 'Only management or admin can decide change requests' });
  }
  next();
}

// Pending + approved requests for one project/FY, so the financials modal can flag
// cells awaiting approval (requests) and cells already changed by approval (approved, oldest first).
router.get('/projects/:id/financials/change-requests', requireAuth, requireProjectAccess(), (req, res) => {
  const fiscalYear = Number(req.query.fiscalYear) || new Date().getFullYear();
  const requests = db.prepare(`${requestSelect} WHERE r.project_id = ? AND r.fiscal_year = ? AND r.status = 'pending'`)
    .all(req.params.id, fiscalYear);
  const approved = db.prepare(`${requestSelect} WHERE r.project_id = ? AND r.fiscal_year = ? AND r.status = 'approved' ORDER BY r.decided_at, r.id`)
    .all(req.params.id, fiscalYear);
  res.json({ requests, approved });
});

router.post(
  '/projects/:id/financials/:fiscalYear/:monthIndex/change-requests',
  requireAuth,
  requireProjectAccess(),
  requireAnyRole('pmo'),
  (req, res) => {
    const mi = Number(req.params.monthIndex);
    const fiscalYear = Number(req.params.fiscalYear);
    if (!Number.isInteger(mi) || mi < 0 || mi > 11) {
      return res.status(400).json({ error: 'monthIndex must be an integer 0-11' });
    }
    const { field, reason } = req.body || {};
    const newValue = Number(req.body && req.body.newValue);
    if (!Object.hasOwn(FROZEN_FIELDS, field)) return res.status(400).json({ error: 'field must be planBilling or planCollection' });
    if (!Number.isFinite(newValue) || newValue < 0) return res.status(400).json({ error: 'newValue must be a number ≥ 0' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is required' });

    const col = FROZEN_FIELDS[field];
    const row = db.prepare(
      `SELECT ${col} AS value FROM financial_entries WHERE project_id = ? AND fiscal_year = ? AND month_index = ?`
    ).get(req.params.id, fiscalYear, mi);
    const current = row ? row.value : 0;
    if (!isFrozen(current)) return res.status(400).json({ error: `${FIELD_LABELS[field]} is not frozen yet — edit it directly` });
    if (Math.abs(newValue - current) <= 1e-9) return res.status(400).json({ error: 'New value is the same as the current value' });

    const dup = db.prepare(
      "SELECT 1 FROM financial_change_requests WHERE project_id = ? AND fiscal_year = ? AND month_index = ? AND field = ? AND status = 'pending'"
    ).get(req.params.id, fiscalYear, mi, field);
    if (dup) return res.status(409).json({ error: 'A change request for this figure is already pending' });

    const info = db.prepare(`
      INSERT INTO financial_change_requests
        (project_id, fiscal_year, month_index, field, old_value, new_value, reason, requested_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(req.params.id, fiscalYear, mi, field, current, newValue, String(reason).trim(), req.user.username);
    res.status(201).json({ id: info.lastInsertRowid });
  }
);

// Approvers (admin/mgmt) see every request; pmo sees the ones they raised.
router.get('/financial-change-requests', requireAuth, (req, res) => {
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

function decide(status) {
  return (req, res) => {
    const note = String((req.body && req.body.note) || '').trim() || null;
    const outcome = db.transaction(() => {
      const r = db.prepare('SELECT * FROM financial_change_requests WHERE id = ?').get(req.params.id);
      if (!r) return { code: 404, error: 'Request not found' };
      if (r.status !== 'pending') return { code: 409, error: `Request was already ${r.status}` };
      if (status === 'approved') {
        const col = FROZEN_FIELDS[r.field]; // whitelisted by the table's CHECK constraint + FROZEN_FIELDS
        db.prepare(
          'INSERT OR IGNORE INTO financial_entries (project_id, fiscal_year, month_index) VALUES (?,?,?)'
        ).run(r.project_id, r.fiscal_year, r.month_index);
        db.prepare(
          `UPDATE financial_entries SET ${col} = ?, updated_by = ?, updated_at = datetime('now')
           WHERE project_id = ? AND fiscal_year = ? AND month_index = ?`
        ).run(r.new_value, req.user.username, r.project_id, r.fiscal_year, r.month_index);
      }
      db.prepare(
        "UPDATE financial_change_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?"
      ).run(status, req.user.username, note, r.id);
      return { code: 200 };
    })();
    if (outcome.error) return res.status(outcome.code).json({ error: outcome.error });
    res.json({ ok: true });
  };
}
// A still-pending request can be withdrawn (e.g. a typo) by whoever raised it, or by an admin.
// Pending requests have not touched any figure, so a hard delete loses nothing.
router.delete('/financial-change-requests/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT id, status, requested_by AS requestedBy FROM financial_change_requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (req.user.role !== 'admin' && r.requestedBy !== req.user.username) {
    return res.status(403).json({ error: 'Only the person who raised this request (or an admin) can delete it' });
  }
  const info = db.prepare("DELETE FROM financial_change_requests WHERE id = ? AND status = 'pending'").run(r.id);
  if (!info.changes) return res.status(409).json({ error: `Request was already ${r.status} and can no longer be deleted` });
  res.json({ ok: true });
});
router.post('/financial-change-requests/:id/approve', requireAuth, requireApprover, decide('approved'));
router.post('/financial-change-requests/:id/reject', requireAuth, requireApprover, decide('rejected'));

// Aggregate MIS view: every project the user can see, with YTD totals + full 12-month series (for charts)
router.get('/mis', requireAuth, (req, res) => {
  const fiscalYear = Number(req.query.fiscalYear) || new Date().getFullYear();
  const type = req.query.type;
  const quarter = Number(req.query.quarter) || 4;
  const cutoff = Math.min(11, Math.max(0, quarter * 3 - 1));

  let projects = db.prepare(
    'SELECT id, code, name, type, wo_value_cr AS woValueCr FROM projects ORDER BY code'
  ).all();
  if (type) projects = projects.filter((p) => p.type === type);
  if (!canSeeAllProjects(req.user)) {
    const ids = new Set(assignedProjectIds(req.user.username));
    projects = projects.filter((p) => ids.has(p.id));
  }

  // Lifecycle columns: everything billed/collected/spent up to the end of the
  // selected quarter, across all fiscal years.
  const lifetimeStmt = db.prepare(`
    SELECT COALESCE(SUM(actual_billing),0) AS billing, COALESCE(SUM(actual_collection),0) AS collection,
           COALESCE(SUM(expenditure),0) AS expenditure
    FROM financial_entries
    WHERE project_id = ? AND (fiscal_year < ? OR (fiscal_year = ? AND month_index <= ?))`);

  const result = projects.map((p) => {
    const months = monthRows(p.id, fiscalYear);
    const lifetime = lifetimeStmt.get(p.id, fiscalYear, fiscalYear, cutoff);
    const ytd = months.slice(0, cutoff + 1);
    const sum = (key) => ytd.reduce((a, m) => a + m[key], 0);
    const actualBilling = sum('actualBilling');
    const actualCollection = sum('actualCollection');
    const expenditure = sum('expenditure');
    const planBilling = sum('planBilling');
    const planCollection = sum('planCollection');
    const margin = actualBilling - expenditure;
    return {
      ...p,
      months,
      lifetime,
      ytd: {
        planBilling,
        actualBilling,
        planCollection,
        actualCollection,
        expenditure,
        margin,
        marginPct: actualBilling ? margin / actualBilling : 0,
      },
    };
  });
  res.json({ fiscalYear, quarter, projects: result });
});

module.exports = router;

const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { requireProjectAccess } = require('../scope');
const { BUDGET_CATEGORIES, DELIVERABLE_STATUS } = require('../dashboardConstants');
const { computeRowPercent } = require('../activityConstants');

// Project dashboard (mockup page 3): header dates/amounts, budget vs
// expenditure, life cycle totals and the billing/collection deliverables.
const router = express.Router();

// Overall project "% Complete": the plain average of every corridor row's own
// % complete (computeRowPercent -- the same weighted-by-column-weightage
// figure shown per-row on the activity grid), across both Office and Field
// tabs. Each corridor counts equally regardless of tab, so adding/removing
// corridors changes the mix, not a fixed Office/Field 50-50 split.
function computeProjectPercent(projectId) {
  let total = 0, count = 0;
  ['office', 'field'].forEach((tab) => {
    const columnRows = db.prepare('SELECT id, column_key AS name, weightage FROM activity_columns WHERE tab = ?').all(tab);
    if (!columnRows.length) return;
    const activities = db.prepare('SELECT id FROM project_activities WHERE project_id = ? AND tab = ?').all(projectId, tab);
    if (!activities.length) return;
    const ids = activities.map((a) => a.id);
    const placeholders = ids.map(() => '?').join(',');
    const cellRows = db.prepare(
      `SELECT activity_id AS activityId, column_key AS columnKey, status FROM activity_cells WHERE activity_id IN (${placeholders})`
    ).all(...ids);
    const cellsByActivity = new Map();
    cellRows.forEach((c) => {
      if (!cellsByActivity.has(c.activityId)) cellsByActivity.set(c.activityId, {});
      cellsByActivity.get(c.activityId)[c.columnKey] = c;
    });
    activities.forEach((a) => {
      const pct = computeRowPercent(cellsByActivity.get(a.id) || {}, columnRows);
      if (pct != null) { total += pct; count += 1; }
    });
  });
  return count > 0 ? total / count : null;
}

const DETAIL_FIELDS = {
  contractStart: 'contract_start', contractEnd: 'contract_end', forecastCompletion: 'forecast_completion',
  eotUpto: 'eot_upto', pbgValidUpto: 'pbg_valid_upto', unbilledRevenueCr: 'unbilled_revenue_cr',
  retentionCr: 'retention_cr', bankGuaranteeCr: 'bank_guarantee_cr',
};

router.get('/projects/:id/dashboard', requireAuth, requireProjectAccess(), (req, res) => {
  const project = db.prepare(`
    SELECT id, code, name, type, wo_value_cr AS woValueCr, contract_start AS contractStart, contract_end AS contractEnd,
           forecast_completion AS forecastCompletion, eot_upto AS eotUpto, pbg_valid_upto AS pbgValidUpto,
           unbilled_revenue_cr AS unbilledRevenueCr, retention_cr AS retentionCr, bank_guarantee_cr AS bankGuaranteeCr
    FROM projects WHERE id = ?`).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const stored = new Map(db.prepare(
    'SELECT category, budget_cr AS budgetCr, expenditure_cr AS expenditureCr FROM project_budget WHERE project_id = ?'
  ).all(req.params.id).map((b) => [b.category, b]));
  const budget = BUDGET_CATEGORIES.map((category) => stored.get(category) || { category, budgetCr: 0, expenditureCr: 0 });

  const lifetime = db.prepare(`
    SELECT COALESCE(SUM(actual_billing),0) AS billing, COALESCE(SUM(actual_collection),0) AS collection
    FROM financial_entries WHERE project_id = ?`).get(req.params.id);

  const deliverables = db.prepare(`
    SELECT d.id, d.kind, d.name, d.status, d.value_cr AS valueCr, d.due_date AS dueDate, d.remarks,
           (SELECT COUNT(*) FROM deliverable_audit_log a WHERE a.deliverable_id = d.id) AS historyCount
    FROM project_deliverables d WHERE d.project_id = ? ORDER BY d.sort_order, d.id`).all(req.params.id);

  res.json({
    project,
    percentComplete: computeProjectPercent(req.params.id),
    budget,
    lifetime,
    deliverables: {
      billing: deliverables.filter((d) => d.kind === 'billing'),
      collection: deliverables.filter((d) => d.kind === 'collection'),
    },
  });
});

router.patch('/projects/:id/details', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const body = req.body || {};
  const sets = [];
  const values = [];
  for (const [key, col] of Object.entries(DETAIL_FIELDS)) {
    if (body[key] === undefined) continue;
    sets.push(`${col} = ?`);
    values.push(col.endsWith('_cr') ? Number(body[key]) || 0 : body[key] || null);
  }
  const upsertBudget = db.prepare(`
    INSERT INTO project_budget (project_id, category, budget_cr, expenditure_cr) VALUES (?,?,?,?)
    ON CONFLICT(project_id, category) DO UPDATE SET budget_cr = excluded.budget_cr, expenditure_cr = excluded.expenditure_cr`);

  db.transaction(() => {
    if (sets.length) db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.params.id);
    (Array.isArray(body.budget) ? body.budget : []).forEach((b) => {
      if (!BUDGET_CATEGORIES.includes(b.category)) return;
      upsertBudget.run(req.params.id, b.category, Number(b.budgetCr) || 0, Number(b.expenditureCr) || 0);
    });
  })();
  res.json({ ok: true });
});

router.post('/projects/:id/deliverables', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const { kind, name, valueCr, dueDate } = req.body || {};
  if (!['billing', 'collection'].includes(kind) || !name) {
    return res.status(400).json({ error: 'kind (billing|collection) and name are required' });
  }
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_deliverables WHERE project_id = ? AND kind = ?'
  ).get(req.params.id, kind).m;
  const info = db.prepare(`
    INSERT INTO project_deliverables (project_id, kind, name, value_cr, due_date, sort_order, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    req.params.id, kind, name, Number(valueCr) || 0, dueDate || null, maxOrder + 1, req.user.username, new Date().toISOString()
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

function findDeliverable(req) {
  return db.prepare('SELECT * FROM project_deliverables WHERE id = ? AND project_id = ?').get(req.params.did, req.params.id);
}

// Same rule as activity cells (PRD §4.2): every status change needs the signature tick and is audit-logged.
router.patch('/projects/:id/deliverables/:did', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const existing = findDeliverable(req);
  if (!existing) return res.status(404).json({ error: 'Deliverable not found' });
  const { status, remarks, signed } = req.body || {};
  if (!DELIVERABLE_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!signed) return res.status(400).json({ error: 'Digital signature confirmation is required' });

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE project_deliverables SET status = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .run(status, remarks || '', req.user.username, now, existing.id);
    db.prepare(`
      INSERT INTO deliverable_audit_log (deliverable_id, from_status, to_status, remarks, updated_by, updated_at)
      VALUES (?,?,?,?,?,?)`).run(existing.id, existing.status, status, remarks || '', req.user.username, now);
  })();
  res.json({ ok: true });
});

router.get('/projects/:id/deliverables/:did/history', requireAuth, requireProjectAccess(), (req, res) => {
  if (!findDeliverable(req)) return res.status(404).json({ error: 'Deliverable not found' });
  const history = db.prepare(`
    SELECT from_status AS fromStatus, to_status AS toStatus, remarks, updated_by AS updatedBy, updated_at AS updatedAt
    FROM deliverable_audit_log WHERE deliverable_id = ? ORDER BY updated_at DESC, id DESC`).all(req.params.did);
  res.json({ history });
});

module.exports = router;

const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { canSeeAllProjects, assignedProjectIds, requireProjectAccess } = require('../scope');

const router = express.Router();

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

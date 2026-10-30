const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { requireProjectAccess } = require('../scope');
const { BUDGET_CATEGORIES, DELIVERABLE_STATUS } = require('../dashboardConstants');
const { loadMilestoneConfig, rowPercent } = require('../milestones');
const { getColumnRows } = require('../activityColumns');
const { classifyPbgRenewal } = require('../derivedAlerts');
const { logAudit, describeChanges } = require('../changeLog');

// Project dashboard (mockup page 3): header dates/amounts, budget vs
// expenditure, life cycle totals and the billing/collection deliverables.
const router = express.Router();

// Overall project "% Complete": the plain average of every corridor row's own
// % complete (rowPercent -- the same figure shown per-row on the activity
// grid, weighted by column or by payment milestone per the project's setting
// on that tab), across both Office and Field
// tabs. Each corridor counts equally regardless of tab, so adding/removing
// corridors changes the mix, not a fixed Office/Field 50-50 split.
function computeProjectPercent(projectId) {
  let total = 0, count = 0;
  ['office', 'field'].forEach((tab) => {
    const columnRows = getColumnRows(tab, projectId);
    if (!columnRows.length) return;
    const activities = db.prepare('SELECT id FROM project_activities WHERE project_id = ? AND tab = ?').all(projectId, tab);
    if (!activities.length) return;
    const milestoneConfig = loadMilestoneConfig(projectId, tab);
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
      const pct = rowPercent(cellsByActivity.get(a.id) || {}, columnRows, milestoneConfig);
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

const DETAIL_LABELS = {
  contractStart: 'Contract start', contractEnd: 'Contract end', forecastCompletion: 'Forecast completion', eotUpto: 'EOT upto',
  pbgValidUpto: 'PBG valid upto', unbilledRevenueCr: 'Unbilled revenue (Cr)', retentionCr: 'Retention (Cr)', bankGuaranteeCr: 'Bank guarantee (Cr)',
};

// Budget categories are per-project rows (add / rename / delete). The standard set is
// copied in once, the first time a project's dashboard is read or saved, so new projects
// start with it and it can then be edited freely (budget_seeded stops deleted ones returning).
function ensureBudgetRows(projectId) {
  const p = db.prepare('SELECT budget_seeded FROM projects WHERE id = ?').get(projectId);
  if (!p || p.budget_seeded) return;
  const seed = db.prepare(`
    INSERT INTO project_budget (project_id, category, budget_cr, expenditure_cr, sort_order) VALUES (?,?,0,0,?)
    ON CONFLICT(project_id, category) DO UPDATE SET sort_order = excluded.sort_order`);
  db.transaction(() => {
    BUDGET_CATEGORIES.forEach((category, i) => seed.run(projectId, category, i));
    db.prepare('UPDATE projects SET budget_seeded = 1 WHERE id = ?').run(projectId);
  })();
}

const BUDGET_SELECT = 'SELECT id, category, budget_cr AS budgetCr, expenditure_cr AS expenditureCr FROM project_budget WHERE project_id = ? ORDER BY sort_order, id';

router.get('/projects/:id/dashboard', requireAuth, requireProjectAccess(), (req, res) => {
  const project = db.prepare(`
    SELECT id, code, name, type, wo_value_cr AS woValueCr, contract_start AS contractStart, contract_end AS contractEnd,
           forecast_completion AS forecastCompletion, eot_upto AS eotUpto, pbg_valid_upto AS pbgValidUpto,
           pbg_prev_valid_upto AS pbgPrevValidUpto, unbilled_revenue_cr AS unbilledRevenueCr, retention_cr AS retentionCr, bank_guarantee_cr AS bankGuaranteeCr,
           activity_layout AS activityLayout
    FROM projects WHERE id = ?`).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  ensureBudgetRows(project.id);
  const budget = db.prepare(BUDGET_SELECT).all(project.id);

  const lifetime = db.prepare(`
    SELECT COALESCE(SUM(actual_billing),0) AS billing, COALESCE(SUM(actual_collection),0) AS collection
    FROM financial_entries WHERE project_id = ?`).get(req.params.id);

  const deliverables = db.prepare(`
    SELECT d.id, d.kind, d.name, d.status, d.value_cr AS valueCr, d.due_date AS dueDate, d.remarks,
           (SELECT COUNT(*) FROM deliverable_audit_log a WHERE a.deliverable_id = d.id) AS historyCount
    FROM project_deliverables d WHERE d.project_id = ? ORDER BY d.sort_order, d.id`).all(req.params.id);

  res.json({
    project,
    pbgRenewal: classifyPbgRenewal(project.eotUpto, project.pbgValidUpto),
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
  // Contractual end date is frozen once set; only an approved change request (or an admin) may alter it.
  if (body.contractEnd !== undefined && req.user.role !== 'admin') {
    const current = db.prepare('SELECT contract_end FROM projects WHERE id = ?').get(req.params.id);
    if (current && current.contract_end && (body.contractEnd || null) !== current.contract_end) {
      return res.status(409).json({ error: 'Contractual end date is frozen — request a change for management approval', frozen: ['contractEnd'] });
    }
  }
  const sets = [];
  const values = [];
  // Remember the date the PBG was changed from, so the project view can flag the change.
  if (body.pbgValidUpto !== undefined) {
    const current = db.prepare('SELECT pbg_valid_upto FROM projects WHERE id = ?').get(req.params.id);
    const next = body.pbgValidUpto || null;
    if (current && current.pbg_valid_upto !== next) {
      sets.push('pbg_prev_valid_upto = ?');
      values.push(next ? current.pbg_valid_upto : null);
    }
  }
  for (const [key, col] of Object.entries(DETAIL_FIELDS)) {
    if (body[key] === undefined) continue;
    sets.push(`${col} = ?`);
    values.push(col.endsWith('_cr') ? Number(body[key]) || 0 : body[key] || null);
  }

  // `budget`, when sent, is the project's complete category list: rows with an id are
  // updated (incl. rename), rows without one are added, stored rows left out are deleted.
  let budgetRows = null;
  if (Array.isArray(body.budget)) {
    budgetRows = body.budget.map((b) => ({
      id: Number(b.id) || null, category: String(b.category || '').trim(),
      budgetCr: Number(b.budgetCr) || 0, expenditureCr: Number(b.expenditureCr) || 0,
    }));
    if (budgetRows.some((b) => !b.category)) return res.status(400).json({ error: 'Every budget category needs a name' });
    const names = budgetRows.map((b) => b.category.toLowerCase());
    if (new Set(names).size !== names.length) return res.status(400).json({ error: 'Budget category names must be unique' });
  }

  ensureBudgetRows(req.params.id);
  const before = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  const budgetBefore = new Map(db.prepare(BUDGET_SELECT).all(req.params.id).map((r) => [r.id, r]));

  db.transaction(() => {
    if (sets.length) db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, req.params.id);
    const changes = [];
    if (before) {
      const after = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
      const d = describeChanges(before, after, Object.fromEntries(Object.entries(DETAIL_FIELDS).map(([k, col]) => [col, DETAIL_LABELS[k]])));
      if (d) changes.push(d);
    }
    if (budgetRows) {
      const kept = new Set(budgetRows.filter((b) => budgetBefore.has(b.id)).map((b) => b.id));
      budgetBefore.forEach((old) => {
        if (kept.has(old.id)) return;
        db.prepare('DELETE FROM project_budget WHERE id = ?').run(old.id);
        changes.push(`Removed budget category ${old.category}`);
      });
      // Park renamed rows on a temporary name first so swapping two names can't trip UNIQUE(project_id, category).
      budgetRows.forEach((b) => {
        const old = budgetBefore.get(b.id);
        if (old && old.category !== b.category) db.prepare('UPDATE project_budget SET category = ? WHERE id = ?').run(`\u0000${old.id}`, old.id);
      });
      budgetRows.forEach((b, i) => {
        const old = budgetBefore.get(b.id);
        if (!old) {
          db.prepare('INSERT INTO project_budget (project_id, category, budget_cr, expenditure_cr, sort_order) VALUES (?,?,?,?,?)')
            .run(req.params.id, b.category, b.budgetCr, b.expenditureCr, i);
          changes.push(`Added budget category ${b.category} (budget ${b.budgetCr} Cr, expenditure ${b.expenditureCr} Cr)`);
          return;
        }
        db.prepare('UPDATE project_budget SET category = ?, budget_cr = ?, expenditure_cr = ?, sort_order = ? WHERE id = ?')
          .run(b.category, b.budgetCr, b.expenditureCr, i, old.id);
        const d = describeChanges(old, b, { category: 'name', budgetCr: 'budget (Cr)', expenditureCr: 'expenditure (Cr)' });
        if (d) changes.push(`${old.category} — ${d}`);
      });
    }
    if (changes.length) {
      logAudit(req.user, { projectId: Number(req.params.id), area: 'details', action: 'update', subject: before ? `${before.code} — project details` : 'Project details', detail: changes.join(' | ') });
    }
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
  logAudit(req.user, {
    projectId: Number(req.params.id), area: 'deliverable', action: 'create', subject: `${kind === 'billing' ? 'Billing' : 'Collection'} — ${name}`,
    detail: [`Value: ${Number(valueCr) || 0} Cr`, dueDate && `Due: ${dueDate}`].filter(Boolean).join('; '),
  });
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
    logAudit(req.user, {
      projectId: Number(req.params.id), area: 'deliverable', action: 'update', subject: `${existing.kind === 'billing' ? 'Billing' : 'Collection'} — ${existing.name}`,
      detail: [`Status: ${existing.status} → ${status}`, (remarks || '') !== (existing.remarks || '') && `Remarks: ${remarks || '—'}`].filter(Boolean).join('; '),
    });
  })();
  res.json({ ok: true });
});

router.get('/projects/:id/deliverables/:did/history', requireAuth, requireProjectAccess(), (req, res) => {
  if (!findDeliverable(req)) return res.status(404).json({ error: 'Deliverable not found' });
  const history = db.prepare(`
    SELECT l.from_status AS fromStatus, l.to_status AS toStatus, l.remarks, l.updated_by AS updatedBy, u.display_name AS updatedByName, l.updated_at AS updatedAt
    FROM deliverable_audit_log l LEFT JOIN users u ON u.username = l.updated_by WHERE l.deliverable_id = ? ORDER BY l.updated_at DESC, l.id DESC`).all(req.params.did);
  res.json({ history });
});

module.exports = router;

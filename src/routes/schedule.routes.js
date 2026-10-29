const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { requireProjectAccess } = require('../scope');
const { deriveScheduleStatus } = require('../scheduleConstants');

// Schedule / resource-planning module (from "NR schedule stage 1 -Final.xlsx"):
// a flat task list per stretch with planned dates + resourcing, separate from
// the Office/Field status grid (see activities.routes.js).
const router = express.Router();

router.get('/projects/:id/schedule', requireAuth, requireProjectAccess(), (req, res) => {
  const items = db.prepare(`
    SELECT id, stretch, route_length_km AS routeLengthKm, work_item AS workItem, quantity, resources, productivity,
           days_required AS daysRequired, planned_start AS plannedStart, lead_lag_days AS leadLagDays,
           planned_finish AS plannedFinish, predecessor, design_expenditure_cr AS designExpenditureCr,
           actual_completion AS actualCompletion, remarks, updated_by AS updatedBy, updated_at AS updatedAt
    FROM schedule_items WHERE project_id = ? ORDER BY sort_order, id`).all(req.params.id);
  res.json({ items: items.map((it) => ({ ...it, status: deriveScheduleStatus(it) })) });
});

router.post('/projects/:id/schedule', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const { stretch, routeLengthKm, workItem, quantity, resources, productivity, daysRequired, plannedStart, leadLagDays, plannedFinish, predecessor, designExpenditureCr } = req.body || {};
  if (!stretch || !workItem) return res.status(400).json({ error: 'stretch and workItem are required' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM schedule_items WHERE project_id = ?').get(req.params.id).m;
  const info = db.prepare(`
    INSERT INTO schedule_items (project_id, stretch, route_length_km, work_item, quantity, resources, productivity,
      days_required, planned_start, lead_lag_days, planned_finish, predecessor, design_expenditure_cr, sort_order, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.params.id, stretch, routeLengthKm || null, workItem, quantity || null, resources || null, productivity || null,
    daysRequired || null, plannedStart || null, leadLagDays || 0, plannedFinish || null, predecessor || null, designExpenditureCr || null,
    maxOrder + 1, req.user.username, new Date().toISOString()
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/projects/:id/schedule/:itemId', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const existing = db.prepare('SELECT id FROM schedule_items WHERE id = ? AND project_id = ?').get(req.params.itemId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule item not found' });
  const { actualCompletion, remarks } = req.body || {};
  db.prepare('UPDATE schedule_items SET actual_completion = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .run(actualCompletion || null, remarks || '', req.user.username, new Date().toISOString(), existing.id);
  res.json({ ok: true });
});

// Reference data: resource rate card is internal cost information, not shown
// to pmo (field/office executives) — mgmt and admin only.
router.get('/resource-rates', requireAuth, requireAnyRole('mgmt'), (req, res) => {
  const rates = db.prepare('SELECT role, monthly_rate AS monthlyRate FROM resource_rates ORDER BY monthly_rate DESC').all();
  res.json({ rates });
});

router.get('/holidays', requireAuth, (req, res) => {
  const holidays = db.prepare('SELECT holiday_date AS date, description FROM holidays ORDER BY holiday_date').all();
  res.json({ holidays });
});

module.exports = router;

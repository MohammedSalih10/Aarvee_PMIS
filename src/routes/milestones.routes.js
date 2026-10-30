const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { requireProjectAccess } = require('../scope');
const { loadMilestoneConfig } = require('../milestones');
const { getColumnRows } = require('../activityColumns');
const { logActivityChange } = require('../changeLog');

// Payment-milestone (KD) header band for a project's activity grid: which
// columns sit under which KD, each KD's claim weightage, and whether the
// corridor "% Complete" is weighted by column or by KD.
const router = express.Router();

const tabOf = (v) => (v === 'field' ? 'field' : 'office');

router.get('/projects/:id/milestones', requireAuth, requireProjectAccess(), (req, res) => {
  const tab = tabOf(req.query.tab);
  res.json({ tab, ...loadMilestoneConfig(req.params.id, tab) });
});

// Replaces the tab's whole milestone set (sent as one unit since the weights
// only make sense together). An empty list removes the band.
router.put('/projects/:id/milestones', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const { tab, basis, milestones } = req.body || {};
  if (!['office', 'field'].includes(tab) || !Array.isArray(milestones)) {
    return res.status(400).json({ error: 'tab (office|field) and milestones are required' });
  }
  if (!['column', 'kd'].includes(basis)) return res.status(400).json({ error: 'basis must be column or kd' });

  const tabColumns = getColumnRows(tab, req.params.id);
  const validCols = new Set(tabColumns.map((c) => c.id));
  const usedCols = new Set(), labels = new Set();
  let sum = 0;
  const clean = [];
  for (const m of milestones) {
    const label = String((m && m.label) || '').trim();
    const weightage = Number(m && m.weightage);
    if (!label) return res.status(400).json({ error: 'Every milestone needs a name' });
    if (labels.has(label.toLowerCase())) return res.status(400).json({ error: `Milestone name "${label}" is used twice` });
    labels.add(label.toLowerCase());
    if (!Number.isFinite(weightage) || weightage < 0) return res.status(400).json({ error: `${label}: weightage must be a non-negative number` });
    const columnIds = Array.isArray(m.columnIds) ? m.columnIds.map(Number) : [];
    for (const id of columnIds) {
      if (!validCols.has(id)) return res.status(400).json({ error: `${label}: unknown column for this tab` });
      if (usedCols.has(id)) return res.status(400).json({ error: 'A column can sit under only one milestone' });
      usedCols.add(id);
    }
    sum += weightage;
    clean.push({ label, weightage, columnIds });
  }
  if (clean.length && Math.abs(sum - 100) > 0.05) {
    return res.status(400).json({ error: `Milestone weightage must sum to 100 (currently ${sum.toFixed(1)})` });
  }
  if (basis === 'kd' && !clean.some((m) => m.weightage > 0 && m.columnIds.length)) {
    return res.status(400).json({ error: 'Computing % complete by milestone needs at least one weighted milestone with columns' });
  }

  const pid = req.params.id;
  const before = loadMilestoneConfig(pid, tab);
  const colName = new Map(tabColumns.map((c) => [c.id, c.name]));
  const colList = (ids) => (ids.length ? ids.map((id) => colName.get(id)).join(', ') : 'no columns');
  const diffs = [];
  const oldByLabel = new Map(before.milestones.map((m) => [m.label.toLowerCase(), m]));
  clean.forEach((m) => {
    const old = oldByLabel.get(m.label.toLowerCase());
    oldByLabel.delete(m.label.toLowerCase());
    if (!old) { diffs.push({ subject: m.label, action: 'create', detail: `Added — ${m.weightage}%, ${colList(m.columnIds)}` }); return; }
    const parts = [];
    if (old.weightage !== m.weightage) parts.push(`Weightage: ${old.weightage}% → ${m.weightage}%`);
    const a = [...old.columnIds].sort((x, y) => x - y).join(), b = [...m.columnIds].sort((x, y) => x - y).join();
    if (a !== b) parts.push(`Columns: ${colList(old.columnIds)} → ${colList(m.columnIds)}`);
    if (parts.length) diffs.push({ subject: m.label, action: 'update', detail: parts.join('; ') });
  });
  oldByLabel.forEach((old) => diffs.push({ subject: old.label, action: 'delete', detail: 'KD removed' }));
  const newBasis = clean.length ? basis : 'column';
  if (newBasis !== before.basis) {
    const basisText = (b) => (b === 'kd' ? 'KD weightages' : 'Column weightages');
    diffs.push({ subject: '% Complete basis', action: 'update', detail: `Computed from: ${basisText(before.basis)} → ${basisText(newBasis)}` });
  }

  db.transaction(() => {
    diffs.forEach((d) => logActivityChange(req.user, { projectId: Number(pid), tab, panel: 'milestone', ...d }));
    db.prepare('DELETE FROM project_milestones WHERE project_id = ? AND tab = ?').run(pid, tab);
    db.prepare('DELETE FROM project_milestone_config WHERE project_id = ? AND tab = ?').run(pid, tab);
    if (!clean.length) return;
    db.prepare('INSERT INTO project_milestone_config (project_id, tab, percent_basis) VALUES (?,?,?)').run(pid, tab, basis);
    const insM = db.prepare('INSERT INTO project_milestones (project_id, tab, label, weightage, sort_order) VALUES (?,?,?,?,?)');
    const insC = db.prepare('INSERT INTO project_milestone_columns (milestone_id, column_id) VALUES (?,?)');
    clean.forEach((m, i) => {
      const { lastInsertRowid } = insM.run(pid, tab, m.label, m.weightage, i);
      m.columnIds.forEach((id) => insC.run(lastInsertRowid, id));
    });
  })();
  res.json({ ok: true });
});

module.exports = router;

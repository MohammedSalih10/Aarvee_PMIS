const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { canSeeAllProjects, assignedProjectIds, requireProjectAccess } = require('../scope');
const { logAudit, logActivityChange, describeChanges } = require('../changeLog');
const { seedMergedColumns } = require('../mergedDefaults');

const router = express.Router();
router.use(requireAuth);

const PROJECT_COLUMNS = 'id, code, name, type, wo_value_cr AS woValueCr, responsible_person AS responsiblePerson, stage, activity_layout AS activityLayout';

router.get('/', (req, res) => {
  let rows = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at DESC, id DESC`).all();
  if (!canSeeAllProjects(req.user)) {
    const ids = new Set(assignedProjectIds(req.user.username));
    rows = rows.filter((p) => ids.has(p.id));
  }
  res.json({ projects: rows });
});

router.get('/:id', requireProjectAccess(), (req, res) => {
  const project = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project });
});

// Project provisioning (core record: code/name/type/WO value/stage/owner)
// is a pmo/admin action per PRD §1.2 — mgmt operates within assigned
// projects, it doesn't create them.
router.post('/', requireAnyRole('pmo'), (req, res) => {
  const { code, name, type, woValueCr, responsiblePerson, stage, activityLayout } = req.body || {};
  if (!code || !name || !['FLS', 'DPR'].includes(type)) {
    return res.status(400).json({ error: 'code, name and type (FLS|DPR) are required' });
  }
  if (activityLayout && !['split', 'combined'].includes(activityLayout)) {
    return res.status(400).json({ error: 'activityLayout must be split or combined' });
  }
  const layout = activityLayout || 'split';
  let info;
  try {
    info = db.prepare(
      'INSERT INTO projects (code, name, type, wo_value_cr, responsible_person, stage, activity_layout) VALUES (?,?,?,?,?,?,?)'
    ).run(code, name, type, woValueCr || 0, responsiblePerson || null, stage || null, layout);
  } catch {
    return res.status(400).json({ error: 'A project with that code already exists' });
  }
  logAudit(req.user, {
    projectId: info.lastInsertRowid, area: 'project', action: 'create', subject: `${code} — ${name}`,
    detail: [`Type: ${type}`, `WO value: ${woValueCr || 0} Cr`, stage && `Stage: ${stage}`, responsiblePerson && `Responsible: ${responsiblePerson}`, layout === 'combined' && 'Activity layout: combined'].filter(Boolean).join('; '),
  });
  // A merged-layout project starts with its own editable copy of the standard merged column heads.
  if (layout === 'combined') logSeededColumns(req.user, info.lastInsertRowid, seedMergedColumns(info.lastInsertRowid));
  res.status(201).json({ id: info.lastInsertRowid });
});

function logSeededColumns(user, projectId, added) {
  if (!added) return;
  logActivityChange(user, { projectId, tab: 'office', panel: 'column', action: 'create', subject: 'Default columns', detail: `${added} default Office and Field activity columns added` });
}

router.patch('/:id', requireAnyRole('pmo'), (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  const { name, type, woValueCr, responsiblePerson, stage, activityLayout } = req.body || {};
  if (name !== undefined && name !== existing.name) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can rename a project' });
    if (!String(name).trim()) return res.status(400).json({ error: 'Project name is required' });
  }
  if (type && !['FLS', 'DPR'].includes(type)) {
    return res.status(400).json({ error: 'type must be FLS or DPR' });
  }
  if (activityLayout && !['split', 'combined'].includes(activityLayout)) {
    return res.status(400).json({ error: 'activityLayout must be split or combined' });
  }
  const after = {
    name: name ?? existing.name, type: type ?? existing.type, wo_value_cr: woValueCr ?? existing.wo_value_cr,
    responsible_person: responsiblePerson ?? existing.responsible_person, stage: stage ?? existing.stage,
    activity_layout: activityLayout ?? existing.activity_layout,
  };
  db.transaction(() => {
    db.prepare(
      'UPDATE projects SET name = ?, type = ?, wo_value_cr = ?, responsible_person = ?, stage = ?, activity_layout = ? WHERE id = ?'
    ).run(after.name, after.type, after.wo_value_cr, after.responsible_person, after.stage, after.activity_layout, req.params.id);
    const detail = describeChanges(existing, after, {
      name: 'Name', type: 'Type', wo_value_cr: 'WO value (Cr)', responsible_person: 'Responsible', stage: 'Stage',
      activity_layout: 'Activity layout',
    });
    if (detail) logAudit(req.user, { projectId: existing.id, area: 'project', action: 'update', subject: `${existing.code} — ${after.name}`, detail });
  })();
  // Switching a project to the merged layout gives it the standard merged column heads, unless it
  // already has its own columns or recorded statuses (seedMergedColumns leaves those alone).
  let seededColumns = 0;
  if (after.activity_layout === 'combined' && existing.activity_layout !== 'combined') {
    seededColumns = seedMergedColumns(existing.id);
    logSeededColumns(req.user, existing.id, seededColumns);
  }
  res.json({ ok: true, seededColumns });
});

// Admin only (not pmo): removes the project and, by cascade, everything under it.
router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can delete a project' });
  const existing = db.prepare('SELECT id, code, name FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  db.transaction(() => {
    // Logged first so the project code can still be looked up for the snapshot.
    logAudit(req.user, { projectId: existing.id, area: 'project', action: 'delete', subject: `${existing.code} — ${existing.name}`, detail: 'Project deleted with all its data' });
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

module.exports = router;

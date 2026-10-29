const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { canSeeAllProjects, assignedProjectIds, requireProjectAccess } = require('../scope');

const router = express.Router();
router.use(requireAuth);

const PROJECT_COLUMNS = 'id, code, name, type, wo_value_cr AS woValueCr, division, responsible_person AS responsiblePerson, stage';

router.get('/', (req, res) => {
  let rows = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY code`).all();
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

// Project provisioning (core record: code/name/type/WO value/division/stage/owner)
// is a pmo/admin action per PRD §1.2 — mgmt operates within assigned
// projects, it doesn't create them.
router.post('/', requireAnyRole('pmo'), (req, res) => {
  const { code, name, type, woValueCr, division, responsiblePerson, stage } = req.body || {};
  if (!code || !name || !['FLS', 'DPR'].includes(type)) {
    return res.status(400).json({ error: 'code, name and type (FLS|DPR) are required' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO projects (code, name, type, wo_value_cr, division, responsible_person, stage) VALUES (?,?,?,?,?,?,?)'
    ).run(code, name, type, woValueCr || 0, division || null, responsiblePerson || null, stage || null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'A project with that code already exists' });
  }
});

router.patch('/:id', requireAnyRole('pmo'), (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  const { name, type, woValueCr, division, responsiblePerson, stage } = req.body || {};
  if (type && !['FLS', 'DPR'].includes(type)) {
    return res.status(400).json({ error: 'type must be FLS or DPR' });
  }
  db.prepare(
    'UPDATE projects SET name = ?, type = ?, wo_value_cr = ?, division = ?, responsible_person = ?, stage = ? WHERE id = ?'
  ).run(
    name ?? existing.name,
    type ?? existing.type,
    woValueCr ?? existing.wo_value_cr,
    division ?? existing.division,
    responsiblePerson ?? existing.responsible_person,
    stage ?? existing.stage,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id', requireAnyRole('pmo'), (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

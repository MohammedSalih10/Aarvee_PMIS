const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { requireProjectAccess } = require('../scope');
const { logAudit } = require('../changeLog');

const router = express.Router();

const PROJECT_ROLES = ['lead', 'coordinator'];
const roleLabel = (r) => (r === 'lead' ? 'Project Lead' : r === 'coordinator' ? 'Project Coordinator' : 'none');

// "Edit access: granted X; revoked Y" for a corridor list replaced wholesale;
// an empty list means unrestricted for view access and none for edit access, so
// say so rather than listing nothing.
function describeList(before, after, label) {
  const added = after.filter((c) => !before.includes(c));
  const removed = before.filter((c) => !after.includes(c));
  if (!added.length && !removed.length) return '';
  const parts = [];
  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  const now = after.length ? after.join(', ') : (label === 'View access' ? 'all corridors' : 'none');
  return `${label}: ${parts.join('; ')} (now: ${now})`;
}

// Granting per-corridor edit access is admin-only -- pmo keeps every other
// assignment-management capability (roles, view-restriction corridors,
// add/remove members) but not this one.
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not permitted for your role' });
  next();
}

// A project_role is a per-project title (Project Lead / Project Coordinator);
// only one assignment per project may hold a given title at a time, so
// granting it to someone clears it from whoever held it before.
function grantProjectRole(projectId, role, username) {
  db.transaction(() => {
    db.prepare('UPDATE project_assignments SET project_role = NULL WHERE project_id = ? AND project_role = ?')
      .run(projectId, role);
    db.prepare('UPDATE project_assignments SET project_role = ? WHERE project_id = ? AND username = ?')
      .run(role, projectId, username);
  })();
}

router.get('/projects/:id/assignments', requireAuth, requireProjectAccess(), (req, res) => {
  const rows = db.prepare(
    `SELECT pa.username, u.display_name AS displayName, u.role, pa.project_role AS projectRole
     FROM project_assignments pa JOIN users u ON u.username = pa.username
     WHERE pa.project_id = ? ORDER BY u.role, u.username`
  ).all(req.params.id);
  res.json({ assignments: rows });
});

// Only pmo (and admin, which has every pmo capability) may assign or remove
// project members. mgmt is review-only here, same as everywhere else.
router.post('/projects/:id/assignments', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const { username, projectRole } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });
  if (projectRole && !PROJECT_ROLES.includes(projectRole)) {
    return res.status(400).json({ error: 'projectRole must be lead or coordinator' });
  }
  const target = db.prepare('SELECT role FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'No such user' });
  try {
    db.prepare(
      'INSERT INTO project_assignments (project_id, username, assigned_by) VALUES (?,?,?)'
    ).run(req.params.id, username, req.user.username);
  } catch {
    return res.status(400).json({ error: 'That user is already assigned to this project' });
  }
  if (projectRole) grantProjectRole(req.params.id, projectRole, username);
  logAudit(req.user, {
    projectId: Number(req.params.id), area: 'access', action: 'create', subject: username,
    detail: `Added to the project${projectRole ? ` as Project ${projectRole === 'lead' ? 'Lead' : 'Coordinator'}` : ''}`,
  });
  res.status(201).json({ ok: true });
});

// PMO picks who holds the Project Lead / Project Coordinator title for this
// project; the target must already be an assigned member. Pass projectRole:
// null to clear the title without removing the person's project access.
router.patch('/projects/:id/assignments/:username', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const { projectRole } = req.body || {};
  if (projectRole && !PROJECT_ROLES.includes(projectRole)) {
    return res.status(400).json({ error: 'projectRole must be lead or coordinator' });
  }
  const row = db.prepare('SELECT project_role AS projectRole FROM project_assignments WHERE project_id = ? AND username = ?')
    .get(req.params.id, req.params.username);
  if (!row) return res.status(404).json({ error: 'That user is not assigned to this project' });
  // Granting a title takes it from whoever held it before; note that in the log too.
  const previousHolder = projectRole
    ? db.prepare('SELECT username FROM project_assignments WHERE project_id = ? AND project_role = ? AND username != ?').get(req.params.id, projectRole, req.params.username)
    : null;
  if (projectRole) {
    grantProjectRole(req.params.id, projectRole, req.params.username);
  } else {
    db.prepare('UPDATE project_assignments SET project_role = NULL WHERE project_id = ? AND username = ?')
      .run(req.params.id, req.params.username);
  }
  logAudit(req.user, {
    projectId: Number(req.params.id), area: 'access', action: 'update', subject: req.params.username,
    detail: `Project role: ${roleLabel(row.projectRole)} → ${roleLabel(projectRole)}${previousHolder ? ` (taken from ${previousHolder.username})` : ''}`,
  });
  res.json({ ok: true });
});

router.delete('/projects/:id/assignments/:username', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const info = db.prepare('DELETE FROM project_assignments WHERE project_id = ? AND username = ?').run(req.params.id, req.params.username);
  if (info.changes) logAudit(req.user, { projectId: Number(req.params.id), area: 'access', action: 'delete', subject: req.params.username, detail: 'Removed from the project' });
  res.json({ ok: true });
});

// All distinct corridor names in this project (shared across Office/Field),
// for the "restrict to specific corridors" picker below. Ordered the same way
// the activity grid orders its rows (sort_order, lowest first across both
// tabs) rather than alphabetically, so this list lines up with what the admin
// sees on the Office/Field screens instead of looking shuffled.
router.get('/projects/:id/corridors', requireAuth, requireProjectAccess(), (req, res) => {
  const rows = db.prepare(
    `SELECT corridor, MIN(sort_order) AS so FROM project_activities WHERE project_id = ?
     GROUP BY corridor ORDER BY so, corridor`
  ).all(req.params.id);
  res.json({ corridors: rows.map((r) => r.corridor) });
});

function findAssignment(req) {
  return db.prepare('SELECT id FROM project_assignments WHERE project_id = ? AND username = ?')
    .get(req.params.id, req.params.username);
}

// Empty corridors array = unrestricted (every corridor in the project), the
// default for every assignment until a PMO narrows it down here.
router.get('/projects/:id/assignments/:username/corridors', requireAuth, requireProjectAccess(), (req, res) => {
  const assignment = findAssignment(req);
  if (!assignment) return res.status(404).json({ error: 'That user is not assigned to this project' });
  const corridors = db.prepare('SELECT corridor FROM assignment_corridors WHERE assignment_id = ?')
    .all(assignment.id).map((r) => r.corridor);
  res.json({ corridors });
});

router.put('/projects/:id/assignments/:username/corridors', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const { corridors } = req.body || {};
  if (!Array.isArray(corridors)) return res.status(400).json({ error: 'corridors must be an array' });
  const assignment = findAssignment(req);
  if (!assignment) return res.status(404).json({ error: 'That user is not assigned to this project' });
  const valid = new Set(
    db.prepare('SELECT DISTINCT corridor FROM project_activities WHERE project_id = ?').all(req.params.id).map((r) => r.corridor)
  );
  const clean = [...new Set(corridors)].filter((c) => valid.has(c));
  db.transaction(() => {
    const before = db.prepare('SELECT corridor FROM assignment_corridors WHERE assignment_id = ?').all(assignment.id).map((r) => r.corridor);
    db.prepare('DELETE FROM assignment_corridors WHERE assignment_id = ?').run(assignment.id);
    const ins = db.prepare('INSERT INTO assignment_corridors (assignment_id, corridor) VALUES (?,?)');
    clean.forEach((c) => ins.run(assignment.id, c));
    const detail = describeList(before, clean, 'View access');
    if (detail) logAudit(req.user, { projectId: Number(req.params.id), area: 'access', action: 'update', subject: req.params.username, detail });
  })();
  res.json({ ok: true });
});

// Edit-access grant, on top of the view restriction above: which corridors
// this Project Lead/Coordinator may edit (activity rows + status cells), not
// just view. Empty = no edit access, the default. Only meaningful while the
// assignment holds project_role lead/coordinator (see canEditCorridor), but
// the grant itself is kept even if the title changes hands later so it's
// simply inactive rather than lost, in case it's handed back.
// Admin-only (see requireAdmin above) -- unlike the rest of this file, pmo
// does not get this capability.
router.get('/projects/:id/assignments/:username/edit-corridors', requireAuth, requireProjectAccess(), requireAdmin, (req, res) => {
  const assignment = findAssignment(req);
  if (!assignment) return res.status(404).json({ error: 'That user is not assigned to this project' });
  const corridors = db.prepare('SELECT corridor FROM assignment_edit_corridors WHERE assignment_id = ?')
    .all(assignment.id).map((r) => r.corridor);
  res.json({ corridors });
});

router.put('/projects/:id/assignments/:username/edit-corridors', requireAuth, requireProjectAccess(), requireAdmin, (req, res) => {
  const { corridors } = req.body || {};
  if (!Array.isArray(corridors)) return res.status(400).json({ error: 'corridors must be an array' });
  const assignment = db.prepare(
    'SELECT id, project_role AS projectRole FROM project_assignments WHERE project_id = ? AND username = ?'
  ).get(req.params.id, req.params.username);
  if (!assignment) return res.status(404).json({ error: 'That user is not assigned to this project' });
  if (!['lead', 'coordinator'].includes(assignment.projectRole)) {
    return res.status(400).json({ error: 'Edit access can only be granted to the Project Lead or Coordinator' });
  }
  const valid = new Set(
    db.prepare('SELECT DISTINCT corridor FROM project_activities WHERE project_id = ?').all(req.params.id).map((r) => r.corridor)
  );
  const clean = [...new Set(corridors)].filter((c) => valid.has(c));
  db.transaction(() => {
    const before = db.prepare('SELECT corridor FROM assignment_edit_corridors WHERE assignment_id = ?').all(assignment.id).map((r) => r.corridor);
    db.prepare('DELETE FROM assignment_edit_corridors WHERE assignment_id = ?').run(assignment.id);
    const ins = db.prepare('INSERT INTO assignment_edit_corridors (assignment_id, corridor) VALUES (?,?)');
    clean.forEach((c) => ins.run(assignment.id, c));
    const detail = describeList(before, clean, 'Edit access');
    if (detail) logAudit(req.user, { projectId: Number(req.params.id), area: 'access', action: 'update', subject: req.params.username, detail });
  })();
  res.json({ ok: true });
});

module.exports = router;

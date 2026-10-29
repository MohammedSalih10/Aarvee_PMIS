const db = require('./db');

// admin, pmo and mgmt all see every project with no assignment needed --
// admin/pmo because they're the app's editors/admins, mgmt because its whole
// job is reviewing everything. Only 'member' (a Project Lead/Coordinator or
// other site reviewer) is scoped to projects pmo explicitly assigns them to
// via project_assignments -- that table exists for member-scoping (and
// tagging a member as Project Lead/Coordinator), not for admin/pmo/mgmt, who
// never need to be "added" to a project they can already see.
function isAdmin(user) {
  return user.role === 'admin';
}

function canSeeAllProjects(user) {
  return user.role === 'admin' || user.role === 'pmo' || user.role === 'mgmt';
}

function assignedProjectIds(username) {
  return db.prepare('SELECT project_id FROM project_assignments WHERE username = ?')
    .all(username)
    .map((r) => r.project_id);
}

function canAccessProject(user, projectId) {
  if (canSeeAllProjects(user)) return true;
  const row = db.prepare(
    'SELECT 1 FROM project_assignments WHERE project_id = ? AND username = ?'
  ).get(projectId, user.username);
  return !!row;
}

// Express middleware: requires :id (or :projectId) in the route to be a
// project the signed-in user is allowed to touch. Mount after requireAuth.
function requireProjectAccess(paramName = 'id') {
  return (req, res, next) => {
    const projectId = Number(req.params[paramName]);
    if (!canAccessProject(req.user, projectId)) {
      return res.status(403).json({ error: 'You are not assigned to this project' });
    }
    next();
  };
}

// Corridor-level restriction, layered on top of (not instead of) project
// assignment: a PMO can optionally limit any assigned member (plain member,
// Project Coordinator, or Project Lead) to specific corridors. No
// assignment_corridors rows for that assignment = unrestricted, i.e. every
// corridor in the project -- the original, still-default behavior.
function restrictedCorridors(projectId, username) {
  const assignment = db.prepare(
    'SELECT id FROM project_assignments WHERE project_id = ? AND username = ?'
  ).get(projectId, username);
  if (!assignment) return null; // not assigned at all; caller should have already checked canAccessProject
  return db.prepare('SELECT corridor FROM assignment_corridors WHERE assignment_id = ?')
    .all(assignment.id).map((r) => r.corridor);
}

function canAccessCorridor(user, projectId, corridor) {
  if (canSeeAllProjects(user)) return true;
  const restricted = restrictedCorridors(projectId, user.username);
  if (restricted == null) return false; // not assigned to the project at all
  return restricted.length === 0 || restricted.includes(corridor);
}

// Edit grant on top of (not instead of) the view restriction above: an
// admin/pmo can allow a member currently titled Project Lead or Coordinator
// to edit specific corridors (activity rows + status cells). No
// assignment_edit_corridors rows = no edit access, the default for every
// member -- plain read-only members, and a lead/coordinator with no grant
// yet, fall through to false here same as before this feature existed.
function editableCorridors(projectId, username) {
  const assignment = db.prepare(
    'SELECT id, project_role AS projectRole FROM project_assignments WHERE project_id = ? AND username = ?'
  ).get(projectId, username);
  if (!assignment || !['lead', 'coordinator'].includes(assignment.projectRole)) return [];
  return db.prepare('SELECT corridor FROM assignment_edit_corridors WHERE assignment_id = ?')
    .all(assignment.id).map((r) => r.corridor);
}

function canEditCorridor(user, projectId, corridor) {
  // admin/pmo are the app's editors everywhere; mgmt is a read-only reviewer
  // (canSeeAllProjects would wrongly include it here, so check explicitly).
  if (user.role === 'admin' || user.role === 'pmo') return true;
  if (user.role !== 'member') return false;
  if (!canAccessCorridor(user, projectId, corridor)) return false;
  return editableCorridors(projectId, user.username).includes(corridor);
}

module.exports = {
  isAdmin, canSeeAllProjects, assignedProjectIds, canAccessProject, requireProjectAccess,
  restrictedCorridors, canAccessCorridor, editableCorridors, canEditCorridor,
};

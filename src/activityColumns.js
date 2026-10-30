const db = require('./db');

// Activity columns are DB-backed (activity_columns). project_id NULL is the set
// shared by every project for a tab; a project that has any rows of its own for
// a tab uses only those, leaving the shared set (and every other project)
// untouched.

// The project id whose own column set applies to this project+tab, or null when
// it uses the shared set.
function columnScope(projectId, tab) {
  if (projectId == null || projectId === '') return null;
  const own = db.prepare('SELECT 1 FROM activity_columns WHERE project_id = ? AND tab = ? LIMIT 1').get(Number(projectId), tab);
  return own ? Number(projectId) : null;
}

function getColumnRows(tab, projectId) {
  const scope = columnScope(projectId, tab);
  return scope == null
    ? db.prepare('SELECT id, column_key AS name, weightage FROM activity_columns WHERE tab = ? AND project_id IS NULL ORDER BY sort_order, id').all(tab)
    : db.prepare('SELECT id, column_key AS name, weightage FROM activity_columns WHERE tab = ? AND project_id = ? ORDER BY sort_order, id').all(tab, scope);
}

function getColumns(tab, projectId) {
  return getColumnRows(tab, projectId).map((c) => c.name);
}

module.exports = { columnScope, getColumnRows, getColumns };

const db = require('./db');

// Configurable corridor-detail columns (per project + tab) and their per-row
// values, replacing the old fixed project_activities.line_type / length_km /
// responsible_person fields (still in the table, but only read once, below,
// to carry existing data over). Values are free-form text.

const DEFAULT_COLUMNS = [
  { name: 'Line', legacy: 'line_type' },
  { name: 'Length (Km)', legacy: 'length_km' },
  { name: 'Responsible', legacy: 'responsible_person' },
];

// First use of a project+tab creates the default columns and copies any legacy
// values into them. Done lazily (not in migrate.js) so rows inserted by the
// seeds and brand-new projects get the same treatment.
function ensureDetailColumns(projectId, tab) {
  if (db.prepare('SELECT 1 FROM corridor_detail_init WHERE project_id = ? AND tab = ?').get(projectId, tab)) return;
  db.transaction(() => {
    const rows = db.prepare('SELECT id, line_type, length_km, responsible_person FROM project_activities WHERE project_id = ? AND tab = ?').all(projectId, tab);
    const insCol = db.prepare('INSERT INTO corridor_detail_columns (project_id, tab, name, sort_order) VALUES (?,?,?,?)');
    const insVal = db.prepare('INSERT INTO corridor_detail_values (activity_id, column_id, value) VALUES (?,?,?)');
    DEFAULT_COLUMNS.forEach((d, i) => {
      const colId = insCol.run(projectId, tab, d.name, i).lastInsertRowid;
      rows.forEach((r) => {
        const v = r[d.legacy];
        if (v != null && String(v).trim() !== '') insVal.run(r.id, colId, String(v));
      });
    });
    db.prepare('INSERT INTO corridor_detail_init (project_id, tab) VALUES (?,?)').run(projectId, tab);
  })();
}

function getDetailColumns(projectId, tab) {
  ensureDetailColumns(projectId, tab);
  return db.prepare('SELECT id, name FROM corridor_detail_columns WHERE project_id = ? AND tab = ? ORDER BY sort_order, id').all(projectId, tab);
}

// Map of activityId -> { [columnId]: value }.
function loadDetailValues(activityIds) {
  const byActivity = new Map();
  if (!activityIds.length) return byActivity;
  db.prepare(
    `SELECT activity_id AS activityId, column_id AS columnId, value FROM corridor_detail_values WHERE activity_id IN (${activityIds.map(() => '?').join(',')})`
  ).all(...activityIds).forEach((v) => {
    if (!byActivity.has(v.activityId)) byActivity.set(v.activityId, {});
    byActivity.get(v.activityId)[v.columnId] = v.value;
  });
  return byActivity;
}

// Validates a { columnId: value } payload against the project+tab's columns and
// returns { values: { columnId: trimmedString|null } } or { error }. Only the
// columns present in the payload are returned, so a partial update leaves the
// rest untouched.
function cleanDetails(columns, details) {
  const values = {};
  if (details == null) return { values };
  if (typeof details !== 'object' || Array.isArray(details)) return { error: 'details must be an object of column id -> value' };
  const ids = new Set(columns.map((c) => String(c.id)));
  for (const [id, raw] of Object.entries(details)) {
    if (!ids.has(String(id))) return { error: 'Unknown corridor column' };
    const v = raw == null ? '' : String(raw).trim();
    if (v.length > 200) return { error: 'Corridor column values are limited to 200 characters' };
    values[id] = v || null;
  }
  return { values };
}

function saveDetailValues(activityId, values) {
  const del = db.prepare('DELETE FROM corridor_detail_values WHERE activity_id = ? AND column_id = ?');
  const upsert = db.prepare(
    `INSERT INTO corridor_detail_values (activity_id, column_id, value) VALUES (?,?,?)
     ON CONFLICT(activity_id, column_id) DO UPDATE SET value = excluded.value`
  );
  Object.entries(values).forEach(([colId, v]) => (v == null ? del.run(activityId, colId) : upsert.run(activityId, colId, v)));
}

// The grid's built-in columns that aren't corridor-detail columns. Each can be
// renamed or hidden per project + tab (corridor_builtin_columns). Sl. No, Corridor
// (the row's identity) and Last updated (the audit trail) always stay, as-is.
const BUILTIN_COLUMNS = [
  { key: 'pct', name: '% Complete' },
];

function getBuiltinColumns(projectId, tab) {
  const saved = new Map(db.prepare('SELECT key, label, hidden FROM corridor_builtin_columns WHERE project_id = ? AND tab = ?')
    .all(projectId, tab).map((r) => [r.key, r]));
  return BUILTIN_COLUMNS.map((b) => {
    const s = saved.get(b.key);
    return { key: b.key, defaultName: b.name, name: (s && s.label) || b.name, hidden: !!(s && s.hidden) };
  });
}

module.exports = { ensureDetailColumns, getDetailColumns, loadDetailValues, cleanDetails, saveDetailValues, BUILTIN_COLUMNS, getBuiltinColumns };

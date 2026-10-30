const db = require('./db');
const { columnScope } = require('./activityColumns');

// Starting column heads for a project that uses the merged "Office and Field
// activities" layout -- the set project 2652 (South Western Railway) uses, each
// classed as an office or field activity. The counterpart of the shared default
// columns the split Office / Field tabs start from. Applied by seedMergedColumns
// as the project's own copy, so it stays fully editable (rename, add, delete,
// weights, Office/Field class) without touching any other project.
const MERGED_DEFAULT_COLUMNS = [
  { name: 'Stage 1 HAL', weight: 2.7777, kind: 'office' },
  { name: 'Stage 1 H&H', weight: 2.7777, kind: 'office' },
  { name: 'Stage 1 BL', weight: 2.7777, kind: 'office' },
  { name: 'Stage 1 VAL', weight: 2.7777, kind: 'office' },
  { name: 'GCS', weight: 2.7777, kind: 'field' },
  { name: 'LiDAR', weight: 2.7777, kind: 'field' },
  { name: 'LiDAR Processed data', weight: 2.7777, kind: 'field' },
  { name: 'Bathymetric Surveys', weight: 2.7777, kind: 'field' },
  { name: 'Stream Surveys', weight: 2.7777, kind: 'field' },
  { name: 'Traffic Surveys', weight: 2.7777, kind: 'field' },
  { name: 'Desk study', weight: 2.7777, kind: 'office' },
  { name: 'Regression', weight: 2.7777, kind: 'office' },
  { name: 'CP', weight: 2.7777, kind: 'office' },
  { name: 'SIP', weight: 2.7777, kind: 'office' },
  { name: 'HAL', weight: 2.7777, kind: 'office' },
  { name: 'H&H Design', weight: 2.7777, kind: 'office' },
  { name: 'Bridgelist', weight: 2.7777, kind: 'office' },
  { name: 'VAL', weight: 2.7777, kind: 'office' },
  { name: 'Bridge design', weight: 2.7777, kind: 'office' },
  { name: 'P&P', weight: 2.7777, kind: 'office' },
  { name: 'Geotech Investigations', weight: 2.7777, kind: 'field' },
  { name: 'Geotech Report', weight: 2.7777, kind: 'office' },
  { name: 'OHE', weight: 2.7777, kind: 'office' },
  { name: 'S&T estimates', weight: 2.7777, kind: 'office' },
  { name: 'Civil estimate', weight: 2.7777, kind: 'office' },
  { name: 'Traffic reports', weight: 2.7777, kind: 'office' },
  { name: 'FIRR & EIRR', weight: 2.7777, kind: 'office' },
  { name: 'DPR', weight: 2.7777, kind: 'office' },
  { name: 'Final DPR', weight: 2.7777, kind: 'office' },
  { name: 'c/s drawings', weight: 2.7777, kind: 'office' },
  { name: 'ESP', weight: 2.7777, kind: 'office' },
  { name: 'Index plan & section', weight: 2.7777, kind: 'office' },
  { name: 'LWR', weight: 2.7777, kind: 'office' },
  { name: 'LAP', weight: 2.7777, kind: 'field' },
  { name: 'Village maps collection', weight: 2.7777, kind: 'field' },
  { name: 'GAD', weight: 2.7805, kind: 'office' },
];

// Gives a project its own copy of MERGED_DEFAULT_COLUMNS (stored on the 'office'
// tab, which is the merged grid's data) plus each column's Office/Field class.
// Skipped, returning 0, when the project already has its own column set or
// already holds recorded statuses against the current columns -- swapping those
// out would orphan its data. Returns the number of columns added.
function seedMergedColumns(projectId) {
  if (columnScope(projectId, 'office') != null) return 0;
  const hasStatuses = db.prepare(
    `SELECT 1 FROM activity_cells c JOIN project_activities a ON a.id = c.activity_id
     WHERE a.project_id = ? AND a.tab = 'office' LIMIT 1`
  ).get(projectId);
  if (hasStatuses) return 0;
  const insCol = db.prepare('INSERT INTO activity_columns (tab, column_key, sort_order, weightage, project_id) VALUES (?,?,?,?,?)');
  const insKind = db.prepare('INSERT INTO project_column_kind (project_id, column_id, kind) VALUES (?,?,?)');
  db.transaction(() => {
    MERGED_DEFAULT_COLUMNS.forEach((c, i) => {
      const id = insCol.run('office', c.name, i, c.weight, projectId).lastInsertRowid;
      insKind.run(projectId, id, c.kind);
    });
  })();
  return MERGED_DEFAULT_COLUMNS.length;
}

module.exports = { MERGED_DEFAULT_COLUMNS, seedMergedColumns };

const { LEGACY_COLUMN_RENAMES, COLUMNS_BY_TAB } = require('./activityConstants');

// schema.sql only creates missing tables, so databases created before a schema
// change need these one-off upgrades. Every step is idempotent.

function addColumnIfMissing(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// SQLite can't alter a CHECK constraint, so the table is rebuilt to accept the
// mockup's status set (IP / APP / PC / NA added).
function widenActivityStatusCheck(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activity_cells'").get();
  if (sql.includes("'IP'")) return;
  db.exec(`
    CREATE TABLE activity_cells_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL REFERENCES project_activities(id) ON DELETE CASCADE,
      column_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'YTS' CHECK(status IN ('YTS','IP','OH','SUB','APP','PC','C','NA')),
      cell_date TEXT,
      remarks TEXT,
      signed INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT,
      UNIQUE(activity_id, column_key)
    );
    INSERT INTO activity_cells_new SELECT * FROM activity_cells;
    DROP TABLE activity_cells;
    ALTER TABLE activity_cells_new RENAME TO activity_cells;
  `);
}

// 'PC' (P. Completed) and 'C' (Completed) were dropped -- Submitted/Approved
// are the only end states now. Remap any stored cells to 'APP' (they were
// already shown/treated as Approved) before narrowing the CHECK constraint,
// since SQLite can't alter one in place.
function dropCompletedActivityStatuses(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activity_cells'").get();
  if (!sql.includes("'PC'")) return;
  db.prepare("UPDATE activity_cells SET status = 'APP' WHERE status IN ('PC','C')").run();
  db.exec(`
    CREATE TABLE activity_cells_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL REFERENCES project_activities(id) ON DELETE CASCADE,
      column_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'YTS' CHECK(status IN ('YTS','IP','OH','SUB','APP','NA')),
      planned_date TEXT,
      actual_date TEXT,
      remarks TEXT,
      signed INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT,
      UNIQUE(activity_id, column_key)
    );
    INSERT INTO activity_cells_new SELECT * FROM activity_cells;
    DROP TABLE activity_cells;
    ALTER TABLE activity_cells_new RENAME TO activity_cells;
  `);
}

// SQLite can't alter a CHECK constraint, so the table is rebuilt to accept the
// new 'member' role (a read-only reviewer scoped to assigned projects only,
// distinct from 'mgmt' which now reviews every project automatically).
function widenUserRoleCheck(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (sql.includes("'member'")) return;
  db.exec(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','pmo','mgmt','member')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users_new SELECT * FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `);
}

// 'admin' was briefly dropped and then brought back as the only role that can
// manage user accounts (create/edit-role/remove), on top of every pmo
// capability. The CHECK constraint already allows it (see schema.sql / the
// users_new rebuild history) -- removed the removeAdminRole/restoreAdminRole
// pair that used to run here, since their schema-only guards re-triggered on
// every server start and silently flipped any 'admin' row back to 'pmo'.

// activity_columns is new (used to be the hardcoded COLUMNS_BY_TAB only) --
// seed it once from the defaults so existing grids keep their columns.
function seedActivityColumns(db) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM activity_columns').get();
  if (c > 0) return;
  const insert = db.prepare('INSERT INTO activity_columns (tab, column_key, sort_order) VALUES (?,?,?)');
  Object.entries(COLUMNS_BY_TAB).forEach(([tab, cols]) => cols.forEach((col, i) => insert.run(tab, col, i)));
}

// weightage is new on an already-seeded activity_columns table -- give every
// tab whose columns are all still at the zero default an equal split (so the
// sum-to-100 rule holds immediately); leave any tab a user already weighted.
function backfillColumnWeights(db) {
  ['office', 'field'].forEach((tab) => {
    const rows = db.prepare('SELECT id, weightage FROM activity_columns WHERE tab = ? AND project_id IS NULL ORDER BY sort_order, id').all(tab);
    if (!rows.length || rows.some((r) => r.weightage !== 0)) return;
    const even = Math.floor((100 / rows.length) * 100) / 100;
    const last = Math.round((100 - even * (rows.length - 1)) * 100) / 100;
    const upd = db.prepare('UPDATE activity_columns SET weightage = ? WHERE id = ?');
    rows.forEach((r, i) => upd.run(i === rows.length - 1 ? last : even, r.id));
  });
}

// cell_date (single date) -> planned_date + actual_date. Existing recorded
// dates were "the date this status was set", closest in spirit to an actual
// date, so the rename preserves them as actual_date; planned_date starts blank.
function splitCellDateIntoPlannedActual(db) {
  const cols = db.prepare('PRAGMA table_info(activity_cells)').all().map((c) => c.name);
  if (cols.includes('tentative_date')) return; // already on the single-date schema below
  if (!cols.includes('actual_date')) {
    if (cols.includes('cell_date')) db.exec('ALTER TABLE activity_cells RENAME COLUMN cell_date TO actual_date');
    else db.exec('ALTER TABLE activity_cells ADD COLUMN actual_date TEXT');
  }
  addColumnIfMissing(db, 'activity_cells', 'planned_date', 'TEXT');
}

// planned_date + actual_date -> a single tentative_date, whose meaning now
// follows the cell's status (tentative start/finish/approval -- see
// activityConstants.deriveCellAlert) instead of recording a plan vs. what
// actually happened. There's no "actual date" input anymore, so actual_date
// is dropped rather than preserved; planned_date's value carries over as the
// starting tentative_date.
function mergeDatesIntoTentative(db) {
  const cols = db.prepare('PRAGMA table_info(activity_cells)').all().map((c) => c.name);
  if (cols.includes('tentative_date')) return;
  if (cols.includes('planned_date')) db.exec('ALTER TABLE activity_cells RENAME COLUMN planned_date TO tentative_date');
  else db.exec('ALTER TABLE activity_cells ADD COLUMN tentative_date TEXT');
  if (db.prepare('PRAGMA table_info(activity_cells)').all().some((c) => c.name === 'actual_date')) {
    db.exec('ALTER TABLE activity_cells DROP COLUMN actual_date');
  }
}

// projects.division was dropped (every project is a Railways zone, and nothing
// displayed or used it); remove the column from databases created before that.
function dropProjectDivision(db) {
  const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  if (cols.includes('division')) db.exec('ALTER TABLE projects DROP COLUMN division');
}

// Only for projects on the shared column set: a project with its own columns
// (activity_columns.project_id) names them itself, and this runs on every start.
function renameLegacyColumnKeys(db) {
  for (const [tab, renames] of Object.entries(LEGACY_COLUMN_RENAMES)) {
    const scope = `activity_id IN (SELECT id FROM project_activities WHERE tab = ?
      AND project_id NOT IN (SELECT project_id FROM activity_columns WHERE tab = ? AND project_id IS NOT NULL))`;
    const cells = db.prepare(`UPDATE OR IGNORE activity_cells SET column_key = ? WHERE column_key = ? AND ${scope}`);
    const audit = db.prepare(`UPDATE activity_audit_log SET column_key = ? WHERE column_key = ? AND ${scope}`);
    for (const [from, to] of Object.entries(renames)) {
      cells.run(to, from, tab, tab);
      audit.run(to, from, tab, tab);
    }
  }
}

// 'CC' (Comment Compliance) joined the status CHECK; SQLite can't alter one in
// place, so rebuild the table. Runs after every column above exists, so the
// copy lists columns explicitly instead of SELECT *.
function allowCommentComplianceStatus(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activity_cells'").get();
  if (sql.includes("'CC'")) return;
  db.exec(`
    CREATE TABLE activity_cells_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL REFERENCES project_activities(id) ON DELETE CASCADE,
      column_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'YTS' CHECK(status IN ('YTS','IP','OH','SUB','CC','APP','NA')),
      tentative_date TEXT,
      planned_finish_date TEXT,
      revision INTEGER,
      remarks TEXT,
      signed INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT,
      UNIQUE(activity_id, column_key)
    );
    INSERT INTO activity_cells_new (id, activity_id, column_key, status, tentative_date, planned_finish_date, revision, remarks, signed, updated_by, updated_at)
      SELECT id, activity_id, column_key, status, tentative_date, planned_finish_date, revision, remarks, signed, updated_by, updated_at FROM activity_cells;
    DROP TABLE activity_cells;
    ALTER TABLE activity_cells_new RENAME TO activity_cells;
  `);
}

// activity_columns gained project_id (NULL = shared set, else that project's own
// set) and its UNIQUE(tab, column_key) had to become per scope, which SQLite
// can't alter in place -- so rebuild. foreign_keys must be OFF for the rebuild
// (DROP TABLE would otherwise cascade-delete project_column_progress and
// project_milestone_columns rows), and the pragma is a no-op inside a
// transaction, so it is toggled around it.
function scopeActivityColumnsToProject(db) {
  const cols = db.prepare('PRAGMA table_info(activity_columns)').all().map((c) => c.name);
  if (!cols.includes('project_id')) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE activity_columns_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tab TEXT NOT NULL CHECK(tab IN ('office','field')),
            column_key TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            weightage REAL NOT NULL DEFAULT 0,
            project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE
          );
          INSERT INTO activity_columns_new (id, tab, column_key, sort_order, weightage)
            SELECT id, tab, column_key, sort_order, weightage FROM activity_columns;
          DROP TABLE activity_columns;
          ALTER TABLE activity_columns_new RENAME TO activity_columns;
        `);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_columns_scope ON activity_columns(COALESCE(project_id, 0), tab, column_key)');
}

function migrate(db) {
  [
    ['contract_start', 'TEXT'], ['contract_end', 'TEXT'], ['forecast_completion', 'TEXT'],
    ['eot_upto', 'TEXT'], ['pbg_valid_upto', 'TEXT'], ['pbg_prev_valid_upto', 'TEXT'],
    ['unbilled_revenue_cr', 'REAL NOT NULL DEFAULT 0'], ['retention_cr', 'REAL NOT NULL DEFAULT 0'],
    ['bank_guarantee_cr', 'REAL NOT NULL DEFAULT 0'],
  ].forEach(([col, def]) => addColumnIfMissing(db, 'projects', col, def));
  addColumnIfMissing(db, 'projects', 'activity_layout', "TEXT NOT NULL DEFAULT 'split' CHECK(activity_layout IN ('split','combined'))");
  addColumnIfMissing(db, 'financial_entries', 'forecast_billing', 'REAL NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'financial_entries', 'forecast_collection', 'REAL NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'project_activities', 'responsible_person', 'TEXT');
  addColumnIfMissing(db, 'schedule_items', 'predecessor', 'TEXT');
  addColumnIfMissing(db, 'project_assignments', 'project_role', 'TEXT');
  addColumnIfMissing(db, 'activity_columns', 'weightage', 'REAL NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'alerts', 'due_date', 'TEXT');
  // Budget categories are per-project and editable; the standard set is copied into a
  // project the first time its dashboard is loaded (budget_seeded = 0 -> 1).
  addColumnIfMissing(db, 'project_budget', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'projects', 'budget_seeded', 'INTEGER NOT NULL DEFAULT 0');
  scopeActivityColumnsToProject(db);

  db.transaction(() => {
    widenUserRoleCheck(db);
    widenActivityStatusCheck(db);
    splitCellDateIntoPlannedActual(db);
    dropCompletedActivityStatuses(db);
    mergeDatesIntoTentative(db);
    seedActivityColumns(db);
    backfillColumnWeights(db);
    renameLegacyColumnKeys(db);
    dropProjectDivision(db);
  })();
  // After the transaction: the legacy table rebuilds above copy with SELECT *
  // into a fixed column list, so this column must not exist yet while they run.
  addColumnIfMissing(db, 'activity_cells', 'planned_finish_date', 'TEXT');
  addColumnIfMissing(db, 'activity_cells', 'revision', 'INTEGER');
  addColumnIfMissing(db, 'activity_audit_log', 'revision', 'INTEGER');
  addColumnIfMissing(db, 'activity_audit_log', 'tentative_date', 'TEXT');
  addColumnIfMissing(db, 'activity_audit_log', 'planned_finish_date', 'TEXT');
  db.transaction(() => allowCommentComplianceStatus(db))();
  // Every request (whatever its outcome) gets a 'CCQ' "requested" entry at the
  // time it was raised, same match rule as the rejections below.
  db.exec(`
    INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, revision, remarks, updated_by, updated_at)
    SELECT r.activity_id, r.column_key,
           (SELECT status FROM activity_cells c WHERE c.activity_id = r.activity_id AND c.column_key = r.column_key),
           'CCQ', r.to_revision,
           'Revision ' || r.to_revision || ' requested — approval date ' || r.approval_date || ': ' || r.reason,
           r.requested_by, REPLACE(r.requested_at, ' ', 'T') || '.000Z'
    FROM activity_revision_requests r
    WHERE NOT EXISTS (
      SELECT 1 FROM activity_audit_log a
      WHERE a.activity_id = r.activity_id AND a.column_key = r.column_key AND a.to_status = 'CCQ'
        AND a.revision = r.to_revision
        AND ABS(strftime('%s', REPLACE(SUBSTR(a.updated_at, 1, 19), 'T', ' ')) - strftime('%s', r.requested_at)) <= 5
    )`);
  // Rejections decided before rejections were logged get their history entry
  // now. A request already has one if a 'CCR' entry for the same cell/revision
  // exists within a few seconds of its decision (the live insert and the
  // request's decided_at are stamped together), which also keeps this idempotent.
  db.exec(`
    INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, revision, remarks, updated_by, updated_at)
    SELECT r.activity_id, r.column_key,
           (SELECT status FROM activity_cells c WHERE c.activity_id = r.activity_id AND c.column_key = r.column_key),
           'CCR', r.to_revision,
           'Revision ' || r.to_revision || ' request rejected by ' || COALESCE(r.decided_by, 'management')
             || ' (requested by ' || r.requested_by || ': ' || r.reason || ')'
             || CASE WHEN r.decision_note IS NOT NULL THEN ' — ' || r.decision_note ELSE '' END,
           COALESCE(r.decided_by, 'management'),
           REPLACE(COALESCE(r.decided_at, r.requested_at), ' ', 'T') || '.000Z'
    FROM activity_revision_requests r
    WHERE r.status = 'rejected'
      AND NOT EXISTS (
        SELECT 1 FROM activity_audit_log a
        WHERE a.activity_id = r.activity_id AND a.column_key = r.column_key AND a.to_status = 'CCR'
          AND a.revision = r.to_revision
          AND ABS(strftime('%s', REPLACE(SUBSTR(a.updated_at, 1, 19), 'T', ' ')) - strftime('%s', COALESCE(r.decided_at, r.requested_at))) <= 5
      )`);
  // Approvals recorded before they got their own history marker ('CCA').
  db.exec(`UPDATE activity_audit_log SET to_status = 'CCA'
           WHERE to_status = 'CC' AND remarks LIKE 'Revision % approved (requested by %'`);
}

module.exports = migrate;

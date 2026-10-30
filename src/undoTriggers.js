// SQLite triggers that feed Ctrl+Z (see undo.js). Every data table gets
// INSERT / UPDATE / DELETE triggers that copy the row's before/after image into
// undo_journal while a request is being captured (undo_ctx.group_id set by the
// captureUndo middleware). Outside a request -- seeding, migrations, manual SQL --
// group_id is NULL and the triggers do nothing.

// Not journaled: accounts / sessions (auth routes are async and security
// sensitive), per-user read markers, one-off migration flags, the admin audit
// trails (they stay as the true record -- an undo adds its own entry) and the
// undo tables themselves.
const EXCLUDED = new Set([
  'users', 'app_meta', 'request_result_seen', 'audit_log', 'activity_change_log',
  'undo_group', 'undo_journal', 'undo_ctx',
]);

function trackedTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name).filter((n) => !EXCLUDED.has(n));
}

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);

// json_object of every column; prefix is 'NEW.', 'OLD.' or '' (a plain SELECT).
// Used for both the journal and the undo-time comparison, so the text matches.
const imageSql = (cols, prefix) => `json_object(${cols.map((c) => `'${c}', ${prefix}"${c}"`).join(', ')})`;

function remove(db) {
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'undo\\_trg\\_%' ESCAPE '\\'")
    .all().forEach((t) => db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`));
}

// Call after migrations (they rebuild tables, which drops a table's triggers).
// Also empties the undo history: the journal is only meaningful for the schema
// it was written under, so a restart starts a fresh undo history.
function install(db) {
  const ctx = '(SELECT group_id FROM undo_ctx WHERE id = 1)';
  db.transaction(() => {
    db.exec('DELETE FROM undo_journal; DELETE FROM undo_group; INSERT OR IGNORE INTO undo_ctx (id, group_id) VALUES (1, NULL); UPDATE undo_ctx SET group_id = NULL;');
    trackedTables(db).forEach((t) => {
      const cols = columnsOf(db, t);
      const insert = (op, oldRow, newRow, rid) =>
        `INSERT INTO undo_journal (group_id, tbl, op, row_id, old_row, new_row) VALUES (${ctx}, '${t}', '${op}', ${rid}, ${oldRow}, ${newRow});`;
      db.exec(`
        CREATE TRIGGER "undo_trg_${t}_i" AFTER INSERT ON "${t}" WHEN ${ctx} IS NOT NULL
        BEGIN ${insert('I', 'NULL', imageSql(cols, 'NEW.'), 'NEW.rowid')} END;
        CREATE TRIGGER "undo_trg_${t}_u" AFTER UPDATE ON "${t}" WHEN ${ctx} IS NOT NULL AND ${imageSql(cols, 'OLD.')} IS NOT ${imageSql(cols, 'NEW.')}
        BEGIN ${insert('U', imageSql(cols, 'OLD.'), imageSql(cols, 'NEW.'), 'NEW.rowid')} END;
        CREATE TRIGGER "undo_trg_${t}_d" AFTER DELETE ON "${t}" WHEN ${ctx} IS NOT NULL
        BEGIN ${insert('D', imageSql(cols, 'OLD.'), 'NULL', 'OLD.rowid')} END;
      `);
    });
  })();
}

module.exports = { install, remove, trackedTables, columnsOf, imageSql };

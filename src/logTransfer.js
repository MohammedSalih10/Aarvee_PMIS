// Carries the change history (audit_log + activity_change_log) between servers.
// Both tables live only in data/pmis.db, which is not in git, so a deploy that
// starts from an empty database would otherwise lose them.
//
//   node src/logTransfer.js export [file]   -> data/backups/change-logs-<stamp>.json by default
//   node src/logTransfer.js import <file>   -> adds entries the database does not have yet
//
// Import is idempotent (re-running it adds nothing) and never edits or deletes
// existing rows. With Docker: docker compose exec app node src/logTransfer.js ...
// (data/ is the bind mount, so files written there appear on the host).
const fs = require('fs');
const path = require('path');
const db = require('./db');

const FORMAT = 1;

const AUDIT_COLS = ['area', 'action', 'project_id', 'project_code', 'subject', 'detail', 'changed_by', 'changed_at'];
const ACTIVITY_COLS = ['project_id', 'tab', 'panel', 'action', 'activity_id', 'subject', 'detail', 'changed_by', 'changed_at'];

function exportLogs(file) {
  const out = file || path.join(__dirname, '..', 'data', 'backups', `change-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const payload = {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    audit_log: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    // project_code lets import re-attach rows if project ids differ on the target.
    activity_change_log: db.prepare(
      `SELECT l.*, p.code AS project_code FROM activity_change_log l
       LEFT JOIN projects p ON p.id = l.project_id ORDER BY l.id`
    ).all(),
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(payload));
  console.log(`exported ${payload.audit_log.length} audit_log + ${payload.activity_change_log.length} activity_change_log rows -> ${out}`);
}

function importLogs(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (payload.format !== FORMAT) throw new Error(`unsupported log export format: ${payload.format}`);

  const projectByCode = new Map(db.prepare('SELECT id, code FROM projects').all().map((p) => [String(p.code), p.id]));
  // NULL-safe equality on every column: the same entry is never added twice.
  const where = (cols) => cols.map((c) => `${c} IS ?`).join(' AND ');
  const insert = (table, cols) => db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const exists = (table, cols) => db.prepare(`SELECT 1 FROM ${table} WHERE ${where(cols)}`);

  const auditExists = exists('audit_log', AUDIT_COLS), auditInsert = insert('audit_log', AUDIT_COLS);
  const actExists = exists('activity_change_log', ACTIVITY_COLS), actInsert = insert('activity_change_log', ACTIVITY_COLS);

  let added = 0, skipped = 0;
  db.transaction(() => {
    for (const r of payload.audit_log || []) {
      const vals = AUDIT_COLS.map((c) => r[c] ?? null);
      if (auditExists.get(...vals)) skipped++; else { auditInsert.run(...vals); added++; }
    }
    for (const r of payload.activity_change_log || []) {
      const projectId = r.project_code != null && projectByCode.has(String(r.project_code)) ? projectByCode.get(String(r.project_code)) : r.project_id;
      const vals = ACTIVITY_COLS.map((c) => (c === 'project_id' ? projectId : r[c]) ?? null);
      if (actExists.get(...vals)) skipped++; else { actInsert.run(...vals); added++; }
    }
  })();
  console.log(`imported ${added} new rows, skipped ${skipped} already present`);
}

const [cmd, file] = process.argv.slice(2);
try {
  if (cmd === 'export') exportLogs(file);
  else if (cmd === 'import' && file) importLogs(file);
  else { console.error('usage: node src/logTransfer.js export [file] | import <file>'); process.exitCode = 1; }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}

const db = require('./db');
const { trackedTables, columnsOf, imageSql } = require('./undoTriggers');

// Ctrl+Z support. captureUndo groups every row change a mutating request makes
// (journaled by the triggers in undoTriggers.js) into one undo_group owned by
// the signed-in user; undoLast reverts that user's most recent group.
//
// Handlers here are synchronous (better-sqlite3), so the capture window is
// exactly the next() call -- nothing from another request can interleave. The
// async routes (auth, users, uploads) are skipped: account / password changes
// and file uploads are deliberately not undoable.

const MAX_STEPS = 50;                     // undo depth per user
const MAX_AGE_MS = 12 * 60 * 60 * 1000;   // same as the login session
const PROBE = -1;                         // journal group used to spot side effects while undoing
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SKIP = /^\/(auth|users|uploads|undo)(\/|$)/;

class UndoError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
class Conflict extends Error {}

let currentLabel = null;
// Names the step for the "Undid: ..." message. First call in a request wins.
function setUndoLabel(label) {
  if (currentLabel === null) currentLabel = String(label).slice(0, 200);
}

const setCtx = (id) => db.prepare('UPDATE undo_ctx SET group_id = ? WHERE id = 1').run(id);
const cutoff = () => new Date(Date.now() - MAX_AGE_MS).toISOString();

function dropGroup(id) {
  db.prepare('DELETE FROM undo_journal WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM undo_group WHERE id = ?').run(id);
}

function finalize(groupId, req, res) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM undo_journal WHERE group_id = ?').get(groupId);
  if (!n || res.statusCode >= 400 || !req.user) return dropGroup(groupId);
  db.prepare('UPDATE undo_group SET username = ?, label = ? WHERE id = ?')
    .run(req.user.username, currentLabel || 'Last change', groupId);
  const stale = `SELECT id FROM undo_group WHERE created_at < '${cutoff()}'
    OR id IN (SELECT id FROM undo_group WHERE username = ? ORDER BY id DESC LIMIT -1 OFFSET ${MAX_STEPS})`;
  db.prepare(`DELETE FROM undo_journal WHERE group_id IN (${stale})`).run(req.user.username);
  db.prepare(`DELETE FROM undo_group WHERE id IN (${stale})`).run(req.user.username);
}

function captureUndo(req, res, next) {
  if (!MUTATING.has(req.method) || SKIP.test(req.path)) return next();
  const groupId = db.prepare('INSERT INTO undo_group (created_at) VALUES (?)').run(new Date().toISOString()).lastInsertRowid;
  setCtx(groupId);
  currentLabel = null;
  try {
    next();
  } finally {
    try { setCtx(null); finalize(groupId, req, res); } catch (err) { console.error('undo capture failed', err); }
    currentLabel = null;
  }
}

// ---- Reverting ----

function revertEntry(e, tables) {
  if (!tables.has(e.tbl)) throw new Conflict();
  const cols = columnsOf(db, e.tbl);
  const current = db.prepare(`SELECT ${imageSql(cols, '')} AS img FROM "${e.tbl}" WHERE rowid = ?`).get(e.row_id);
  const img = current ? current.img : null;
  // A lone INTEGER PRIMARY KEY column is the rowid itself: set it via rowid, not twice.
  const pks = db.prepare(`PRAGMA table_info("${e.tbl}")`).all().filter((c) => c.pk > 0);
  const alias = pks.length === 1 && pks[0].type.toUpperCase() === 'INTEGER' ? pks[0].name : null;

  if (e.op === 'D') {
    if (img !== null) throw new Conflict(); // something took the row's place
    const old = JSON.parse(e.old_row);
    const keys = Object.keys(old).filter((k) => k !== alias);
    db.prepare(`INSERT INTO "${e.tbl}" (rowid${keys.map((k) => `, "${k}"`).join('')}) VALUES (?${keys.map(() => ', ?').join('')})`)
      .run(e.row_id, ...keys.map((k) => old[k]));
    return;
  }
  if (img !== e.new_row) throw new Conflict(); // row changed (or vanished) since this edit
  if (e.op === 'I') {
    db.prepare(`DELETE FROM "${e.tbl}" WHERE rowid = ?`).run(e.row_id);
  } else {
    const old = JSON.parse(e.old_row);
    const keys = Object.keys(old);
    db.prepare(`UPDATE "${e.tbl}" SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE rowid = ?`)
      .run(...keys.map((k) => old[k]), e.row_id);
  }
}

function revertGroup(group, entries) {
  db.pragma('defer_foreign_keys = ON'); // parents/children are restored in reverse order; check at commit
  // Journal the undo's own writes under PROBE so a cascade that wipes rows other
  // users built on top of this change is caught (more journal rows than entries).
  setCtx(PROBE);
  const tables = new Set(trackedTables(db));
  entries.forEach((e) => revertEntry(e, tables));
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM undo_journal WHERE group_id = ?').get(PROBE);
  if (n > entries.length) throw new Conflict();
  setCtx(null);
  dropGroup(PROBE);
  dropGroup(group.id);
}

// Reverts the user's most recent captured request. Throws UndoError (404 nothing
// to undo, 409 data changed since). A step that can't be undone is dropped so it
// doesn't block the older ones.
function undoLast(username) {
  const group = db.prepare(
    'SELECT id, label FROM undo_group WHERE username = ? AND created_at >= ? ORDER BY id DESC LIMIT 1'
  ).get(username, cutoff());
  if (!group) throw new UndoError('Nothing to undo', 404);
  const entries = db.prepare('SELECT * FROM undo_journal WHERE group_id = ? ORDER BY id DESC').all(group.id);
  try {
    db.transaction(() => revertGroup(group, entries))();
  } catch (err) {
    if (err instanceof Conflict || (err.code && String(err.code).startsWith('SQLITE_CONSTRAINT'))) {
      dropGroup(group.id);
      throw new UndoError(`Can't undo "${group.label}" — the data has changed since. Press Ctrl+Z again for the step before it.`, 409);
    }
    throw err;
  }
  return { label: group.label };
}

module.exports = { captureUndo, setUndoLabel, undoLast, UndoError };

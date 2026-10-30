const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { requireProjectAccess, canAccessCorridor, restrictedCorridors, canEditCorridor, canSeeAllProjects } = require('../scope');
const {
  ACTIVITY_STATUS, ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_UPDATE_ORDER, ACTIVITY_STATUS_GROUP, TENTATIVE_DATE_LABEL,
  SUB_APPROVAL_DAYS, MAX_FREE_REVISION, deriveCellAlertSummary, addWorkingDaysISO,
} = require('../activityConstants');
const { loadMilestoneConfig, rowPercent } = require('../milestones');
const { logActivityChange, describeChanges } = require('../changeLog');
const { setUndoLabel } = require('../undo');
const { ensureDetailColumns, getDetailColumns, loadDetailValues, cleanDetails, saveDetailValues, getBuiltinColumns } = require('../corridorDetails');
const { columnScope, getColumnRows, getColumns } = require('../activityColumns');

const router = express.Router();

// Columns are DB-backed (activity_columns) so the Edit grid screen can add/
// rename/delete them; shared across projects for a given tab unless a project
// has its own set (see activityColumns.js). ?projectId= picks that project's view.
router.get('/activity-meta', requireAuth, (req, res) => {
  const projectId = req.query.projectId ? Number(req.query.projectId) : null;
  const columnsByTab = {}, columnDetail = {}, columnScopeByTab = {};
  ['office', 'field'].forEach((tab) => {
    const rows = getColumnRows(tab, projectId);
    columnDetail[tab] = rows;
    columnsByTab[tab] = rows.map((r) => r.name);
    columnScopeByTab[tab] = columnScope(projectId, tab) == null ? 'shared' : 'project';
  });
  res.json({
    columnsByTab, columnDetail, columnScope: columnScopeByTab, status: ACTIVITY_STATUS, statusOrder: ACTIVITY_STATUS_ORDER,
    statusUpdateOrder: ACTIVITY_STATUS_UPDATE_ORDER, statusGroup: ACTIVITY_STATUS_GROUP,
    tentativeDateLabel: TENTATIVE_DATE_LABEL, subApprovalDays: SUB_APPROVAL_DAYS, maxFreeRevision: MAX_FREE_REVISION,
  });
});

// All of a tab's column weights must sum to 100 (within floating-point
// rounding) so the corridor "% Complete" column is a true weighted average.
router.put('/activity-columns/weights', requireAuth, requireAnyRole('pmo'), (req, res) => {
  const { tab, weights, projectId } = req.body || {};
  if (!['office', 'field'].includes(tab) || !weights || typeof weights !== 'object') {
    return res.status(400).json({ error: 'tab (office|field) and weights are required' });
  }
  const scope = columnScope(projectId, tab);
  const cols = getColumnRows(tab, projectId);
  const colIds = cols.map((c) => String(c.id));
  const givenIds = Object.keys(weights);
  if (colIds.length !== givenIds.length || !colIds.every((id) => givenIds.includes(id))) {
    return res.status(400).json({ error: 'All columns for this tab must be included' });
  }
  let sum = 0;
  for (const id of colIds) {
    const w = Number(weights[id]);
    if (!Number.isFinite(w) || w < 0) return res.status(400).json({ error: 'Each weightage must be a non-negative number' });
    sum += w;
  }
  if (Math.abs(sum - 100) > 0.05) {
    return res.status(400).json({ error: `Weightage must sum to 100 (currently ${sum.toFixed(1)})` });
  }
  const upd = db.prepare('UPDATE activity_columns SET weightage = ? WHERE id = ?');
  db.transaction(() => {
    colIds.forEach((id) => upd.run(Number(weights[id]), id));
    cols.forEach((c) => {
      if (Number(weights[c.id]) === c.weightage) return;
      logActivityChange(req.user, { projectId: scope, tab, panel: 'weight', action: 'update', subject: c.name, detail: `Weightage: ${c.weightage}% → ${Number(weights[c.id])}%` });
    });
  })();
  res.json({ ok: true });
});

router.post('/activity-columns', requireAuth, requireAnyRole('pmo'), (req, res) => {
  const { tab, name, projectId } = req.body || {};
  const key = (name || '').trim();
  if (!['office', 'field'].includes(tab) || !key) {
    return res.status(400).json({ error: 'tab (office|field) and name are required' });
  }
  const scope = columnScope(projectId, tab);
  if (db.prepare('SELECT id FROM activity_columns WHERE tab = ? AND column_key = ? AND COALESCE(project_id, 0) = ?').get(tab, key, scope ?? 0)) {
    return res.status(400).json({ error: 'A column with this name already exists' });
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM activity_columns WHERE tab = ? AND COALESCE(project_id, 0) = ?').get(tab, scope ?? 0).m;
  const info = db.prepare('INSERT INTO activity_columns (tab, column_key, sort_order, project_id) VALUES (?,?,?,?)').run(tab, key, maxOrder + 1, scope);
  logActivityChange(req.user, { projectId: scope, tab, panel: 'column', action: 'create', subject: key, detail: 'Column added' });
  res.status(201).json({ id: info.lastInsertRowid });
});

// The cells/history a column's rename or delete reaches: just its own project's
// rows for a project-specific column; for a shared one, every project still on
// the shared set (a project with its own set has its own, separate columns).
function columnCellScope(col) {
  return col.projectId != null
    ? { sql: 'activity_id IN (SELECT id FROM project_activities WHERE tab = ? AND project_id = ?)', params: [col.tab, col.projectId] }
    : {
      sql: 'activity_id IN (SELECT id FROM project_activities WHERE tab = ? AND project_id NOT IN (SELECT project_id FROM activity_columns WHERE tab = ? AND project_id IS NOT NULL))',
      params: [col.tab, col.tab],
    };
}

router.patch('/activity-columns/:colId', requireAuth, requireAnyRole('pmo'), (req, res) => {
  const col = db.prepare('SELECT id, tab, column_key AS name, project_id AS projectId FROM activity_columns WHERE id = ?').get(req.params.colId);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  const key = ((req.body || {}).name || '').trim();
  if (!key) return res.status(400).json({ error: 'name is required' });
  if (key !== col.name && db.prepare('SELECT id FROM activity_columns WHERE tab = ? AND column_key = ? AND COALESCE(project_id, 0) = ?').get(col.tab, key, col.projectId ?? 0)) {
    return res.status(400).json({ error: 'A column with this name already exists' });
  }
  const scope = columnCellScope(col);
  db.transaction(() => {
    db.prepare('UPDATE activity_columns SET column_key = ? WHERE id = ?').run(key, col.id);
    db.prepare(`UPDATE activity_cells SET column_key = ? WHERE column_key = ? AND ${scope.sql}`).run(key, col.name, ...scope.params);
    db.prepare(`UPDATE activity_audit_log SET column_key = ? WHERE column_key = ? AND ${scope.sql}`).run(key, col.name, ...scope.params);
    if (key !== col.name) logActivityChange(req.user, { projectId: col.projectId, tab: col.tab, panel: 'column', action: 'update', subject: key, detail: `Name: ${col.name} → ${key}` });
  })();
  res.json({ ok: true });
});

router.delete('/activity-columns/:colId', requireAuth, requireAnyRole('pmo'), (req, res) => {
  const col = db.prepare('SELECT id, tab, column_key AS name, project_id AS projectId FROM activity_columns WHERE id = ?').get(req.params.colId);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  const scope = columnCellScope(col);
  db.transaction(() => {
    db.prepare(`DELETE FROM activity_audit_log WHERE column_key = ? AND ${scope.sql}`).run(col.name, ...scope.params);
    db.prepare(`DELETE FROM activity_cells WHERE column_key = ? AND ${scope.sql}`).run(col.name, ...scope.params);
    db.prepare('DELETE FROM activity_columns WHERE id = ?').run(col.id);
    logActivityChange(req.user, { projectId: col.projectId, tab: col.tab, panel: 'column', action: 'delete', subject: col.name, detail: 'Column deleted along with its recorded statuses/history' });
  })();
  res.json({ ok: true });
});

// Per-project progress estimate for each column (distinct from weightage,
// which is shared across all projects) -- feeds the Project Dashboard's
// overall "% Complete" KPI.
router.get('/projects/:id/column-progress', requireAuth, requireProjectAccess(), (req, res) => {
  const tab = req.query.tab === 'field' ? 'field' : 'office';
  const progress = new Map(db.prepare(
    'SELECT column_id AS columnId, percent_complete AS pct FROM project_column_progress WHERE project_id = ?'
  ).all(req.params.id).map((r) => [r.columnId, r.pct]));
  const columns = getColumnRows(tab, req.params.id).map((c) => ({ id: c.id, name: c.name, weightage: c.weightage, percentComplete: progress.get(c.id) || 0 }));
  res.json({ tab, columns });
});

router.put('/projects/:id/column-progress', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const { tab, values } = req.body || {};
  if (!['office', 'field'].includes(tab) || !values || typeof values !== 'object') {
    return res.status(400).json({ error: 'tab (office|field) and values are required' });
  }
  const validIds = new Set(getColumnRows(tab, req.params.id).map((c) => String(c.id)));
  for (const [id, pct] of Object.entries(values)) {
    if (!validIds.has(String(id))) return res.status(400).json({ error: 'Unknown column for this tab' });
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: 'Each % complete must be between 0 and 100' });
  }
  const now = new Date().toISOString();
  const current = new Map(db.prepare('SELECT column_id AS columnId, percent_complete AS pct FROM project_column_progress WHERE project_id = ?')
    .all(req.params.id).map((r) => [r.columnId, r.pct]));
  const colName = new Map(getColumnRows(tab, req.params.id).map((c) => [String(c.id), c.name]));
  const upsert = db.prepare(`
    INSERT INTO project_column_progress (project_id, column_id, percent_complete, updated_by, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(project_id, column_id) DO UPDATE SET percent_complete = excluded.percent_complete, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    Object.entries(values).forEach(([id, pct]) => {
      upsert.run(req.params.id, id, Number(pct), req.user.username, now);
      const before = current.get(Number(id)) || 0;
      if (before !== Number(pct)) {
        logActivityChange(req.user, { projectId: Number(req.params.id), tab, panel: 'progress', action: 'update', subject: colName.get(String(id)), detail: `% complete: ${before}% → ${Number(pct)}%` });
      }
    });
  })();
  res.json({ ok: true });
});

function loadActivities(projectId, tab) {
  const activities = db.prepare(
    `SELECT id, corridor, sort_order AS sortOrder
     FROM project_activities WHERE project_id = ? AND tab = ? ORDER BY sort_order, id`
  ).all(projectId, tab);
  if (!activities.length) return [];

  const ids = activities.map((a) => a.id);
  const detailsByActivity = loadDetailValues(ids);
  const placeholders = ids.map(() => '?').join(',');

  const cellRows = db.prepare(
    `SELECT activity_id AS activityId, column_key AS columnKey, status, tentative_date AS tentativeDate, planned_finish_date AS plannedFinishDate, revision, remarks, signed, updated_by AS updatedBy, updated_at AS updatedAt
     FROM activity_cells WHERE activity_id IN (${placeholders})`
  ).all(...ids);

  // Every revision request on these rows, oldest first: the pending one and the
  // latest decided one per cell are derived from it below.
  const revisionRequestRows = db.prepare(
    `SELECT id, activity_id AS activityId, column_key AS columnKey, from_revision AS fromRevision, to_revision AS toRevision,
            status, reason, decided_by AS decidedBy, decided_at AS decidedAt, decision_note AS decisionNote
     FROM activity_revision_requests WHERE activity_id IN (${placeholders}) ORDER BY id`
  ).all(...ids);

  const auditRows = db.prepare(
    `SELECT id, activity_id AS activityId, column_key AS columnKey, from_status AS fromStatus, to_status AS toStatus, remarks, updated_by AS updatedBy, updated_at AS updatedAt
     FROM activity_audit_log WHERE activity_id IN (${placeholders}) ORDER BY updated_at ASC, id ASC`
  ).all(...ids);

  const attachRows = db.prepare(
    `SELECT audit_log_id AS auditLogId, activity_id AS activityId, original_name AS originalName, stored_name AS storedName
     FROM activity_attachments WHERE activity_id IN (${placeholders})`
  ).all(...ids);

  const cellsByActivity = new Map();
  cellRows.forEach((c) => {
    if (!cellsByActivity.has(c.activityId)) cellsByActivity.set(c.activityId, {});
    cellsByActivity.get(c.activityId)[c.columnKey] = c;
  });

  const auditByActivity = new Map();
  auditRows.forEach((a) => {
    if (!auditByActivity.has(a.activityId)) auditByActivity.set(a.activityId, []);
    auditByActivity.get(a.activityId).push(a);
  });

  const attachByActivity = new Map();
  attachRows.forEach((f) => {
    if (!attachByActivity.has(f.activityId)) attachByActivity.set(f.activityId, []);
    attachByActivity.get(f.activityId).push(f);
  });

  const columnRows = getColumnRows(tab, projectId);
  const milestoneConfig = loadMilestoneConfig(projectId, tab);
  return activities.map((a) => {
    const cellMap = cellsByActivity.get(a.id) || {};
    const cells = {};
    const audit = auditByActivity.get(a.id) || [];
    columnRows.forEach((col) => {
      // status null = never set (rendered blank, like the mockup's empty cells)
      const cell = cellMap[col.name] || { status: null, tentativeDate: null, plannedFinishDate: null, revision: null, remarks: '', signed: 0, updatedBy: null, updatedAt: null };
      const alert = deriveCellAlertSummary(cell);
      const cellRequests = revisionRequestRows.filter((p) => p.activityId === a.id && p.columnKey === col.name);
      const pendingRev = cellRequests.find((p) => p.status === 'pending');
      // Flagged while the latest request on a Comment Compliance cell was
      // rejected and the cell is still on the revision it was requested from;
      // a new request or revision change clears it.
      const latest = cellRequests[cellRequests.length - 1];
      const rejected = latest && latest.status === 'rejected' && cell.status === 'CC' && cell.revision === latest.fromRevision ? latest : null;
      cells[col.name] = {
        ...cell, pendingRevision: pendingRev ? { id: pendingRev.id, toRevision: pendingRev.toRevision } : null,
        rejectedRevision: rejected
          ? { toRevision: rejected.toRevision, by: rejected.decidedBy, at: rejected.decidedAt, note: rejected.decisionNote, reason: rejected.reason }
          : null,
        alertState: alert ? alert.state : null,
        alertKind: alert ? alert.kind : null, alertDueDate: alert ? alert.dueDate : null,
      };
    });
    const lastAudit = audit[audit.length - 1];
    // The pinned "Remarks" column should keep showing the latest remark the
    // user actually entered, even if a later update on a different column
    // left remarks blank -- so find the most recent audit entry with
    // non-empty remarks, separately from "last updated" (which is always
    // the most recent action on the row, remark or not).
    const lastRemarkAudit = [...audit].reverse().find((entry) => entry.remarks);
    const attachments = attachByActivity.get(a.id) || [];
    return {
      ...a,
      details: detailsByActivity.get(a.id) || {},
      cells,
      percentComplete: rowPercent(cells, columnRows, milestoneConfig),
      lastRemark: lastRemarkAudit ? lastRemarkAudit.remarks : '',
      lastUpdated: lastAudit ? { by: lastAudit.updatedBy, at: lastAudit.updatedAt } : null,
      attachments: attachments.map((f) => ({ originalName: f.originalName, storedName: f.storedName })),
    };
  });
}

router.get('/projects/:id/activities', requireAuth, requireProjectAccess(), (req, res) => {
  const tab = req.query.tab === 'field' ? 'field' : 'office';
  const detailColumns = getDetailColumns(req.params.id, tab);
  const activities = loadActivities(req.params.id, tab)
    .filter((a) => canAccessCorridor(req.user, req.params.id, a.corridor))
    // pmo/admin already know they can edit everything (the global canEdit()
    // check on the client); this flag is what lets a Project Lead/Coordinator
    // with a corridor edit grant open the status-update modal for just the
    // corridors they've been given, while staying read-only elsewhere.
    .map((a) => ({ ...a, canEdit: canEditCorridor(req.user, req.params.id, a.corridor) }));
  res.json({ tab, activities, detailColumns, builtinColumns: getBuiltinColumns(req.params.id, tab), columnKinds: loadColumnKinds(req.params.id) });
});

// column id -> 'office' | 'field' for this project; columns with no row are office.
function loadColumnKinds(projectId) {
  return Object.fromEntries(db.prepare('SELECT column_id AS columnId, kind FROM project_column_kind WHERE project_id = ?')
    .all(projectId).map((r) => [r.columnId, r.kind]));
}

// Office / Field class of each activity column, for a project using the merged tab.
// Body: { tab, kinds: { columnId: 'office'|'field' } } -- partial updates are fine.
router.put('/projects/:id/column-kinds', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  if (rejectIfCorridorRestricted(req, res, 'change the columns')) return;
  const { tab, kinds } = req.body || {};
  if (!['office', 'field'].includes(tab) || !kinds || typeof kinds !== 'object') {
    return res.status(400).json({ error: 'tab (office|field) and kinds are required' });
  }
  const cols = new Map(getColumnRows(tab, req.params.id).map((c) => [String(c.id), c]));
  for (const [id, kind] of Object.entries(kinds)) {
    if (!cols.has(String(id))) return res.status(400).json({ error: 'Unknown column for this tab' });
    if (!['office', 'field'].includes(kind)) return res.status(400).json({ error: 'Each kind must be office or field' });
  }
  const current = loadColumnKinds(req.params.id);
  const upsert = db.prepare(
    `INSERT INTO project_column_kind (project_id, column_id, kind) VALUES (?,?,?)
     ON CONFLICT(project_id, column_id) DO UPDATE SET kind = excluded.kind`
  );
  const label = { office: 'Office', field: 'Field' };
  db.transaction(() => {
    Object.entries(kinds).forEach(([id, kind]) => {
      const before = current[id] || 'office';
      upsert.run(req.params.id, id, kind);
      if (before !== kind) {
        logActivityChange(req.user, { projectId: Number(req.params.id), tab, panel: 'column', action: 'update', subject: cols.get(String(id)).name, detail: `Activity type: ${label[before]} → ${label[kind]}` });
      }
    });
  })();
  res.json({ ok: true });
});

// Adding a brand-new corridor (or corridor-detail column) is a project-wide
// structural change, reserved for members with unrestricted (every-corridor)
// access to this project. Returns true after sending the 403.
function rejectIfCorridorRestricted(req, res, what) {
  const restricted = restrictedCorridors(req.params.id, req.user.username);
  if (restricted && restricted.length > 0) {
    res.status(403).json({ error: `You are restricted to specific corridors and cannot ${what}` });
    return true;
  }
  return false;
}

router.post('/projects/:id/activities', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  if (rejectIfCorridorRestricted(req, res, 'add new ones')) return;
  const { tab, details } = req.body || {};
  const corridor = ((req.body || {}).corridor || '').trim();
  if (!['office', 'field'].includes(tab) || !corridor) {
    return res.status(400).json({ error: 'tab (office|field) and corridor are required' });
  }
  const columns = getDetailColumns(req.params.id, tab);
  const cleaned = cleanDetails(columns, details);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_activities WHERE project_id = ? AND tab = ?'
  ).get(req.params.id, tab).m;
  const id = db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO project_activities (project_id, tab, corridor, sort_order) VALUES (?,?,?,?)'
    ).run(req.params.id, tab, corridor, maxOrder + 1);
    saveDetailValues(info.lastInsertRowid, cleaned.values);
    const detail = columns.filter((c) => cleaned.values[c.id]).map((c) => `${c.name}: ${cleaned.values[c.id]}`).join('; ');
    logActivityChange(req.user, {
      projectId: Number(req.params.id), tab, panel: 'row', action: 'create', activityId: info.lastInsertRowid, subject: corridor, detail: detail || null,
    });
    return info.lastInsertRowid;
  })();
  res.status(201).json({ id });
});

// No requireAnyRole('pmo') here: a Project Lead/Coordinator with an edit
// grant for this row's corridor (canEditCorridor) may also update it, not
// just pmo/admin. Adding/removing whole corridor rows stays pmo/admin-only
// (see POST/DELETE below) since that's a structural change, not an edit.
router.patch('/projects/:id/activities/:activityId', requireAuth, requireProjectAccess(), (req, res) => {
  const activity = db.prepare(
    'SELECT id, tab, corridor FROM project_activities WHERE id = ? AND project_id = ?'
  ).get(req.params.activityId, req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity row not found' });
  if (!canEditCorridor(req.user, req.params.id, activity.corridor)) {
    return res.status(403).json({ error: 'You do not have edit access to this corridor' });
  }
  const corridor = ((req.body || {}).corridor || '').trim();
  if (!corridor) return res.status(400).json({ error: 'corridor is required' });
  const columns = getDetailColumns(req.params.id, activity.tab);
  const cleaned = cleanDetails(columns, (req.body || {}).details);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  db.transaction(() => {
    const before = loadDetailValues([activity.id]).get(activity.id) || {};
    db.prepare('UPDATE project_activities SET corridor = ? WHERE id = ?').run(corridor, activity.id);
    saveDetailValues(activity.id, cleaned.values);
    const labels = { corridor: 'Corridor' };
    columns.forEach((c) => { labels['d' + c.id] = c.name; });
    const flat = (corr, vals) => Object.fromEntries([['corridor', corr], ...columns.map((c) => ['d' + c.id, vals[c.id]])]);
    const detail = describeChanges(flat(activity.corridor, before), flat(corridor, { ...before, ...cleaned.values }), labels);
    if (detail) {
      logActivityChange(req.user, { projectId: Number(req.params.id), tab: activity.tab, panel: 'row', action: 'update', activityId: activity.id, subject: corridor, detail });
    }
  })();
  res.json({ ok: true });
});

// Corridor-detail columns (Line, Length, ... or anything else) for this
// project's Office/Field grid. Structural, so pmo/admin with unrestricted access.
router.post('/projects/:id/corridor-columns', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  if (rejectIfCorridorRestricted(req, res, 'change the corridor columns')) return;
  const { tab } = req.body || {};
  const name = ((req.body || {}).name || '').trim();
  if (!['office', 'field'].includes(tab) || !name) return res.status(400).json({ error: 'tab (office|field) and name are required' });
  ensureDetailColumns(req.params.id, tab);
  if (db.prepare('SELECT id FROM corridor_detail_columns WHERE project_id = ? AND tab = ? AND name = ?').get(req.params.id, tab, name)) {
    return res.status(400).json({ error: 'A corridor column with this name already exists' });
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM corridor_detail_columns WHERE project_id = ? AND tab = ?').get(req.params.id, tab).m;
  const info = db.prepare('INSERT INTO corridor_detail_columns (project_id, tab, name, sort_order) VALUES (?,?,?,?)').run(req.params.id, tab, name, maxOrder + 1);
  logActivityChange(req.user, { projectId: Number(req.params.id), tab, panel: 'row', action: 'create', subject: name, detail: 'Corridor column added' });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/projects/:id/corridor-columns/:colId', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  if (rejectIfCorridorRestricted(req, res, 'change the corridor columns')) return;
  const col = db.prepare('SELECT id, tab, name FROM corridor_detail_columns WHERE id = ? AND project_id = ?').get(req.params.colId, req.params.id);
  if (!col) return res.status(404).json({ error: 'Corridor column not found' });
  const name = ((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name !== col.name && db.prepare('SELECT id FROM corridor_detail_columns WHERE project_id = ? AND tab = ? AND name = ?').get(req.params.id, col.tab, name)) {
    return res.status(400).json({ error: 'A corridor column with this name already exists' });
  }
  db.prepare('UPDATE corridor_detail_columns SET name = ? WHERE id = ?').run(name, col.id);
  if (name !== col.name) {
    logActivityChange(req.user, { projectId: Number(req.params.id), tab: col.tab, panel: 'row', action: 'update', subject: name, detail: `Corridor column name: ${col.name} → ${name}` });
  }
  res.json({ ok: true });
});

router.delete('/projects/:id/corridor-columns/:colId', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  if (rejectIfCorridorRestricted(req, res, 'change the corridor columns')) return;
  const col = db.prepare('SELECT id, tab, name FROM corridor_detail_columns WHERE id = ? AND project_id = ?').get(req.params.colId, req.params.id);
  if (!col) return res.status(404).json({ error: 'Corridor column not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM corridor_detail_columns WHERE id = ?').run(col.id); // values cascade
    logActivityChange(req.user, { projectId: Number(req.params.id), tab: col.tab, panel: 'row', action: 'delete', subject: col.name, detail: 'Corridor column deleted along with its values' });
  })();
  res.json({ ok: true });
});

// Built-in grid columns (Sl. No, % Complete, Last updated): rename and/or hide per
// project + tab. Body: { tab, name?, hidden? }; name '' restores the default header.
// Hiding only removes the column from the grid -- nothing is deleted or recalculated.
router.patch('/projects/:id/builtin-columns/:key', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  if (rejectIfCorridorRestricted(req, res, 'change the corridor columns')) return;
  const { tab, name, hidden } = req.body || {};
  const cur = getBuiltinColumns(req.params.id, tab).find((b) => b.key === req.params.key);
  if (!['office', 'field'].includes(tab) || !cur) return res.status(404).json({ error: 'Built-in column not found' });
  let label = cur.name === cur.defaultName ? null : cur.name;
  if (name !== undefined) {
    label = String(name).trim() || null;
    if (label && label.length > 60) return res.status(400).json({ error: 'Column names are limited to 60 characters' });
    if (label === cur.defaultName) label = null;
  }
  const nowHidden = hidden === undefined ? cur.hidden : !!hidden;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO corridor_builtin_columns (project_id, tab, key, label, hidden) VALUES (?,?,?,?,?)
       ON CONFLICT(project_id, tab, key) DO UPDATE SET label = excluded.label, hidden = excluded.hidden`
    ).run(req.params.id, tab, cur.key, label, nowHidden ? 1 : 0);
    const newName = label || cur.defaultName;
    if (newName !== cur.name) {
      logActivityChange(req.user, { projectId: Number(req.params.id), tab, panel: 'row', action: 'update', subject: newName, detail: `Corridor column name: ${cur.name} → ${newName}` });
    }
    if (nowHidden !== cur.hidden) {
      logActivityChange(req.user, { projectId: Number(req.params.id), tab, panel: 'row', action: nowHidden ? 'delete' : 'create', subject: newName, detail: nowHidden ? 'Built-in column removed from the grid' : 'Built-in column restored to the grid' });
    }
  })();
  res.json({ ok: true });
});

router.delete('/projects/:id/activities/:activityId', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const activity = db.prepare('SELECT id, tab, corridor FROM project_activities WHERE id = ? AND project_id = ?').get(req.params.activityId, req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity row not found' });
  if (!canAccessCorridor(req.user, req.params.id, activity.corridor)) {
    return res.status(403).json({ error: 'You do not have access to this corridor' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM project_activities WHERE id = ?').run(req.params.activityId);
    logActivityChange(req.user, {
      projectId: Number(req.params.id), tab: activity.tab, panel: 'row', action: 'delete', activityId: activity.id,
      subject: activity.corridor, detail: 'Corridor row deleted along with its recorded statuses/history',
    });
  })();
  res.json({ ok: true });
});

router.get(
  '/projects/:id/activities/:activityId/history',
  requireAuth,
  requireProjectAccess(),
  (req, res) => {
    const activity = db.prepare(
      'SELECT id, corridor FROM project_activities WHERE id = ? AND project_id = ?'
    ).get(req.params.activityId, req.params.id);
    if (!activity) return res.status(404).json({ error: 'Activity row not found' });
    if (!canAccessCorridor(req.user, req.params.id, activity.corridor)) {
      return res.status(403).json({ error: 'You do not have access to this corridor' });
    }

    const audit = db.prepare(
      `SELECT l.id, l.column_key AS columnKey, l.from_status AS fromStatus, l.to_status AS toStatus, l.revision,
              l.tentative_date AS tentativeDate, l.planned_finish_date AS plannedFinishDate, l.remarks,
              l.updated_by AS updatedBy, u.display_name AS updatedByName, l.updated_at AS updatedAt
       FROM activity_audit_log l LEFT JOIN users u ON u.username = l.updated_by WHERE l.activity_id = ? ORDER BY l.updated_at DESC, l.id DESC`
    ).all(req.params.activityId);

    const attachStmt = db.prepare(
      'SELECT original_name AS originalName, stored_name AS storedName FROM activity_attachments WHERE audit_log_id = ?'
    );
    const history = audit.map((a) => ({ ...a, attachments: attachStmt.all(a.id) }));
    res.json({ history });
  }
);

// Who changed what in the activity grid's panels (see activity_change_log in
// schema.sql). Open to anyone with access to the project; a member limited to
// specific corridors only sees entries for those corridors' rows. Column /
// weightage edits are global per tab (project_id NULL), so they appear in
// every project's log for that tab. ?panel= takes a comma-separated subset;
// ?activityId= narrows to one corridor row.
router.get('/projects/:id/activity-change-log', requireAuth, requireProjectAccess(), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can view the change history' });
  const tab = req.query.tab === 'field' ? 'field' : 'office';
  const panels = String(req.query.panel || '').split(',').filter((p) => ['row', 'column', 'weight', 'milestone', 'progress'].includes(p));
  const where = ['(project_id = ? OR project_id IS NULL)', 'tab = ?'];
  const params = [req.params.id, tab];
  if (panels.length) { where.push(`panel IN (${panels.map(() => '?').join(',')})`); params.push(...panels); }
  if (req.query.activityId) { where.push('activity_id = ?'); params.push(Number(req.query.activityId)); }
  let history = db.prepare(
    `SELECT l.id, l.panel, l.action, l.activity_id AS activityId, l.subject, l.detail,
            l.changed_by AS changedBy, u.display_name AS changedByName, l.changed_at AS changedAt
     FROM activity_change_log l LEFT JOIN users u ON u.username = l.changed_by
     WHERE ${where.map((w) => w.replace(/\b(project_id|tab|panel|activity_id)\b/g, 'l.$1')).join(' AND ')} ORDER BY l.id DESC LIMIT 500`
  ).all(...params);
  const restricted = canSeeAllProjects(req.user) ? [] : restrictedCorridors(req.params.id, req.user.username);
  if (restricted && restricted.length) {
    const allowed = new Set(db.prepare(
      `SELECT id FROM project_activities WHERE project_id = ? AND corridor IN (${restricted.map(() => '?').join(',')})`
    ).all(req.params.id, ...restricted).map((r) => r.id));
    history = history.filter((h) => h.activityId == null || allowed.has(h.activityId));
  }
  res.json({ history });
});

// No requireAnyRole('pmo') here either: this is the main day-to-day edit (cell
// status/remarks/attachments), which is exactly what a corridor edit grant is
// for -- gated below by canEditCorridor instead.
router.patch(
  '/projects/:id/activities/:activityId/cells/:column',
  requireAuth,
  requireProjectAccess(),
  (req, res) => {
    const column = req.params.column;
    const activity = db.prepare(
      'SELECT id, tab, corridor FROM project_activities WHERE id = ? AND project_id = ?'
    ).get(req.params.activityId, req.params.id);
    if (!activity) return res.status(404).json({ error: 'Activity row not found' });
    if (!canEditCorridor(req.user, req.params.id, activity.corridor)) {
      return res.status(403).json({ error: 'You do not have edit access to this corridor' });
    }
    if (!getColumns(activity.tab, req.params.id).includes(column)) {
      return res.status(400).json({ error: 'Unknown activity column for this tab' });
    }

    const { status, tentativeDate, plannedFinishDate, remarks, signed, attachments, revision } = req.body || {};
    if (!ACTIVITY_STATUS_ORDER.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    // PRD §4.2 — digital signature/approval is a mandatory step for every update.
    if (!signed) {
      return res.status(400).json({ error: 'Digital signature confirmation is required' });
    }

    const existing = db.prepare(
      'SELECT status, tentative_date AS tentativeDate, revision FROM activity_cells WHERE activity_id = ? AND column_key = ?'
    ).get(req.params.activityId, column);
    const fromStatus = existing ? existing.status : null;
    const now = new Date().toISOString();

    // NA means this activity doesn't apply to this corridor -- nothing else
    // on the cell is meaningful, so the date/remarks/attachments are dropped
    // regardless of what the client sent.
    const isNA = status === 'NA';
    // The status's date (TENTATIVE_DATE_LABEL: start / finish / approval date
    // ...) is mandatory for every status except NA, which has no date. The
    // Submitted's "Expected approval date" and Comment Compliance's "Approval
    // date" are not editable, whatever the client sent: a cell already in that
    // status (and, for CC, on the same revision) keeps its stored date;
    // otherwise it gets SUB_APPROVAL_DAYS working days from today.
    const isDateLocked = status === 'SUB' || status === 'CC';
    const keepStoredDate = existing && existing.status === status && existing.tentativeDate
      && (status !== 'CC' || Number(revision) === existing.revision);
    const lockedDate = isDateLocked
      ? (keepStoredDate ? existing.tentativeDate : addWorkingDaysISO(now, SUB_APPROVAL_DAYS))
      : null;
    const cellTentativeDate = isNA ? null : (isDateLocked ? lockedDate : (tentativeDate || null));
    if (status !== 'NA' && !isDateLocked && !tentativeDate) {
      return res.status(400).json({ error: `${TENTATIVE_DATE_LABEL[status]} is required` });
    }
    // Planned finish date is mandatory for Yet to Start (and only applies
    // there); it can't fall before the tentative start date.
    if (status === 'YTS') {
      if (!plannedFinishDate) return res.status(400).json({ error: 'Planned finish date is required for Yet to Start' });
      if (tentativeDate && plannedFinishDate < tentativeDate) {
        return res.status(400).json({ error: 'Planned finish date cannot be before the tentative start date' });
      }
    }
    const cellPlannedFinish = status === 'YTS' ? (plannedFinishDate || null) : null;

    // Comment Compliance: a revision number is required. Revisions never go
    // backwards, and anything past MAX_FREE_REVISION (other than staying on the
    // revision the cell already holds) must go through a revision request that
    // management/admin approve -- see revisionRequests.routes.js.
    const storedRevision = (existing && existing.revision) || null;
    let cellRevision = storedRevision; // retained across other statuses
    if (status === 'CC') {
      const rev = Number(revision);
      if (!Number.isInteger(rev) || rev < 1) return res.status(400).json({ error: 'Revision is required for Comment Compliance' });
      if (storedRevision && rev < storedRevision) {
        return res.status(400).json({ error: `Revision cannot go back below the current revision (${storedRevision})` });
      }
      if (rev > MAX_FREE_REVISION && rev !== storedRevision) {
        return res.status(403).json({
          error: `Revision ${rev} needs management or admin approval — raise a revision request`, needsApproval: true,
        });
      }
      cellRevision = rev;
    }
    const cellRemarks = isNA ? '' : (remarks || '');
    const cellAttachments = isNA ? [] : (attachments || []);

    // Completed-like statuses (Submitted/Approved -- ACTIVITY_STATUS_GROUP's
    // 'C' bucket) pin this project's % complete for the column to 100; Yet to
    // Start pins it to 0. In Progress/On Hold leave whatever % complete is
    // already set alone.
    let autoPct = null;
    if (ACTIVITY_STATUS_GROUP[status] === 'C') autoPct = 100;
    else if (status === 'YTS') autoPct = 0;
    const col = autoPct != null ? getColumnRows(activity.tab, req.params.id).find((c) => c.name === column) : null;
    const priorPct = col ? db.prepare('SELECT percent_complete AS pct FROM project_column_progress WHERE project_id = ? AND column_id = ?').get(req.params.id, col.id) : null;

    setUndoLabel(`${column} status on ${activity.corridor}`);
    const txn = db.transaction(() => {
      db.prepare(`
        INSERT INTO activity_cells (activity_id, column_key, status, tentative_date, planned_finish_date, revision, remarks, signed, updated_by, updated_at)
        VALUES (@activityId, @column, @status, @tentativeDate, @plannedFinishDate, @revision, @remarks, 1, @updatedBy, @updatedAt)
        ON CONFLICT(activity_id, column_key) DO UPDATE SET
          status = excluded.status, tentative_date = excluded.tentative_date, planned_finish_date = excluded.planned_finish_date,
          revision = excluded.revision, remarks = excluded.remarks, signed = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run({
        activityId: req.params.activityId, column, status, tentativeDate: cellTentativeDate, plannedFinishDate: cellPlannedFinish,
        revision: cellRevision,
        remarks: cellRemarks, updatedBy: req.user.username, updatedAt: now,
      });

      const auditInfo = db.prepare(
        `INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, revision, tentative_date, planned_finish_date, remarks, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(req.params.activityId, column, fromStatus, status, status === 'CC' ? cellRevision : null, cellTentativeDate, cellPlannedFinish, cellRemarks, req.user.username, now);

      cellAttachments.forEach((f) => {
        if (!f || !f.originalName || !f.storedName) return;
        db.prepare(
          `INSERT INTO activity_attachments (audit_log_id, activity_id, original_name, stored_name, uploaded_by, uploaded_at)
           VALUES (?,?,?,?,?,?)`
        ).run(auditInfo.lastInsertRowid, req.params.activityId, f.originalName, f.storedName, req.user.username, now);
      });

      if (col) {
        db.prepare(`
          INSERT INTO project_column_progress (project_id, column_id, percent_complete, updated_by, updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(project_id, column_id) DO UPDATE SET percent_complete = excluded.percent_complete, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        `).run(req.params.id, col.id, autoPct, req.user.username, now);
        const before = priorPct ? priorPct.pct : 0;
        if (before !== autoPct) {
          logActivityChange(req.user, {
            projectId: Number(req.params.id), tab: activity.tab, panel: 'progress', action: 'update', activityId: activity.id, subject: column,
            detail: `% complete: ${before}% → ${autoPct}% (set automatically by status ${ACTIVITY_STATUS[status] || status}, ${activity.corridor})`,
          });
        }
      }
    });
    txn();

    res.json({ ok: true, autoPercentComplete: autoPct });
  }
);

module.exports = router;

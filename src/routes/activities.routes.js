const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../auth');
const { requireProjectAccess, canAccessCorridor, restrictedCorridors, canEditCorridor } = require('../scope');
const {
  ACTIVITY_STATUS, ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_UPDATE_ORDER, ACTIVITY_STATUS_GROUP, TENTATIVE_DATE_LABEL,
  SUB_APPROVAL_DAYS, MAX_FREE_REVISION, deriveCellAlertSummary,
} = require('../activityConstants');
const { loadMilestoneConfig, rowPercent } = require('../milestones');

const router = express.Router();

// Columns are DB-backed (activity_columns) so the Edit grid screen can add/
// rename/delete them; shared across all projects for a given tab.
function getColumnRows(tab) {
  return db.prepare('SELECT id, column_key AS name, weightage FROM activity_columns WHERE tab = ? ORDER BY sort_order, id').all(tab);
}
function getColumns(tab) {
  return getColumnRows(tab).map((c) => c.name);
}

router.get('/activity-meta', requireAuth, (req, res) => {
  const columnsByTab = {}, columnDetail = {};
  ['office', 'field'].forEach((tab) => {
    const rows = getColumnRows(tab);
    columnDetail[tab] = rows;
    columnsByTab[tab] = rows.map((r) => r.name);
  });
  res.json({
    columnsByTab, columnDetail, status: ACTIVITY_STATUS, statusOrder: ACTIVITY_STATUS_ORDER,
    statusUpdateOrder: ACTIVITY_STATUS_UPDATE_ORDER, statusGroup: ACTIVITY_STATUS_GROUP,
    tentativeDateLabel: TENTATIVE_DATE_LABEL, subApprovalDays: SUB_APPROVAL_DAYS, maxFreeRevision: MAX_FREE_REVISION,
  });
});

// All of a tab's column weights must sum to 100 (within floating-point
// rounding) so the corridor "% Complete" column is a true weighted average.
router.put('/activity-columns/weights', requireAuth, requireAnyRole('pmo'), (req, res) => {
  const { tab, weights } = req.body || {};
  if (!['office', 'field'].includes(tab) || !weights || typeof weights !== 'object') {
    return res.status(400).json({ error: 'tab (office|field) and weights are required' });
  }
  const cols = db.prepare('SELECT id FROM activity_columns WHERE tab = ?').all(tab);
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
  db.transaction(() => { colIds.forEach((id) => upd.run(Number(weights[id]), id)); })();
  res.json({ ok: true });
});

router.post('/activity-columns', requireAuth, requireAnyRole('pmo'), (req, res) => {
  const { tab, name } = req.body || {};
  const key = (name || '').trim();
  if (!['office', 'field'].includes(tab) || !key) {
    return res.status(400).json({ error: 'tab (office|field) and name are required' });
  }
  if (db.prepare('SELECT id FROM activity_columns WHERE tab = ? AND column_key = ?').get(tab, key)) {
    return res.status(400).json({ error: 'A column with this name already exists' });
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM activity_columns WHERE tab = ?').get(tab).m;
  const info = db.prepare('INSERT INTO activity_columns (tab, column_key, sort_order) VALUES (?,?,?)').run(tab, key, maxOrder + 1);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/activity-columns/:colId', requireAuth, requireAnyRole('pmo'), (req, res) => {
  const col = db.prepare('SELECT id, tab, column_key AS name FROM activity_columns WHERE id = ?').get(req.params.colId);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  const key = ((req.body || {}).name || '').trim();
  if (!key) return res.status(400).json({ error: 'name is required' });
  if (key !== col.name && db.prepare('SELECT id FROM activity_columns WHERE tab = ? AND column_key = ?').get(col.tab, key)) {
    return res.status(400).json({ error: 'A column with this name already exists' });
  }
  const scope = 'activity_id IN (SELECT id FROM project_activities WHERE tab = ?)';
  db.transaction(() => {
    db.prepare('UPDATE activity_columns SET column_key = ? WHERE id = ?').run(key, col.id);
    db.prepare(`UPDATE activity_cells SET column_key = ? WHERE column_key = ? AND ${scope}`).run(key, col.name, col.tab);
    db.prepare(`UPDATE activity_audit_log SET column_key = ? WHERE column_key = ? AND ${scope}`).run(key, col.name, col.tab);
  })();
  res.json({ ok: true });
});

router.delete('/activity-columns/:colId', requireAuth, requireAnyRole('pmo'), (req, res) => {
  const col = db.prepare('SELECT id, tab, column_key AS name FROM activity_columns WHERE id = ?').get(req.params.colId);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  const scope = 'activity_id IN (SELECT id FROM project_activities WHERE tab = ?)';
  db.transaction(() => {
    db.prepare(`DELETE FROM activity_audit_log WHERE column_key = ? AND ${scope}`).run(col.name, col.tab);
    db.prepare(`DELETE FROM activity_cells WHERE column_key = ? AND ${scope}`).run(col.name, col.tab);
    db.prepare('DELETE FROM activity_columns WHERE id = ?').run(col.id);
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
  const columns = getColumnRows(tab).map((c) => ({ id: c.id, name: c.name, weightage: c.weightage, percentComplete: progress.get(c.id) || 0 }));
  res.json({ tab, columns });
});

router.put('/projects/:id/column-progress', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const { tab, values } = req.body || {};
  if (!['office', 'field'].includes(tab) || !values || typeof values !== 'object') {
    return res.status(400).json({ error: 'tab (office|field) and values are required' });
  }
  const validIds = new Set(getColumnRows(tab).map((c) => String(c.id)));
  for (const [id, pct] of Object.entries(values)) {
    if (!validIds.has(String(id))) return res.status(400).json({ error: 'Unknown column for this tab' });
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: 'Each % complete must be between 0 and 100' });
  }
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO project_column_progress (project_id, column_id, percent_complete, updated_by, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(project_id, column_id) DO UPDATE SET percent_complete = excluded.percent_complete, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    Object.entries(values).forEach(([id, pct]) => upsert.run(req.params.id, id, Number(pct), req.user.username, now));
  })();
  res.json({ ok: true });
});

function loadActivities(projectId, tab) {
  const activities = db.prepare(
    `SELECT id, corridor, line_type AS lineType, length_km AS lengthKm, responsible_person AS responsiblePerson,
            sort_order AS sortOrder
     FROM project_activities WHERE project_id = ? AND tab = ? ORDER BY sort_order, id`
  ).all(projectId, tab);
  if (!activities.length) return [];

  const ids = activities.map((a) => a.id);
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

  const columnRows = getColumnRows(tab);
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
  const activities = loadActivities(req.params.id, tab)
    .filter((a) => canAccessCorridor(req.user, req.params.id, a.corridor))
    // pmo/admin already know they can edit everything (the global canEdit()
    // check on the client); this flag is what lets a Project Lead/Coordinator
    // with a corridor edit grant open the status-update modal for just the
    // corridors they've been given, while staying read-only elsewhere.
    .map((a) => ({ ...a, canEdit: canEditCorridor(req.user, req.params.id, a.corridor) }));
  res.json({ tab, activities });
});

router.post('/projects/:id/activities', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  // Adding a brand-new corridor is a project-wide structural change, reserved
  // for members with unrestricted (every-corridor) access to this project.
  const restricted = restrictedCorridors(req.params.id, req.user.username);
  if (restricted && restricted.length > 0) {
    return res.status(403).json({ error: 'You are restricted to specific corridors and cannot add new ones' });
  }
  const { tab, corridor, lineType, lengthKm, responsiblePerson } = req.body || {};
  if (!['office', 'field'].includes(tab) || !corridor) {
    return res.status(400).json({ error: 'tab (office|field) and corridor are required' });
  }
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_activities WHERE project_id = ? AND tab = ?'
  ).get(req.params.id, tab).m;
  const info = db.prepare(
    'INSERT INTO project_activities (project_id, tab, corridor, line_type, length_km, responsible_person, sort_order) VALUES (?,?,?,?,?,?,?)'
  ).run(req.params.id, tab, corridor, lineType || null, lengthKm || null, responsiblePerson || null, maxOrder + 1);
  res.status(201).json({ id: info.lastInsertRowid });
});

// No requireAnyRole('pmo') here: a Project Lead/Coordinator with an edit
// grant for this row's corridor (canEditCorridor) may also update it, not
// just pmo/admin. Adding/removing whole corridor rows stays pmo/admin-only
// (see POST/DELETE below) since that's a structural change, not an edit.
router.patch('/projects/:id/activities/:activityId', requireAuth, requireProjectAccess(), (req, res) => {
  const activity = db.prepare('SELECT id, corridor FROM project_activities WHERE id = ? AND project_id = ?').get(req.params.activityId, req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity row not found' });
  if (!canEditCorridor(req.user, req.params.id, activity.corridor)) {
    return res.status(403).json({ error: 'You do not have edit access to this corridor' });
  }
  const { corridor, lineType, lengthKm, responsiblePerson } = req.body || {};
  if (!corridor || !corridor.trim()) return res.status(400).json({ error: 'corridor is required' });
  db.prepare(
    'UPDATE project_activities SET corridor = ?, line_type = ?, length_km = ?, responsible_person = ? WHERE id = ?'
  ).run(corridor.trim(), lineType || null, lengthKm || null, responsiblePerson || null, req.params.activityId);
  res.json({ ok: true });
});

router.delete('/projects/:id/activities/:activityId', requireAuth, requireProjectAccess(), requireAnyRole('pmo'), (req, res) => {
  const activity = db.prepare('SELECT id, corridor FROM project_activities WHERE id = ? AND project_id = ?').get(req.params.activityId, req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity row not found' });
  if (!canAccessCorridor(req.user, req.params.id, activity.corridor)) {
    return res.status(403).json({ error: 'You do not have access to this corridor' });
  }
  db.prepare('DELETE FROM project_activities WHERE id = ?').run(req.params.activityId);
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
      `SELECT id, column_key AS columnKey, from_status AS fromStatus, to_status AS toStatus, revision, remarks, updated_by AS updatedBy, updated_at AS updatedAt
       FROM activity_audit_log WHERE activity_id = ? ORDER BY updated_at DESC, id DESC`
    ).all(req.params.activityId);

    const attachStmt = db.prepare(
      'SELECT original_name AS originalName, stored_name AS storedName FROM activity_attachments WHERE audit_log_id = ?'
    );
    const history = audit.map((a) => ({ ...a, attachments: attachStmt.all(a.id) }));
    res.json({ history });
  }
);

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
    if (!getColumns(activity.tab).includes(column)) {
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
    // modal pre-suggests SUB_APPROVAL_DAYS working days for Submitted and
    // Comment Compliance, but that is only a suggestion the user can change --
    // the server never fills one in on its own.
    const cellTentativeDate = isNA ? null : (tentativeDate || null);
    if (status !== 'NA' && !tentativeDate) {
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
    const col = autoPct != null ? db.prepare('SELECT id FROM activity_columns WHERE tab = ? AND column_key = ?').get(activity.tab, column) : null;

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
        `INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, revision, remarks, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(req.params.activityId, column, fromStatus, status, status === 'CC' ? cellRevision : null, cellRemarks, req.user.username, now);

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
      }
    });
    txn();

    res.json({ ok: true, autoPercentComplete: autoPct });
  }
);

module.exports = router;

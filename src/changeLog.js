const db = require('./db');
const { setUndoLabel } = require('./undo');

const VERB = { create: 'Added', update: 'Edited', delete: 'Deleted', request: 'Requested change to', withdraw: 'Withdrew request for', approve: 'Approved', reject: 'Rejected' };

// Records one edit to an activity-grid panel in activity_change_log (see
// schema.sql). `subject` is what was edited (corridor / column / KD name) and
// `detail` a short human-readable "old -> new" description.
function logActivityChange(user, { projectId = null, tab, panel, action, activityId = null, subject, detail = null }) {
  setUndoLabel(`${VERB[action] || action} ${subject}`);
  db.prepare(
    `INSERT INTO activity_change_log (project_id, tab, panel, action, activity_id, subject, detail, changed_by, changed_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(projectId, tab, panel, action, activityId, subject, detail, user.username, new Date().toISOString());
}

// Records one edit anywhere else in the app in audit_log (admin-only view, see
// auditLog.routes.js). `area` groups it for the History buttons: project,
// details, financial, contract_end, deliverable, access, schedule, alert,
// pending, user. The project code is snapshotted so the entry outlives the project.
function logAudit(user, { projectId = null, area, action, subject, detail = null }) {
  setUndoLabel(`${VERB[action] || action} ${subject}`);
  const project = projectId == null ? null : db.prepare('SELECT code FROM projects WHERE id = ?').get(projectId);
  db.prepare(
    `INSERT INTO audit_log (area, action, project_id, project_code, subject, detail, changed_by, changed_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(area, action, projectId == null ? null : Number(projectId), project ? String(project.code) : null, subject, detail, user.username, new Date().toISOString());
}

// "field: old → new" lines for the fields that actually differ.
function describeChanges(before, after, labels) {
  const norm = (v) => (v == null || v === '' ? '—' : String(v));
  return Object.entries(labels)
    .filter(([key]) => norm(before[key]) !== norm(after[key]))
    .map(([key, label]) => `${label}: ${norm(before[key])} → ${norm(after[key])}`)
    .join('; ');
}

module.exports = { logActivityChange, logAudit, describeChanges };

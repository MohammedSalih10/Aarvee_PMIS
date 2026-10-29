// Activity cells still Yet to Start/In Progress/Submitted once their
// tentative date passes surface themselves in the Alerts / Pending actions
// panels without anyone having to create them manually -- see
// deriveCellAlert for the 'upcoming' (within ALERT_LEAD_DAYS working days of
// the tentative date) vs 'overdue' (past it) split. Submitted's tentative
// date is auto-filled (submission + SUB_APPROVAL_DAYS working days) by the
// cell PATCH route rather than entered manually, but once set it's read the
// same way as YTS/IP's. Each row names a project AND a corridor, so
// visibility is checked the same way the activity grid itself is gated:
// canAccessCorridor covers both "not assigned to this project at all" and
// "assigned, but restricted to other corridors" in one call.
const db = require('./db');
const { deriveCellAlertDetails } = require('./activityConstants');
const { canAccessCorridor } = require('./scope');

// kind: 'finish' is a Yet to Start cell's planned finish date; every other
// reason follows the cell's status (its tentative date).
function getAlertReason(status, timing, kind) {
  const deadline = timing === 'upcoming' ? 'due soon' : 'overdue';
  if (kind === 'finish') return `Planned finish is ${deadline}`;
  if (status === 'YTS') return `Activity start is ${deadline}`;
  if (status === 'IP') return `Activity completion is ${deadline}`;
  return `Approval is pending; ${deadline}`;
}

function getDerivedCellAlerts(user) {
  const rows = db.prepare(`
    SELECT ac.id, ac.column_key AS columnKey, ac.status, ac.tentative_date AS tentativeDate,
           ac.planned_finish_date AS plannedFinishDate,
           pa.project_id AS projectId, pa.corridor AS corridor, pa.tab AS tab, p.code AS projectCode, p.name AS projectName
    FROM activity_cells ac
    JOIN project_activities pa ON pa.id = ac.activity_id
    JOIN projects p ON p.id = pa.project_id
    WHERE ac.status IN ('YTS','IP','SUB','CC')
      AND (ac.tentative_date IS NOT NULL OR (ac.status = 'YTS' AND ac.planned_finish_date IS NOT NULL))
  `).all();

  const upcoming = [], overdue = [];
  rows.forEach((r) => {
    if (!canAccessCorridor(user, r.projectId, r.corridor)) return;
    // One item per alerting deadline: a Yet to Start cell with both a start
    // and a planned finish date can surface two rows.
    deriveCellAlertDetails({ status: r.status, tentativeDate: r.tentativeDate, plannedFinishDate: r.plannedFinishDate }).forEach((d) => {
      const item = {
        id: d.kind === 'finish' ? `cell-${r.id}-finish` : `cell-${r.id}`,
        projectId: r.projectId, projectCode: r.projectCode, projectName: r.projectName,
        corridor: r.corridor, column: r.columnKey, tab: r.tab, dueDate: d.dueDate,
        reason: getAlertReason(r.status, d.state, d.kind),
        timing: d.state === 'upcoming' ? 'Due soon' : 'Behind schedule',
      };
      (d.state === 'upcoming' ? upcoming : overdue).push(item);
    });
  });
  return { upcoming, overdue };
}

module.exports = { getDerivedCellAlerts };

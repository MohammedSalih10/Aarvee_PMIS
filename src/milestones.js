const db = require('./db');
const { computeRowPercent, computeRowPercentByMilestones } = require('./activityConstants');

// A project's payment-milestone (KD) header config for one tab -- see
// project_milestones in schema.sql. `basis` is 'column' whenever the project
// hasn't set milestones up, so callers can always just ask rowPercent().
function loadMilestoneConfig(projectId, tab) {
  const cfg = db.prepare('SELECT percent_basis AS basis FROM project_milestone_config WHERE project_id = ? AND tab = ?').get(projectId, tab);
  const milestones = db.prepare(
    'SELECT id, label, weightage FROM project_milestones WHERE project_id = ? AND tab = ? ORDER BY sort_order, id'
  ).all(projectId, tab);
  const colStmt = db.prepare('SELECT column_id AS columnId FROM project_milestone_columns WHERE milestone_id = ?');
  milestones.forEach((m) => { m.columnIds = colStmt.all(m.id).map((r) => r.columnId); });
  return { basis: milestones.length && cfg ? cfg.basis : 'column', milestones };
}

// Row "% Complete" under the project's chosen basis.
function rowPercent(cells, columnRows, config) {
  return config.basis === 'kd'
    ? computeRowPercentByMilestones(cells, columnRows, config.milestones)
    : computeRowPercent(cells, columnRows);
}

module.exports = { loadMilestoneConfig, rowPercent };

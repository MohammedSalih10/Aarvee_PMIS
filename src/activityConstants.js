// Single source of truth for the Field/Office activity module (PRD §3.2, §4.1),
// exposed to the frontend via GET /api/activity-meta so columns/status are
// never duplicated between server and client.
//
// Columns and statuses follow the "Aarvee PMIS - Portal.html" reference mockup
// (chosen over the PRD's 26-column / 4-status list).

const COLUMNS_BY_TAB = {
  office: [
    'DPR Submission TDC (Internal)', 'Desk Study', 'Regression', 'CP', 'HAL', 'H&H Design',
    'Bridgelist', 'VAL', 'P&P', 'C/s Drawings', 'Structures input for estimates', 'ESPs',
    'Geotech report', 'Traffic reports', 'OHE', 'S&T', 'Estimation', 'EIRR & FIRR', 'GADs', 'DPR',
  ],
  field: [
    'GCS', 'LiDAR', 'Lidar output', 'Bathymetric Surveys', 'Stream Surveys',
    'Geotech Investigations', 'Traffic Surveys', 'Village Maps', 'LAP', 'Foot by Foot',
  ],
};

// Old PRD column keys -> mockup keys, applied once to existing data by migrate.js.
const LEGACY_COLUMN_RENAMES = {
  office: {
    'C/S Drawings': 'C/s Drawings', ESP: 'ESPs', 'Geotech Report': 'Geotech report',
    'Traffic Reports': 'Traffic reports', 'S&T Estimates': 'S&T', 'Civil Estimate': 'Estimation',
    'FIRR & EIRR': 'EIRR & FIRR', GAD: 'GADs',
  },
  field: { 'Lidar Output': 'Lidar output' },
};

const ACTIVITY_STATUS = {
  YTS: 'Yet to Start',
  IP: 'In Progress',
  OH: 'On Hold',
  SUB: 'Submitted',
  CC: 'Comment Compliance',
  APP: 'Approved',
  NA: 'NA',
  // Not statuses a cell can hold -- only labels for the history entries logged
  // when a Comment Compliance revision is requested (CCQ) and when
  // management/admin approve (CCA) or reject (CCR) it (not in
  // ACTIVITY_STATUS_ORDER, so they can't be saved as a status).
  CCQ: 'Comment Compliance revision requested',
  CCA: 'Comment Compliance revision approved',
  CCR: 'Comment Compliance revision rejected',
};
const ACTIVITY_STATUS_ORDER = ['YTS', 'IP', 'OH', 'SUB', 'CC', 'APP', 'NA'];

// Comment Compliance carries a revision number. Revisions 1 and 2 can be
// recorded directly; anything beyond MAX_FREE_REVISION has to be requested and
// approved by management/admin (see revisionRequests.routes.js).
const MAX_FREE_REVISION = 2;

// Every status is offered as an update choice -- Submitted/Approved are the
// end states.
const ACTIVITY_STATUS_UPDATE_ORDER = ACTIVITY_STATUS_ORDER;

// Mockup summary chips: Submitted / Approved count as Completed; NA isn't
// counted.
const ACTIVITY_STATUS_GROUP = {
  YTS: 'YTS', IP: 'IP', OH: 'OH', SUB: 'C', CC: 'CC', APP: 'C', NA: null,
};

// Corridor "% Complete" column: each cell's status maps to a completion %,
// weighted by its column's weightage (activity_columns.weightage) and summed
// into a weighted average. NA and On Hold are both excluded from that
// average entirely -- NA because the activity doesn't apply to this
// corridor, On Hold because a paused activity shouldn't drag the row's %
// down; computeRowPercent redistributes their weightage across the row's
// other active columns instead of dropping it. A cell with no status yet
// counts as 0% (same as Yet to Start), not excluded, so an untouched
// corridor reads as 0% complete rather than skipping straight to 100%.
const ACTIVITY_STATUS_PERCENT = {
  YTS: 0, IP: 50, OH: null, SUB: 100, CC: 75, APP: 100, NA: null,
};

// PRD §4.2 — PDF, DWG, XLSX, DOCX, Images.
const ALLOWED_UPLOAD_EXTENSIONS = ['.pdf', '.dwg', '.xls', '.xlsx', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.gif'];

// Each cell carries a single date whose meaning follows its status, instead
// of separate planned/actual dates -- there's no "actual date" to enter.
const TENTATIVE_DATE_LABEL = {
  YTS: 'Tentative start date', IP: 'Tentative finish date', OH: 'On hold from',
  SUB: 'Expected approval date', CC: 'Approval date', APP: 'Approved on', NA: null,
};

// A cell's alert state is derived from its tentative date, not stored.
// YTS/IP/SUB are tentative-date-tracked: once the date passes while the cell
// is still in that status, it's 'overdue' (-> "Behind Schedule" color on the
// matrix + an auto-generated pending action); within ALERT_LEAD_DAYS (counted
// in working days -- see addWorkingDaysISO) before it, it's 'upcoming'
// (-> Alerts panel). Changing the status is what resolves the alert -- there's
// no separate actual date to enter.
//
// Submitted's tentative date ("Expected approval date") isn't manually
// entered like YTS/IP's -- the cell PATCH route auto-fills it to
// SUB_APPROVAL_DAYS working days after the day the status became Submitted,
// so it rides the same overdue/upcoming logic below for free.
const ALERT_LEAD_DAYS = 2;
const ALERTABLE_STATUSES = ['YTS', 'IP', 'SUB', 'CC'];
const SUB_APPROVAL_DAYS = 10;

// Working-day (Mon-Fri) calendar for this module -- Saturdays and Sundays are
// always non-working. No further holiday list is consulted here (the
// schedule module's separate holiday calendar, with its alternate-Saturdays
// convention, is a different thing and isn't used for this).
function isWeekend(dateISO) {
  const [y, m, d] = dateISO.slice(0, 10).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

// Steps `days` working days from fromISO (exclusive of fromISO itself) and
// returns the landing date. `days` may be negative to step backward. Used
// both to auto-fill Submitted's deadline (forward) and to find the start of
// its alert window (backward, ALERT_LEAD_DAYS before the deadline).
function addWorkingDaysISO(fromISO, days) {
  const msPerDay = 86400000;
  const [y, m, d] = fromISO.slice(0, 10).split('-').map(Number);
  let cur = Date.UTC(y, m - 1, d);
  const dir = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    cur += dir * msPerDay;
    if (!isWeekend(new Date(cur).toISOString())) remaining -= 1;
  }
  return new Date(cur).toISOString().slice(0, 10);
}

// `todayISO` defaults to now; pass a fixed date in tests for determinism.
// Overdue is a plain calendar comparison (the due date is a specific day,
// whether or not today happens to be a working day); only the "upcoming"
// lead window is reckoned in working days.
// Alerts and pending actions run on the Mon-Fri working week: on a Saturday or
// Sunday "today" is treated as the preceding Friday, so nothing becomes
// due-soon or overdue over the weekend -- an item due on Friday (or on the
// weekend itself) turns overdue on Monday, not Saturday.
function lastWorkingDayISO(dateISO) {
  let d = dateISO.slice(0, 10);
  while (isWeekend(d)) d = new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return d;
}

function classifyDue(dueISO, rawTodayISO) {
  const todayISO = lastWorkingDayISO(rawTodayISO);
  const due = dueISO.slice(0, 10);
  if (todayISO > due) return 'overdue';
  if (todayISO >= addWorkingDaysISO(due, -ALERT_LEAD_DAYS)) return 'upcoming';
  return null;
}

// Every deadline on the cell that is currently alerting, as
// [{ kind, state, dueDate }]. A Yet to Start cell can carry two: its tentative
// start date (kind 'start') and its planned finish date (kind 'finish'),
// each alerting independently with the same upcoming/overdue rules. Other
// alertable statuses only have the single tentative date (kind 'date').
function deriveCellAlertDetails(cell, todayISO = new Date().toISOString().slice(0, 10)) {
  if (!cell || !ALERTABLE_STATUSES.includes(cell.status)) return [];
  const out = [];
  const add = (kind, dueDate) => {
    if (!dueDate) return;
    const state = classifyDue(dueDate, todayISO);
    if (state) out.push({ kind, state, dueDate });
  };
  add(cell.status === 'YTS' ? 'start' : 'date', cell.tentativeDate);
  if (cell.status === 'YTS') add('finish', cell.plannedFinishDate);
  return out;
}

// Worst alert across the cell's deadlines (overdue beats upcoming) -- what the
// grid colours the cell by. Also returns which deadline it came from so the
// hover popup can name the right date.
function deriveCellAlertSummary(cell, todayISO) {
  const details = deriveCellAlertDetails(cell, todayISO);
  return details.find((d) => d.state === 'overdue') || details[0] || null;
}

function deriveCellAlert(cell, todayISO) {
  const worst = deriveCellAlertSummary(cell, todayISO);
  return worst ? worst.state : null;
}

// Weighted average of each applicable column's status -> % complete for one
// corridor row. An NA or On Hold cell's weightage doesn't just drop out --
// it's split equally across the row's other active columns, so the activity
// this corridor doesn't apply to (or has paused) neither drags the % down
// nor (by shrinking the weight total) quietly inflates the rest. Shared by
// the activity grid (per-row %) and the project dashboard (averaged across
// a project's corridor rows for the overall % complete).
function computeRowPercent(cells, columnRows) {
  const active = [];
  let excludedWeight = 0;
  columnRows.forEach((col) => {
    if (col.weightage <= 0) return;
    const cell = cells[col.name];
    const pct = ACTIVITY_STATUS_PERCENT[(cell && cell.status) || 'YTS'];
    if (pct == null) { excludedWeight += col.weightage; return; }
    active.push({ weight: col.weightage, pct });
  });
  if (!active.length) return null;
  const bonus = excludedWeight / active.length;
  let weightSum = 0, weighted = 0;
  active.forEach(({ weight, pct }) => {
    const effWeight = weight + bonus;
    weightSum += effWeight;
    weighted += effWeight * pct;
  });
  return weightSum > 0 ? weighted / weightSum : null;
}

// Same idea as computeRowPercent, but weighted by payment milestone (KD)
// instead of by column. Each milestone's own % is the column-weighted average
// of its columns (computeRowPercent; equal split if none of them carry a
// column weightage), then the milestones are averaged by their claim
// weightage. A milestone whose columns are all NA / On Hold drops out and its
// weightage is split across the others, exactly as columns do above. Columns
// outside every milestone don't carry payment weight, so they're ignored.
// `milestones` = [{ weightage, columnIds }].
function computeRowPercentByMilestones(cells, columnRows, milestones) {
  const active = [];
  let excludedWeight = 0;
  milestones.forEach((m) => {
    if (m.weightage <= 0) return;
    let cols = columnRows.filter((c) => m.columnIds.includes(c.id));
    if (cols.length && cols.every((c) => c.weightage <= 0)) cols = cols.map((c) => ({ ...c, weightage: 1 }));
    const pct = computeRowPercent(cells, cols);
    if (pct == null) { excludedWeight += m.weightage; return; }
    active.push({ weight: m.weightage, pct });
  });
  if (!active.length) return null;
  const bonus = excludedWeight / active.length;
  let weightSum = 0, weighted = 0;
  active.forEach(({ weight, pct }) => {
    weightSum += weight + bonus;
    weighted += (weight + bonus) * pct;
  });
  return weightSum > 0 ? weighted / weightSum : null;
}

module.exports = {
  computeRowPercentByMilestones,
  COLUMNS_BY_TAB, LEGACY_COLUMN_RENAMES, ACTIVITY_STATUS, ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_UPDATE_ORDER,
  ACTIVITY_STATUS_GROUP, ACTIVITY_STATUS_PERCENT, ALLOWED_UPLOAD_EXTENSIONS, TENTATIVE_DATE_LABEL, ALERT_LEAD_DAYS,
  SUB_APPROVAL_DAYS, MAX_FREE_REVISION, isWeekend, addWorkingDaysISO, deriveCellAlert, deriveCellAlertDetails, deriveCellAlertSummary, computeRowPercent,
};

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
  APP: 'Approved',
  NA: 'NA',
};
const ACTIVITY_STATUS_ORDER = ['YTS', 'IP', 'OH', 'SUB', 'APP', 'NA'];

// Every status is offered as an update choice -- Submitted/Approved are the
// end states.
const ACTIVITY_STATUS_UPDATE_ORDER = ACTIVITY_STATUS_ORDER;

// Mockup summary chips: Submitted / Approved count as Completed; NA isn't
// counted.
const ACTIVITY_STATUS_GROUP = {
  YTS: 'YTS', IP: 'IP', OH: 'OH', SUB: 'C', APP: 'C', NA: null,
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
  YTS: 0, IP: 50, OH: null, SUB: 100, APP: 100, NA: null,
};

// PRD §4.2 — PDF, DWG, XLSX, DOCX, Images.
const ALLOWED_UPLOAD_EXTENSIONS = ['.pdf', '.dwg', '.xls', '.xlsx', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.gif'];

// Each cell carries a single date whose meaning follows its status, instead
// of separate planned/actual dates -- there's no "actual date" to enter.
const TENTATIVE_DATE_LABEL = {
  YTS: 'Tentative start date', IP: 'Tentative finish date', OH: 'Tentative date',
  SUB: 'Expected approval date', APP: 'Approved on', NA: null,
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
const ALERTABLE_STATUSES = ['YTS', 'IP', 'SUB'];
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
function deriveCellAlert(cell, todayISO = new Date().toISOString().slice(0, 10)) {
  if (!cell || !cell.tentativeDate || !ALERTABLE_STATUSES.includes(cell.status)) return null;
  const due = cell.tentativeDate.slice(0, 10);
  if (todayISO > due) return 'overdue';
  if (todayISO >= addWorkingDaysISO(due, -ALERT_LEAD_DAYS)) return 'upcoming';
  return null;
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

module.exports = {
  COLUMNS_BY_TAB, LEGACY_COLUMN_RENAMES, ACTIVITY_STATUS, ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_UPDATE_ORDER,
  ACTIVITY_STATUS_GROUP, ACTIVITY_STATUS_PERCENT, ALLOWED_UPLOAD_EXTENSIONS, TENTATIVE_DATE_LABEL, ALERT_LEAD_DAYS,
  SUB_APPROVAL_DAYS, isWeekend, addWorkingDaysISO, deriveCellAlert, computeRowPercent,
};

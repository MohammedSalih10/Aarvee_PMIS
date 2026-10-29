const db = require('./db');
const { COLUMNS_BY_TAB } = require('./activityConstants');

// ---------------------------------------------------------------------------
// Real project data from the four files the client supplied ("PMIS- Progress
// flow Automation R4 21-11-25.pptx", "NR schedule stage 1 -Final.xlsx",
// "Aarvee PMIS Framework R3 11-06-26.docx", "Task Dashboard- SWR Sample.xlsx").
//
// This adds two real projects (2765, 2989) with their real corridor/
// responsible-person data and Office/Field statuses, plus the schedule module
// (schedule_items, resource_rates, holidays) seeded from the NR/SWR schedule
// sheets. It does not touch the 5 projects already seeded in seed.js.
//
// What's NOT carried over, and why: the schedule sheets' per-task resource
// costings and 20+ Office columns from the real tracker (Stage 1 HAL/H&H/BL/
// VAL, SIP, Index Plan & Section, LWR, Bridge Design) have no matching column
// in the app's current 20-column Office grid — see REALDATA_NOTES below and
// the README for the full list of what's mapped vs. dropped.
// ---------------------------------------------------------------------------
const TAG = 'real-data-seed';
const VERSION = '2';

// Excel's date serial (1900 system) -> ISO date. Matches the serials used
// throughout the source spreadsheets.
function xl(serial) {
  return new Date(Math.round((serial - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
}

function projectIdByCode(code) {
  const row = db.prepare('SELECT id FROM projects WHERE code = ?').get(code);
  return row ? row.id : null;
}

function alreadySeeded() {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'real_data_seed_version'").get();
  return row && row.value === VERSION;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
const NEW_PROJECTS = [
  // code, name, type, woValueCr (0 = not stated in any source file — flagged in README)
  [2765, 'South Western Railway (SWR)', 'FLS', 0],
  [2989, 'Northern Railway (Reasi-Poonch)', 'DPR', 22.07],
];

function seedProjects() {
  const insert = db.prepare('INSERT INTO projects (code, name, type, wo_value_cr) VALUES (?,?,?,?)');
  NEW_PROJECTS.forEach(([code, name, type, wo]) => { if (!projectIdByCode(code)) insert.run(code, name, type, wo); });

  // "NR schedule stage 1 -Final.xlsx", Top sheet: contractual dates for 2989.
  db.prepare('UPDATE projects SET contract_start = ?, contract_end = ? WHERE code = 2989 AND contract_start IS NULL')
    .run(xl(46266), xl(46536));

  // Give both demo accounts access, same as the originally-seeded projects
  // (they don't exist when demo seeding is off, and the FK would reject them).
  const assign = db.prepare(
    'INSERT OR IGNORE INTO project_assignments (project_id, username, assigned_by) VALUES (?,?,?)'
  );
  const demoUsers = ['pmo.demo', 'mgmt.demo']
    .filter((u) => db.prepare('SELECT 1 FROM users WHERE username = ?').get(u));
  NEW_PROJECTS.forEach(([code]) => {
    const id = projectIdByCode(code);
    demoUsers.forEach((u) => assign.run(id, u, TAG));
  });
}

// ---------------------------------------------------------------------------
// Corridors for South Western Railway (2765) — "Task Dashboard- SWR Sample.xlsx"
// (SWR- Field, SWR- Office sheets). Each entry: corridor, lineType ("Type of
// Proposal"), lengthKm, responsiblePerson (null for the 8 stretches
// still awaiting a work order, per the sheet's own "Work order yet to
// receive" grouping).
// ---------------------------------------------------------------------------
const SWR_CORRIDORS = [
  ['Birur-Shimoga', 'Doubling', 62.9, 'Mr. Lilith'],
  ['Arsikera-Hassan-Mysore', 'Doubling', 166, 'Mr. Lilith'],
  ['Rayadurga-Tumkur', 'Doubling', 194, 'Mr. Lilith'],
  ['Dharwad-Belgaum', 'Doubling', 73, 'Mr. Mallesh'],
  ['Talguppa-Sirsi-Hubli', 'New line', 185, 'Mr. Mallesh'],
  ['Shimoga-Shringeri-Manglore', 'New line', 227, null],
  ['Hejjala-Chamarajanagar', 'New line', 142, null],
  ['Daroji-Gangavathi-Bagalkot', 'New line', 178.3, null],
  ['Shravanabelagola-Madikeri', 'New line', 117, null],
  ['Redi Port-Sawantwadi Road', 'New line', 40, null],
  ['Honnavar Port-Hosapattana', 'New line', 10, null],
  ['Keni Port-Ankola', 'New line', 16, null],
  ['Pavinkurve Port-Honnavar', 'New line', 8, null],
];

// Field survey statuses — "SWR- Field" sheet (5 active corridors; the other 8
// are all Yet to Start, matching "SWR- Sample"'s "Work orders yet to
// receive"/"Port connectivity Surveys" groups). Keyed by the app's field
// column names (COLUMNS_BY_TAB.field), not the sheet's column order.
const SWR_FIELD_STATUS = {
  'Rayadurga-Tumkur': { GCS: 'APP', LiDAR: 'APP', 'Lidar output': 'APP', 'Bathymetric Surveys': 'YTS', 'Stream Surveys': 'YTS', 'Geotech Investigations': 'YTS', 'Traffic Surveys': 'YTS', 'Village Maps': 'IP', LAP: 'YTS', 'Foot by Foot': 'YTS' },
  'Talguppa-Sirsi-Hubli': { GCS: 'APP', LiDAR: 'OH', 'Lidar output': 'YTS', 'Bathymetric Surveys': 'YTS', 'Stream Surveys': 'YTS', 'Geotech Investigations': 'YTS', 'Traffic Surveys': 'YTS', 'Village Maps': 'IP', LAP: 'YTS', 'Foot by Foot': 'YTS' },
  'Dharwad-Belgaum': { GCS: 'APP', LiDAR: 'APP', 'Lidar output': 'OH', 'Bathymetric Surveys': 'YTS', 'Stream Surveys': 'YTS', 'Geotech Investigations': 'YTS', 'Traffic Surveys': 'YTS', 'Village Maps': 'IP', LAP: 'YTS', 'Foot by Foot': 'YTS' },
  'Birur-Shimoga': { GCS: 'APP', LiDAR: 'APP', 'Lidar output': 'APP', 'Bathymetric Surveys': 'YTS', 'Stream Surveys': 'YTS', 'Geotech Investigations': 'YTS', 'Traffic Surveys': 'YTS', 'Village Maps': 'IP', LAP: 'YTS', 'Foot by Foot': 'YTS' },
  'Arsikera-Hassan-Mysore': { GCS: 'APP', LiDAR: 'APP', 'Lidar output': 'APP', 'Bathymetric Surveys': 'YTS', 'Stream Surveys': 'YTS', 'Geotech Investigations': 'YTS', 'Traffic Surveys': 'YTS', 'Village Maps': 'IP', LAP: 'YTS', 'Foot by Foot': 'YTS' },
};

// Office deliverable statuses — "SWR- Office" sheet. Token is either a status
// string or an Excel serial (meaning "approved on this date"). Only columns
// with a real equivalent in the app's 20-column Office grid are included —
// see REALDATA_NOTES for the 9 real columns with no match (dropped, not lost:
// the source files still have them).
const SWR_OFFICE_STATUS = {
  'Birur-Shimoga': { 'Desk Study': 46142, Regression: 46154, CP: 46166, ESPs: 46178, HAL: 46184, 'H&H Design': 46184, Bridgelist: 46153, VAL: 46184, 'P&P': 46184, 'C/s Drawings': 'YTS', 'Geotech report': 'YTS', 'Traffic reports': 'YTS', OHE: 'YTS', 'S&T': 'YTS', Estimation: 'YTS', 'EIRR & FIRR': 'YTS', GADs: 'YTS', DPR: 'YTS' },
  'Arsikera-Hassan-Mysore': { 'Desk Study': 46142, Regression: 46154, CP: 46166, ESPs: 'YTS', HAL: 46187, 'H&H Design': 46187, Bridgelist: 46187, VAL: 46187, 'P&P': 46187, 'C/s Drawings': 46187, 'Geotech report': 'YTS', 'Traffic reports': 'YTS', OHE: 'YTS', 'S&T': 'YTS', Estimation: 'YTS', 'EIRR & FIRR': 'YTS', GADs: 'YTS', DPR: 'YTS' },
  'Rayadurga-Tumkur': { 'Desk Study': 46157, Regression: 46169, CP: 46193, ESPs: 'YTS', HAL: 46187, 'H&H Design': 46187, Bridgelist: 46187, VAL: 46187, 'P&P': 46202, 'C/s Drawings': 46248, 'Geotech report': 'YTS', 'Traffic reports': 46199, OHE: 46199, 'S&T': 46199, Estimation: 46199, 'EIRR & FIRR': 46202, GADs: 46248, DPR: 46203 },
  'Dharwad-Belgaum': { 'Desk Study': 46157, Regression: 'OH', CP: 'OH', ESPs: 'OH', HAL: 'OH', 'H&H Design': 'OH', Bridgelist: 'OH', VAL: 'OH', 'P&P': 'OH', 'C/s Drawings': 'OH', 'Geotech report': 'OH', 'Traffic reports': 'OH', OHE: 'OH', 'S&T': 'OH', Estimation: 'OH', 'EIRR & FIRR': 'OH', GADs: 'OH', DPR: 'OH' },
  'Talguppa-Sirsi-Hubli': { 'Desk Study': 46157, Regression: 'NA', CP: 46219, HAL: 46209, 'H&H Design': 46219, Bridgelist: 46220, VAL: 46230, 'P&P': 46245, 'C/s Drawings': 46291, 'Traffic reports': 46199, OHE: 46240, 'S&T': 46234, Estimation: 46243, 'EIRR & FIRR': 46244, GADs: 46291, DPR: 46246 },
};

// The app's Office grid has 2 columns with no equivalent in the real SWR-
// Office sheet at all ("DPR Submission TDC (Internal)", "Structures input for
// estimates" — carried over from the earlier mockup-based seed). Left blank
// for every corridor, not just the ones with no real data.
const SWR_OFFICE_NO_REAL_EQUIVALENT = new Set(['DPR Submission TDC (Internal)', 'Structures input for estimates']);

function seedSwrActivities() {
  const projectId = projectIdByCode(2765);
  if (!projectId) return;

  const insertActivity = db.prepare(`
    INSERT INTO project_activities (project_id, tab, corridor, line_type, length_km, responsible_person, sort_order)
    VALUES (?,?,?,?,?,?,?)`);
  const insertCell = db.prepare(`
    INSERT OR IGNORE INTO activity_cells (activity_id, column_key, status, tentative_date, remarks, signed, updated_by)
    VALUES (?,?,?,?,'',1,?)`);

  ['office', 'field'].forEach((tab) => {
    SWR_CORRIDORS.forEach(([corridor, lineType, lengthKm, responsiblePerson], i) => {
      const existing = db.prepare('SELECT id FROM project_activities WHERE project_id = ? AND tab = ? AND corridor = ?')
        .get(projectId, tab, corridor);
      const activityId = existing ? existing.id
        : insertActivity.run(projectId, tab, corridor, lineType, lengthKm, responsiblePerson, i).lastInsertRowid;

      const statusMap = tab === 'field' ? SWR_FIELD_STATUS[corridor] : SWR_OFFICE_STATUS[corridor];
      const columns = COLUMNS_BY_TAB[tab];
      columns.forEach((col) => {
        if (tab === 'office' && SWR_OFFICE_NO_REAL_EQUIVALENT.has(col)) return; // leave blank, no real data at all
        const raw = statusMap ? statusMap[col] : 'YTS'; // the 8 WO-pending stretches default to Yet to Start
        if (raw === undefined) return; // no real-data equivalent for this column for this corridor — leave blank
        const [status, date] = typeof raw === 'number' ? ['APP', xl(raw)] : [raw, null];
        insertCell.run(activityId, col, status, date, TAG);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Schedule module — "NR schedule stage 1 -Final.xlsx"
// ---------------------------------------------------------------------------
// Project 2989, stretch "Reasi-Poonch" (190km) — "NR schedule template" sheet.
const NR_SCHEDULE = [
  ['Inception report', 190, null, null, 10, 46290, 0, 46304, 0],
  ['Stage 1 HAL', 570, 2, 30, 10, 46295, 0, 46309, null],
  ['Stage 1 H&H', 570, 2, 50, 6, 46303, -5, 46310, null],
  ['Stage 1 Bridge list', 570, 2, 50, 6, 46304, -5, 46311, null],
  ['Stage 1 VAL', 570, 2, 30, 10, 46307, -5, 46321, null],
  ['Site visit report', 190, 1, null, 7, 46307, 0, 46316, 0],
  ['MCA report', 190, 1, null, 7, 46322, 0, 46330, null],
  ['Alignment Finalisation Stage 1', 190, 1, null, 7, 46331, 0, 46339, null],
  ['AOI', 190, 1, null, 2, 46342, 0, 46343, null],
  ['DGCA Permission', 190, 1, null, 15, 46344, 0, 46364, null],
  ['MOCA Permission', 190, 1, null, 5, 46365, 0, 46371, null],
  ['Airport authority permission', 190, 1, null, 7, 46365, 0, 46373, null],
  ['Border security permission', 190, 1, null, 7, 46365, 0, 46373, null],
  ['Home affairs', 190, 1, null, 15, 46365, 0, 46386, null],
  ['Drone flying', 190, 1, 12, 16, 46387, 0, 46408, null],
  ['Processed data', 190, 1, 10, 10, 46409, 0, 46422, null],
  ['HAL', 190, 2, 15, 7, 46423, 0, 46433, null],
  ['H&H-Greenfield', 190, 2, 8, 12, 46426, -6, 46441, null],
  ['Bridge list', 190, 1, 30, 7, 46434, -6, 46442, null],
  ['CP-GF', 19, 2, 2, 5, 46443, 0, 46449, null],
  ['VAL', 190, 2, 10, 10, 46436, -5, 46449, null],
  ['VAL remarks 1', 190, 2, 25, 4, 46447, -3, 46450, null],
  ['VAL remarks 2', 190, 2, 25, 4, 46448, -3, 46451, null],
  ['Alignment Reports', 190, 2, null, 1, 46454, 0, 46454, null],
  ['Geotech reccomendations- Minor', 190, 2, 15, 7, 46455, 0, 46463, null],
  ['Bridge Design- GF- Minor', 190, 1, 60, 4, 46461, -3, 46464, null],
  ['Geotech reccomendations- Major', 190, 2, 5, 19, 46455, -8, 46479, null],
  ['Bridge Design- GF- Major', 190, 1, 8, 24, 46456, -18, 46489, null],
  ['Final Bridge List', 190, 2, 0, 1, 46490, 0, 46490, null],
  ['PnPs', 190, 2, 15, 7, 46491, 0, 46499, null],
  ['PnP- Access roads', 190, 2, 15, 7, 46491, 0, 46499, null],
  ['OHE Estimate', 190, 2, 10, 10, 46450, 0, 46463, null],
  ['SIP- GF', 19, 2, 2, 5, 46450, 0, 46456, null],
  ['S&T Estimate- GF', 19, 2, 2, 5, 46457, 0, 46463, null],
  ['Civil Estimate', 190, 2, 0, 3, 46491, 0, 46493, null],
  ['ESP- GF', 19, 2, 1, 10, 46450, 0, 46463, null],
  ['EIRR & FIRR', 190, 2, null, 2, 46496, 0, 46497, null],
  ['DPR', 190, 2, 100, 1, 46500, 0, 46500, null],
];

// Project 2765, stretches not yet in the SWR-Field/Office status sheets.
// Bhadravathi-Chikjajur has the full 29-task breakdown with predecessor
// chains from the "predecessor template" sheet (richer than the 6-task
// summary in "SWR schedule" used for the other 3 stretches below).
// Item shape: [workItem, qty, resources, productivity, days, predecessor(s)
// or null, plannedStart serial, leadLagDays, plannedFinish serial].
const BHADRAVATHI_CHIKJAJUR_SCHEDULE = [
  ['Stage 1 HAL', 219, 2, 30, 4, null, 46235, 0, 46239],
  ['Stage 1 H&H', 219, 1, 50, 5, 'Stage 1 HAL', 46234, -4, 46240],
  ['Stage 1 Bridge list', 219, 1, 50, 5, 'Stage 1 H&H', 46237, -4, 46241],
  ['Stage 1 VAL', 219, 1, 30, 8, 'Stage 1 Bridge list', 46240, -2, 46251],
  ['Alignment Finalisation', 73, 2, 100, 1, 'Stage 1 VAL', 46252, 0, 46252],
  ['Drone flying', 73, 1, 12, 7, 'Alignment Finalisation', 46262, 7, 46272],
  ['Processed data', 73, 0, null, 10, 'Drone flying', 46273, 0, 46287],
  ['HAL', 73, 1, 15, 5, 'Processed data', 46288, 0, 46294],
  ['H&H-Greenfield', 73, 2, 8, 5, 'HAL', 46290, -3, 46296],
  ['Bridge list', 73, 1, 30, 3, 'H&H-Greenfield', 46295, -2, 46300],
  ['CP- BF', 9.125, 2, 1, 5, 'Bridge list', 46295, -3, 46302],
  ['VAL', 73, 1, 10, 8, 'CP- BF', 46295, -5, 46307],
  ['VAL remarks 1', 73, 1, 2, 37, 'VAL', 46304, -2, 46357],
  ['VAL remarks 2', 73, 1, 2, 37, 'VAL remarks 1', 46356, -2, 46407],
  ['Alignment Reports', 73, 1, 1, 3, 'VAL remarks 2', 46408, 0, 46412],
  ['Geotech reccomendations- Minor', 116.8, 2, 15, 4, 'Alignment Reports', 46413, 0, 46416],
  ['Bridge Design- GF- Minor', 116.8, 1, 60, 2, 'Geotech reccomendations- Minor', 46416, -1, 46419],
  ['Geotech reccomendations- Major', 29.2, 2, 5, 3, 'Alignment Reports', 46412, -1, 46414],
  ['Bridge Design- GF- Major', 29.2, 1, 8, 4, 'Geotech reccomendations- Major', 46413, -2, 46416],
  ['Final Bridge List', 73, 1, null, 1, 'Bridge Design- GF- Major', 46419, 0, 46419],
  ['PnPs', 73, 1, 15, 5, 'Final Bridge List', 46420, 0, 46426],
  ['OHE Estimate', 73, 1, 10, 8, 'CP- BF', 46281, -15, 46290],
  ['SIPs', 9.125, 1, 1, 10, 'CP- BF', 46280, -16, 46293],
  ['S&T Estimate- GF', 9.125, 1, 2, 5, 'SIPs', 46294, 0, 46301],
  ['Civil Estimate', 73, 1, null, 3, 'Final Bridge List', 46420, 0, 46422],
  ['ESP- GF', 9.125, 1, 1, 10, 'CP- BF', 46303, 0, 46317],
  ['EIRR & FIRR', 73, 1, null, 2, 'OHE Estimate, S&T Estimate- GF, Civil Estimate', 46423, 0, 46426],
  ['DPR', 73, 1, 100, 1, 'EIRR & FIRR', 46427, 0, 46427],
  ['GAD- Green field', 146, 3, 4, 13, 'Final Bridge List', 46420, 0, 46436],
];

// The other 3 stretches only have the 6-task summary from "SWR schedule"
// (no predecessor-level breakdown exists for them in the source files).
const SWR_SCHEDULE_STRETCHES = [
  ['Talguppa-Honnavara', 95, [
    ['Stage 1 HAL', 285, 1, 30, 10, 46235, 0, 46247],
    ['Stage 1 H&H', 285, 1, 50, 6, 46241, -5, 46248],
    ['Stage 1 Bridge list', 285, 1, 50, 6, 46244, -5, 46251],
    ['Stage 1 VAL', 285, 1, 30, 10, 46248, -2, 46261],
    ['Alignment Finalisation', 95, 1, 100, 1, 46262, 0, 46262],
    ['Flying & Processed data', 95, 1, 20, 15, 46274, 7, 46295],
  ]],
  ['Alamtti-Yadgiri', 162, [
    ['Stage 1 HAL', 486, 2, 30, 9, 46269, 0, 46282],
    ['Stage 1 H&H', 486, 2, 50, 5, 46276, -4, 46283],
    ['Stage 1 Bridge list', 486, 2, 50, 5, 46280, -4, 46286],
    ['Stage 1 VAL', 486, 2, 30, 9, 46283, -2, 46295],
    ['Alignment Finalisation', 162, 2, 100, 1, 46296, 0, 46296],
    ['Flying & Processed data', 162, 1, 20, 19, 46309, 7, 46336],
  ]],
  ['Shivamogga-Sringeri-Manglore', 332, [
    ['Stage 1 HAL', 996, 2, 30, 17, 46303, 0, 46328],
    ['Stage 1 H&H', 996, 2, 50, 10, 46316, -9, 46329],
    ['Stage 1 Bridge list', 996, 2, 50, 10, 46317, -9, 46330],
    ['Stage 1 VAL', 996, 2, 30, 17, 46329, -2, 46351],
    ['Alignment Finalisation', 332, 2, 100, 1, 46352, 0, 46352],
    ['Flying & Processed data', 332, 1, 20, 14, 46364, 7, 46384],
  ]],
];

// Idempotent upsert: the planned fields always come from the source file (not
// user-editable), so they're refreshed on every re-seed; actual_completion/
// remarks (the only fields a user can set via PATCH) are left alone once a
// row exists, whoever owns it.
function upsertScheduleItem(projectId, stretch, lengthKm, sortOrder, [workItem, qty, res, prod, days, predecessor, start, lag, finish, designExp]) {
  const existing = db.prepare('SELECT id FROM schedule_items WHERE project_id = ? AND stretch = ? AND work_item = ?')
    .get(projectId, stretch, workItem);
  if (existing) {
    db.prepare(`
      UPDATE schedule_items SET route_length_km = ?, quantity = ?, resources = ?, productivity = ?, days_required = ?,
        planned_start = ?, lead_lag_days = ?, planned_finish = ?, predecessor = ?, design_expenditure_cr = ?, sort_order = ?
      WHERE id = ?`).run(lengthKm, qty, res, prod, days, xl(start), lag, xl(finish), predecessor || null, designExp || null, sortOrder, existing.id);
  } else {
    db.prepare(`
      INSERT INTO schedule_items (project_id, stretch, route_length_km, work_item, quantity, resources, productivity,
        days_required, planned_start, lead_lag_days, planned_finish, predecessor, design_expenditure_cr, sort_order, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      projectId, stretch, lengthKm, workItem, qty, res, prod, days, xl(start), lag, xl(finish), predecessor || null, designExp || null, sortOrder, TAG
    );
  }
}

function seedScheduleItems() {
  const nrId = projectIdByCode(2989);
  if (nrId) {
    NR_SCHEDULE.forEach(([workItem, qty, res, prod, days, start, lag, finish, designExp], i) => {
      upsertScheduleItem(nrId, 'Reasi-Poonch', 190, i, [workItem, qty, res, prod, days, null, start, lag, finish, designExp]);
    });
  }

  const swrId = projectIdByCode(2765);
  if (swrId) {
    // v1 seeded a 6-item summary for this stretch under different work-item
    // names (e.g. "Flying & Processed data" split into "Drone flying" +
    // "Processed data" in the fuller v2 breakdown) — drop any seed-owned row
    // that isn't in the new list, so the rename doesn't leave a stale
    // duplicate. A user-edited row (updated_by != TAG) is never touched.
    const keepNames = new Set(BHADRAVATHI_CHIKJAJUR_SCHEDULE.map((item) => item[0]));
    db.prepare(`
      DELETE FROM schedule_items WHERE project_id = ? AND stretch = ? AND updated_by = ?
        AND work_item NOT IN (${[...keepNames].map(() => '?').join(',')})`
    ).run(swrId, 'Bhadravathi-Chikjajur', TAG, ...keepNames);

    let order = 0;
    BHADRAVATHI_CHIKJAJUR_SCHEDULE.forEach((item) => upsertScheduleItem(swrId, 'Bhadravathi-Chikjajur', 73, order++, item));
    SWR_SCHEDULE_STRETCHES.forEach(([stretch, lengthKm, items]) => {
      items.forEach(([workItem, qty, res, prod, days, start, lag, finish]) =>
        upsertScheduleItem(swrId, stretch, lengthKm, order++, [workItem, qty, res, prod, days, null, start, lag, finish, null]));
    });
  }
}

// ---------------------------------------------------------------------------
// Reference data: resource rate card + holiday calendar — "NR schedule
// stage 1 -Final.xlsx" (Resource sheet, List of Holidays sheet). Not
// project-scoped.
// ---------------------------------------------------------------------------
const RESOURCE_RATES = [
  ['Senior VP', 400000],
  ['VP / Team Leader', 325000],
  ['A.V.P / Sr. Consultant', 225000],
  ['Manager / Coordinator', 125000],
  ['Asst. Mgr', 75000],
  ['Engineer / GTE / PGTE', 55000],
  ['CAD / Surveyors', 55000],
];

const HOLIDAYS = [
  [46085, 'Sunday'], [46123, '2nd Saturday'], [46124, 'Sunday'], [46131, 'Sunday'],
  [46137, '4th Saturday'], [46145, 'Sunday'], [46151, '2nd Saturday'], [46152, 'Sunday'],
  [46159, 'Sunday'], [46165, '4th Saturday'], [46166, 'Sunday'], [46172, '5th Saturday'],
  [46173, 'Sunday'], [46180, 'Sunday'], [46186, '2nd Saturday'], [46187, 'Sunday'],
];

function seedReferenceData() {
  const insertRate = db.prepare('INSERT OR IGNORE INTO resource_rates (role, monthly_rate) VALUES (?,?)');
  RESOURCE_RATES.forEach(([role, rate]) => insertRate.run(role, rate));

  const insertHoliday = db.prepare('INSERT OR IGNORE INTO holidays (holiday_date, description) VALUES (?,?)');
  HOLIDAYS.forEach(([serial, desc]) => insertHoliday.run(xl(serial), desc));
}

function seedRealData() {
  if (alreadySeeded()) return;
  db.transaction(() => {
    seedProjects();
    seedSwrActivities();
    seedScheduleItems();
    seedReferenceData();
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('real_data_seed_version', ?)").run(VERSION);
  })();
  console.log(`Loaded real project data v${VERSION} (projects 2765, 2989 + schedule module) from the client's source files.`);
}

module.exports = seedRealData;

const db = require('./db');
const { COLUMNS_BY_TAB } = require('./activityConstants');
const { BUDGET_CATEGORIES } = require('./dashboardConstants');

// ---------------------------------------------------------------------------
// Demo data taken from the reference mockups ("Aarvee PMIS - Portal.html",
// "Aarvee PMIS updated.html"). Rows are tagged created_by/updated_by =
// DEMO_TAG. The whole set runs once per DEMO_VERSION (tracked in app_meta),
// back-fills existing databases, and never overwrites user-edited rows.
// ---------------------------------------------------------------------------
const DEMO_TAG = 'demo-seed';
const DEMO_VERSION = '3';
const DEMO_PROJECT_CODES = [2746, 2616, 2577, 2681, 2702];

// Same deterministic generator the mockup uses for its placeholder numbers.
const rnd = (s) => { s = Math.sin(s * 9301 + 49297) * 233280; return s - Math.floor(s); };
const round2 = (x) => Math.round(x * 100) / 100;
const demoProjects = () => db.prepare(
  `SELECT id, code, wo_value_cr AS wo FROM projects WHERE code IN (${DEMO_PROJECT_CODES.join(',')})`
).all();
const projectIdByCode = (code) => {
  const row = db.prepare('SELECT id FROM projects WHERE code = ?').get(code);
  return row ? row.id : null;
};
const hasDemoRows = (table, col) =>
  !!db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`).get(DEMO_TAG);

// --- Dashboard alerts / pending actions (mockup `alerts`, `pend`) ----------
const DEMO_ALERTS = [
  [2577, 'Project 2577 - BG expired on 10-10-2025'],
  [2616, 'Approval of VAL is due on 12-10-2025'],
  [null, 'EOT approved till 31-12-2025'],
];
const DEMO_PENDING = [
  [2616, 'Approve VAL for Project 2616', '2025-10-12'],
  [2577, 'Renew bank guarantee - Project 2577', '2025-10-10'],
  [2681, 'Submit Q3 billing statement - Project 2681', '2025-10-20'],
];

function seedAlertsAndPending() {
  if (!hasDemoRows('alerts', 'created_by')) {
    const insert = db.prepare('INSERT INTO alerts (project_id, message, created_by) VALUES (?,?,?)');
    DEMO_ALERTS.forEach(([code, msg]) => insert.run(code ? projectIdByCode(code) : null, msg, DEMO_TAG));
  }
  if (!hasDemoRows('pending_actions', 'created_by')) {
    const insert = db.prepare('INSERT INTO pending_actions (project_id, title, due_date, created_by) VALUES (?,?,?,?)');
    DEMO_PENDING.forEach(([code, title, due]) => insert.run(projectIdByCode(code), title, due, DEMO_TAG));
  }
}

// --- Monthly financials ----------------------------------------------------
// The mockup has no stored figures — it derives billing/collection from WO
// value with an S-curve plan and noisy actuals. Persist the same shape for the
// three FYs the dashboard offers; actuals for completed months, forecasts for
// the rest of the current FY.
function seedFinancials() {
  const now = new Date();
  const currentFY = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const monthsElapsed = (now.getMonth() + 9) % 12; // completed months since April
  const S = (x) => x * x * (3 - 2 * x) * 0.6 + x * 0.4; // mockup's cumulative plan curve

  const insert = db.prepare(`
    INSERT OR IGNORE INTO financial_entries
      (project_id, fiscal_year, month_index, plan_billing, actual_billing, plan_collection, actual_collection,
       expenditure, forecast_billing, forecast_collection, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const setForecast = db.prepare(`
    UPDATE financial_entries SET forecast_billing = ?, forecast_collection = ?
    WHERE project_id = ? AND fiscal_year = ? AND month_index = ? AND updated_by = ?
      AND actual_billing = 0 AND forecast_billing = 0`);

  for (const p of demoProjects()) {
    for (const fy of [currentFY - 2, currentFY - 1, currentFY]) {
      const annualPlan = p.wo * 0.35;
      const actualMonths = fy < currentFY ? 12 : monthsElapsed;
      for (let m = 0; m < 12; m++) {
        const k = p.code + fy * 7 + m * 13;
        const planBilling = annualPlan * (S((m + 1) / 12) - S(m / 12));
        const planCollection = planBilling * 0.85;
        const hasActual = m < actualMonths;
        const actualBilling = hasActual ? planBilling * (0.75 + 0.35 * rnd(k + 1)) : 0;
        const actualCollection = hasActual ? actualBilling * (0.8 + 0.1 * rnd(k + 2)) : 0;
        const expenditure = hasActual ? actualBilling * (0.7 + 0.2 * rnd(k + 3)) : 0;
        const forecastBilling = hasActual ? 0 : planBilling * (0.85 + 0.3 * rnd(k + 4));
        const forecastCollection = hasActual ? 0 : planCollection * (0.8 + 0.3 * rnd(k + 5));
        insert.run(p.id, fy, m, round2(planBilling), round2(actualBilling), round2(planCollection),
          round2(actualCollection), round2(expenditure), round2(forecastBilling), round2(forecastCollection), DEMO_TAG);
        // Rows from demo v1 had no forecast columns.
        if (!hasActual) setForecast.run(round2(forecastBilling), round2(forecastCollection), p.id, fy, m, DEMO_TAG);
      }
    }
  }
}

// --- Project dashboard (mockup page 3) -------------------------------------
// Mockup META: contract start, contract end, forecast completion, EOT up to, PBG valid up to.
const DEMO_PROJECT_DATES = {
  2746: ['2024-03-05', '2025-09-30', '2025-12-31', '2025-12-31', '2025-12-31'],
  2616: ['2025-01-19', '2025-06-17', '2025-12-31', '2025-12-31', '2025-12-31'],
  2577: ['2024-02-10', '2025-06-30', '2026-03-31', '2025-12-31', '2025-11-30'],
  2681: ['2024-10-01', '2026-09-30', '2026-09-30', '2026-03-31', '2027-03-31'],
  2702: ['2024-07-15', '2026-01-31', '2026-03-31', '2025-12-31', '2026-02-28'],
};
// Mockup budget split per category (fraction of WO / 2.5).
const BUDGET_SHARE = [0.14, 0.18, 0.5, 0.45, 0.3];
// Mockup DLCache — the same four deliverables shown for every project.
const DEMO_DELIVERABLES = [
  ['billing', 'Ujjain - Agar - Jhalawar - NL & Neemuch - Kota - NL - KD1 20%', 'completed', 1.33, '2025-11-27'],
  ['billing', 'Processed Date - 1.38 Cr / Osmanabad - Beed - Aurangabad', 'in_progress', 1.38, '2025-11-30'],
  ['collection', 'Processed Date - 1.26 Cr', 'completed', 1.33, '2025-10-27'],
  ['collection', 'Submission of EPC', 'completed', 1.38, '2025-10-30'],
];

function seedProjectDashboards() {
  const setDetails = db.prepare(`
    UPDATE projects SET contract_start = ?, contract_end = ?, forecast_completion = ?, eot_upto = ?, pbg_valid_upto = ?,
      unbilled_revenue_cr = ?, retention_cr = ?, bank_guarantee_cr = ?
    WHERE id = ? AND contract_start IS NULL`);
  const insertBudget = db.prepare(
    'INSERT OR IGNORE INTO project_budget (project_id, category, budget_cr, expenditure_cr) VALUES (?,?,?,?)'
  );
  const hasDeliverables = db.prepare('SELECT 1 FROM project_deliverables WHERE project_id = ? LIMIT 1');
  const insertDeliverable = db.prepare(`
    INSERT INTO project_deliverables (project_id, kind, name, status, value_cr, due_date, sort_order, updated_by)
    VALUES (?,?,?,?,?,?,?,?)`);

  for (const p of demoProjects()) {
    const r = (i) => rnd(p.code + 5 + i); // mockup render3() with FY 2025-26 selected
    const w = p.wo;
    const unbilled = (r(3) - 0.65) * 0.6 * w / 2.5;
    const retention = r(4) > 0.5 ? 0 : w * 0.012;
    setDetails.run(...DEMO_PROJECT_DATES[p.code], round2(unbilled), round2(retention), round2(w * 0.016), p.id);

    BUDGET_CATEGORIES.forEach((category, i) => {
      const budget = BUDGET_SHARE[i] * w / 2.5;
      insertBudget.run(p.id, category, round2(budget), round2(budget * (0.12 + 0.35 * r(20 + i))));
    });

    if (!hasDeliverables.get(p.id)) {
      DEMO_DELIVERABLES.forEach(([kind, name, status, value, due], i) =>
        insertDeliverable.run(p.id, kind, name, status, value, due, i, DEMO_TAG));
    }
  }
}

// --- Office / Field activity grids for WCR 2616 ----------------------------
// Mockup field grid (FR), one row per corridor, columns as COLUMNS_BY_TAB.field.
const DEMO_FIELD_GRID = [
  'C C C C C C C C OH NA', 'C C C C C C C C OH NA', 'C C C NA C C C C C NA',
  'C C C NA C PC C C C NA', 'C C C NA C PC C C C NA',
  'C C C C C IP:30-10-2025 C IP:15-11-2025 OH C', 'C C C C C IP:30-10-2025 C IP:15-11-2025 OH C',
  'C C C C C PC C C OH C', 'C C C C C PC C C OH C', 'C C C C C PC C C OH NA',
  'C C C C C PC C C OH NA', 'C C C C C PC C C OH NA', 'C C C C C PC C C OH B',
  'C C C C C PC C C OH NA', 'C C C C C PC C C OH NA',
  'C C C C C IP:15-11-2025 C YS YS C', 'PC PC C C C N/A C YS YS C',
].map((r) => r.split(' '));

// Mockup office grid (OR_), columns as COLUMNS_BY_TAB.office.
const OB = (o) => { const a = Array(20).fill('C'); a[0] = 'B'; Object.assign(a, o); return a; };
const O8 = OB({ 8: 'OH', 9: 'YS', 11: 'YS', 12: 'IP', 18: 'IP' });
const DEMO_OFFICE_GRID = [
  OB({ 0: 'Approved', 18: 'IP' }), OB({ 0: 'Approved', 18: 'IP' }),
  OB({ 0: 'Submitted', 11: 'YS', 18: 'IP' }),
  OB({ 0: 'Submitted', 9: 'YS', 11: 'YS', 18: 'PC' }), OB({ 0: 'Submitted', 9: 'YS', 11: 'YS', 18: 'PC' }),
  OB({ 0: 'Submitted', 9: 'YS', 11: 'YS', 12: 'IP', 18: 'YS' }), OB({ 0: 'Submitted', 9: 'YS', 11: 'YS', 12: 'IP', 18: 'YS' }),
  O8, O8, O8, O8, O8, O8, O8, O8,
  OB({ 2: 'NA', 8: 'YS', 9: 'YS', 11: 'YS', 12: 'N/A', 18: 'YS' }),
  OB({ 2: 'NA', 8: 'YS', 9: 'YS', 10: 'YS', 11: 'YS', 12: 'N/A', 14: 'IP:17-10-2025', 15: 'IP:17-10-2025', 18: 'YS' }),
];

const TOKEN_STATUS = { C: 'APP', PC: 'APP', IP: 'IP', OH: 'OH', YS: 'YTS', NA: 'NA', 'N/A': 'NA', Approved: 'APP', Submitted: 'SUB' };
function parseToken(token) {
  const [code, ddmmyyyy] = token.split(':');
  const status = TOKEN_STATUS[code];
  if (!status) return null; // 'B' = blank cell in the mockup
  return { status, date: ddmmyyyy ? ddmmyyyy.split('-').reverse().join('-') : null };
}

// "Aarvee PMIS updated.html" realistic updates on the Office tab, recorded as
// audit-log entries so they show in each row's history.
const DEMO_OFFICE_UPDATES = [
  ['Bina-Bhopal', 'DPR', 'APP', '2025-11-27', 'Submitted to TDC', '2025-11-27T10:14:00+05:30'],
  ['Bina-Bhopal', 'VAL', 'IP', '2025-10-12', 'Awaiting client approval', '2025-10-12T11:30:00+05:30'],
  ['Bhopal-Itarsi', 'DPR', 'SUB', '2025-11-30', 'Under review', '2025-11-30T15:02:00+05:30'],
  ['Gurra-Powerkheda', 'Geotech report', 'OH', null, 'Blocked - pending forest clearance', '2025-10-18T09:40:00+05:30'],
];

function seedActivityCells() {
  const wcrId = projectIdByCode(2616);
  if (!wcrId) return;

  // Drop earlier demo cells (v1 mapped them onto the PRD's 4 statuses) and
  // their demo audit entries; user-edited cells have a different updated_by.
  db.prepare('DELETE FROM activity_cells WHERE updated_by = ?').run(DEMO_TAG);
  const delAudit = db.prepare('DELETE FROM activity_audit_log WHERE updated_by = ? AND remarks = ? AND updated_at = ?');
  DEMO_OFFICE_UPDATES.forEach((u) => delAudit.run('pmo.demo', u[4], new Date(u[5]).toISOString()));

  const rowsFor = (tab) => db.prepare(
    'SELECT id, corridor FROM project_activities WHERE project_id = ? AND tab = ? ORDER BY sort_order, id'
  ).all(wcrId, tab);
  const insertCell = db.prepare(`
    INSERT OR IGNORE INTO activity_cells (activity_id, column_key, status, tentative_date, remarks, signed, updated_by)
    VALUES (?,?,?,?,'',1,?)`);
  const fill = (tab, grid) => rowsFor(tab).forEach((row, i) => {
    (grid[i] || []).forEach((token, j) => {
      const cell = parseToken(token);
      if (cell) insertCell.run(row.id, COLUMNS_BY_TAB[tab][j], cell.status, cell.date, DEMO_TAG);
    });
  });
  fill('field', DEMO_FIELD_GRID);
  fill('office', DEMO_OFFICE_GRID);

  const officeRows = rowsFor('office');
  const getCell = db.prepare('SELECT status, updated_by AS by FROM activity_cells WHERE activity_id = ? AND column_key = ?');
  const updateCell = db.prepare(`
    UPDATE activity_cells SET status = ?, tentative_date = ?, remarks = ?, updated_at = ? WHERE activity_id = ? AND column_key = ?`);
  const insertAudit = db.prepare(`
    INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, remarks, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?)`);
  for (const [corridor, column, status, date, remarks, at] of DEMO_OFFICE_UPDATES) {
    const row = officeRows.find((r) => r.corridor === corridor);
    const existing = row && getCell.get(row.id, column);
    if (!existing || existing.by !== DEMO_TAG) continue; // missing row or user-edited cell
    const ts = new Date(at).toISOString();
    updateCell.run(status, date, remarks, ts, row.id, column);
    insertAudit.run(row.id, column, existing.status, status, remarks, 'pmo.demo', ts);
  }
}

function seedDemoData() {
  const done = db.prepare("SELECT value FROM app_meta WHERE key = 'demo_seed_version'").get();
  if (done && done.value === DEMO_VERSION) return;
  db.transaction(() => {
    seedAlertsAndPending();
    seedFinancials();
    seedProjectDashboards();
    seedActivityCells();
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('demo_seed_version', ?)").run(DEMO_VERSION);
  })();
  console.log(`Loaded demo data v${DEMO_VERSION} from the reference mockups (rows tagged '${DEMO_TAG}').`);
}

module.exports = seedDemoData;

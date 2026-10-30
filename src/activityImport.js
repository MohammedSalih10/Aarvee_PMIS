const ExcelJS = require('exceljs');
const db = require('./db');
const { ACTIVITY_STATUS_PERCENT, computeRowPercentByMilestones, addWorkingDaysISO, SUB_APPROVAL_DAYS } = require('./activityConstants');
const { logAudit } = require('./changeLog');

// Fills a combined-layout project's empty Office-and-Field grid from a workbook:
//   row N-2  KD labels (KD 1, KD 2 ... over their columns)     row N-1  KD weightage
//   row N    headers: "Project code", detail columns (incl. "Corridor"), then one column per activity
//   below    one row per corridor, one status per activity cell (cell comments become remarks)
// where N is the row holding "Project code" in column A. The same layout the
// grid exports, so an export can be imported into another (empty) project.

const TAB = 'office'; // a combined project keeps its single grid under the 'office' tab

// Sheet wording -> app status. Completed / P. Completed are both Submitted (expected approval
// date SUB_APPROVAL_DAYS working days out); Observations = client comments received -> Comment
// Compliance revision 1 (the sheet carries no revision number).
// 'On hold' is what an export writes for On Hold cells; 'Submitted' / 'Approved' are accepted as plain aliases.
const STATUS_MAP = {
  'completed': 'SUB', 'p. completed': 'SUB', 'submitted': 'SUB', 'approved': 'SUB', 'observations': 'CC',
  'in progress': 'IP', 'yet to start': 'YTS', 'on hold': 'OH', 'na': 'NA',
};
const CC_REVISION = 1;
const MAX_ROWS = 2000;
const MAX_COLUMNS = 200;

// A problem with the workbook or the target project that the user can fix.
class ImportError extends Error {}
// Thrown inside the import transaction to discard a preview's writes.
class Rollback extends Error {}

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
};

function cellValue(cell) {
  let v = cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
    else v = null;
  }
  if (v instanceof Date) v = v.toISOString().slice(0, 10);
  return v;
}

function noteText(cell) {
  const n = cell.note;
  if (!n) return null;
  return clean(typeof n === 'string' ? n : (n.texts || []).map((t) => t.text).join(''));
}

// A merged range's non-top-left cells all report the range's value; skip them.
const isMergedFollower = (cell) => cell.isMerged && cell.master && cell.master.address !== cell.address;

function detailText(cell) {
  const v = cellValue(cell);
  if (v == null) return null;
  if (typeof v === 'number') return /%/.test(cell.numFmt || '') ? `${Math.round(v * 10000) / 100}%` : String(v);
  return clean(v);
}

const colLetter = (n) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };

async function parseActivityGrid(buffer, sourceFile) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw new ImportError('Could not read this file as an .xlsx workbook'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportError('The workbook has no sheets');
  if (ws.rowCount > MAX_ROWS) throw new ImportError('The sheet has too many rows to import');

  let headerRow = null;
  for (let r = 1; r <= Math.min(ws.rowCount, 15) && !headerRow; r += 1) {
    if (/^project\s*code$/i.test(clean(cellValue(ws.getCell(r, 1))) || '')) headerRow = r;
  }
  if (!headerRow || headerRow < 3) {
    throw new ImportError('Could not find the header row: "Project code" must be in column A, with the KD label and KD weightage rows directly above it');
  }
  const kdRow = headerRow - 2, weightRow = headerRow - 1;
  // A sheet's used range can run far past its data (empty formatted columns), so the width is
  // taken from the header row's actual content.
  let lastCol = 1;
  ws.getRow(headerRow).eachCell((cell, c) => { if (clean(cellValue(cell)) && c > lastCol) lastCol = c; });
  if (lastCol > MAX_COLUMNS) throw new ImportError('The sheet has too many columns to import');

  const kdStarts = [];
  for (let c = 2; c <= lastCol; c += 1) {
    const cell = ws.getCell(kdRow, c);
    if (!isMergedFollower(cell) && clean(cellValue(cell))) kdStarts.push(c);
  }
  if (!kdStarts.length) throw new ImportError(`No KD labels found in row ${kdRow}`);
  const actFirst = kdStarts[0];
  let actLast = actFirst;
  for (let c = actFirst; c <= lastCol; c += 1) if (clean(cellValue(ws.getCell(headerRow, c)))) actLast = c;

  const columns = [];
  const seen = new Set();
  for (let c = actFirst; c <= actLast; c += 1) {
    const name = clean(cellValue(ws.getCell(headerRow, c)));
    if (!name) throw new ImportError(`Activity column ${colLetter(c)} has no header in row ${headerRow}`);
    if (seen.has(name.toLowerCase())) throw new ImportError(`Activity column "${name}" appears twice`);
    seen.add(name.toLowerCase());
    columns.push({ col: c, letter: colLetter(c), name });
  }

  let corridorCol = null;
  const detailHeaders = [];
  for (let c = 2; c < actFirst; c += 1) {
    const name = clean(cellValue(ws.getCell(headerRow, c)));
    if (!name) continue; // e.g. an unlabeled serial-number column
    if (/^corridor$/i.test(name)) corridorCol = c;
    else detailHeaders.push({ col: c, name });
  }
  if (!corridorCol) throw new ImportError('No "Corridor" column found before the activity columns');
  if (new Set(detailHeaders.map((h) => h.name.toLowerCase())).size !== detailHeaders.length) throw new ImportError('Two corridor detail columns share a name');

  const rawWeights = kdStarts.map((c) => Number(cellValue(ws.getCell(weightRow, c))));
  if (rawWeights.some((w) => !Number.isFinite(w) || w < 0)) throw new ImportError(`Every KD needs a weightage in row ${weightRow}`);
  const asFraction = rawWeights.every((w) => w <= 1);
  const kds = kdStarts.map((c, i) => ({
    label: clean(cellValue(ws.getCell(kdRow, c))),
    weightage: Math.round(rawWeights[i] * (asFraction ? 100 : 1) * 10000) / 10000,
    startCol: c,
    endCol: i + 1 < kdStarts.length ? kdStarts[i + 1] - 1 : actLast,
  }));
  const kdSum = kds.reduce((s, k) => s + k.weightage, 0);
  if (Math.abs(kdSum - 100) > 0.05) throw new ImportError(`KD weightages add up to ${kdSum.toFixed(2)}, they must add up to 100`);
  if (new Set(kds.map((k) => k.label.toLowerCase())).size !== kds.length) throw new ImportError('Two KDs share a label');

  const corridors = [];
  const strayCells = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    const corridor = clean(cellValue(ws.getCell(r, corridorCol)));
    if (!corridor) {
      for (let c = actFirst; c <= actLast; c += 1) {
        const v = cellValue(ws.getCell(r, c));
        if (v != null && v !== '') strayCells.push({ cell: `${colLetter(c)}${r}`, value: v });
      }
      continue;
    }
    const projectCode = clean(cellValue(ws.getCell(r, 1)));
    if (!projectCode) throw new ImportError(`Row ${r} (${corridor}) has no project code`);
    const details = {};
    detailHeaders.forEach((h) => { details[h.name] = detailText(ws.getCell(r, h.col)); });
    const cells = columns.map((col) => {
      const cell = ws.getCell(r, col.col);
      return { col: col.col, name: col.name, raw: clean(cellValue(cell)), comment: noteText(cell) };
    });
    corridors.push({ row: r, projectCode, corridor, details, cells });
  }
  if (!corridors.length) throw new ImportError('No corridor rows found below the header');
  const dupe = corridors.find((r, i) => corridors.findIndex((o) => o.corridor.toLowerCase() === r.corridor.toLowerCase()) !== i);
  if (dupe) throw new ImportError(`Corridor "${dupe.corridor}" appears twice`);

  return { sourceFile: sourceFile || 'workbook.xlsx', detailHeaders, columns, kds, corridors, strayCells };
}

// Writes the parsed grid into an empty combined-layout project, all or nothing.
// dryRun runs every write inside the same transaction and then discards it, so the
// preview is exactly what an import would do. Returns a report for the UI.
function importActivityGrid(projectId, data, user, { dryRun = false } = {}) {
  const report = { warnings: [] };
  const project = db.prepare('SELECT id, code, name, activity_layout AS layout FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new ImportError('Project not found');

  const codes = [...new Set(data.corridors.map((c) => c.projectCode))];
  if (codes.length !== 1) throw new ImportError(`The sheet mixes project codes: ${codes.join(', ')}`);
  if (codes[0] !== String(project.code)) throw new ImportError(`This sheet is for project code ${codes[0]}, but this project is ${project.code}`);
  if (project.layout !== 'combined') throw new ImportError('Importing needs the combined "Office and Field" layout; switch this project to it in Edit grid first');

  const existing = db.prepare('SELECT COUNT(*) AS n FROM project_activities WHERE project_id = ?').get(project.id).n;
  if (existing) throw new ImportError(`This project already has ${existing} corridor rows. The import only fills an empty grid`);
  if (db.prepare('SELECT 1 FROM activity_columns WHERE project_id = ?').get(project.id)) throw new ImportError('This project already has its own activity columns');

  const unknown = new Set();
  data.corridors.forEach((r) => r.cells.forEach((c) => { if (c.raw && !STATUS_MAP[c.raw.toLowerCase()]) unknown.add(c.raw); }));
  if (unknown.size) throw new ImportError(`Unrecognised status values: ${[...unknown].join(', ')}. Expected: Completed, P. Completed, Observations, In progress, Yet to start, On hold, NA`);

  const cols = data.columns;
  const names = cols.map((c) => c.name);
  const now = new Date().toISOString();
  const src = data.sourceFile;
  const logSubject = `${project.code} — activity grid import`;

  const run = db.transaction(() => {
    // Opening the grid auto-creates empty default corridor columns (Line / Length / Responsible);
    // replace those, but never any that hold values.
    const usedValues = db.prepare(
      'SELECT COUNT(*) AS n FROM corridor_detail_values v JOIN corridor_detail_columns c ON c.id = v.column_id WHERE c.project_id = ? AND c.tab = ?'
    ).get(project.id, TAB).n;
    if (usedValues) throw new ImportError(`This project already has ${usedValues} corridor detail values`);
    db.prepare('DELETE FROM corridor_detail_columns WHERE project_id = ? AND tab = ?').run(project.id, TAB);
    db.prepare('DELETE FROM corridor_detail_init WHERE project_id = ? AND tab = ?').run(project.id, TAB);

    const changeLog = db.prepare(
      `INSERT INTO activity_change_log (project_id, tab, panel, action, activity_id, subject, detail, changed_by, changed_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    const log = (panel, subject, detail, activityId = null) =>
      changeLog.run(project.id, TAB, panel, 'create', activityId, subject, `${detail} — imported from ${src}`, user.username, now);

    // No per-column weights in the sheet: split equally (sums to 100); the KD weightages drive % complete.
    const even = Math.floor((100 / cols.length) * 10000) / 10000;
    const weights = cols.map((_, i) => (i === cols.length - 1 ? Math.round((100 - even * (cols.length - 1)) * 10000) / 10000 : even));
    const insCol = db.prepare('INSERT INTO activity_columns (tab, column_key, sort_order, weightage, project_id) VALUES (?,?,?,?,?)');
    const colIds = cols.map((c, i) => Number(insCol.run(TAB, c.name, i, weights[i], project.id).lastInsertRowid));
    cols.forEach((c, i) => log('column', c.name, `Column added (weightage ${weights[i]}%)`));

    const insDC = db.prepare('INSERT INTO corridor_detail_columns (project_id, tab, name, sort_order) VALUES (?,?,?,?)');
    const dcIds = {};
    data.detailHeaders.forEach((h, i) => { dcIds[h.name] = Number(insDC.run(project.id, TAB, h.name, i).lastInsertRowid); log('row', h.name, 'Corridor column added'); });
    db.prepare('INSERT INTO corridor_detail_init (project_id, tab) VALUES (?,?)').run(project.id, TAB);

    const insAct = db.prepare('INSERT INTO project_activities (project_id, tab, corridor, sort_order) VALUES (?,?,?,?)');
    const insDV = db.prepare('INSERT INTO corridor_detail_values (activity_id, column_id, value) VALUES (?,?,?)');
    const insCell = db.prepare(
      `INSERT INTO activity_cells (activity_id, column_key, status, tentative_date, planned_finish_date, revision, remarks, signed, updated_by, updated_at)
       VALUES (?,?,?,?,NULL,?,?,0,?,?)`);
    const insAudit = db.prepare(
      `INSERT INTO activity_audit_log (activity_id, column_key, from_status, to_status, revision, tentative_date, planned_finish_date, remarks, updated_by, updated_at)
       VALUES (?,?,NULL,?,?,?,NULL,?,?,?)`);
    // Submitted's "Expected approval date" = SUB_APPROVAL_DAYS working days after the import day (the app's own rule).
    const subApprovalDate = addWorkingDaysISO(now.slice(0, 10), SUB_APPROVAL_DAYS);

    const statusCount = {}, perColumn = names.map(() => []), rowPct = [];
    const milestoneCols = data.kds.map((k) => colIds.slice(k.startCol - cols[0].col, k.endCol - cols[0].col + 1));
    const columnRows = cols.map((c, i) => ({ id: colIds[i], name: c.name, weightage: weights[i] }));
    const ms = data.kds.map((k, i) => ({ weightage: k.weightage, columnIds: milestoneCols[i] }));
    data.corridors.forEach((row, ri) => {
      const actId = Number(insAct.run(project.id, TAB, row.corridor, ri).lastInsertRowid);
      const detail = [];
      Object.entries(row.details).forEach(([name, v]) => { if (v != null) { insDV.run(actId, dcIds[name], v); detail.push(`${name}: ${v}`); } });
      log('row', row.corridor, detail.join('; ') || 'Corridor row added', actId);
      const cellMap = {};
      row.cells.forEach((cell, ci) => {
        if (!cell.raw) { report.warnings.push(`Blank cell left empty: ${row.corridor} / ${cell.name}`); return; }
        const status = STATUS_MAP[cell.raw.toLowerCase()];
        const revision = status === 'CC' ? CC_REVISION : null;
        const remarks = cell.comment || '';
        const tentative = status === 'SUB' ? subApprovalDate : null;
        insCell.run(actId, cell.name, status, tentative, revision, remarks, user.username, now);
        insAudit.run(actId, cell.name, status, revision, tentative, remarks, user.username, now);
        statusCount[status] = (statusCount[status] || 0) + 1;
        cellMap[cell.name] = { status };
        perColumn[ci].push(ACTIVITY_STATUS_PERCENT[status]);
      });
      rowPct.push({ corridor: row.corridor, percent: computeRowPercentByMilestones(cellMap, columnRows, ms) });
    });

    db.prepare('INSERT INTO project_milestone_config (project_id, tab, percent_basis) VALUES (?,?,?)').run(project.id, TAB, 'kd');
    const insM = db.prepare('INSERT INTO project_milestones (project_id, tab, label, weightage, sort_order) VALUES (?,?,?,?,?)');
    const insMC = db.prepare('INSERT INTO project_milestone_columns (milestone_id, column_id) VALUES (?,?)');
    data.kds.forEach((k, i) => {
      const mid = Number(insM.run(project.id, TAB, k.label, k.weightage, i).lastInsertRowid);
      milestoneCols[i].forEach((cid) => insMC.run(mid, cid));
      log('milestone', k.label, `Added — ${k.weightage}%, ${names.slice(k.startCol - cols[0].col, k.endCol - cols[0].col + 1).join(', ')}`);
    });
    log('milestone', '% Complete basis', 'Computed from: Column weightages → KD weightages');

    // Per-column "project % complete": mean of the cells' status percentages (NA / On Hold excluded).
    const insProg = db.prepare('INSERT INTO project_column_progress (project_id, column_id, percent_complete, updated_by, updated_at) VALUES (?,?,?,?,?)');
    perColumn.forEach((arr, i) => {
      const vals = arr.filter((v) => v != null);
      insProg.run(project.id, colIds[i], vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : 0, user.username, now);
    });

    Object.assign(report, {
      project: { id: project.id, code: project.code, name: project.name }, source: src,
      columns: cols.length, corridors: data.corridors.length, cells: Object.values(statusCount).reduce((a, b) => a + b, 0),
      statusCount, submittedExpectedApprovalDate: subApprovalDate,
      kds: data.kds.map((k, i) => ({ label: k.label, weightage: k.weightage, columns: milestoneCols[i].length })),
      corridorPercent: rowPct, detailColumns: data.detailHeaders.map((h) => h.name), ignoredStrayCells: data.strayCells,
    });
    if (dryRun) throw new Rollback();
    logAudit(user, {
      projectId: project.id, area: 'project', action: 'update', subject: logSubject,
      detail: `Imported ${data.corridors.length} corridors × ${cols.length} activities (${report.cells} cells) from ${src}`,
    });
  });

  try { run(); } catch (err) { if (!(err instanceof Rollback)) throw err; }
  return report;
}

module.exports = { parseActivityGrid, importActivityGrid, ImportError };

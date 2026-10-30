const ExcelJS = require('exceljs');
const db = require('./db');
const { getColumnRows } = require('./activityColumns');
const { loadMilestoneConfig } = require('./milestones');
const { getDetailColumns, loadDetailValues } = require('./corridorDetails');
const { canAccessCorridor } = require('./scope');

// Writes a project's activity grid to an .xlsx in the layout activityImport.js reads:
//   row 1 title | row 2 KD labels (merged over their columns) | row 3 KD weightage | row 4 headers | rows 5+ corridors
//   columns: A Project code, B serial, C Corridor, then the corridor-detail columns, then one column per activity.
// A combined project exports one sheet; a split project one sheet per tab. Statuses use the sheet's wording
// (Completed / In progress / Yet to start / Observations / NA) so the file reads like the hand-kept tracker.
// Lossy on purpose: Submitted and Approved both read "Completed", dates and revision numbers aren't part of
// the format; a cell's remarks travel as its comment.

const STATUS_LABEL = {
  YTS: 'Yet to start', IP: 'In progress', OH: 'On hold', SUB: 'Completed', CC: 'Observations', APP: 'Completed', NA: 'NA',
};
const STATUS_STYLE = {
  'Completed': { fill: 'FFC6EFCE', font: 'FF006100' },
  'Yet to start': { fill: 'FFFFC7CE', font: 'FF9C0006' },
  'In progress': { fill: 'FFFFEB9C', font: 'FF9C5700' },
  'Observations': { fill: 'FFF2F2F2', font: 'FF595959' },
  'On hold': { fill: 'FFDDEBF7', font: 'FF1F4E78' },
};
const THIN = { style: 'thin' };
const BORDER = { left: THIN, right: THIN, top: THIN, bottom: THIN };
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
const ACTIVITY_HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
const FIRST_DETAIL_COL = 4; // A code, B serial, C corridor

function styleCell(cell, { bold = false, size = 11, h = 'center', fill, wrap = true, color } = {}) {
  cell.font = { name: 'Calibri', size, bold, ...(color ? { color: { argb: color } } : {}) };
  cell.alignment = { horizontal: h, vertical: 'middle', wrapText: wrap };
  cell.border = BORDER;
  if (fill) cell.fill = fill;
}

// Corridor-detail values are free text; write plain numbers / percentages as numbers like the hand-kept sheet
// does, and anything else (codes with leading zeros, "KD 1, KD 2", ...) verbatim.
function detailCellValue(text) {
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) return { value: Number(text) };
  if (/^-?(0|[1-9]\d*)(\.\d+)?%$/.test(text)) return { value: Number(text.slice(0, -1)) / 100, numFmt: '0%' };
  return { value: text };
}

function addGridSheet(wb, project, tab, sheetName, titleLabel, user) {
  const columnRows = getColumnRows(tab, project.id);
  if (!columnRows.length) return false;
  const config = loadMilestoneConfig(project.id, tab);

  // A KD band covers a contiguous run of columns, so columns are grouped by their KD (in KD order); columns
  // under no KD follow at the end.
  const kdIndex = new Map();
  config.milestones.forEach((m, i) => m.columnIds.forEach((id) => kdIndex.set(id, i)));
  const ordered = [];
  const bands = [];
  config.milestones.forEach((m, i) => {
    const cols = columnRows.filter((c) => kdIndex.get(c.id) === i);
    if (!cols.length) return;
    bands.push({ label: m.label, weightage: m.weightage, start: ordered.length, size: cols.length });
    ordered.push(...cols);
  });
  columnRows.filter((c) => !kdIndex.has(c.id)).forEach((c) => ordered.push(c));

  const detailCols = getDetailColumns(project.id, tab);
  const actFirst = FIRST_DETAIL_COL + detailCols.length;
  const lastCol = actFirst + ordered.length - 1;

  const activities = db.prepare('SELECT id, corridor FROM project_activities WHERE project_id = ? AND tab = ? ORDER BY sort_order, id')
    .all(project.id, tab).filter((a) => canAccessCorridor(user, project.id, a.corridor));
  const ids = activities.map((a) => a.id);
  const details = loadDetailValues(ids);
  const cellsByActivity = new Map();
  if (ids.length) {
    db.prepare(`SELECT activity_id AS activityId, column_key AS columnKey, status, remarks FROM activity_cells WHERE activity_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids).forEach((c) => {
        if (!cellsByActivity.has(c.activityId)) cellsByActivity.set(c.activityId, new Map());
        cellsByActivity.get(c.activityId).set(c.columnKey, c);
      });
  }

  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.getColumn(1).width = 14.9; ws.getColumn(2).width = 5.5; ws.getColumn(3).width = 31.5;
  detailCols.forEach((_, i) => { ws.getColumn(FIRST_DETAIL_COL + i).width = 16.5; });
  ordered.forEach((_, i) => { ws.getColumn(actFirst + i).width = 15; });

  // Row 1: title.
  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = `${project.name} (${project.code}) — ${titleLabel} Activities`;
  styleCell(ws.getCell(1, 1), { bold: true, size: 16, h: 'left', wrap: false });
  ws.getRow(1).height = 19.7;

  // Rows 2-3: KD labels and weightage over the activity columns (blank where a project has no KDs).
  for (let c = 1; c <= lastCol; c += 1) { styleCell(ws.getCell(2, c), { bold: true, size: 14 }); styleCell(ws.getCell(3, c), { bold: true, size: 14 }); }
  ws.getCell(2, 1).value = bands.length ? 'Payment milestone (KD)' : null;
  ws.getCell(3, 1).value = bands.length ? 'KD weightage' : null;
  ws.getCell(2, 1).alignment = ws.getCell(3, 1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
  bands.forEach((b) => {
    const from = actFirst + b.start, to = from + b.size - 1;
    if (to > from) { ws.mergeCells(2, from, 2, to); ws.mergeCells(3, from, 3, to); }
    ws.getCell(2, from).value = b.label;
    ws.getCell(3, from).value = b.weightage / 100;
    ws.getCell(3, from).numFmt = '0%';
  });
  ws.getRow(2).height = 17.35; ws.getRow(3).height = 17.35;

  // Row 4: headers.
  const headers = ['Project code', null, 'Corridor', ...detailCols.map((d) => d.name), ...ordered.map((c) => c.name)];
  headers.forEach((text, i) => {
    const cell = ws.getCell(4, i + 1);
    cell.value = text;
    styleCell(cell, { bold: true, fill: i + 1 >= actFirst ? ACTIVITY_HEADER_FILL : HEADER_FILL });
  });
  ws.getRow(4).height = 35.05;

  // Rows 5+: corridors.
  activities.forEach((a, ri) => {
    const r = 5 + ri;
    ws.getRow(r).height = 23.85;
    ws.getCell(r, 1).value = Number.isFinite(Number(project.code)) ? Number(project.code) : String(project.code);
    styleCell(ws.getCell(r, 1), { wrap: false });
    ws.getCell(r, 2).value = ri + 1;
    styleCell(ws.getCell(r, 2));
    ws.getCell(r, 3).value = a.corridor;
    styleCell(ws.getCell(r, 3), { h: 'left' });
    const vals = details.get(a.id) || {};
    detailCols.forEach((d, i) => {
      const cell = ws.getCell(r, FIRST_DETAIL_COL + i);
      const text = vals[d.id];
      styleCell(cell, { h: i === 0 ? 'left' : 'center' });
      if (text == null || text === '') return;
      const { value, numFmt } = detailCellValue(String(text));
      cell.value = value;
      if (numFmt) cell.numFmt = numFmt;
    });
    const cellMap = cellsByActivity.get(a.id) || new Map();
    ordered.forEach((col, i) => {
      const cell = ws.getCell(r, actFirst + i);
      const rec = cellMap.get(col.name);
      const label = rec && STATUS_LABEL[rec.status];
      const style = label && STATUS_STYLE[label];
      styleCell(cell, style ? { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } }, color: style.font } : {});
      if (label) cell.value = label;
      if (rec && rec.remarks) cell.note = rec.remarks;
    });
  });

  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 4 }];
  return true;
}

// -> { workbook, filename }. Corridors the user may not see (a corridor-restricted member) are left out,
// the same as the grid itself.
function buildActivityWorkbook(projectId, user) {
  const project = db.prepare('SELECT id, code, name, activity_layout AS activityLayout FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aarvee PMIS';
  wb.created = new Date();
  if (project.activityLayout === 'combined') {
    addGridSheet(wb, project, 'office', `${project.code} Office and Field`, 'Office & Field', user);
  } else {
    addGridSheet(wb, project, 'office', 'Office', 'Office', user);
    addGridSheet(wb, project, 'field', 'Field', 'Field', user);
  }
  if (!wb.worksheets.length) wb.addWorksheet('Activities');
  return { workbook: wb, filename: `${project.code}_activities.xlsx` };
}

module.exports = { buildActivityWorkbook };

// Schedule module (from "NR schedule stage 1 -Final.xlsx"): a task's status is
// derived, not stored — from today vs. planned dates and whether an actual
// completion date has been entered. This is schedule-aware (distinguishes
// on-time vs. behind-schedule), unlike the Office/Field activity status set.

const SCHEDULE_STATUS = {
  C: 'Completed',
  YTS: 'Yet to Start',
  IP: 'In Progress',
  BEHIND: 'Behind Schedule',
};

// `today` defaults to now; pass a fixed date in tests for determinism.
function deriveScheduleStatus(item, today = new Date()) {
  if (item.actualCompletion) return 'C';
  const start = item.plannedStart ? new Date(item.plannedStart) : null;
  const finish = item.plannedFinish ? new Date(item.plannedFinish) : null;
  if (start && today < start) return 'YTS';
  if (finish && today > finish) return 'BEHIND';
  return 'IP';
}

module.exports = { SCHEDULE_STATUS, deriveScheduleStatus };

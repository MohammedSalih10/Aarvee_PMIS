-- Roles: admin = System Administrator (sole account provisioner — the only
-- role that can create/edit/remove user accounts — and otherwise has every
-- pmo capability); pmo = the app's editor/manager (full read/write
-- everywhere except account management, assigns projects to other users);
-- mgmt = Higher Management reviewer (read-only, sees every project
-- automatically, no assignment needed); member = any other reviewer (e.g. a
-- Project Lead/Coordinator or site member) — read-only, and only sees a
-- project once pmo assigns them to it. Exception: a member currently holding
-- the Project Lead or Coordinator title may be granted edit access to
-- specific corridors -- see assignment_edit_corridors below.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','pmo','mgmt','member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('FLS','DPR')),
  wo_value_cr REAL NOT NULL DEFAULT 0,
  responsible_person TEXT,
  stage TEXT,
  -- Project dashboard (mockup page 3) header fields.
  contract_start TEXT,
  contract_end TEXT,
  forecast_completion TEXT,
  eot_upto TEXT,
  pbg_valid_upto TEXT,
  unbilled_revenue_cr REAL NOT NULL DEFAULT 0,
  retention_cr REAL NOT NULL DEFAULT 0,
  bank_guarantee_cr REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- PRD §3.1 — project scope/assignment: which users (pmo or mgmt) can see and
-- act on a given project. admin, pmo and mgmt bypass this (see everything).
CREATE TABLE IF NOT EXISTS project_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Per-project title (PMO-assigned), distinct from the user's global role above.
  project_role TEXT CHECK(project_role IN ('lead','coordinator')),
  UNIQUE(project_id, username)
);

-- Optional per-assignment restriction to specific corridors (by name, shared
-- across the Office/Field tabs). No rows for an assignment = unrestricted,
-- i.e. every corridor in the project -- the pre-existing, default behavior.
CREATE TABLE IF NOT EXISTS assignment_corridors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES project_assignments(id) ON DELETE CASCADE,
  corridor TEXT NOT NULL,
  UNIQUE(assignment_id, corridor)
);

-- Opt-in edit grant, separate from the view restriction above: specific
-- corridors an admin (only -- not pmo) has allowed this assignment's Project
-- Lead/Coordinator to edit (activity rows + status cells), on top of being
-- able to see them. No rows = no edit access, the default for every member.
-- Only honored while the assignment holds project_role 'lead' or
-- 'coordinator' -- see canEditCorridor in scope.js.
CREATE TABLE IF NOT EXISTS assignment_edit_corridors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES project_assignments(id) ON DELETE CASCADE,
  corridor TEXT NOT NULL,
  UNIQUE(assignment_id, corridor)
);

-- PRD §4 — corridor-level rows within a project's Office/Field activity tabs.
CREATE TABLE IF NOT EXISTS project_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tab TEXT NOT NULL CHECK(tab IN ('office','field')),
  corridor TEXT NOT NULL,
  line_type TEXT,
  length_km REAL,
  responsible_person TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Column headers for the Office/Field activity grid, editable via the Edit
-- grid screen (add/rename/delete). Shared across all projects for a tab, like
-- the grid's row set is per-project (project_activities above).
CREATE TABLE IF NOT EXISTS activity_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab TEXT NOT NULL CHECK(tab IN ('office','field')),
  column_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Share of the corridor's overall "% Complete" this column contributes;
  -- all columns' weightage within a tab must sum to 100.
  weightage REAL NOT NULL DEFAULT 0,
  UNIQUE(tab, column_key)
);

-- Per-project, per-column progress estimate (0-100), set by PMO independent
-- of any single corridor's recorded statuses. Combined with the column's
-- (shared, global) weightage, this rolls up into the project's overall
-- "% Complete" KPI on the Project Dashboard.
CREATE TABLE IF NOT EXISTS project_column_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL REFERENCES activity_columns(id) ON DELETE CASCADE,
  percent_complete REAL NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT,
  UNIQUE(project_id, column_id)
);

-- tentative_date's meaning follows the cell's status (tentative start/finish/
-- approval -- src/activityConstants.js: TENTATIVE_DATE_LABEL). While the cell
-- is Yet to Start or In Progress, deriveCellAlert alerts from ALERT_LEAD_DAYS
-- before tentative_date, and becomes an overdue/pending action once it passes.
CREATE TABLE IF NOT EXISTS activity_cells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES project_activities(id) ON DELETE CASCADE,
  column_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'YTS' CHECK(status IN ('YTS','IP','OH','SUB','APP','NA')),
  tentative_date TEXT,
  remarks TEXT,
  signed INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT,
  UNIQUE(activity_id, column_key)
);

-- PRD §4.3 — audit log / transparency section.
CREATE TABLE IF NOT EXISTS activity_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES project_activities(id) ON DELETE CASCADE,
  column_key TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  remarks TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_log_id INTEGER NOT NULL REFERENCES activity_audit_log(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES project_activities(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,
  month_index INTEGER NOT NULL CHECK(month_index BETWEEN 0 AND 11),
  plan_billing REAL NOT NULL DEFAULT 0,
  actual_billing REAL NOT NULL DEFAULT 0,
  plan_collection REAL NOT NULL DEFAULT 0,
  actual_collection REAL NOT NULL DEFAULT 0,
  expenditure REAL NOT NULL DEFAULT 0,
  forecast_billing REAL NOT NULL DEFAULT 0,
  forecast_collection REAL NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT,
  UNIQUE(project_id, fiscal_year, month_index)
);

-- ABP billing / ABP collection are frozen once a non-zero value is saved (see
-- financials.routes.js). A pmo changes a frozen figure by filing a request here;
-- an admin or mgmt user approves (value is applied) or rejects it.
CREATE TABLE IF NOT EXISTS financial_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,
  month_index INTEGER NOT NULL CHECK(month_index BETWEEN 0 AND 11),
  field TEXT NOT NULL CHECK(field IN ('planBilling','planCollection')),
  old_value REAL NOT NULL,
  new_value REAL NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  due_date TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_by TEXT,
  dismissed_at TEXT
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_date TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_by TEXT,
  done_at TEXT
);

-- Key/value store for one-off migrations and demo-seed versions.
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Project dashboard: budget vs expenditure by cost category.
CREATE TABLE IF NOT EXISTS project_budget (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  budget_cr REAL NOT NULL DEFAULT 0,
  expenditure_cr REAL NOT NULL DEFAULT 0,
  UNIQUE(project_id, category)
);

-- Project dashboard: current-month billing / collection deliverables.
CREATE TABLE IF NOT EXISTS project_deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('billing','collection')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('completed','in_progress','pending')),
  value_cr REAL NOT NULL DEFAULT 0,
  due_date TEXT,
  remarks TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS deliverable_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deliverable_id INTEGER NOT NULL REFERENCES project_deliverables(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT,
  remarks TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- =====================================================================
-- Schedule / resource-planning module (from "NR schedule stage 1 -Final.xlsx")
-- A project's work plan as a flat task list per stretch/corridor, distinct
-- from the Office/Field status grid above: each row is one deliverable with
-- planned start/finish dates, resourcing, and (once worked) an actual
-- completion date. Status is derived (not stored): Completed / Yet to Start /
-- In Progress / Behind Schedule, from today vs. planned dates + actual_completion.
-- =====================================================================
CREATE TABLE IF NOT EXISTS schedule_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stretch TEXT NOT NULL,
  route_length_km REAL,
  work_item TEXT NOT NULL,
  quantity REAL,
  resources INTEGER,
  productivity REAL,
  days_required REAL,
  planned_start TEXT,
  lead_lag_days INTEGER NOT NULL DEFAULT 0,
  planned_finish TEXT,
  predecessor TEXT,
  design_expenditure_cr REAL,
  actual_completion TEXT,
  remarks TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);

-- Reference data (not project-scoped): the resource rate card and working-day
-- calendar the schedule sheet's day counts are based on.
CREATE TABLE IF NOT EXISTS resource_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT UNIQUE NOT NULL,
  monthly_rate REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date TEXT UNIQUE NOT NULL,
  description TEXT
);

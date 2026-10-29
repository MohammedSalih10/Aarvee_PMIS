# Aarvee PMIS

Internal project MIS dashboard, built to the `PMIS (PRD).doc` requirements. Node.js (Express) + SQLite backend,
static HTML/JS frontend served by the same server.

**Built so far**: login (PRD §2.1), role-scoped project dashboard (PRD §3 — members see only their
assigned projects), manually-entered monthly billing/collection/expenditure figures + MIS trend charts, alerts,
pending actions, the Office/Field activity-tracking module per project (PRD §4 — status/date/remarks/mandatory
digital signature/attachments, with a full audit log per PRD §4.3), and account/assignment provisioning for
System Administrators (PRD §1.2/§2.1).

Screens follow the `Aarvee PMIS - Portal.html` mockup: MIS table (lifecycle / ABP YTD / monthly / quarter
columns, cumulative planned-actual-forecast charts), per-project dashboard (contract dates, O/S, unbilled revenue,
retention, BG, budget vs expenditure, life cycle gauge, ABP/actual/forecast charts, billing/collection
deliverables with signed + audited status changes), Office/Field activity grids, and a per-project **Schedule**
screen (work plan per stretch — planned dates, resourcing, a derived on-time/behind-schedule status — from
`NR schedule stage 1 -Final.xlsx`; see "Schedule / resource-planning module" below).

## Project layout

```
src/
  server.js              Express app entry point
  db.js                  SQLite connection + schema bootstrap
  schema.sql             Table definitions
  auth.js                JWT auth + role-check middleware, password rules
  rateLimit.js           In-memory failed-attempt limiter (login / change-password)
  scope.js                Project-assignment (RBAC) helpers — who can see/edit which project
  migrate.js             One-off upgrades for databases created before a schema change (idempotent)
  activityConstants.js   Office/Field column lists + status enum (from the mockup) — single source of truth
  dashboardConstants.js  Project dashboard budget categories + deliverable statuses
  scheduleConstants.js   Schedule module: derives a task's status from today vs. its planned dates
  derivedAlerts.js       Derives upcoming/overdue alerts from activity cells' planned vs. actual dates (see below)
  seed.js                Seeds demo accounts/projects/corridors on first run (idempotent)
  demoSeed.js            Demo data from the mockups (versioned via app_meta, never overwrites user edits)
  realDataSeed.js        Real project/corridor/schedule data from the client's own files (see below)
  routes/                One file per API resource
public/
  index.html             Frontend (login, MIS, project dashboard, Office/Field activity view)
  aarvee-logo.svg        Topbar/favicon logo (SVG)
  aarvee-mark.png        Login-screen logo mark
deploy/
  nginx.conf             Reverse-proxy server blocks (TLS, 30 MB uploads, login throttling)
  pmis-proxy.conf        Shared proxy headers included by nginx.conf
data/                     SQLite DB file, WAL, and uploaded attachments (created at runtime, not committed)
```

## Local setup

```
npm install
cp .env.example .env
# edit .env: set JWT_SECRET to a long random string, e.g.
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm start
```

The server refuses to start if `JWT_SECRET` is unset, shorter than 32 characters, or still the `.env.example`
placeholder.

Open http://localhost:3000 on the host computer. By default, the server listens on all network interfaces so
other devices on the same LAN can connect using `http://<host-computer-LAN-IP>:3000`. On Windows, find the
host computer's IPv4 address with `ipconfig` (look under the active Wi-Fi or Ethernet adapter). If Windows
Firewall blocks the connection, allow inbound TCP port 3000 on Private networks only. Keep the computer and
other devices on a trusted LAN; this app serves HTTP, so do not expose it directly to the internet.

Set `HOST=127.0.0.1` in `.env` to restrict the server to the host computer. `PORT` can be set to change the
default port 3000. Demo seeding (below) runs only when `NODE_ENV` is not `production`, or `SEED_DEMO=true` is
set. Seeded accounts (change before real use — see "Accounts" below; the server logs a warning at startup for
any account still using `password123`):

- `admin` / `password123` — System Administrator: provisions accounts, creates/edits projects, assigns anyone to any project
- `pmo.demo` / `password123` — PMO/Field-Office Executive: edits activities/financials on assigned projects
- `mgmt.demo` / `password123` — Management: reviews assigned projects, assigns/removes pmo accounts within them

With demo seeding off (production), none of the above demo accounts, the 5 mockup projects or the demo data
below are created; only the real-data projects are seeded, and the first admin comes from `ADMIN_USERNAME` /
`ADMIN_PASSWORD` in `.env` (startup fails on an empty database without them; remove `ADMIN_PASSWORD` after
the first start). A database carried over from dev keeps whatever it already contains.

Both demo accounts are pre-assigned to all 5 seeded projects. West Central Railway (code 2616) additionally has
17 real corridor rows seeded (from the existing mockup) so the Office/Field activity grids aren't empty.
On startup, missing WCR corridor rows and mockup activity statuses are added to existing databases as well;
existing activity rows and user-edited statuses are preserved.

**Demo data** (from the reference mockups, `src/demoSeed.js`): alerts and pending actions, Office/Field cell
statuses for WCR 2616, monthly plan/actual/forecast billing, collection and expenditure for the 5 seeded projects
(current FY + 2 previous, derived from WO value like the mockup's charts — not real figures), and each project's
dashboard dates, unbilled/retention/BG amounts, budget split and deliverables. Rows are tagged `demo-seed` in
`created_by`/`updated_by` where the table has one; the set runs once per demo version (`app_meta`) and never
overwrites user-edited cells. Remove with e.g. `DELETE FROM financial_entries WHERE updated_by='demo-seed'`.

## Real project data (from the client's own files)

`src/realDataSeed.js` adds two real projects, seeded once (tracked via `app_meta`, never overwrites a user edit),
from four files the client supplied: `PMIS- Progress flow Automation R4 21-11-25.pptx`,
`NR schedule stage 1 -Final.xlsx`, `Aarvee PMIS Framework R3 11-06-26.docx`, `Task Dashboard- SWR Sample.xlsx`.

- **Project 2765, "South Western Railway (SWR)"** (type FLS) — 13 corridors across Bangalore/Hubli/Mysuru
  divisions, with real Office/Field survey statuses for the 5 corridors that have a work order (including named
  responsible persons — "Mr. Lilith", "Mr. Mallesh" — as given in the source sheet) and the 8 still awaiting one.
  **Its work-order value is unknown — no source file states it — so it's seeded as 0.** Set it via "Edit project
  details" or `PATCH /api/projects/:id` once you have the real figure.
- **Project 2989, "Northern Railway (Reasi-Poonch)"** (type DPR) — real WO value (₹22.07 Cr) and contract dates
  from the schedule file's "Top sheet". Its corridor (Reasi-Poonch, 190km) only has schedule data (see below), not
  Office/Field statuses, since the source file doesn't track it that way.

Both are assigned to `pmo.demo`/`mgmt.demo` like the originally-seeded projects. **Project 2681 ("Northern
Railway", ₹42.1 Cr) is unrelated and left untouched** — the name collision with 2989 is in the client's own data,
not a mistake on this end; it's flagged here for you to resolve (rename one, or confirm they're genuinely two
separate contracts).

**Division & Responsible Person**: `project_activities` now has `division`/`responsible_person` columns, shown as
extra columns in the Office/Field grids and settable via "+ Add corridor". Only populated for real data so far.

**Real Office columns vs. the app's 20**: the real SWR-Office sheet tracks 26 columns — close to the PRD's list,
not the mockup's 20 the app currently shows (see "Known simplifications" below). 18 of the 20 app columns have a
clear real-sheet match and are populated; the other 2 ("DPR Submission TDC (Internal)", "Structures input for
estimates") have no equivalent in the real sheet and are left blank for every corridor. **9 real columns have no
home in the app at all and are dropped**: Stage 1 HAL/H&H/BL/VAL, SIP, Index Plan & Section, LWR, Bridge Design.
If you want these tracked, the Office grid needs to move to the fuller 26-column list — ask and I'll switch it
(it was deliberately kept at 20 on your earlier call between the two options).

### Schedule / resource-planning module (new)

The NR/SWR "schedule" sheets are Gantt-style task lists (planned start/finish per deliverable, resource counts,
productivity) — a different shape from the Office/Field status grid (one task per row, not one corridor per row
with status-per-column), so this is a new module, not a reuse of the activity grid:

- **`schedule_items`**: one row per task per stretch — quantity, resources, productivity, days required, planned
  start/finish, lead/lag days, an optional actual-completion date, remarks. Reachable via the project dashboard's
  **Schedule** button. Status (Completed / Yet to Start / In Progress / **Behind Schedule**) is *derived*, not
  stored — from today's date vs. the plan and whether an actual-completion date has been entered
  (`src/scheduleConstants.js`). Since the source dates are already in the past relative to today, most seeded
  items show "Behind Schedule" until someone enters an actual completion date — that's expected, not a bug.
- Seeded for **2989** (38 tasks, stretch "Reasi-Poonch") from "NR schedule template", and for **2765** (24 tasks
  across 4 further stretches — Bhadravathi-Chikjajur, Talguppa-Honnavara, Alamtti-Yadgiri,
  Shivamogga-Sringeri-Manglore — not yet in its Office/Field sheets) from "SWR schedule".
- **`resource_rates`**: the rate card (Senior VP ₹4,00,000/month down to CAD/Surveyors ₹55,000/month) — global,
  not per-project. Visible via "Resource rates" on the Schedule screen to **mgmt/admin only** (an internal cost
  figure, not shown to pmo/Field-Office executives — my call, tell me if pmo should see it too).
  `GET /api/resource-rates`.
- **`holidays`**: the non-working-day calendar (Sundays + 2nd/4th/5th Saturdays) the sheet's day-counts are based
  on. Visible to everyone via "Holiday calendar". `GET /api/holidays`.
- **Not carried over**: the sheets' per-task resource *costings* (cost/day, cost incl. 20% overheads) and the
  predecessor-chain logic (task N can't start until task N-1 finishes) — the module stores the planned dates as
  given, it doesn't (yet) compute or validate them from a dependency chain.
- The Framework doc's task-status legend is **7 schedule-aware colors** (Submitted / Approved / Hold / Yet to
  Start / In Progress-on-schedule / In Progress-**behind schedule** / Yet to Start-**behind schedule**) — this new
  Schedule module's 4-status model approximates that distinction (on-time vs. behind) without touching the
  Office/Field activity status set, which already changed once at your request. If you want the Office/Field
  grids themselves to carry this schedule-awareness, that's a further change — say so and I'll scope it.
- Not built at all: the enterprise/division-level dashboards the Framework doc describes above the per-project
  one (org-wide and division-wide rollups) — flagged for later, not started.

### Derived alerts & pending actions (new)

Alongside the manually-created alerts/pending rows, every Office/Field activity cell with a planned date and no
actual date yet is surfaced automatically (`src/derivedAlerts.js`, `GET /api/alerts` and `GET /api/pending`):
within `ALERT_LEAD_DAYS` (3) of its planned date it shows as an **upcoming alert**; once the planned date has
passed, it escalates to a **pending action** instead (`deriveCellAlert` in `src/activityConstants.js`). These
derived rows are id-prefixed `cell-`, carry `derived: true`, scope to the viewer's assigned projects the same way
manual rows do, and aren't dismissable — they resolve themselves once someone enters an actual date, or an `NA`
status.

## Roles & project access (PRD §1.2, §3.1)

- **admin**: every pmo capability, plus the only role that can provision user accounts (`Manage users` in the
  topbar), change roles, remove accounts, and grant corridor edit access to members.
- **pmo**: the app's editor — creates/edits/deletes projects (including the core record: code, name, type, WO
  value, division, responsible person, stage), edits financials, Office/Field activity statuses, schedule and
  dashboards on every project (each status change requires the digital-signature checkbox per PRD §4.2), and
  assigns members to projects.
- **mgmt**: read-only reviewer; sees every project without needing an assignment.
- **member**: read-only, and sees only projects pmo has assigned them to (optionally limited to specific
  corridors). A member titled Project Lead/Coordinator on a project can additionally be granted edit access to
  specific corridors.

Project assignment (`project_assignments`) therefore scopes **member** accounts only; admin/pmo/mgmt see every
project. Logic lives in `src/scope.js`.

## Accounts & the planned HRMS integration

Credentials are currently checked against the local `users` table (`src/auth.js`, function `authenticate`).
That function is the single place to change when HRMS SSO is wired in: replace its body with a call to the
HRMS API and map the response to `{username, displayName, role}`. Keep `role` (`admin`/`pmo`/`mgmt`) assigned via
the local `users` table regardless — it's an app-level permission HRMS won't know about.

Accounts are created through the app now (`admin` role → "Manage users" in the topbar, or `POST /api/users`),
matching the PRD's "no self-registration" requirement.

**Passwords**: 8–72 characters with at least one letter and one number. `password123` is currently allowed (dev convenience) — the server warns
at startup while any account still uses it; change them before deploying. Any user can change their own via the user menu →
"Change password" (`POST /api/auth/password`); doing so signs out all their sessions. There is no admin reset
for a forgotten password yet — remove and recreate the account.

**Sessions**: a JWT in an httpOnly cookie, 12 h. Role and account existence are re-read from the database on
every request, so removing or demoting an account takes effect immediately. Failed logins are throttled
in-memory (8 per IP+username and 30 per IP per 15 min → HTTP 429); counters reset on restart.

## Known simplifications (read before entering real figures)

The original mockup computed billing/collection/margin numbers from a seeded random-number generator — those
were placeholder demo values, not real formulas. This build replaces that with **plain arithmetic over
manually-entered monthly figures**: YTD totals are sums of the months up to the selected quarter's end, margin
is `billing − expenditure`. "ABP" is the monthly plan; "Work %" is actual ÷ plan for that month; the forecast
line uses the entered monthly forecast (falling back to plan when none is entered) after the last month with
actuals; O/S = total billed − total collected. If your finance team uses other definitions, tell me.

**Activity statuses and Office columns follow the mockup, not the PRD**: statuses are Yet to Start, In Progress,
On Hold, Submitted, Approved, P. Completed, Completed and NA (PRD §4.1 lists only four); summary chips count
Submitted/Approved/P. Completed as Completed, as the mockup does. Office columns are the mockup's 20 (PRD §3.2
lists 26, incl. Stage 1 HAL/H&H/BL/VAL, SIP, LWR, Bridge Design). Cells saved under PRD-only columns are kept in
the database but not shown. Never-set cells show blank. See `src/activityConstants.js`.

**Project dashboard edits** (dates, unbilled/retention/BG, budget split, deliverables) and the core project
record (code/name/type/WO value) are allowed for pmo and admin, like monthly financials. Deleting a project
cascades to all of its activities, financials and schedule — there is no undo.

**File uploads**: stored on local disk under `data/uploads/` with server-generated filenames (metadata — who
uploaded what, when, against which status change — lives in the database). Allowed types per PRD §4.2: PDF,
DWG, XLS/XLSX, DOC/DOCX, and common images; 25 MB per file, 10 files per upload. Back these up along with
`data/pmis.db` — they're both part of your real data.

## Deploying on a Linux server

1. Install Node.js (v18+) on the server, then on the app directory:
   ```
   npm ci --omit=dev   # once a package-lock.json exists; npm install works too
   cp .env.example .env
   # set JWT_SECRET (32+ random chars), NODE_ENV=production, HOST=127.0.0.1, TRUST_PROXY=1
   # fresh database only: ADMIN_USERNAME + ADMIN_PASSWORD for the first admin (remove the password afterwards)
   ```
   `data/` is not in git. Either start with an empty database (first admin from `ADMIN_*`, no demo data) or
   copy your existing one over — see step 4 for how to copy it safely.
2. Run it as a systemd service so it restarts on crash/reboot. Example unit file
   `/etc/systemd/system/aarvee-pmis.service`:
   ```ini
   [Unit]
   Description=Aarvee PMIS
   After=network.target

   [Service]
   Type=simple
   User=aarvee
   WorkingDirectory=/opt/aarvee-pmis
   EnvironmentFile=/opt/aarvee-pmis/.env
   ExecStart=/usr/bin/node src/server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```
   Then: `systemctl daemon-reload && systemctl enable --now aarvee-pmis`
3. Put nginx in front using `deploy/nginx.conf` (copy to `/etc/nginx/conf.d/`) and `deploy/pmis-proxy.conf`
   (copy to `/etc/nginx/pmis-proxy.conf`). Set `server_name` and the TLS certificate paths. It redirects HTTP to
   HTTPS, raises the body limit to 30 MB (nginx's 1 MB default rejects uploads), forwards client IP/protocol,
   and rate-limits the login route. HTTPS is required: with `NODE_ENV=production` the auth cookie is `secure`
   and browsers drop it over plain HTTP, so login would silently fail.
4. Back up `data/pmis.db` **and** `data/uploads/` regularly. The database runs in WAL mode, so recent writes
   live in `pmis.db-wal` until a checkpoint — a plain `cp data/pmis.db` while the app runs can miss them.
   Use `sqlite3 data/pmis.db ".backup backup.db"` (safe while running), or, with the app stopped, copy
   `pmis.db`, `pmis.db-wal` and `pmis.db-shm` together. Same rule when moving the database to the server.
5. Run a single instance only (SQLite/WAL, in-memory login throttling). The server logs a startup warning for any
   account still using `password123` — change those from the user menu before real use.

## Note on the Node/npm versions used here

This was built and tested with Node 24 / npm installing Express 5, better-sqlite3 13, jsonwebtoken 9, and
bcryptjs 3 (see `package.json` after `npm install`, and `package-lock.json` for exact pins). If the Linux
server has an older Node, run `npm install` there rather than copying `node_modules/` from this machine —
`better-sqlite3` has a native module that must be built/fetched for the server's own OS/architecture.

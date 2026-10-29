const bcrypt = require('bcryptjs');
const db = require('./db');
const { validatePassword } = require('./auth');
const seedDemoData = require('./demoSeed');
const seedRealData = require('./realDataSeed');

// Real corridor list for West Central Railway (project code 2616), taken from
// the existing "Aarvee PMIS - Portal.html" reference mockup — used for both
// the Office and Field activity tabs.
const WCR_CORRIDORS = [
  ['Bina-Bhopal', '4th Line', 138],
  ['Bhopal-Itarsi', '4th Line', 92],
  ['Gurra-Powerkheda', 'Bypass', 9],
  ['Bayana ROR', 'ROR', 5],
  ['Khutsala ROR', 'ROR', 10],
  ['Manikpur-Katni', '3rd Line', 176],
  ['Katni-Itarsi', '3rd Line', 336],
  ['Mathura-Bharatpur', '3rd & 4th', 34],
  ['Bharatpur-Bayana', '3rd & 4th', 42],
  ['Bayana-Gangapur', '3rd & 4th', 78],
  ['Gangapur-Sawai Madhopur', '3rd & 4th', 65],
  ['Sawai Madhopur-Gurla', '3rd & 4th', 101],
  ['Kota Bypass', '3rd & 4th', null],
  ['Ravtha Road-Ramganj Mandi', '3rd & 4th', 71],
  ['Ramganj Mandi-Nagda', '3rd & 4th', 153],
  ['Ujjain-Agar-Jhalawar', 'New Line', 190],
  ['Neemuch-Kota', 'New Line', 201],
];

// Demo accounts, mockup projects and fake financials are for local/dev use.
// In production they're off unless SEED_DEMO=true; the first admin is created
// from ADMIN_USERNAME / ADMIN_PASSWORD instead.
const SEED_DEMO = process.env.SEED_DEMO
  ? process.env.SEED_DEMO === 'true'
  : process.env.NODE_ENV !== 'production';

function seedInitialUsers() {
  const insert = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)'
  );
  if (SEED_DEMO) {
    const initialUsers = [
      ['admin', 'password123', 'System Administrator', 'admin'],
      ['pmo.demo', 'password123', 'PMO Demo User', 'pmo'],
      ['mgmt.demo', 'password123', 'Management Demo User', 'mgmt'],
    ];
    for (const [username, pw, name, role] of initialUsers) {
      insert.run(username, bcrypt.hashSync(pw, 10), name, role);
    }
    console.log('Seeded accounts: admin / pmo.demo / mgmt.demo (password: password123) — change these before real use.');
    return;
  }

  const { ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
  const invalid = ADMIN_USERNAME ? validatePassword(ADMIN_PASSWORD) : 'ADMIN_USERNAME is not set';
  if (invalid) {
    throw new Error(
      `Empty database and demo seeding is off — set ADMIN_USERNAME and ADMIN_PASSWORD in .env to create the first admin (${invalid}).`
    );
  }
  insert.run(ADMIN_USERNAME, bcrypt.hashSync(ADMIN_PASSWORD, 10), 'System Administrator', 'admin');
  console.log(`Created first admin account "${ADMIN_USERNAME}" — remove ADMIN_PASSWORD from .env now.`);
}

// Databases carried over from dev may still hold the well-known demo password.
function warnDefaultPasswords() {
  const weak = db.prepare('SELECT username, password_hash FROM users').all()
    .filter((u) => bcrypt.compareSync('password123', u.password_hash))
    .map((u) => u.username);
  if (weak.length) {
    console.warn(`WARNING: accounts still using the default password "password123": ${weak.join(', ')} — change or remove them.`);
  }
}

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) seedInitialUsers();

  const projectCount = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  if (SEED_DEMO && projectCount === 0) {
    const insert = db.prepare(
      'INSERT INTO projects (code, name, type, wo_value_cr) VALUES (?,?,?,?)'
    );
    const initialProjects = [
      [2746, 'Central Railway', 'FLS', 2],
      [2616, 'West Central Railway', 'FLS', 25],
      [2577, 'South Central Railway', 'DPR', 18.4],
      [2681, 'Northern Railway', 'DPR', 42.1],
      [2702, 'East Coast Railway', 'FLS', 12.75],
    ];
    for (const row of initialProjects) insert.run(...row);
    console.log('Seeded initial project list (from the existing mockup) — edit via the Projects screen if incorrect.');

    // Demo accounts need assignments or project scoping (PRD §3.1) hides
    // everything from them — give both demo accounts every project to start.
    const projectIds = db.prepare('SELECT id FROM projects').all().map((r) => r.id);
    const assign = db.prepare(
      'INSERT INTO project_assignments (project_id, username, assigned_by) VALUES (?,?,?)'
    );
    for (const id of projectIds) {
      assign.run(id, 'pmo.demo', 'admin');
      assign.run(id, 'mgmt.demo', 'admin');
    }

  }

  // Existing deployments may already have users/projects but no activity rows.
  // Add only missing corridors; never replace rows that may have user edits.
  const wcr = db.prepare('SELECT id FROM projects WHERE code = 2616').get();
  if (wcr) {
    const findActivity = db.prepare(
      'SELECT id FROM project_activities WHERE project_id = ? AND tab = ? AND corridor = ?'
    );
    const insertActivity = db.prepare(
      'INSERT INTO project_activities (project_id, tab, corridor, line_type, length_km, sort_order) VALUES (?,?,?,?,?,?)'
    );
    ['office', 'field'].forEach((tab) => {
      WCR_CORRIDORS.forEach(([corridor, lineType, lengthKm], i) => {
        if (!findActivity.get(wcr.id, tab, corridor)) {
          insertActivity.run(wcr.id, tab, corridor, lineType, lengthKm, i);
        }
      });
    });
  }

  if (SEED_DEMO) seedDemoData();
  seedRealData();
  warnDefaultPasswords();
}

module.exports = seed;

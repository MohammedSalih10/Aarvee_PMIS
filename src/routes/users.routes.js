const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, validatePassword } = require('../auth');
const { logAudit } = require('../changeLog');

const router = express.Router();
router.use(requireAuth);

// Account management (create / change role / remove) is admin-only -- pmo
// keeps every other admin-level capability, but not this one.
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not permitted for your role' });
  next();
}

// PRD §1.2 — admin and pmo see everyone (pmo needs the full list to pick
// project assignees, even though it can't manage accounts); mgmt gets a
// pmo-only list (to pick who to assign to their projects).
router.get('/', (req, res) => {
  if (req.user.role === 'admin' || req.user.role === 'pmo') {
    const rows = db.prepare('SELECT username, display_name AS displayName, role FROM users ORDER BY username').all();
    return res.json({ users: rows });
  }
  if (req.user.role === 'mgmt') {
    const rows = db.prepare(
      "SELECT username, display_name AS displayName, role FROM users WHERE role = 'pmo' ORDER BY username"
    ).all();
    return res.json({ users: rows });
  }
  res.status(403).json({ error: 'Not permitted for your role' });
});

// Accounts are provisioned by admin, not self-registration.
router.post('/', requireAdmin, async (req, res) => {
  const { username, password, displayName, role } = req.body || {};
  if (!username || !password || !displayName || !['admin', 'pmo', 'mgmt', 'member'].includes(role)) {
    return res.status(400).json({ error: 'username, password, displayName and role (admin|pmo|mgmt|member) are required' });
  }
  const invalid = validatePassword(password);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)'
    ).run(username, hash, displayName, role);
  } catch {
    return res.status(400).json({ error: 'That username already exists' });
  }
  logAudit(req.user, { area: 'user', action: 'create', subject: username, detail: `Account created (${displayName}, role ${role})` });
  res.status(201).json({ ok: true });
});

// Lets admin correct an existing account (role, and/or reset a forgotten
// password) without recreating it. admin-only, same as account creation.
// A password reset also signs that user out everywhere (see passwordVersion).
router.patch('/:username', requireAdmin, async (req, res) => {
  const { role, password } = req.body || {};
  if (role === undefined && password === undefined) {
    return res.status(400).json({ error: 'role and/or password is required' });
  }
  if (role !== undefined && !['admin', 'pmo', 'mgmt', 'member'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin|pmo|mgmt|member' });
  }
  if (password !== undefined) {
    const invalid = validatePassword(password);
    if (invalid) return res.status(400).json({ error: invalid });
  }
  const target = db.prepare('SELECT role FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'No such user' });

  // Also guarantees at least one admin always remains (only an admin can get here).
  if (role !== undefined && role !== target.role && req.params.username === req.user.username) {
    return res.status(400).json({ error: 'You cannot change your own role' });
  }
  if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE username = ?').run(role, req.params.username);
  if (password !== undefined) {
    db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
      .run(await bcrypt.hash(password, 10), req.params.username);
  }
  // Never the password itself, only that it was reset.
  const changes = [
    role !== undefined && role !== target.role && `Role: ${target.role} → ${role}`,
    password !== undefined && 'Password reset',
  ].filter(Boolean);
  if (changes.length) logAudit(req.user, { area: 'user', action: 'update', subject: req.params.username, detail: changes.join('; ') });
  res.json({ ok: true });
});

// Lets admin remove an account. admin-only, same as account creation. Can't
// remove yourself, and can't remove the last admin -- otherwise no one would
// be left who can manage accounts. project_assignments rows for the user are
// cascade-deleted by the schema's FK.
router.delete('/:username', requireAdmin, (req, res) => {
  if (req.params.username === req.user.username) {
    return res.status(400).json({ error: 'You cannot remove your own account' });
  }
  const target = db.prepare('SELECT role FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'No such user' });
  if (target.role === 'admin') {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
    if (n <= 1) return res.status(400).json({ error: 'At least one admin account must remain' });
  }
  db.prepare('DELETE FROM users WHERE username = ?').run(req.params.username);
  logAudit(req.user, { area: 'user', action: 'delete', subject: req.params.username, detail: `Account removed (role ${target.role})` });
  res.json({ ok: true });
});

module.exports = router;

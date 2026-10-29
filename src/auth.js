const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is not set — copy .env.example to .env and fill it in');
if (JWT_SECRET.length < 32 || /change-this/i.test(JWT_SECRET)) {
  throw new Error(
    'JWT_SECRET is a placeholder or shorter than 32 characters — generate one with: ' +
    `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
  );
}

const COOKIE_NAME = 'aarvee_token';

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt ignores everything past 72 bytes

// Returns an error message, or null when the password is acceptable.
function validatePassword(password) {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (Buffer.byteLength(password) > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} bytes`;
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Password must contain both letters and numbers';
  return null;
}

// Burned on unknown usernames so a miss costs the same as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Tokens carry a fingerprint of the password hash, so changing a password
// invalidates every session issued before it. HMAC'd so the token (readable by
// the client) doesn't leak any part of the hash.
function passwordVersion(passwordHash) {
  return crypto.createHmac('sha256', JWT_SECRET).update(passwordHash).digest('hex').slice(0, 16);
}

// This is the one function to replace when HRMS SSO is wired in: call the HRMS
// API here instead of checking the local users table, then map its response to
// {username, displayName, role}. The `role` (pmo|mgmt) is an app-level concept
// HRMS won't know about, so keep assigning it via the local `users` table even
// after credential checking moves to HRMS.
async function authenticate(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return null;
  return { username: user.username, displayName: user.display_name, role: user.role };
}

function signToken(user) {
  const { password_hash: hash } = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(user.username);
  return jwt.sign({ ...user, pv: passwordVersion(hash) }, JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256' });
}

// The token only proves who signed in; role/name/existence are re-read from the
// DB on every request so removing or demoting an account takes effect
// immediately instead of when the 12h token expires.
function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
  const row = db.prepare(
    'SELECT username, display_name AS displayName, role, password_hash FROM users WHERE username = ?'
  ).get(payload.username);
  if (!row || payload.pv !== passwordVersion(row.password_hash)) {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
  req.user = { username: row.username, displayName: row.displayName, role: row.role };
  next();
}

// admin and pmo can always do what any other role-specific route allows
// (PRD §1.2 — admin has every pmo capability plus account management), so
// both bypass these checks too.
function requireAnyRole(...roles) {
  return (req, res, next) => {
    const bypass = req.user.role === 'admin' || req.user.role === 'pmo';
    if (!bypass && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not permitted for your role' });
    }
    next();
  };
}

module.exports = { authenticate, signToken, requireAuth, requireAnyRole, validatePassword, COOKIE_NAME };

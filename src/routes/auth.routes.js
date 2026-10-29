const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, signToken, requireAuth, validatePassword, COOKIE_NAME } = require('../auth');
const { createLimiter } = require('../rateLimit');

const router = express.Router();

// Failed attempts only: a per-IP cap stops one host spraying many usernames, a
// per-(IP, username) cap stops guessing at a single account. A successful login
// clears the latter so normal users aren't penalised for earlier typos.
const WINDOW_MS = 15 * 60 * 1000;
const loginByIp = createLimiter({ windowMs: WINDOW_MS, max: 30 });
const loginByUser = createLimiter({ windowMs: WINDOW_MS, max: 8 });
const passwordByUser = createLimiter({ windowMs: WINDOW_MS, max: 8 });

function tooManyAttempts(res, seconds) {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).` });
}

router.post('/login', async (req, res) => {
  const { username, password, remember } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const userKey = `${req.ip}|${username.toLowerCase()}`;
  const wait = Math.max(loginByIp.retryAfter(req.ip), loginByUser.retryAfter(userKey));
  if (wait) return tooManyAttempts(res, wait);

  const user = await authenticate(username, password);
  if (!user) {
    loginByIp.fail(req.ip);
    loginByUser.fail(userKey);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  loginByUser.reset(userKey);

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    // Unchecked "Keep me signed in" -> session cookie, cleared when the browser closes.
    ...(remember === false ? {} : { maxAge: 12 * 60 * 60 * 1000 }),
  });
  res.json({ user });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Any signed-in user can change their own password. Every session issued
// before the change (this one included) stops working, so the client signs in
// again afterwards.
router.post('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword) {
    return res.status(400).json({ error: 'Current password is required' });
  }
  const invalid = validatePassword(newPassword);
  if (invalid) return res.status(400).json({ error: invalid });
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'New password must differ from the current one' });
  }

  const key = req.user.username;
  const wait = passwordByUser.retryAfter(key);
  if (wait) return tooManyAttempts(res, wait);

  const { password_hash: hash } = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(key);
  if (!(await bcrypt.compare(currentPassword, hash))) {
    passwordByUser.fail(key);
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  passwordByUser.reset(key);

  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(await bcrypt.hash(newPassword, 10), key);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

module.exports = router;

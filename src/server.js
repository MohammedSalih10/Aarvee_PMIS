require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const db = require('./db');
const seed = require('./seed');
const authRoutes = require('./routes/auth.routes');
const projectsRoutes = require('./routes/projects.routes');
const financialsRoutes = require('./routes/financials.routes');
const activitiesRoutes = require('./routes/activities.routes');
const assignmentsRoutes = require('./routes/assignments.routes');
const alertsRoutes = require('./routes/alerts.routes');
const pendingRoutes = require('./routes/pending.routes');
const usersRoutes = require('./routes/users.routes');
const uploadsRoutes = require('./routes/uploads.routes');
const projectDashboardRoutes = require('./routes/projectDashboard.routes');
const scheduleRoutes = require('./routes/schedule.routes');

seed();

const app = express();
// Behind nginx set TRUST_PROXY=1 so req.ip is the real client (login rate limiting
// keys on it). Leave unset when exposed directly: X-Forwarded-For is client-controlled.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.use(express.json());
app.use(cookieParser());

// Liveness probe for Docker/monitoring: unauthenticated, and fails (500) if the DB is unreachable.
app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api', financialsRoutes);
app.use('/api', activitiesRoutes);
app.use('/api', assignmentsRoutes);
app.use('/api', projectDashboardRoutes);
app.use('/api', scheduleRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/pending', pendingRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.use((req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Client errors from body parsing (malformed JSON, oversized body) are not server faults.
  const status = err.status || err.statusCode;
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'Bad request' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Aarvee PMIS listening on ${HOST}:${PORT}`));

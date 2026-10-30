const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../auth');
const { requireProjectAccess, restrictedCorridors } = require('../scope');
const { parseActivityGrid, importActivityGrid, ImportError } = require('../activityImport');

// Excel import of a project's Office-and-Field activity grid (see activityImport.js).
// Admin only (not pmo). mode=preview parses and validates and reports what would be
// created without writing; mode=apply writes it. The client sends the file for both.
const router = express.Router();

const MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } }).single('file');

router.post(
  '/projects/:id/activities/import',
  requireAuth,
  (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only admin can import an activity grid' })),
  requireProjectAccess(),
  (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (10 MB max)' : 'The upload failed' });
  }),
  async (req, res) => {
    // Adding a whole grid is a project-wide structural change, as in the corridor add/delete routes.
    const restricted = restrictedCorridors(req.params.id, req.user.username);
    if (restricted && restricted.length > 0) {
      return res.status(403).json({ error: 'You are restricted to specific corridors and cannot import a grid' });
    }
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Choose an .xlsx file to import' });
    // .xlsx is a zip container: check the name and the "PK" signature, not just the extension.
    if (!/\.xlsx$/i.test(file.originalname || '') || file.buffer.length < 4 || file.buffer.toString('latin1', 0, 2) !== 'PK') {
      return res.status(400).json({ error: 'Only .xlsx workbooks can be imported' });
    }
    const apply = (req.body || {}).mode === 'apply';
    try {
      const data = await parseActivityGrid(file.buffer, file.originalname);
      const report = importActivityGrid(Number(req.params.id), data, req.user, { dryRun: !apply });
      res.json({ ok: true, applied: apply, report });
    } catch (err) {
      if (err instanceof ImportError) return res.status(400).json({ error: err.message });
      console.error('activity import failed', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { requireAuth, requireAnyRole } = require('../auth');
const { ALLOWED_UPLOAD_EXTENSIONS } = require('../activityConstants');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
      return cb(new Error('File type not allowed: ' + ext));
    }
    cb(null, true);
  },
});

const router = express.Router();

router.post('/', requireAuth, requireAnyRole('pmo'), (req, res) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const files = (req.files || []).map((f) => ({ originalName: f.originalname, storedName: f.filename }));
    res.status(201).json({ files });
  });
});

// Stored filenames are server-generated (crypto.randomUUID() + known extension),
// so this pattern check is enough to rule out path traversal.
const SAFE_NAME = /^[a-f0-9-]{36}\.[a-z0-9]{1,6}$/i;

router.get('/:storedName', requireAuth, (req, res) => {
  const name = req.params.storedName;
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'Invalid file name' });
  const filePath = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

module.exports = router;

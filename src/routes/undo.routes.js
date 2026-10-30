const express = require('express');
const { requireAuth } = require('../auth');
const { undoLast, UndoError } = require('../undo');
const { logAudit } = require('../changeLog');

// Ctrl+Z: reverts the signed-in user's most recent change (any area). Authorization
// isn't re-checked -- it only restores rows to what they were before this user's
// own already-permitted edit, and refuses if anyone has touched them since.
const router = express.Router();

router.post('/undo', requireAuth, (req, res) => {
  try {
    const { label } = undoLast(req.user.username);
    logAudit(req.user, { area: 'undo', action: 'undo', subject: label, detail: 'Reverted by the user (Ctrl+Z)' });
    res.json({ ok: true, label });
  } catch (err) {
    if (err instanceof UndoError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;

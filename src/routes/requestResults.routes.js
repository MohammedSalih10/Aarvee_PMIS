const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

// Tells whoever raised a change request (pmo etc.) that a result is waiting:
// approved/rejected requests they haven't opened the inbox for yet. Covers all
// three request kinds. Approvers (admin/mgmt) are badged for pending requests
// instead -- see refreshReqBadge on the client.
const router = express.Router();

const TABLES = { fin: 'financial_change_requests', end: 'contract_end_change_requests', rev: 'activity_revision_requests' };

function decidedRequests(username) {
  return Object.entries(TABLES).flatMap(([kind, table]) =>
    db.prepare(`SELECT id FROM ${table} WHERE requested_by = ? AND status IN ('approved','rejected')`)
      .all(username).map((r) => ({ kind, id: r.id })));
}

router.get('/request-results/unseen', requireAuth, (req, res) => {
  const seen = new Set(db.prepare('SELECT kind, request_id FROM request_result_seen WHERE username = ?')
    .all(req.user.username).map((r) => `${r.kind}:${r.request_id}`));
  const unseen = decidedRequests(req.user.username).filter((r) => !seen.has(`${r.kind}:${r.id}`));
  res.json({ count: unseen.length, unseen });
});

router.post('/request-results/seen', requireAuth, (req, res) => {
  const ins = db.prepare('INSERT OR IGNORE INTO request_result_seen (username, kind, request_id) VALUES (?,?,?)');
  db.transaction(() => decidedRequests(req.user.username).forEach((r) => ins.run(req.user.username, r.kind, r.id)))();
  res.json({ ok: true });
});

module.exports = router;

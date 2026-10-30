const express = require('express');
const { requireAuth } = require('../auth');
const { requireProjectAccess } = require('../scope');
const { buildActivityWorkbook } = require('../activityExport');

// Excel download of a project's activity grid (see activityExport.js). Open to anyone who can see the
// project's grid; a corridor-restricted member only gets the corridors they can see.
const router = express.Router();

router.get('/projects/:id/activities/export', requireAuth, requireProjectAccess(), async (req, res) => {
  try {
    const built = buildActivityWorkbook(Number(req.params.id), req.user);
    if (!built) return res.status(404).json({ error: 'Project not found' });
    const buffer = await built.workbook.xlsx.writeBuffer();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${built.filename.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('activity export failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

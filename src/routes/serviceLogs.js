'use strict';

const { Router } = require('express');
const { readServiceLogTail, listServiceLogsIndex } = require('../lib/logger');
const { requireServicePin } = require('../middleware/servicePin');

const router = Router();

router.get('/v1/service/logs/days', requireServicePin, (_req, res) => {
  const idx = listServiceLogsIndex();
  res.json({
    ok: true,
    retentionDays: idx.retentionDays,
    dates: idx.dates.slice().reverse(),
    files: idx.files,
  });
});

router.get('/v1/service/logs', requireServicePin, (req, res) => {
  const maxBytes = Math.min(Math.max(Number(req.query.maxBytes) || 120_000, 1024), 500_000);
  const maxLines = Math.min(Math.max(Number(req.query.lines) || 500, 10), 5000);
  const date = String(req.query.date || '').trim();
  const result = readServiceLogTail({ maxBytes, maxLines, date: date || undefined });
  res.json({
    ok: true,
    lines: result.lines,
    truncated: result.truncated,
    fileExists: result.fileExists,
    lineCount: result.lines.length,
    date: result.date,
  });
});

module.exports = router;

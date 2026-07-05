'use strict';

const { Router } = require('express');
const { readServiceLogTail, listServiceLogsIndex, LOG_DIR, LOGS_SUBDIR } = require('../lib/logger');
const { listHelperDataPaths, resolveOpenTarget, revealInExplorer } = require('../lib/helperPaths');
const { requireServicePin } = require('../middleware/servicePin');

const router = Router();

router.get('/v1/service/logs/days', requireServicePin, (_req, res) => {
  const idx = listServiceLogsIndex();
  res.json({
    ok: true,
    retentionDays: idx.retentionDays,
    dates: idx.dates.slice().reverse(),
    files: idx.files,
    dataDir: LOG_DIR,
    logsDir: LOGS_SUBDIR,
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
    pathUsed: result.pathUsed || null,
  });
});

router.get('/v1/service/paths', requireServicePin, (req, res) => {
  const date = String(req.query.date || '').trim();
  res.json({
    ok: true,
    dataDir: LOG_DIR,
    logsDir: LOGS_SUBDIR,
    paths: listHelperDataPaths(date || undefined),
  });
});

router.post('/v1/service/open-path', requireServicePin, async (req, res) => {
  const target = resolveOpenTarget(req.body || {});
  if (!target) {
    return res.status(400).json({ ok: false, error: 'invalid_target' });
  }
  const selectFile = Boolean(req.body?.selectFile);
  const result = await revealInExplorer(target, { selectFile });
  if (!result.ok) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

module.exports = router;

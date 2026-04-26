'use strict';

const { Router } = require('express');
const { getState, checkNow, quitAndInstall, consumeJustUpdated } = require('../lib/autoUpdater');

const router = Router();

/** Current auto-update state (status, progress, versions). */
router.get('/v1/update/status', (_req, res) => {
  res.json({ ok: true, ...getState() });
});

/** Trigger an immediate update check. */
router.post('/v1/update/check', async (_req, res) => {
  try {
    const result = await checkNow();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

/** Quit the app and install the downloaded update. */
router.post('/v1/update/install', (_req, res) => {
  const started = quitAndInstall();
  if (started) {
    res.json({ ok: true, message: 'restarting' });
  } else {
    res.status(409).json({ ok: false, error: 'no-update-downloaded' });
  }
});

/**
 * Returns { justUpdated: true, from, to } once after an update restart.
 * Subsequent calls return { justUpdated: false }.
 */
router.get('/v1/update/just-updated', (_req, res) => {
  const info = consumeJustUpdated();
  if (info) {
    res.json({ ok: true, justUpdated: true, from: info.from, to: info.to });
  } else {
    res.json({ ok: true, justUpdated: false });
  }
});

module.exports = router;

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Router } = express;
const { publicDir } = require('../config');
const { appendServiceLog } = require('../lib/logger');

const router = Router();
const panelDir = path.join(publicDir, 'panel');
const panelIndex = path.join(panelDir, 'index.html');

router.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

/** Vite-built React panel (npm run panel:build → public/panel/). */
router.get('/', (_req, res) => {
  if (!fs.existsSync(panelIndex)) {
    appendServiceLog(`GET / panel missing: ${panelIndex} (run npm run panel:build)`);
    return res
      .status(503)
      .type('html')
      .send(
        '<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"/><title>Helper</title></head><body style="font-family:system-ui;padding:2rem;background:#0a0c12;color:#edf0f7"><p>Panel derlenmemiş.</p><pre style="color:#818cf8">cd print-bridge && npm install && npm run panel:build</pre></body></html>',
      );
  }
  return res.sendFile(panelIndex);
});

router.use(express.static(panelDir));
router.use(express.static(publicDir));

module.exports = router;

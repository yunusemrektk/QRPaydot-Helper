'use strict';

const { Router } = require('express');
const { SERVICE_SLUG, SERVICE_VERSION, BIND, PORT, getMerchantDashUrl } = require('../config');
const { getBackendWsState } = require('../lib/backendWsClient');
const { getState: getUpdateState } = require('../lib/autoUpdater');

const router = Router();

router.get('/health', (_req, res) => {
  const ws = getBackendWsState();
  const update = getUpdateState();
  res.json({
    ok: true,
    service: SERVICE_SLUG,
    version: SERVICE_VERSION,
    bind: `${BIND}:${PORT}`,
    merchantDash: getMerchantDashUrl(),
    backendWs: ws.backendWs,
    update: {
      status: update.status,
      availableVersion: update.availableVersion,
    },
  });
});

module.exports = router;

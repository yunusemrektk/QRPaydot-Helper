'use strict';

const { Router } = require('express');
const { setBackendConnection, getBackendConnection } = require('../lib/printerStore');
const { startBackendWs, stopBackendWs, getBackendWsState } = require('../lib/backendWsClient');
const { appendServiceLog } = require('../lib/logger');

const router = Router();

/**
 * POST /v1/credentials
 * Panel: jwt token + merchantId + apiBaseUrl, veya bridgeKey + merchantId + apiBaseUrl.
 */
router.post('/v1/credentials', (req, res) => {
  try {
    const body = req.body || {};
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const bridgeKey = typeof body.bridgeKey === 'string' ? body.bridgeKey.trim() : '';
    const merchantId = typeof body.merchantId === 'string' ? body.merchantId.trim() : '';
    const apiBaseUrl = typeof body.apiBaseUrl === 'string' ? body.apiBaseUrl.trim() : '';

    if (!merchantId || !apiBaseUrl) {
      return res.status(400).json({ error: 'merchantId, apiBaseUrl required' });
    }
    if (!token && !bridgeKey) {
      return res.status(400).json({ error: 'token or bridgeKey required' });
    }

    const payload = bridgeKey
      ? { bridgeKey, merchantId, apiBaseUrl, token: '' }
      : { token, merchantId, apiBaseUrl, bridgeKey: '' };

    setBackendConnection(payload);
    const saved = getBackendConnection();
    if (!saved) {
      return res.status(500).json({ error: 'failed to persist credentials' });
    }
    startBackendWs(saved);
    appendServiceLog(
      bridgeKey ? '[credentials] saved (bridge key) + backend WS starting' : '[credentials] saved + backend WS starting',
    );
    const st = getBackendWsState();
    return res.json({ ok: true, backendWs: st.backendWs });
  } catch (err) {
    console.error('[qrpaydot-helper] POST /v1/credentials', err.message || err);
    return res.status(500).json({ error: err.message || 'failed' });
  }
});

/** GET /v1/credentials — secret döndürmez */
router.get('/v1/credentials', (_req, res) => {
  const c = getBackendConnection();
  const st = getBackendWsState();
  if (!c) {
    return res.json({ hasToken: false, backendWs: false });
  }
  return res.json({
    hasToken: true,
    authMode: c.bridgeKey ? 'bridge' : 'jwt',
    merchantId: c.merchantId,
    backendWs: st.backendWs,
  });
});

/** DELETE /v1/credentials — WS kapat */
router.delete('/v1/credentials', (_req, res) => {
  setBackendConnection(null);
  stopBackendWs();
  appendServiceLog('[credentials] cleared');
  return res.json({ ok: true });
});

module.exports = router;

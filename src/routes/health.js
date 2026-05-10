'use strict';

const { Router } = require('express');
const { SERVICE_SLUG, SERVICE_VERSION, BIND, PORT, getMerchantDashUrl } = require('../config');
const { getBackendWsState } = require('../lib/backendWsClient');
const { getState: getUpdateState } = require('../lib/autoUpdater');
const { getAllPosAssignments, getBackendConnection } = require('../lib/printerStore');

const router = Router();

function buildPosHealth() {
  const raw = getAllPosAssignments();
  const assignments = Object.entries(raw || {})
    .filter(([, ep]) => ep && String(ep.host || '').trim())
    .map(([posDeviceId, ep]) => ({
      posDeviceId: String(posDeviceId),
      host: String(ep.host).trim(),
      port: Number(ep.port) > 0 ? Number(ep.port) : 0,
      scheme: ep.scheme === 'https' ? 'https' : 'http',
    }))
    .sort((a, b) => a.posDeviceId.localeCompare(b.posDeviceId));
  return {
    assignmentCount: assignments.length,
    assignments,
  };
}

function buildBackendSummary() {
  const c = getBackendConnection();
  if (!c) {
    return {
      configured: false,
      merchantId: null,
      apiBaseUrl: null,
      authKind: null,
    };
  }
  const authKind = c.bridgeKey && String(c.bridgeKey).trim() ? 'bridgeKey' : 'jwt';
  return {
    configured: true,
    merchantId: c.merchantId || null,
    apiBaseUrl: c.apiBaseUrl || null,
    authKind,
  };
}

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
    backendWsDetail: {
      socketOpen: ws.backendWsSocketOpen,
      authenticated: ws.backendWsAuthenticated,
      lastError: ws.lastError,
    },
    backend: buildBackendSummary(),
    pos: buildPosHealth(),
    update: {
      status: update.status,
      availableVersion: update.availableVersion,
    },
  });
});

module.exports = router;

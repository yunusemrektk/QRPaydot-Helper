'use strict';

const { Router } = require('express');
const {
  getPosAssignment,
  setPosAssignment,
  removePosAssignment,
  getAllPosAssignments,
} = require('../lib/printerStore');

const router = Router();

router.get('/v1/pos-devices/resolve', (req, res) => {
  const posDeviceId = req.query.posDeviceId;
  if (!posDeviceId) {
    return res.status(400).json({ error: 'posDeviceId query param required' });
  }
  const ep = getPosAssignment(posDeviceId);
  if (!ep) {
    return res.status(404).json({ error: 'no assignment', posDeviceId });
  }
  return res.json({ ok: true, posDeviceId, host: ep.host, port: ep.port });
});

router.post('/v1/pos-devices/assign', (req, res) => {
  const { posDeviceId, host, port, scheme } = req.body || {};
  if (!posDeviceId || typeof posDeviceId !== 'string') {
    return res.status(400).json({ error: 'posDeviceId is required' });
  }
  if (!host || typeof host !== 'string' || !host.trim() || host.includes('://') || /\s/.test(host)) {
    return res.status(400).json({ error: 'host is required' });
  }
  const p = Number(port);
  if (!(Number.isFinite(p) && p >= 1 && p <= 65535)) {
    return res.status(400).json({ error: 'port must be 1-65535' });
  }
  setPosAssignment(posDeviceId, { host: host.trim(), port: Math.trunc(p), scheme });
  return res.json({ ok: true, posDeviceId, host: host.trim(), port: Math.trunc(p) });
});

router.delete('/v1/pos-devices/assign/:posDeviceId', (req, res) => {
  const posDeviceId = req.params.posDeviceId;
  if (!posDeviceId) {
    return res.status(400).json({ error: 'posDeviceId is required' });
  }
  removePosAssignment(posDeviceId);
  return res.json({ ok: true, posDeviceId });
});

router.get('/v1/pos-devices/assignments', (_req, res) => {
  return res.json({ ok: true, assignments: getAllPosAssignments() });
});

module.exports = router;


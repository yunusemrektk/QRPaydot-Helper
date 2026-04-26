'use strict';

const { Router } = require('express');
const {
  getDiscovered,
  getLastScan,
  getAssignment,
  setAssignment,
  removeAssignment,
  getAllAssignments,
} = require('../lib/printerStore');

const router = Router();

router.get('/v1/printers', (_req, res) => {
  res.json({
    ok: true,
    printers: getDiscovered(),
    lastScan: getLastScan(),
  });
});

router.get('/v1/printers/resolve', (req, res) => {
  const printerId = req.query.printerId;
  if (!printerId) {
    return res.status(400).json({ error: 'printerId query param required' });
  }
  const ep = getAssignment(printerId);
  if (!ep) {
    return res.status(404).json({ error: 'no assignment', printerId });
  }
  res.json({ ok: true, printerId, host: ep.host, port: ep.port });
});

router.post('/v1/printers/assign', (req, res) => {
  const { printerId, host, port } = req.body || {};
  if (!printerId || typeof printerId !== 'string') {
    return res.status(400).json({ error: 'printerId is required' });
  }
  if (!host || typeof host !== 'string' || !host.trim()) {
    return res.status(400).json({ error: 'host is required' });
  }
  setAssignment(printerId, { host: host.trim(), port: Number(port) > 0 ? Number(port) : 9100 });
  res.json({ ok: true, printerId, host: host.trim(), port: Number(port) > 0 ? Number(port) : 9100 });
});

router.delete('/v1/printers/assign/:printerId', (req, res) => {
  const printerId = req.params.printerId;
  if (!printerId) {
    return res.status(400).json({ error: 'printerId is required' });
  }
  removeAssignment(printerId);
  res.json({ ok: true, printerId });
});

router.get('/v1/printers/assignments', (_req, res) => {
  res.json({ ok: true, assignments: getAllAssignments() });
});

module.exports = router;

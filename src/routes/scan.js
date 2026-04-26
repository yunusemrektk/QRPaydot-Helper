'use strict';

const { Router } = require('express');
const { scanSubnetForPort, getLocalSubnets } = require('../lib/scanner');
const { setDiscovered, getDiscovered, getLastScan } = require('../lib/printerStore');

const router = Router();

let scanning = false;

/**
 * Runs the actual subnet scan logic. Used by both the API endpoint
 * and the background startup scan in index.js.
 */
async function runScan(opts) {
  const port = (opts && opts.port) || 9100;
  const timeout = (opts && opts.timeoutMs) || 900;
  const start = Date.now();
  const printers = await scanSubnetForPort({ port, timeoutMs: timeout });
  setDiscovered(printers);
  return {
    printers,
    subnets: getLocalSubnets().map(function (s) { return s.address + ' (' + s.iface + ')'; }),
    elapsed: Date.now() - start,
  };
}

router.get('/v1/scan-printers', async (_req, res) => {
  if (scanning) {
    return res.json({
      ok: true,
      printers: getDiscovered(),
      subnets: getLocalSubnets().map(function (s) { return s.address + ' (' + s.iface + ')'; }),
      elapsed: 0,
      cached: true,
      lastScan: getLastScan(),
      busy: true,
    });
  }

  try {
    scanning = true;
    const port = Number(_req.query.port) > 0 ? Number(_req.query.port) : 9100;
    const timeout = Number(_req.query.timeout) > 0 ? Math.min(Number(_req.query.timeout), 5000) : 900;
    const result = await runScan({ port, timeoutMs: timeout });
    res.json({
      ok: true,
      printers: result.printers,
      subnets: result.subnets,
      elapsed: result.elapsed,
      cached: false,
      lastScan: getLastScan(),
    });
  } catch (err) {
    console.error('[qrpaydot-helper] /v1/scan-printers', err.message || err);
    res.status(500).json({ error: err.message || 'scan failed' });
  } finally {
    scanning = false;
  }
});

module.exports = router;
module.exports.runScan = runScan;

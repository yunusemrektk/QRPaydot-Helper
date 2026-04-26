'use strict';

const os = require('os');
const { Router } = require('express');

const router = Router();

function normalizeMac(mac) {
  const s = String(mac || '').trim();
  if (!s) return '';
  return s.replace(/-/g, ':').toUpperCase();
}

function isValidMac(mac) {
  const m = normalizeMac(mac);
  if (!m) return false;
  if (m === '00:00:00:00:00:00') return false;
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(m);
}

function pickBestMac() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name] || [];
    for (const a of addrs) {
      // a: { address, netmask, family, mac, internal, cidr, scopeid? }
      if (!a) continue;
      if (a.internal) continue;
      const mac = normalizeMac(a.mac);
      if (!isValidMac(mac)) continue;
      candidates.push({ name, mac, family: a.family, address: a.address });
    }
  }

  if (candidates.length === 0) return null;

  // Prefer IPv4-bound interfaces (most stable on Windows LAN)
  const ipv4 = candidates.find((c) => c.family === 'IPv4');
  return (ipv4 || candidates[0]).mac;
}

router.get('/v1/device', (_req, res) => {
  const hardwareId = pickBestMac();
  if (!hardwareId) {
    return res.status(404).json({ ok: false, error: 'no-mac-found' });
  }
  return res.json({ ok: true, hardwareId });
});

module.exports = router;


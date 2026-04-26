'use strict';

const net = require('net');
const os = require('os');

const DEFAULT_RAW_PORT = 9100;
const CONNECT_TIMEOUT_MS = 900;
const MAX_CONCURRENT = 80;

function getLocalSubnets() {
  const ifaces = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name]) {
      if (info.family === 'IPv4' && !info.internal) {
        results.push({ address: info.address, netmask: info.netmask, iface: name });
      }
    }
  }
  return results;
}

function subnetHosts(localIp) {
  const parts = localIp.split('.');
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join('.');
  const hosts = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${prefix}.${i}`;
    if (ip !== localIp) hosts.push(ip);
  }
  return hosts;
}

/**
 * Hard-timeout TCP connect probe.
 * Node's socket `timeout` option only fires on inactivity AFTER connection,
 * not on the SYN phase. We use our own setTimeout to force-kill the attempt.
 */
function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const start = Date.now();

    function done(open) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.removeAllListeners(); socket.destroy(); } catch {}
      resolve({ host, port, open, ms: Date.now() - start });
    }

    const socket = net.connect({ host, port });
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));

    const timer = setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Scans the local /24 subnet(s) for hosts with a given port open.
 * Uses high concurrency + short hard-timeout for speed.
 */
async function scanSubnetForPort(opts) {
  const port = (opts && opts.port) || DEFAULT_RAW_PORT;
  const timeoutMs = (opts && opts.timeoutMs) || CONNECT_TIMEOUT_MS;
  const maxConcurrent = (opts && opts.maxConcurrent) || MAX_CONCURRENT;

  const subnets = getLocalSubnets();
  if (!subnets.length) return [];

  const found = [];
  const seen = new Set();

  for (const sub of subnets) {
    const hosts = subnetHosts(sub.address);
    let idx = 0;

    async function worker() {
      while (idx < hosts.length) {
        const h = hosts[idx++];
        if (seen.has(h)) continue;
        seen.add(h);
        const res = await probePort(h, port, timeoutMs);
        if (res.open) {
          found.push({ host: res.host, port: res.port, ms: res.ms, iface: sub.iface });
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(maxConcurrent, hosts.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  return found;
}

module.exports = { scanSubnetForPort, getLocalSubnets, probePort };

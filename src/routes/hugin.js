'use strict';

const { Router } = require('express');
const { fetch: undiciFetch, Agent } = require('undici');
const { getPosAssignment } = require('../lib/printerStore');
const { isPrivateOrLocalHost } = require('../config');
const os = require('os');
const dgram = require('dgram');

const router = Router();

// In-memory VUK token per POS device id (short-lived).
const vukTokenByPosId = new Map();
// In-memory last started document id per POS device id (best-effort reuse).
const lastDocumentIdByPosId = new Map();

function debugEnabled() {
  return String(process.env.HELPER_HUGIN_DEBUG || '').trim() === '1';
}

function dbg(event, payload) {
  if (!debugEnabled()) return;
  try {
    console.log(`[hugin-proxy] ${event}`, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

/**
 * Paketli kurulumda repo/.env yok; geliştirmede merchant-dash/.env içindeki
 * HELPER_HUGIN_INSECURE_TLS=1 ile TLS gevşetiliyordu. Hugin PC Link (HTTPS 4443)
 * çoğu kurulumda self-signed kullanır — LAN/Hugin hedeflerinde doğrulamayı
 * isteğe bağlı gevşet (process genelinde NODE_TLS_REJECT_UNAUTHORIZED kullanmadan).
 * Tam doğrulama: HELPER_HUGIN_STRICT_TLS=1
 */
let huginInsecureDispatcher = null;
function getHuginInsecureDispatcher() {
  if (!huginInsecureDispatcher) {
    huginInsecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return huginInsecureDispatcher;
}

function shouldRelaxTlsForHugin(hostname, port) {
  if (String(process.env.HELPER_HUGIN_STRICT_TLS || '').trim() === '1') return false;
  const legacyEnv = String(process.env.HELPER_HUGIN_INSECURE_TLS || '').trim() === '1';
  const h = String(hostname || '').trim();
  const p = Number(port);
  if (!h) return legacyEnv;
  if (legacyEnv) return true;
  if (isPrivateOrLocalHost(h)) return true;
  if (p === 4443) return true;
  if (h.endsWith('.local')) return true;
  return false;
}

function hardwareIdOverride() {
  const raw = String(process.env.HELPER_HUGIN_HARDWARE_ID || '').trim();
  if (!raw) return null;
  // Accept AA:BB:.., AA-BB-.., or AABB..
  return raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

function cleanBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function normalizeMac(mac) {
  const s = String(mac || '').trim();
  if (!s) return '';
  return s.replace(/-/g, ':').toUpperCase();
}

function pickBestMac() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name] || [];
    for (const a of addrs) {
      if (!a || a.internal) continue;
      const mac = normalizeMac(a.mac);
      if (!mac || mac === '00:00:00:00:00:00') continue;
      // Hugin expects MAC without separators (e.g. 401A58A259AD)
      return mac.replace(/:/g, '');
    }
  }
  return null;
}

async function pickMacForRoute(remoteHost) {
  // Determine which local IP will be used to reach remoteHost, then map that IP back to a NIC MAC.
  const host = String(remoteHost || '').trim();
  if (!host) return null;

  const localAddr = await new Promise((resolve) => {
    try {
      const sock = dgram.createSocket('udp4');
      sock.on('error', () => {
        try { sock.close(); } catch {}
        resolve(null);
      });
      // UDP connect does not send packets; it just picks a route.
      sock.connect(1, host, () => {
        const a = sock.address();
        try { sock.close(); } catch {}
        resolve(a && a.address ? String(a.address) : null);
      });
    } catch {
      resolve(null);
    }
  });

  if (!localAddr) return null;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name] || [];
    for (const a of addrs) {
      if (!a || a.internal) continue;
      if (String(a.address || '').trim() !== localAddr) continue;
      const mac = normalizeMac(a.mac);
      if (!mac || mac === '00:00:00:00:00:00') continue;
      return mac.replace(/:/g, '');
    }
  }
  return null;
}

function padSoftwareId10(raw) {
  const s = String(raw || '').trim();
  if (s.length >= 10) return s.slice(0, 10);
  return s.padEnd(10, '0');
}

async function huginFetch(posDeviceId, path, init, headersExtra) {
  const ep = getPosAssignment(posDeviceId);
  if (!ep || !ep.host || !(Number(ep.port) > 0)) {
    const err = new Error('POS_NOT_ASSIGNED');
    err.code = 'POS_NOT_ASSIGNED';
    throw err;
  }

  const scheme = ep.scheme === 'https' ? 'https' : 'http';
  const url = `${cleanBaseUrl(`${scheme}://${ep.host}:${ep.port}`)}/v1/${String(path).replace(/^\/+/, '')}`;
  const mac = hardwareIdOverride() || (await pickMacForRoute(ep.host)) || pickBestMac();

  const headers = {
    'Content-Type': 'application/json',
    ...(headersExtra || {}),
  };
  if (mac) headers['X-HardwareId'] = mac;

  const token = vukTokenByPosId.get(posDeviceId);
  if (token) headers.Authorization = `Bearer ${token}`;

  dbg('request', {
    posDeviceId,
    to: url,
    method: init.method,
    headers: {
      'X-SoftwareId': headers['X-SoftwareId'],
      'X-SerialNo': headers['X-SerialNo'],
      'X-HardwareId': headers['X-HardwareId'],
      Authorization: headers.Authorization ? 'Bearer <redacted>' : undefined,
    },
    body: init.body ?? undefined,
  });

  const urlObj = new URL(url);
  const relaxTls = urlObj.protocol === 'https:' && shouldRelaxTlsForHugin(urlObj.hostname, ep.port);
  const fetchOpts = {
    ...init,
    headers,
    body: init.body != null ? JSON.stringify(init.body) : undefined,
    ...(relaxTls ? { dispatcher: getHuginInsecureDispatcher() } : {}),
  };
  const res = await undiciFetch(url, fetchOpts);

  const json = await res.json().catch(() => null);
  dbg('response', { posDeviceId, from: url, httpStatus: res.status, json });
  if (json && typeof json.token === 'string' && json.token.trim()) {
    vukTokenByPosId.set(posDeviceId, json.token.trim());
  }
  return { httpStatus: res.status, json };
}

function parseActiveDocumentId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const direct = data?.activeDocumentId || data?.documentId;
  if (direct && typeof direct === 'string' && direct.trim()) return direct.trim();
  const activeDoc = data?.activeDocument && typeof data.activeDocument === 'object' ? data.activeDocument : null;
  const fromActive = activeDoc?.documentId;
  if (fromActive && typeof fromActive === 'string' && fromActive.trim()) return fromActive.trim();
  return null;
}

function parseStartedDocumentId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const id = data?.documentId;
  if (id && typeof id === 'string' && id.trim()) return id.trim();
  return parseActiveDocumentId(payload);
}

router.get('/v1/hugin/status', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'status',
      { method: 'GET' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.get('/v1/hugin/settings', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'settings',
      { method: 'GET' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.patch('/v1/hugin/settings', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'settings',
      { method: 'PATCH', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/v1/hugin/ensure-sale-document', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    // 1) Check terminal state first; if there is an ACTIVE document, reuse it.
    const st = await huginFetch(
      posDeviceId,
      'status',
      { method: 'GET' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    if (st.json && st.json.status === 'SUCCESS') {
      const openId = parseActiveDocumentId(st.json);
      if (openId) {
        lastDocumentIdByPosId.set(posDeviceId, openId);
        return res.json({ status: 'SUCCESS', data: { documentId: openId, reused: true } });
      }
      const stateRaw = st.json?.data?.state;
      const state = stateRaw != null ? String(stateRaw).trim().toUpperCase() : '';

      // If POS explicitly says IDLE, we must start a new SALE document.
      if (state === 'IDLE') {
        // fall through to start
      } else if (state) {
        // Non-IDLE but no document id returned → cannot safely proceed
        return res.json({
          status: 'ERROR',
          error: {
            title: 'Açık belge var',
            description: `POS state=${stateRaw} ama aktif documentId bulunamadı.`,
          },
        });
      } else {
        // Some firmwares omit state. If they also omit activeDocument, treat as IDLE.
        // fall through to start
      }
    }

    // 2) IDLE or unknown → start a new SALE document.
    const r = await huginFetch(
      posDeviceId,
      'documents/SALE',
      { method: 'POST' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    const startedId = parseStartedDocumentId(r.json);
    if (startedId) lastDocumentIdByPosId.set(posDeviceId, startedId);
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/v1/hugin/documents', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'documents',
      { method: 'POST', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    const startedId = parseActiveDocumentId(r.json);
    if (startedId) lastDocumentIdByPosId.set(posDeviceId, startedId);
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/v1/hugin/documents/:documentId/payments/EFT_POS', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    const documentId = String(req.params.documentId || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });
    if (!documentId) return res.status(400).json({ status: 'ERROR', error: { title: 'documentId gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      `documents/${encodeURIComponent(documentId)}/payments/EFT_POS`,
      { method: 'POST', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.put('/v1/hugin/documents/:documentId', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    const documentId = String(req.params.documentId || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });
    if (!documentId) return res.status(400).json({ status: 'ERROR', error: { title: 'documentId gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      `documents/${encodeURIComponent(documentId)}`,
      { method: 'PUT', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/v1/hugin/documents/:documentId/resume', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    const documentId = String(req.params.documentId || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });
    if (!documentId) return res.status(400).json({ status: 'ERROR', error: { title: 'documentId gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      `documents/${encodeURIComponent(documentId)}/resume`,
      { method: 'POST', body: {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.get('/v1/hugin/reports/X', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'reports/X',
      { method: 'GET' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/v1/hugin/reports/Z', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    // Hugin dokümantasyonunda yer almayan ama gerçek cihazlarda çalışan davranış:
    // `/reports/Z/print` POS üzerinden fiziksel çıktı da bastırır. Default olarak
    // bunu tercih ediyoruz. Sessiz mod için `?print=0` gönderilebilir.
    const shouldPrint = String(req.query.print ?? '1').trim() !== '0';
    const path = shouldPrint ? 'reports/Z/print' : 'reports/Z';

    const r = await huginFetch(
      posDeviceId,
      path,
      { method: 'POST', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.get('/v1/hugin/pos/batch', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'pos/batch',
      { method: 'GET' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/v1/hugin/pos/batch/close', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'pos/batch/close',
      { method: 'POST', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/v1/hugin/documents/:documentId/cancel', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    const documentId = String(req.params.documentId || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });
    if (!documentId) return res.status(400).json({ status: 'ERROR', error: { title: 'documentId gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      `documents/${encodeURIComponent(documentId)}/cancel`,
      { method: 'POST', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

module.exports = router;


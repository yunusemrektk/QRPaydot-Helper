'use strict';

const { Router } = require('express');
const { fetch: undiciFetch, Agent } = require('undici');
const { getPosAssignment } = require('../lib/printerStore');
const { resolveHuginHeadersForPosDevice } = require('../lib/posDeviceRecordCache');
const { isPrivateOrLocalHost } = require('../config');
const { appendServiceLog } = require('../lib/logger');
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
    // Keep-alive reuse Hugin'de yarım kalan TLS soketinden sonra kuyruğu kilitliyor
    // ("birkaç işlem sonra POS'a istek gitmiyor"). Tek bağlantı, pipeline yok, keep-alive kapalı.
    huginInsecureDispatcher = new Agent({
      connect: { rejectUnauthorized: false },
      connections: 1,
      pipelining: 0,
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
    });
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

function summarizeHuginJson(json) {
  if (!json || typeof json !== 'object') return 'no-json';
  const st = String(json.status || '').trim() || '?';
  const title =
    json.error && typeof json.error === 'object' && json.error.title != null
      ? String(json.error.title).slice(0, 100)
      : '';
  return title ? `${st} (${title})` : st;
}

/** Hugin PC Link tek istek kabul eder — cihaz başına HTTP sırası. */
const huginFetchTailByPosId = new Map();
/** Aynı anda birden fazla GET /status kuyruğa girmesin (EFT beklerken probe spam). */
const huginQueuedStatusByPosId = new Map();

/** Operasyon tipine göre üst süre — kuyruk sonsuza kilitlenmesin. EFT bilerek uzun. */
const HUGIN_TIMEOUT_STATUS_MS = 10_000;
const HUGIN_TIMEOUT_EFT_MS = 150_000;
const HUGIN_TIMEOUT_FINALIZE_MS = 120_000;
const HUGIN_TIMEOUT_DEFAULT_MS = 60_000;

function resolveHuginTimeoutMs(relPath, method, explicitMs) {
  if (Number(explicitMs) > 0) return Math.floor(Number(explicitMs));
  const p = String(relPath || '').replace(/^\/+/, '');
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' && (p === 'status' || p.startsWith('status/'))) return HUGIN_TIMEOUT_STATUS_MS;
  if (m === 'POST' && /\/payments\/EFT_POS$/i.test(p)) return HUGIN_TIMEOUT_EFT_MS;
  if (m === 'PUT' && /^documents\/[^/]+$/i.test(p)) return HUGIN_TIMEOUT_FINALIZE_MS;
  return HUGIN_TIMEOUT_DEFAULT_MS;
}

function isAbortTimeoutError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('aborted') || msg.includes('timeout') || msg.includes('headers timeout') || msg.includes('body timeout');
}

function isStatusGet(relPath, method) {
  return String(method || 'GET').toUpperCase() === 'GET' && String(relPath || '').replace(/^\/+/, '') === 'status';
}

async function huginFetchInner(posDeviceId, path, init, headersExtra) {
  const ep = getPosAssignment(posDeviceId);
  if (!ep || !ep.host || !(Number(ep.port) > 0)) {
    appendServiceLog(`[hugin-proxy] blocked pos=${posDeviceId} reason=POS_NOT_ASSIGNED`);
    const err = new Error('POS_NOT_ASSIGNED');
    err.code = 'POS_NOT_ASSIGNED';
    throw err;
  }

  const scheme = ep.scheme === 'https' ? 'https' : 'http';
  const url = `${cleanBaseUrl(`${scheme}://${ep.host}:${ep.port}`)}/v1/${String(path).replace(/^\/+/, '')}`;
  const mac = hardwareIdOverride() || (await pickMacForRoute(ep.host)) || pickBestMac();

  const headers = {
    'Content-Type': 'application/json',
    ...(await resolveHuginHeadersForPosDevice(posDeviceId, headersExtra || {})),
  };
  if (mac) headers['X-HardwareId'] = mac;

  const token = vukTokenByPosId.get(posDeviceId);
  if (token) headers.Authorization = `Bearer ${token}`;

  const method = String((init && init.method) || 'GET').toUpperCase();
  const relPath = String(path).replace(/^\/+/, '');
  const { timeoutMs: explicitTimeout, body: bodyIn, ...restInit } = init || {};
  const timeoutMs = resolveHuginTimeoutMs(relPath, method, explicitTimeout);

  dbg('request', {
    posDeviceId,
    to: url,
    method: init && init.method,
    timeoutMs,
    headers: {
      'X-SoftwareId': headers['X-SoftwareId'],
      'X-SerialNo': headers['X-SerialNo'],
      'X-HardwareId': headers['X-HardwareId'],
      Authorization: headers.Authorization ? 'Bearer <redacted>' : undefined,
    },
    body: bodyIn ?? undefined,
  });

  const urlObj = new URL(url);
  const relaxTls = urlObj.protocol === 'https:' && shouldRelaxTlsForHugin(urlObj.hostname, ep.port);
  const fetchOpts = {
    ...restInit,
    headers,
    body: bodyIn != null ? JSON.stringify(bodyIn) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    ...(relaxTls ? { dispatcher: getHuginInsecureDispatcher() } : {}),
  };
  try {
    const res = await undiciFetch(url, fetchOpts);

    const json = await res.json().catch(() => null);
    dbg('response', { posDeviceId, from: url, httpStatus: res.status, json });
    if (json && typeof json.token === 'string' && json.token.trim()) {
      vukTokenByPosId.set(posDeviceId, json.token.trim());
    }
    appendServiceLog(
      `[hugin-proxy] ${method} ${relPath} pos=${posDeviceId} -> HTTP ${res.status} ${summarizeHuginJson(json)}`,
    );
    return { httpStatus: res.status, json };
  } catch (err) {
    const msg = err && err.message ? String(err.message).slice(0, 240) : String(err);
    if (isAbortTimeoutError(err)) {
      appendServiceLog(
        `[hugin-proxy] ${method} ${relPath} pos=${posDeviceId} -> TIMEOUT ${timeoutMs}ms`,
      );
      dbg('response', {
        posDeviceId,
        from: url,
        httpStatus: 504,
        timeoutMs,
        error: 'Request timed out',
      });
      // Ölü keep-alive soketi bir sonraki isteği de bozmasın.
      try {
        if (huginInsecureDispatcher) {
          huginInsecureDispatcher.close();
          huginInsecureDispatcher = null;
        }
      } catch {
        huginInsecureDispatcher = null;
      }
      return {
        httpStatus: 504,
        json: {
          status: 'ERROR',
          error: {
            title: 'Request timed out',
            description: `POS did not respond within ${timeoutMs}ms`,
          },
        },
      };
    }
    appendServiceLog(`[hugin-proxy] ${method} ${relPath} pos=${posDeviceId} -> FETCH_ERR ${msg}`);
    try {
      if (huginInsecureDispatcher) {
        huginInsecureDispatcher.close();
        huginInsecureDispatcher = null;
      }
    } catch {
      huginInsecureDispatcher = null;
    }
    throw err;
  }
}

async function huginFetch(posDeviceId, path, init, headersExtra) {
  const key = String(posDeviceId || '').trim();
  if (!key) return huginFetchInner(posDeviceId, path, init, headersExtra);

  const method = String((init && init.method) || 'GET').toUpperCase();
  const relPath = String(path).replace(/^\/+/, '');

  // EFT/finalize sırasında arka arkaya status probe'ları kuyruğu şişirip
  // belge sonlandırmayı geciktiriyordu — tek status çağrısına birleştir.
  if (isStatusGet(relPath, method)) {
    const existing = huginQueuedStatusByPosId.get(key);
    if (existing) {
      dbg('status-coalesced', { posDeviceId: key });
      return existing;
    }
  }

  const enqueuedAt = Date.now();
  const prev = huginFetchTailByPosId.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => {
      const waitedMs = Date.now() - enqueuedAt;
      if (waitedMs >= 500) {
        appendServiceLog(
          `[hugin-proxy] queue-wait ${waitedMs}ms ${method} ${relPath} pos=${key}`,
        );
      }
      return huginFetchInner(key, path, init, headersExtra);
    })
    .finally(() => {
      if (huginFetchTailByPosId.get(key) === next) {
        huginFetchTailByPosId.delete(key);
      }
      if (isStatusGet(relPath, method) && huginQueuedStatusByPosId.get(key) === next) {
        huginQueuedStatusByPosId.delete(key);
      }
    });
  huginFetchTailByPosId.set(key, next);
  if (isStatusGet(relPath, method)) {
    huginQueuedStatusByPosId.set(key, next);
  }
  return next;
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

router.get('/status', async (req, res) => {
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

router.get('/settings', async (req, res) => {
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
    const json = r.json || { status: 'ERROR', error: { title: 'Invalid response' } };
    if (json.status === 'SUCCESS') {
      const { getBackendConnection } = require('../lib/printerStore');
      const { maybeRefreshDepartmentsFromSettingsResponse } = require('../lib/posDepartmentsSync');
      void maybeRefreshDepartmentsFromSettingsResponse(
        getBackendConnection(),
        posDeviceId,
        json,
        'get-settings',
      );
    }
    return res.status(r.httpStatus).json(json);
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.patch('/settings', async (req, res) => {
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
    const json = r.json || { status: 'ERROR', error: { title: 'Invalid response' } };
    if (json.status === 'SUCCESS' && Array.isArray(json.data && json.data.departments)) {
      const { getBackendConnection } = require('../lib/printerStore');
      const { persistDepartmentsSnapshot, normalizeDepartments } = require('../lib/posDepartmentsSync');
      const cfg = getBackendConnection();
      const depts = normalizeDepartments(json.data.departments);
      if (depts.length && cfg && cfg.merchantId) {
        void persistDepartmentsSnapshot(cfg, cfg.merchantId, posDeviceId, depts, 'patch-settings');
      }
    }
    return res.status(r.httpStatus).json(json);
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC’de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/ensure-sale-document', async (req, res) => {
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

router.post('/documents', async (req, res) => {
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

router.post('/documents/:documentId/payments/EFT_POS', async (req, res) => {
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

router.put('/documents/:documentId', async (req, res) => {
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

router.post('/documents/:documentId/resume', async (req, res) => {
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

router.get('/reports/X', async (req, res) => {
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

router.post('/reports/Z', async (req, res) => {
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

router.get('/pos/batch', async (req, res) => {
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

router.post('/pos/batch/close', async (req, res) => {
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

router.post('/documents/:documentId/cancel', async (req, res) => {
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

// ---------------------------------------------------------------------------
// Banka İşlemleri — POS transaction list, detail, void, refund, prev batch
// ---------------------------------------------------------------------------

router.get('/pos/transactions', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'pos/transactions',
      { method: 'GET' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC\'de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.get('/pos/transactions/:transactionId', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    const transactionId = String(req.params.transactionId || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });
    if (!transactionId) return res.status(400).json({ status: 'ERROR', error: { title: 'transactionId gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      `pos/transactions/${encodeURIComponent(transactionId)}`,
      { method: 'GET' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC\'de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/pos/transactions/:transactionId/void', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    const transactionId = String(req.params.transactionId || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });
    if (!transactionId) return res.status(400).json({ status: 'ERROR', error: { title: 'transactionId gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      `pos/transactions/${encodeURIComponent(transactionId)}/void`,
      { method: 'POST', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC\'de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.post('/pos/refunds', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'pos/refunds',
      { method: 'POST', body: req.body || {} },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC\'de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

router.get('/pos/batch/previous', async (req, res) => {
  try {
    const posDeviceId = String(req.query.posDeviceId || '').trim();
    const softwareId = padSoftwareId10(String(req.query.softwareId || '').trim());
    const serialNo = String(req.query.serialNo || '').trim();
    if (!posDeviceId) return res.status(400).json({ status: 'ERROR', error: { title: 'posDeviceId gerekli' } });
    if (!softwareId.trim()) return res.status(400).json({ status: 'ERROR', error: { title: 'softwareId gerekli' } });
    if (!serialNo) return res.status(400).json({ status: 'ERROR', error: { title: 'serialNo gerekli' } });

    const r = await huginFetch(
      posDeviceId,
      'pos/batch/previous',
      { method: 'GET' },
      { 'X-SoftwareId': softwareId, 'X-SerialNo': serialNo },
    );
    return res.status(r.httpStatus).json(r.json || { status: 'ERROR', error: { title: 'Invalid response' } });
  } catch (e) {
    if (e && e.code === 'POS_NOT_ASSIGNED') {
      return res.status(400).json({ status: 'ERROR', error: { title: 'POS bu PC\'de atanmadı' } });
    }
    return res.status(502).json({ status: 'ERROR', error: { title: 'Failed to fetch' } });
  }
});

module.exports = router;


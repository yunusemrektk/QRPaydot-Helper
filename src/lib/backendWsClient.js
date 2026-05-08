'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const { appendServiceLog } = require('./logger');
const { getAssignment, getPrintDefaults } = require('./printerStore');
const { buildEscPosPayload } = require('./escpos');
const { sendToPrinter } = require('./printer');
const { normalizePrintEncoding } = require('./encoding');

let ws = null;
let reconnectTimer = null;
let activeConfig = null;
let authenticated = false;
let intentionalClose = false;
let lastError = null;

/** Aynı PRINT_JOB kısa sürede iki kez gelirse (yeniden bağlanma vb.) tek çıktı. */
let lastPrintJobFingerprint = '';
let lastPrintJobAt = 0;
const PRINT_JOB_DEDUPE_MS = 2800;

const BASE_RECONNECT_MS = 4000;
const MAX_RECONNECT_MS = 60000;
let reconnectDelayMs = BASE_RECONNECT_MS;

function apiBaseUrlToWsUrl(apiBaseUrl) {
  try {
    const u = new URL(String(apiBaseUrl).trim().replace(/\/+$/, ''));
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}/ws`;
  } catch {
    return null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (intentionalClose || !activeConfig) return;
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNow();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 1.5, MAX_RECONNECT_MS);
}

function sendAuth() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !activeConfig) return;
  ws.send(
    JSON.stringify({
      type: 'AUTH',
      token: activeConfig.token,
      merchantId: String(activeConfig.merchantId).trim(),
      /** Sunucuda panel oturumlarından ayrım için (MERCHANT_DASH dışında → köprü). */
      clientKind: 'PRINT_BRIDGE',
    }),
  );
}

async function handlePrintJobPayload(data) {
  const printerId = data && data.printerId != null ? String(data.printerId).trim() : '';
  const text = data && typeof data.text === 'string' ? data.text : '';
  if (!printerId || !text) {
    appendServiceLog('[backend-ws] PRINT_JOB missing printerId or text');
    return;
  }
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 40);
  const dedupeBase =
    data.printDedupeKey != null && String(data.printDedupeKey).trim()
      ? String(data.printDedupeKey).trim().slice(0, 512)
      : '';
  const fp = dedupeBase ? `${printerId}|${dedupeBase}|${digest}` : `${printerId}|${digest}`;
  const now = Date.now();
  if (fp === lastPrintJobFingerprint && now - lastPrintJobAt < PRINT_JOB_DEDUPE_MS) {
    appendServiceLog('[backend-ws] PRINT_JOB deduped (same payload)');
    return;
  }
  lastPrintJobFingerprint = fp;
  lastPrintJobAt = now;
  const ep = getAssignment(printerId) || getAssignment(printerId.toLowerCase());
  if (!ep || !ep.host) {
    appendServiceLog(`[backend-ws] no LAN assignment for printerId=${printerId}`);
    console.warn(`[qrpaydot-helper] PRINT_JOB: no assignment for logical printer ${printerId}`);
    return;
  }
  const enc = normalizePrintEncoding(data.encoding || getPrintDefaults().encoding);
  const cut = data.cut !== false;
  const buf = buildEscPosPayload(text, enc, undefined, { cancelDoubleByte: false });
  await sendToPrinter(ep.host, ep.port, [buf], cut);
  appendServiceLog(`[backend-ws] printed job printerId=${printerId} -> ${ep.host}:${ep.port}`);
}

function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const type = String(msg.type || '').toUpperCase();
  if (type === 'AUTH_SUCCESS') {
    authenticated = true;
    reconnectDelayMs = BASE_RECONNECT_MS;
    lastError = null;
    appendServiceLog('[backend-ws] AUTH_SUCCESS');
    try {
      console.log(
        `[qrpaydot-helper] backend WS AUTH_SUCCESS merchantId=${activeConfig ? String(activeConfig.merchantId).trim() : ''}`,
      );
    } catch {
      console.log('[qrpaydot-helper] backend WS AUTH_SUCCESS');
    }
    return;
  }
  if (type === 'AUTH_ERROR') {
    authenticated = false;
    lastError = msg.error || 'AUTH_ERROR';
    appendServiceLog(`[backend-ws] AUTH_ERROR ${lastError}`);
    if (String(lastError).includes('expired')) {
      console.warn(
        '[qrpaydot-helper] backend WS AUTH_ERROR: saved JWT expired — open merchant dashboard on this PC and refresh (F5), or POST /v1/credentials again',
      );
    } else {
      console.warn(`[qrpaydot-helper] backend WS AUTH_ERROR: ${lastError}`);
    }
    return;
  }
  if (type === 'PRINT_JOB' && msg.data) {
    void handlePrintJobPayload(msg.data).catch((err) => {
      lastError = err.message || String(err);
      appendServiceLog(`[backend-ws] PRINT_JOB failed: ${lastError}`);
      console.error('[qrpaydot-helper] PRINT_JOB error:', err.message || err);
    });
    return;
  }
  if (type === 'POS_PAYMENT_JOB' && msg.data) {
    if (!authenticated) {
      appendServiceLog('[backend-ws] POS_PAYMENT_JOB ignored (not authenticated)');
      return;
    }
    appendServiceLog(
      `[backend-ws] POS_PAYMENT_JOB recv jobId=${msg.data.jobId != null ? String(msg.data.jobId) : ''}`,
    );
    console.log(
      `[qrpaydot-helper] backend WS POS_PAYMENT_JOB recv jobId=${msg.data.jobId != null ? String(msg.data.jobId) : ''}`,
    );
    const { runPosPaymentJobFromWs } = require('./posPaymentJobRunner');
    void runPosPaymentJobFromWs(msg.data).catch((err) => {
      lastError = err.message || String(err);
      appendServiceLog(`[backend-ws] POS_PAYMENT_JOB runner error: ${lastError}`);
      console.error('[qrpaydot-helper] POS_PAYMENT_JOB:', err.message || err);
    });
    return;
  }
  if (type === 'POS_HUGIN_STATUS_PROBE' && msg.data) {
    if (!authenticated) {
      appendServiceLog('[backend-ws] POS_HUGIN_STATUS_PROBE ignored (not authenticated)');
      return;
    }
    const { handlePosHuginStatusProbe } = require('./huginStatusProbeWs');
    void handlePosHuginStatusProbe(msg.data).catch((err) => {
      appendServiceLog(`[backend-ws] POS_HUGIN_STATUS_PROBE ${err.message || err}`);
    });
    return;
  }
  if (type === 'POS_HUGIN_DOC_ACTION' && msg.data) {
    if (!authenticated) {
      appendServiceLog('[backend-ws] POS_HUGIN_DOC_ACTION ignored (not authenticated)');
      return;
    }
    const { handlePosHuginDocAction } = require('./huginDocActionWs');
    void handlePosHuginDocAction(msg.data).catch((err) => {
      appendServiceLog(`[backend-ws] POS_HUGIN_DOC_ACTION ${err.message || err}`);
    });
    return;
  }
}

function connectNow() {
  if (!activeConfig) return;
  const url = apiBaseUrlToWsUrl(activeConfig.apiBaseUrl);
  if (!url) {
    lastError = 'invalid apiBaseUrl';
    appendServiceLog('[backend-ws] invalid apiBaseUrl');
    return;
  }
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  intentionalClose = false;
  authenticated = false;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    lastError = e.message || String(e);
    appendServiceLog(`[backend-ws] new WebSocket failed: ${lastError}`);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    appendServiceLog(`[backend-ws] connected ${url}`);
    console.log(`[qrpaydot-helper] backend WS open -> ${url}`);
    sendAuth();
  });

  ws.on('message', (data) => onMessage(data));

  ws.on('close', () => {
    appendServiceLog('[backend-ws] socket closed');
    ws = null;
    authenticated = false;
    if (!intentionalClose) scheduleReconnect();
  });

  ws.on('error', (err) => {
    lastError = err.message || String(err);
    appendServiceLog(`[backend-ws] error ${lastError}`);
  });
}

function stopBackendWs() {
  intentionalClose = true;
  clearReconnectTimer();
  activeConfig = null;
  authenticated = false;
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

/**
 * Kayıtlı token / işletme ile sunucuya bağlanır; PRINT_JOB mesajlarını LAN yazıcıya iletir.
 */
function startBackendWs(config) {
  stopBackendWs();
  if (!config || !config.token || !config.merchantId || !config.apiBaseUrl) return;
  intentionalClose = false;
  activeConfig = { ...config };
  reconnectDelayMs = BASE_RECONNECT_MS;
  connectNow();
}

function getBackendWsState() {
  const open = Boolean(ws && ws.readyState === WebSocket.OPEN);
  return {
    backendWs: open && authenticated,
    backendWsSocketOpen: open,
    backendWsAuthenticated: authenticated,
    lastError,
  };
}

module.exports = {
  startBackendWs,
  stopBackendWs,
  getBackendWsState,
  apiBaseUrlToWsUrl,
};

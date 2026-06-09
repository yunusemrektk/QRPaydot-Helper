'use strict';

const WebSocket = require('ws');
const { appendServiceLog } = require('./logger');
const { getAssignment, getPrintDefaults } = require('./printerStore');
const { buildEscPosPayload } = require('./escpos');
const { sendToPrinter } = require('./printer');
const { normalizePrintEncoding } = require('./encoding');
const { shouldSkipDuplicatePhysicalPrint } = require('./physicalPrintDedupe');

let ws = null;
let reconnectTimer = null;
let activeConfig = null;
let authenticated = false;
let intentionalClose = false;
let lastError = null;

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
  const merchantId = String(activeConfig.merchantId).trim();
  const payload = {
    type: 'AUTH',
    merchantId,
    clientKind: 'PRINT_BRIDGE',
  };
  if (activeConfig.bridgeKey && String(activeConfig.bridgeKey).trim()) {
    payload.bridgeKey = String(activeConfig.bridgeKey).trim();
  } else {
    payload.token = activeConfig.token;
  }
  ws.send(JSON.stringify(payload));
}

async function handlePrintJobPayload(data) {
  const printerId = data && data.printerId != null ? String(data.printerId).trim() : '';
  const text = data && typeof data.text === 'string' ? data.text : '';
  if (!printerId || !text) {
    appendServiceLog('[backend-ws] PRINT_JOB missing printerId or text');
    return;
  }
  const dedupeBase =
    data.printDedupeKey != null && String(data.printDedupeKey).trim()
      ? String(data.printDedupeKey).trim().slice(0, 512)
      : '';
  if (
    shouldSkipDuplicatePhysicalPrint({
      text,
      printDedupeKey: dedupeBase || null,
      printerId,
    })
  ) {
    appendServiceLog('[backend-ws] PRINT_JOB deduped (same payload)');
    return;
  }
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
    if (String(lastError).toLowerCase().includes('expired')) {
      console.warn(
        '[qrpaydot-helper] backend WS AUTH_ERROR: JWT expired — use a Helper API key (Settings → Printing) or open dashboard and POST /v1/credentials again',
      );
    } else if (String(lastError).toLowerCase().includes('bridge')) {
      console.warn(
        '[qrpaydot-helper] backend WS AUTH_ERROR: invalid bridge key — revoke and create a new key in merchant dashboard, then save to Helper',
      );
    } else if (String(lastError).toLowerCase().includes('invalid token')) {
      console.warn(
        '[qrpaydot-helper] backend WS AUTH_ERROR: Invalid token. JWT is valid only on the API that issued it (same JWT_SECRET). If PRINT_BRIDGE / VITE API URL points at local db-server, log in to merchant dashboard on THAT host and save credentials to Helper again, or create a Helper API key on that server and POST it.',
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
      console.warn(
        '[qrpaydot-helper] POS_HUGIN_STATUS_PROBE ignored — not authenticated; open merchant dashboard on this PC and save credentials to Helper',
      );
      return;
    }
    const pid = msg.data.probeId != null ? String(msg.data.probeId).trim() : '';
    appendServiceLog(`[backend-ws] POS_HUGIN_STATUS_PROBE recv probeId=${pid}`);
    console.log(`[qrpaydot-helper] POS_HUGIN_STATUS_PROBE recv probeId=${pid}`);
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
  if (!config || !config.merchantId || !config.apiBaseUrl) return;
  const hasJwt = config.token && String(config.token).trim();
  const hasBridge = config.bridgeKey && String(config.bridgeKey).trim();
  if (!hasJwt && !hasBridge) return;
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

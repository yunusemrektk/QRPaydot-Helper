'use strict';

const { fetch: undiciFetch } = require('undici');
const { PORT } = require('../config');
const { appendServiceLog } = require('./logger');
const { getBackendConnection } = require('./printerStore');
const { backendBearerForApi, hasBackendCallbackAuth } = require('./backendCallbackAuth');
const { classifyHuginStatusJson, isLikelyLostPosResponseError } = require('./huginReachability');

function padSoftwareId10(raw) {
  const s = String(raw || '').trim();
  if (s.length >= 10) return s.slice(0, 10);
  return s.padEnd(10, '0');
}

/**
 * Sunucunun WS yayını: mobil panel Hugin gerçek `status` probu için.
 * Yerel Helper → http://127.0.0.1:${PORT}/v1/pos/status?vendor=hugin → sonucu API'ye yaz.
 */
async function handlePosHuginStatusProbe(wsMsgData) {
  const data = wsMsgData || {};
  const probeId = String(data.probeId || '').trim();
  const merchantId = String(data.merchantId || '').trim();
  const posDeviceId = String(data.posDeviceId || '').trim();
  const serialNo = String(data.serialNo || '').trim();
  const vkn = String(data.vkn || '').trim();

  if (!probeId || !merchantId || !posDeviceId || !serialNo || !vkn) {
    appendServiceLog('[backend-ws] POS_HUGIN_STATUS_PROBE missing fields');
    return;
  }

  const cfg = getBackendConnection();
  if (!cfg || !hasBackendCallbackAuth(cfg)) {
    appendServiceLog('[backend-ws] POS_HUGIN_STATUS_PROBE: no credentials');
    return;
  }

  const softwareId = padSoftwareId10(vkn);
  const localBase = `http://127.0.0.1:${PORT}`;
  const params = new URLSearchParams({
    posDeviceId,
    softwareId,
    serialNo,
    vendor: 'hugin',
  });

  const api = String(cfg.apiBaseUrl || '').replace(/\/+$/, '');
  const url = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-remote-terminal-status/${encodeURIComponent(probeId)}/complete`;

  const out = {
    reachable: false,
    responded: true,
    state: null,
    error: null,
    posDeviceId,
    serialNo,
    softwareId,
    activeDocumentId: null,
    activeDocumentHasPayments: false,
  };

  function pickActiveDocumentId(stData) {
    if (!stData || typeof stData !== 'object') return null;
    if (stData.activeDocumentId != null && String(stData.activeDocumentId).trim()) {
      return String(stData.activeDocumentId).trim();
    }
    if (
      stData.activeDocument &&
      typeof stData.activeDocument === 'object' &&
      stData.activeDocument.documentId != null &&
      String(stData.activeDocument.documentId).trim()
    ) {
      return String(stData.activeDocument.documentId).trim();
    }
    return null;
  }

  /** Boş belgeyi "belgeye devam" ile kilitlememek için: eftPayments vb. dolu mu? */
  function activeDocumentHasPaymentsFromStData(stData) {
    if (!stData || typeof stData !== 'object') return false;
    const ad = stData.activeDocument;
    if (!ad || typeof ad !== 'object' || Array.isArray(ad)) return false;
    for (const k of Object.keys(ad)) {
      if (!/payments$/i.test(k)) continue;
      const v = ad[k];
      if (Array.isArray(v) && v.length > 0) return true;
    }
    return false;
  }

  try {
    const stRes = await undiciFetch(`${localBase}/v1/pos/status?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const stJson = await stRes.json().catch(() => null);
    const cls = classifyHuginStatusJson(stJson);
    if (cls.kind === 'unreachable') {
      out.reachable = false;
      out.error = cls.message ? String(cls.message).slice(0, 220) : 'Hugin status unreachable';
    } else if (cls.kind === 'reachable_issue') {
      out.reachable = true;
      out.error = cls.message ? String(cls.message).slice(0, 220) : 'POS operational issue';
      out.state = cls.data && cls.data.state != null ? String(cls.data.state).trim() : null;
      out.activeDocumentId = pickActiveDocumentId(cls.data);
      out.activeDocumentHasPayments = activeDocumentHasPaymentsFromStData(cls.data);
    } else {
      out.reachable = true;
      out.state = cls.data && cls.data.state != null ? String(cls.data.state).trim() : null;
      out.activeDocumentId = pickActiveDocumentId(cls.data);
      out.activeDocumentHasPayments = activeDocumentHasPaymentsFromStData(cls.data);
    }
  } catch (e) {
    out.reachable = false;
    out.error = e && e.message ? String(e.message).slice(0, 220) : 'status fetch failed';
  }

  try {
    await undiciFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backendBearerForApi(cfg)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(out),
    });
  } catch (e) {
    appendServiceLog(`[backend-ws] POS_HUGIN_STATUS_PROBE complete POST failed ${e.message || e}`);
  }
}

module.exports = {
  handlePosHuginStatusProbe,
};

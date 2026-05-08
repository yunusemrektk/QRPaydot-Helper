'use strict';

const { fetch: undiciFetch } = require('undici');
const { PORT } = require('../config');
const { appendServiceLog } = require('./logger');
const { getBackendConnection } = require('./printerStore');

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
  if (!cfg || !cfg.token || !cfg.apiBaseUrl) {
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
    if (!stJson || stJson.status !== 'SUCCESS') {
      out.reachable = false;
      const errObj = stJson && stJson.error;
      const t = errObj && typeof errObj === 'object' ? errObj.title || errObj.message : null;
      out.error = t ? String(t).slice(0, 220) : 'Hugin status not SUCCESS';
    } else {
      const stateRaw =
        stJson.data && stJson.data.state != null ? String(stJson.data.state).trim().toUpperCase() : '';
      out.state = stJson.data && stJson.data.state != null ? String(stJson.data.state).trim() : null;
      if (stateRaw === 'SERVICE' || stateRaw === 'PREPARATION' || stateRaw === 'ERROR') {
        out.reachable = false;
        out.error = `ÖKC durumu uygun değil (state: ${out.state}).`;
      } else {
        out.reachable = true;
      }
      out.activeDocumentId = pickActiveDocumentId(stJson.data);
      out.activeDocumentHasPayments = activeDocumentHasPaymentsFromStData(stJson.data);
    }
  } catch (e) {
    out.reachable = false;
    out.error = e && e.message ? String(e.message).slice(0, 220) : 'status fetch failed';
  }

  try {
    await undiciFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
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

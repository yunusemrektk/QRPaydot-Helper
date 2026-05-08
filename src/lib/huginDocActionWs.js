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
 * Mobil panelden uzaktan belge resume/cancel → yerel Helper Hugin'e iletir.
 */
async function handlePosHuginDocAction(wsMsgData) {
  const data = wsMsgData || {};
  const probeId = String(data.probeId || '').trim();
  const merchantId = String(data.merchantId || '').trim();
  const posDeviceId = String(data.posDeviceId || '').trim();
  const serialNo = String(data.serialNo || '').trim();
  const vkn = String(data.vkn || '').trim();
  const documentId = String(data.documentId || '').trim();
  const action = String(data.action || '').trim().toLowerCase();

  if (!probeId || !merchantId || !posDeviceId || !serialNo || !vkn || !documentId) {
    appendServiceLog('[backend-ws] POS_HUGIN_DOC_ACTION missing fields');
    return;
  }

  const cfg = getBackendConnection();
  if (!cfg || !cfg.token || !cfg.apiBaseUrl) {
    appendServiceLog('[backend-ws] POS_HUGIN_DOC_ACTION: no credentials');
    return;
  }

  const softwareId = padSoftwareId10(vkn);
  const qs = new URLSearchParams({
    posDeviceId,
    softwareId,
    serialNo,
    vendor: 'hugin',
  });

  const localBase = `http://127.0.0.1:${PORT}`;
  const path =
    action === 'resume'
      ? `documents/${encodeURIComponent(documentId)}/resume`
      : action === 'cancel'
        ? `documents/${encodeURIComponent(documentId)}/cancel`
        : '';

  const api = String(cfg.apiBaseUrl || '').replace(/\/+$/, '');
  const completeUrl = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-remote-hugin-doc-action/${encodeURIComponent(probeId)}/complete`;

  if (!path) {
    appendServiceLog(`[backend-ws] POS_HUGIN_DOC_ACTION unknown action=${action}`);
    return;
  }

  let ok = false;
  let errMsg = '';

  try {
    const docRes = await undiciFetch(`${localBase}/v1/pos/${path}?${qs.toString()}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const docJson = await docRes.json().catch(() => null);
    ok = !!(docJson && docJson.status === 'SUCCESS');
    if (!ok) {
      const e = docJson && docJson.error;
      const title = e && typeof e === 'object' ? e.title || e.message : '';
      errMsg = title ? String(title).slice(0, 380) : 'Hugin işlem sonucu beklenenden farklı';
    }
  } catch (e) {
    ok = false;
    errMsg = e && e.message ? String(e.message).slice(0, 380) : 'DOC_ACTION fetch failed';
  }

  try {
    await undiciFetch(completeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ok, error: ok ? '' : errMsg }),
    });
  } catch (e) {
    appendServiceLog(`[backend-ws] POS_HUGIN_DOC_ACTION complete POST failed ${e.message || e}`);
  }
}

module.exports = {
  handlePosHuginDocAction,
};

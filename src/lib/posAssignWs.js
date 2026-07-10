'use strict';

const { fetch: undiciFetch } = require('undici');
const { appendServiceLog } = require('./logger');
const { getBackendConnection, setPosAssignment } = require('./printerStore');
const { backendBearerForApi, hasBackendCallbackAuth } = require('./backendCallbackAuth');
const { syncDeviceDepartments } = require('./posDepartmentsSync');

/**
 * Sunucu WS: uzak panel POS LAN atamasını kasadaki Helper’a yazar.
 * Yerel setPosAssignment → AUTH yenile → isteğe bağlı departman sync → complete.
 */
async function handlePosHelperPosAssign(wsMsgData) {
  const data = wsMsgData || {};
  const probeId = String(data.probeId || '').trim();
  const merchantId = String(data.merchantId || '').trim();
  const posDeviceId = String(data.posDeviceId || '').trim();
  const host = String(data.host || '').trim();
  const port = Number(data.port);
  const serialNo = String(data.serialNo || '').trim();
  const vkn = String(data.vkn || '').trim();
  const schemeRaw = String(data.scheme || '').trim().toLowerCase();
  const scheme = schemeRaw === 'https' || port === 4443 ? 'https' : 'http';

  if (!probeId || !merchantId || !posDeviceId || !host) {
    appendServiceLog('[backend-ws] POS_HELPER_POS_ASSIGN missing fields');
    return;
  }
  if (!(Number.isFinite(port) && port >= 1 && port <= 65535)) {
    appendServiceLog('[backend-ws] POS_HELPER_POS_ASSIGN invalid port');
    return;
  }
  if (host.includes('://') || /\s/.test(host)) {
    appendServiceLog('[backend-ws] POS_HELPER_POS_ASSIGN invalid host');
    return;
  }

  const cfg = getBackendConnection();
  if (!cfg || !hasBackendCallbackAuth(cfg)) {
    appendServiceLog('[backend-ws] POS_HELPER_POS_ASSIGN: no credentials');
    return;
  }

  const api = String(cfg.apiBaseUrl || '').replace(/\/+$/, '');
  const completeUrl = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-remote-pos-assign/${encodeURIComponent(probeId)}/complete`;

  const out = {
    ok: false,
    error: null,
    departmentsSynced: false,
    departmentCount: 0,
  };

  try {
    setPosAssignment(posDeviceId, { host, port: Math.trunc(port), scheme });
    out.ok = true;
    appendServiceLog(
      `[backend-ws] POS_HELPER_POS_ASSIGN saved posDeviceId=${posDeviceId} -> ${host}:${Math.trunc(port)}`,
    );

    try {
      const { refreshBackendWsAuth } = require('./backendWsClient');
      refreshBackendWsAuth();
    } catch (e) {
      appendServiceLog(`[backend-ws] POS_HELPER_POS_ASSIGN AUTH refresh failed: ${e.message || e}`);
    }

    if (serialNo && vkn) {
      try {
        const synced = await syncDeviceDepartments(cfg, merchantId, posDeviceId, serialNo, vkn);
        if (synced) {
          out.departmentsSynced = true;
          const { getPosDepartmentCache } = require('./printerStore');
          const depts = getPosDepartmentCache(posDeviceId);
          out.departmentCount = Array.isArray(depts) ? depts.length : 0;
        }
      } catch (e) {
        appendServiceLog(
          `[backend-ws] POS_HELPER_POS_ASSIGN dept sync fail: ${e.message || e}`,
        );
      }
    }
  } catch (e) {
    out.ok = false;
    out.error = e && e.message ? String(e.message).slice(0, 220) : 'assign failed';
  }

  try {
    await undiciFetch(completeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backendBearerForApi(cfg)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(out),
    });
  } catch (e) {
    appendServiceLog(`[backend-ws] POS_HELPER_POS_ASSIGN complete POST failed ${e.message || e}`);
  }
}

module.exports = {
  handlePosHelperPosAssign,
};

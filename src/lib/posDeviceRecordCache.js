'use strict';

const { fetch: undiciFetch } = require('undici');
const { getBackendConnection } = require('./printerStore');
const { backendBearerForApi, hasBackendCallbackAuth } = require('./backendCallbackAuth');
const { appendServiceLog } = require('./logger');

const CACHE_TTL_MS = 60_000;

/** @type {{ savedAt: number; merchantId: string; devicesById: Map<string, { serialNo: string; vkn: string }> }} */
let cache = { savedAt: 0, merchantId: '', devicesById: new Map() };

function padSoftwareId10(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/\D/g, '')
    .slice(0, 10);
  if (!s) return '';
  return s.length >= 10 ? s.slice(0, 10) : s.padEnd(10, '0');
}

function invalidatePosDeviceRecordCache() {
  cache = { savedAt: 0, merchantId: '', devicesById: new Map() };
}

async function refreshPosDeviceRecordsIfNeeded() {
  const cfg = getBackendConnection();
  const merchantId = String(cfg?.merchantId || '').trim();
  if (!cfg || !merchantId || !hasBackendCallbackAuth(cfg)) return cache;

  const now = Date.now();
  if (cache.merchantId === merchantId && now - cache.savedAt < CACHE_TTL_MS && cache.devicesById.size > 0) {
    return cache;
  }

  const api = String(cfg.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const bearer = backendBearerForApi(cfg);
  if (!api || !bearer) return cache;

  try {
    const r = await undiciFetch(`${api}/merchants/${encodeURIComponent(merchantId)}/pos-devices`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!r.ok) return cache;
    const j = await r.json().catch(() => null);
    const devices = Array.isArray(j && j.devices) ? j.devices : [];
    const byId = new Map();
    for (const d of devices) {
      const id = String(d.id || '').trim();
      if (!id) continue;
      byId.set(id, {
        serialNo: String(d.serialNo || '').trim(),
        vkn: String(d.vkn || '').trim(),
      });
    }
    cache = { savedAt: now, merchantId, devicesById: byId };
  } catch {
    /* stale cache korunur */
  }
  return cache;
}

/**
 * LAN atamasındaki posDeviceId → backend cihaz kaydı.
 * X-SerialNo / X-SoftwareId alan atamasından değil, yalnızca bu kayıttan gelir.
 */
async function resolveHuginHeadersForPosDevice(posDeviceId, callerHeaders) {
  const id = String(posDeviceId || '').trim();
  const out = { ...(callerHeaders || {}) };
  if (!id) return out;

  const c = await refreshPosDeviceRecordsIfNeeded();
  const dev = c.devicesById.get(id);
  if (!dev) return out;

  const serialNo = String(dev.serialNo || '').trim();
  const softwareId = padSoftwareId10(dev.vkn);
  if (!serialNo || !softwareId) return out;

  const callerSerial = String(out['X-SerialNo'] || '').trim();
  if (callerSerial && callerSerial !== serialNo) {
    appendServiceLog(
      `[hugin-proxy] serial canonicalized pos=${id} caller=${callerSerial} record=${serialNo}`,
    );
  }
  out['X-SerialNo'] = serialNo;
  out['X-SoftwareId'] = softwareId;
  return out;
}

module.exports = {
  invalidatePosDeviceRecordCache,
  refreshPosDeviceRecordsIfNeeded,
  resolveHuginHeadersForPosDevice,
};

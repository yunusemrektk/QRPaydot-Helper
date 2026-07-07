'use strict';

const { fetch: undiciFetch } = require('undici');
const { PORT } = require('../config');
const {
  getAllPosAssignments,
  getBackendConnection,
  getPosDepartmentCache,
  getPosDepartmentCacheEntry,
  setPosDepartmentCache,
} = require('./printerStore');
const { backendBearerForApi, hasBackendCallbackAuth } = require('./backendCallbackAuth');
const { appendServiceLog } = require('./logger');

const SYNC_INTERVAL_MS = 60 * 60 * 1000;
let syncTimer = null;

function padSoftwareId10(raw) {
  const s = String(raw || '').trim();
  if (s.length >= 10) return s.slice(0, 10);
  return s.padEnd(10, '0');
}

function normalizeDepartments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d) => d && d.id != null && Number.isFinite(Number(d.id)))
    .map((d) => {
      const name = d.name != null ? String(d.name).trim().slice(0, 128) : '';
      return {
        id: Number(d.id),
        ...(name ? { name } : {}),
        vatRate: d.vatRate != null && Number.isFinite(Number(d.vatRate)) ? Number(d.vatRate) : 0,
      };
    });
}

function departmentsSnapshotEqual(a, b) {
  const left = normalizeDepartments(a);
  const right = normalizeDepartments(b);
  if (left.length !== right.length) return false;
  const sorted = (rows) => [...rows].sort((x, y) => x.id - y.id);
  const ls = sorted(left);
  const rs = sorted(right);
  for (let i = 0; i < ls.length; i++) {
    if (
      ls[i].id !== rs[i].id ||
      ls[i].vatRate !== rs[i].vatRate ||
      (ls[i].name || '') !== (rs[i].name || '')
    ) {
      return false;
    }
  }
  return true;
}

function parseSavedAtMs(raw) {
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function normalizePosState(stJson) {
  const state =
    stJson && stJson.data && stJson.data.state != null
      ? String(stJson.data.state).trim().toUpperCase()
      : '';
  if (state === 'IDLE') return 'IDLE';
  if (!state && stJson && stJson.status === 'SUCCESS') return 'IDLE';
  return state || 'UNKNOWN';
}

async function fetchSettingsWhenIdle(posDeviceId, softwareId, serialNo) {
  const localBase = `http://127.0.0.1:${PORT}`;
  const q = new URLSearchParams({
    posDeviceId,
    softwareId,
    serialNo,
    vendor: 'hugin',
  });
  const stRes = await undiciFetch(`${localBase}/v1/pos/status?${q.toString()}`, { method: 'GET' });
  const stJson = await stRes.json().catch(() => null);
  if (!stJson || stJson.status !== 'SUCCESS') return null;
  if (normalizePosState(stJson) !== 'IDLE') return null;

  const settingsRes = await undiciFetch(`${localBase}/v1/pos/settings?${q.toString()}`, { method: 'GET' });
  const settingsJson = await settingsRes.json().catch(() => null);
  if (!settingsJson || settingsJson.status !== 'SUCCESS') return null;
  const depts = normalizeDepartments(settingsJson.data && settingsJson.data.departments);
  return depts.length ? depts : null;
}

async function postDepartmentsToBackend(cfg, merchantId, posDeviceId, departments) {
  const api = String(cfg.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const bearer = backendBearerForApi(cfg);
  if (!api || !bearer) return false;
  const url = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-devices/${encodeURIComponent(posDeviceId)}/departments`;
  const r = await undiciFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ departments }),
  });
  return r.ok;
}

/** Yerel cache (+ mümkünse backend) güncelle. */
async function persistDepartmentsSnapshot(cfg, merchantId, posDeviceId, departmentsRaw, logTag) {
  const departments = normalizeDepartments(departmentsRaw);
  if (!departments.length) return false;
  setPosDepartmentCache(posDeviceId, departments);
  if (!cfg || !merchantId) return true;
  try {
    const ok = await postDepartmentsToBackend(cfg, merchantId, posDeviceId, departments);
    if (ok) {
      appendServiceLog(
        `[pos-depts-sync] ${logTag} synced ${departments.length} dept(s) posDeviceId=${posDeviceId}`,
      );
    } else {
      appendServiceLog(
        `[pos-depts-sync] ${logTag} cache ok, backend POST failed posDeviceId=${posDeviceId}`,
      );
    }
  } catch (e) {
    appendServiceLog(
      `[pos-depts-sync] ${logTag} cache ok, backend POST error posDeviceId=${posDeviceId}: ${e.message || e}`,
    );
  }
  return true;
}

/**
 * GET settings yanıtı: cache boşsa veya cihaz departmanları değiştiyse snapshot yaz.
 */
async function maybeRefreshDepartmentsFromSettingsResponse(cfg, posDeviceId, settingsJson, logTag) {
  if (!settingsJson || settingsJson.status !== 'SUCCESS') return false;
  const merchantId = cfg && cfg.merchantId ? String(cfg.merchantId).trim() : '';
  if (!merchantId) return false;
  const depts = settingsJson.data && settingsJson.data.departments;
  const incoming = normalizeDepartments(depts);
  if (!incoming.length) return false;

  const cached = getPosDepartmentCacheEntry(posDeviceId);
  if (cached && departmentsSnapshotEqual(cached.departments, incoming)) {
    return false;
  }

  return persistDepartmentsSnapshot(cfg, merchantId, posDeviceId, depts, logTag || 'settings-response');
}

async function fetchMerchantPosDevices(cfg, merchantId) {
  const api = String(cfg.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const bearer = backendBearerForApi(cfg);
  if (!api || !bearer) return [];
  const url = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-devices`;
  const r = await undiciFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  return Array.isArray(j && j.devices) ? j.devices : [];
}

async function fetchDepartmentsFromBackend(cfg, merchantId, posDeviceId) {
  const api = String(cfg.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const bearer = backendBearerForApi(cfg);
  if (!api || !bearer) return null;
  const url = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-devices/${encodeURIComponent(posDeviceId)}/departments`;
  const r = await undiciFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const depts = normalizeDepartments(j && j.departments);
  if (!depts.length) return null;
  return {
    departments: depts,
    savedAt: j && j.savedAt != null ? String(j.savedAt) : null,
  };
}

/**
 * Tek cihaz: IDLE iken settings oku → yerel cache + backend POST.
 */
async function syncDeviceDepartments(cfg, merchantId, posDeviceId, serialNo, vkn) {
  const serial = String(serialNo || '').trim();
  const softwareId = padSoftwareId10(vkn);
  if (!serial || !softwareId.trim()) return false;

  let departments = null;
  try {
    departments = await fetchSettingsWhenIdle(posDeviceId, softwareId, serial);
  } catch (e) {
    appendServiceLog(`[pos-depts-sync] settings fail posDeviceId=${posDeviceId}: ${e.message || e}`);
    return false;
  }
  if (!departments || !departments.length) {
    appendServiceLog(
      `[pos-depts-sync] periodic skip posDeviceId=${posDeviceId} (not IDLE or empty settings)`,
    );
    return false;
  }

  return persistDepartmentsSnapshot(cfg, merchantId, posDeviceId, departments, 'periodic');
}

async function syncAllAssignedDevices() {
  const cfg = getBackendConnection();
  if (!hasBackendCallbackAuth(cfg)) return;
  const merchantId = String(cfg.merchantId || '').trim();
  if (!merchantId) return;

  const assignments = getAllPosAssignments();
  const deviceIds = Object.keys(assignments).filter((id) => assignments[id] && assignments[id].host);
  if (!deviceIds.length) return;

  let devices = [];
  try {
    devices = await fetchMerchantPosDevices(cfg, merchantId);
  } catch (e) {
    appendServiceLog(`[pos-depts-sync] device list fail: ${e.message || e}`);
    return;
  }

  for (const posDeviceId of deviceIds) {
    const dev = devices.find((d) => String(d.id || '').trim() === posDeviceId);
    if (!dev) continue;
    await syncDeviceDepartments(cfg, merchantId, posDeviceId, dev.serialNo, dev.vkn);
  }
}

/**
 * Ödeme job remap: cache → backend → (opsiyonel) cihazdan oku.
 * Ödeme kritik yolunda `skipDeviceFetch: true` — cihaz status+settings ikinci kez bekletmez;
 * kurulum/periodic sync cache doldurur.
 */
async function ensureDepartmentsForJob(cfg, merchantId, posDeviceId, deviceMeta, opts = {}) {
  const skipDeviceFetch = Boolean(opts && opts.skipDeviceFetch);

  if (cfg && merchantId) {
    try {
      const fromBackend = await fetchDepartmentsFromBackend(cfg, merchantId, posDeviceId);
      if (fromBackend && fromBackend.departments.length) {
        const cached = getPosDepartmentCacheEntry(posDeviceId);
        const backendMs = parseSavedAtMs(fromBackend.savedAt);
        const cacheMs = parseSavedAtMs(cached && cached.savedAt);
        const differs =
          !cached || !departmentsSnapshotEqual(cached.departments, fromBackend.departments);
        if (differs || backendMs > cacheMs) {
          setPosDepartmentCache(posDeviceId, fromBackend.departments);
          if (differs) {
            appendServiceLog(
              `[pos-depts-sync] job backend refresh ${fromBackend.departments.length} dept(s) posDeviceId=${posDeviceId}`,
            );
          }
          return fromBackend.departments;
        }
        return cached.departments;
      }
    } catch (e) {
      appendServiceLog(
        `[pos-depts-sync] job backend fetch fail posDeviceId=${posDeviceId}: ${e.message || e}`,
      );
    }
  }

  const cached = getPosDepartmentCache(posDeviceId);
  if (cached && cached.length) return cached;

  if (skipDeviceFetch) {
    return [];
  }

  const serialNo = deviceMeta && deviceMeta.serialNo != null ? String(deviceMeta.serialNo).trim() : '';
  const vkn = deviceMeta && deviceMeta.vkn != null ? String(deviceMeta.vkn).trim() : '';
  if (!serialNo || !vkn) return [];

  let live = null;
  try {
    live = await fetchSettingsWhenIdle(posDeviceId, padSoftwareId10(vkn), serialNo);
  } catch (e) {
    appendServiceLog(
      `[pos-depts-sync] job refresh settings fail posDeviceId=${posDeviceId}: ${e.message || e}`,
    );
    return [];
  }
  if (!live || !live.length) {
    appendServiceLog(
      `[pos-depts-sync] job refresh skipped posDeviceId=${posDeviceId} (not IDLE or empty settings)`,
    );
    return [];
  }

  await persistDepartmentsSnapshot(cfg, merchantId, posDeviceId, live, 'job-refresh');
  return live;
}

/** @deprecated use ensureDepartmentsForJob */
async function resolveDepartmentsForJob(cfg, merchantId, posDeviceId, deviceMeta) {
  return ensureDepartmentsForJob(cfg, merchantId, posDeviceId, deviceMeta);
}

function schedulePosDepartmentsSync() {
  if (syncTimer) return;
  const tick = () => {
    syncAllAssignedDevices().catch((e) => {
      appendServiceLog(`[pos-depts-sync] periodic fail: ${e.message || e}`);
    });
  };
  setTimeout(tick, 5000);
  syncTimer = setInterval(tick, SYNC_INTERVAL_MS);
}

module.exports = {
  fetchSettingsWhenIdle,
  syncDeviceDepartments,
  syncAllAssignedDevices,
  ensureDepartmentsForJob,
  resolveDepartmentsForJob,
  schedulePosDepartmentsSync,
  normalizeDepartments,
  departmentsSnapshotEqual,
  postDepartmentsToBackend,
  maybeRefreshDepartmentsFromSettingsResponse,
  persistDepartmentsSnapshot,
};

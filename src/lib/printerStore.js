'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getBackendWsApiBaseOverride, getEmbeddedBackendApiBase, isPackagedForDistribution, isLikelyDevLanApiBaseUrl } = require('../config');

const STORE_DIR = path.join(process.env.APPDATA || os.homedir(), 'QRPaydotHelper');
const STORE_FILE = path.join(STORE_DIR, 'printers.json');

function emptyStore() {
  return {
    lastScan: null,
    discovered: [],
    assignments: {},
    posAssignments: {},
    posDepartmentCache: {},
    backendConnection: null,
    printDefaults: { encoding: 'ascii' },
  };
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyStore();
    const printDefaults =
      data.printDefaults &&
      typeof data.printDefaults === 'object' &&
      String(data.printDefaults.encoding || '').trim()
        ? { encoding: String(data.printDefaults.encoding).trim() }
        : { encoding: 'ascii' };
    return {
      lastScan: data.lastScan || null,
      discovered: Array.isArray(data.discovered) ? data.discovered : [],
      assignments: data.assignments && typeof data.assignments === 'object' ? data.assignments : {},
      posAssignments:
        data.posAssignments && typeof data.posAssignments === 'object' ? data.posAssignments : {},
      posDepartmentCache:
        data.posDepartmentCache && typeof data.posDepartmentCache === 'object'
          ? data.posDepartmentCache
          : {},
      backendConnection:
        data.backendConnection && typeof data.backendConnection === 'object'
          ? {
              apiBaseUrl: String(data.backendConnection.apiBaseUrl || '').trim(),
              token: data.backendConnection.token != null ? String(data.backendConnection.token) : '',
              bridgeKey:
                data.backendConnection.bridgeKey != null ? String(data.backendConnection.bridgeKey) : '',
              merchantId: String(data.backendConnection.merchantId || '').trim(),
            }
          : null,
      printDefaults,
    };
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('[qrpaydot-helper] printerStore save failed:', err.message || err);
  }
}

function getDiscovered() {
  return loadStore().discovered;
}

function getLastScan() {
  return loadStore().lastScan;
}

function setDiscovered(list) {
  const store = loadStore();
  store.discovered = Array.isArray(list) ? list : [];
  store.lastScan = new Date().toISOString();
  saveStore(store);
}

function getAssignment(printerId) {
  if (!printerId) return null;
  const ep = loadStore().assignments[String(printerId)];
  if (!ep || !ep.host) return null;
  return { host: ep.host, port: Number(ep.port) > 0 ? ep.port : 9100 };
}

function setAssignment(printerId, endpoint) {
  if (!printerId) return;
  const store = loadStore();
  if (!endpoint || !endpoint.host || !String(endpoint.host).trim()) {
    delete store.assignments[String(printerId)];
  } else {
    store.assignments[String(printerId)] = {
      host: String(endpoint.host).trim(),
      port: Number(endpoint.port) > 0 ? Number(endpoint.port) : 9100,
    };
  }
  saveStore(store);
}

function removeAssignment(printerId) {
  if (!printerId) return;
  const store = loadStore();
  delete store.assignments[String(printerId)];
  saveStore(store);
}

function getAllAssignments() {
  return loadStore().assignments;
}

function getPosAssignment(posDeviceId) {
  if (!posDeviceId) return null;
  const ep = loadStore().posAssignments[String(posDeviceId)];
  if (!ep || !ep.host) return null;
  return {
    host: ep.host,
    port: Number(ep.port) > 0 ? ep.port : 0,
    scheme: ep.scheme === 'https' ? 'https' : 'http',
  };
}

function setPosAssignment(posDeviceId, endpoint) {
  if (!posDeviceId) return;
  const store = loadStore();
  if (!endpoint || !endpoint.host || !String(endpoint.host).trim()) {
    delete store.posAssignments[String(posDeviceId)];
  } else {
    const port = Number(endpoint.port) > 0 ? Number(endpoint.port) : 0;
    const rawScheme = String(endpoint.scheme || '').trim().toLowerCase();
    const scheme = rawScheme === 'https' || port === 4443 ? 'https' : 'http';
    store.posAssignments[String(posDeviceId)] = {
      host: String(endpoint.host).trim(),
      port,
      scheme,
    };
  }
  saveStore(store);
}

function removePosAssignment(posDeviceId) {
  if (!posDeviceId) return;
  const store = loadStore();
  delete store.posAssignments[String(posDeviceId)];
  saveStore(store);
}

function getAllPosAssignments() {
  return loadStore().posAssignments;
}

function getPosDepartmentCache(posDeviceId) {
  if (!posDeviceId) return null;
  const entry = loadStore().posDepartmentCache[String(posDeviceId)];
  if (!entry || !Array.isArray(entry.departments) || entry.departments.length === 0) return null;
  return entry.departments
    .filter((d) => d && d.id != null && Number.isFinite(Number(d.id)))
    .map((d) => ({
      id: Number(d.id),
      vatRate: d.vatRate != null && Number.isFinite(Number(d.vatRate)) ? Number(d.vatRate) : 0,
    }));
}

function setPosDepartmentCache(posDeviceId, departments) {
  if (!posDeviceId || !Array.isArray(departments) || departments.length === 0) return;
  const store = loadStore();
  store.posDepartmentCache[String(posDeviceId)] = {
    savedAt: new Date().toISOString(),
    departments: departments.map((d) => ({
      id: Number(d.id),
      vatRate: d.vatRate != null && Number.isFinite(Number(d.vatRate)) ? Number(d.vatRate) : 0,
    })),
  };
  saveStore(store);
}

function getBackendConnection() {
  const c = loadStore().backendConnection;
  if (!c || !c.merchantId || !c.apiBaseUrl) return null;
  const token = c.token != null ? String(c.token) : '';
  const bridgeKey = c.bridgeKey != null ? String(c.bridgeKey) : '';
  if (!token.trim() && !bridgeKey.trim()) return null;
  const diskApi = String(c.apiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const override = getBackendWsApiBaseOverride();
  const apiBaseUrl = override || diskApi;
  return {
    apiBaseUrl,
    token: token.trim(),
    bridgeKey: bridgeKey.trim(),
    merchantId: c.merchantId,
  };
}

function setBackendConnection(obj) {
  const store = loadStore();
  if (!obj || typeof obj !== 'object') {
    store.backendConnection = null;
  } else {
    const prev =
      store.backendConnection && typeof store.backendConnection === 'object'
        ? store.backendConnection
        : {};
    const merchantId = String(obj.merchantId || '').trim();
    const apiBaseUrl = String(obj.apiBaseUrl || '').trim();
    const incomingToken = obj.token != null ? String(obj.token).trim() : '';
    const incomingBridge = obj.bridgeKey != null ? String(obj.bridgeKey).trim() : '';

    let token = incomingToken;
    let bridgeKey = incomingBridge;

    if (incomingBridge) {
      token = '';
    } else if (incomingToken && !incomingBridge) {
      const sameMerchant =
        prev.merchantId && String(prev.merchantId).trim() === merchantId;
      const prevBridge = prev.bridgeKey != null ? String(prev.bridgeKey).trim() : '';
      if (sameMerchant && prevBridge) {
        bridgeKey = prevBridge;
      } else {
        bridgeKey = '';
      }
    }

    store.backendConnection = {
      apiBaseUrl,
      merchantId,
      token: bridgeKey ? '' : token,
      bridgeKey: bridgeKey || '',
    };
  }
  saveStore(store);
}

function getPrintDefaults() {
  const pd = loadStore().printDefaults;
  if (pd && typeof pd.encoding === 'string' && pd.encoding.trim()) {
    return { encoding: pd.encoding.trim() };
  }
  return { encoding: 'ascii' };
}

/**
 * Paketli prod kurulum: diskte eski LAN/dev `apiBaseUrl` kalmışsa gömülü prod tabana çekilir.
 * JWT/bridgeKey o eski host için üretilmiş olacağından temizlenir; merchantId kalır — mobil/panelden bir kez yeniden kayıt.
 */
function migratePackagedBackendApiBaseIfStale() {
  if (!isPackagedForDistribution()) return { migrated: false };
  const embedded = getEmbeddedBackendApiBase();
  if (!embedded) return { migrated: false };

  const store = loadStore();
  const bc = store.backendConnection;
  if (!bc || typeof bc !== 'object' || !String(bc.merchantId || '').trim()) {
    return { migrated: false };
  }

  const disk = String(bc.apiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!disk) return { migrated: false };
  if (disk === embedded) return { migrated: false };
  if (!isLikelyDevLanApiBaseUrl(disk)) return { migrated: false };

  store.backendConnection = {
    apiBaseUrl: embedded,
    merchantId: String(bc.merchantId || '').trim(),
    token: '',
    bridgeKey: '',
  };
  saveStore(store);
  return { migrated: true, from: disk, to: embedded };
}

/** Eski printers.json dosyasına varsayılan fiş kodlaması yazar (v1.0.1+). */
function ensurePrintDefaults() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;
    if (
      data.printDefaults &&
      typeof data.printDefaults === 'object' &&
      String(data.printDefaults.encoding || '').trim()
    ) {
      return;
    }
    data.printDefaults = { encoding: 'ascii' };
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[qrpaydot-helper] ensurePrintDefaults:', err.message || err);
  }
}

module.exports = {
  loadStore,
  saveStore,
  getDiscovered,
  getLastScan,
  setDiscovered,
  getAssignment,
  setAssignment,
  removeAssignment,
  getAllAssignments,
  getPosAssignment,
  setPosAssignment,
  removePosAssignment,
  getAllPosAssignments,
  getPosDepartmentCache,
  setPosDepartmentCache,
  getBackendConnection,
  setBackendConnection,
  getPrintDefaults,
  ensurePrintDefaults,
  migratePackagedBackendApiBaseIfStale,
};

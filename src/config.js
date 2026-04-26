'use strict';

require('./loadEnv');

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PRINT_BRIDGE_PORT || 17888);
const BIND = process.env.PRINT_BRIDGE_BIND || '127.0.0.1';

function readServiceVersion() {
  try {
    const p = require('../package.json');
    const v = p.version;
    return typeof v === 'string' && v ? v : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

const SERVICE_VERSION = readServiceVersion();
const SERVICE_SLUG = 'qrpaydot-helper';

/**
 * Use require.main (bootstrap.js when packaged) so public/ resolves in pkg snapshot.
 * Falls back to __dirname-relative path when require.main is unavailable (e.g. REPL / -e).
 */
const publicDir = path.join(__dirname, '..', 'public');

const isPkgExe = Boolean(process.pkg);

/** Setup.exe / paketli Electron — `electron .` geliştirme modunda false. */
function isElectronPackagedApp() {
  if (!process.versions?.electron) return false;
  try {
    return require('electron').app?.isPackaged === true;
  } catch {
    return false;
  }
}

function isElectronProcess() {
  return Boolean(process.versions?.electron);
}

function shouldOpenControlPanelInBrowser() {
  if (process.env.PRINT_BRIDGE_OPEN_BROWSER === '1') return true;
  if (process.env.PRINT_BRIDGE_OPEN_BROWSER === '0') return false;
  return false;
}

/**
 * Merchant dashboard URL (panelde "İşletme panelini aç" ve /health.merchantDash).
 *
 * Paketli kurulum ve `npm run desktop`: merchant-dash/.env içindeki VITE_* panel URL’sine
 * düşülmez (aksi halde 192.168…:8080 görünür). Yerel Vite paneli Electron’da lazımsa
 * print-bridge/.env → HELPER_MERCHANT_DASH_FROM_VITE=1
 *
 * Priority:
 *   1. MERCHANT_DASH_URL
 *   2. Paketli (pkg / Setup) veya Electron (desktop) ve HELPER_MERCHANT_DASH_FROM_VITE≠1 → prod
 *   3. Yalnızca `node src/index.js` veya HELPER_MERCHANT_DASH_FROM_VITE=1: VITE_* → LAN :8080
 *
 * MERCHANT_DASH_OPEN=0 otomatik tarayıcı açılışını kapatır.
 */
const MERCHANT_DASH_DEFAULT_PROD = 'https://merchant.qrpaydot.com';
const MERCHANT_DASH_DEV_PORT = 8080;

function trimEnv(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s || s === 'undefined') return '';
  return s;
}

function isPrivateOrLocalHost(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** If VITE_API_BASE_URL points at a local/LAN API, guess dashboard on same host (Vite port). */
function deriveMerchantDashFromApiBase() {
  const raw = trimEnv(process.env.VITE_API_BASE_URL);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!isPrivateOrLocalHost(u.hostname)) return '';
    const port = trimEnv(process.env.VITE_MERCHANT_DASH_PORT) || String(MERCHANT_DASH_DEV_PORT);
    return `${u.protocol}//${u.hostname}:${port}`;
  } catch {
    return '';
  }
}

function getLocalLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name]) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

function isPackagedForDistribution() {
  return isPkgExe || isElectronPackagedApp();
}

function getMerchantDashUrl() {
  const explicit = trimEnv(process.env.MERCHANT_DASH_URL);
  if (explicit) return explicit;

  const viteFromEnv =
    trimEnv(process.env.HELPER_MERCHANT_DASH_FROM_VITE) === '1';

  if (isPackagedForDistribution()) {
    return MERCHANT_DASH_DEFAULT_PROD;
  }

  if (isElectronProcess() && !viteFromEnv) {
    return MERCHANT_DASH_DEFAULT_PROD;
  }

  const viteDash = trimEnv(process.env.VITE_MERCHANT_DASH_URL);
  if (viteDash) return viteDash;
  const fromApi = deriveMerchantDashFromApiBase();
  if (fromApi) return fromApi;
  const port = trimEnv(process.env.VITE_MERCHANT_DASH_PORT) || String(MERCHANT_DASH_DEV_PORT);
  return `http://${getLocalLanIp()}:${port}`;
}

function shouldOpenMerchantDash() {
  if (process.env.MERCHANT_DASH_OPEN === '0') return false;
  return true;
}

module.exports = {
  PORT,
  BIND,
  SERVICE_VERSION,
  SERVICE_SLUG,
  publicDir,
  isPkgExe,
  shouldOpenControlPanelInBrowser,
  getMerchantDashUrl,
  shouldOpenMerchantDash,
};

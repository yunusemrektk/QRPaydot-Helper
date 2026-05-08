'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  PORT, BIND, SERVICE_VERSION, SERVICE_SLUG,
  publicDir, isPkgExe,
  shouldOpenControlPanelInBrowser,
  getMerchantDashUrl, shouldOpenMerchantDash,
} = require('./config');
const { appendServiceLogEarly, appendServiceLog, showPackagedWindowsError } = require('./lib/logger');
const { createApp } = require('./app');
const { runScan } = require('./routes/scan');
const { getBackendConnection, ensurePrintDefaults } = require('./lib/printerStore');
const { startBackendWs } = require('./lib/backendWsClient');

appendServiceLogEarly(`boot isPkgExe=${isPkgExe} argv=${JSON.stringify(process.argv)}`);

/** Open a URL in the default system browser (Windows). */
function openUrlInBrowser(url) {
  if (process.platform !== 'win32') return;
  const rundll = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'rundll32.exe');
  execFile(rundll, ['url.dll,FileProtocolHandler', url], { windowsHide: true }, (err) => {
    if (err) {
      appendServiceLog(`open browser failed (${url}): ${err.message || err}`);
      console.error('[qrpaydot-helper] open browser:', err.message || err);
    }
  });
}

function openControlPanelInBrowser() {
  const host = BIND === '0.0.0.0' ? '127.0.0.1' : BIND;
  openUrlInBrowser(`http://${host}:${PORT}/`);
}

let merchantDashOpened = false;

function openMerchantDash() {
  if (merchantDashOpened) return;
  merchantDashOpened = true;
  const url = getMerchantDashUrl();
  appendServiceLog(`opening merchant dashboard: ${url}`);
  console.log(`[${SERVICE_SLUG}] opening merchant dashboard: ${url}`);
  openUrlInBrowser(url);
}

/* ── Process error handlers ── */
const isElectron = Boolean(process.versions && process.versions.electron);

process.on('uncaughtException', (err) => {
  appendServiceLog(`uncaughtException: ${err && err.stack ? err.stack : err}`);
  if (!isElectron) {
    showPackagedWindowsError('QRPaydot Helper', `Program hatası: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  appendServiceLog(`unhandledRejection: ${reason}`);
});

/* ── Start server ── */

const app = createApp();

const server = app.listen(PORT, BIND, () => {
  const base = `http://${BIND}:${PORT}`;
  const panelIdx = path.join(publicDir, 'panel', 'index.html');
  const panelOk = fs.existsSync(panelIdx);
  appendServiceLog(`listening ${base} publicDir=${publicDir} panelIndex=${panelOk}`);
  ensurePrintDefaults();

  if (BIND === '0.0.0.0' && String(process.env.PRINT_BRIDGE_SILENCE_PUBLIC_BIND_WARNING || '').trim() !== '1') {
    const msg =
      'listening on all interfaces — firewall / trusted network strongly recommended Helper is not a public HTTPS API';
    appendServiceLog(`WARNING: ${msg}`);
    console.warn(`[${SERVICE_SLUG}] SECURITY ${msg}`);
    console.warn(
      `[${SERVICE_SLUG}] Set PRINT_BRIDGE_SILENCE_PUBLIC_BIND_WARNING=1 to suppress; use LAN-only by default (PRINT_BRIDGE_BIND defaults to 127.0.0.1).`,
    );
  }

  console.log(`[${SERVICE_SLUG}] v${SERVICE_VERSION}  ${base}`);
  console.log(`[${SERVICE_SLUG}] panel   ${base}/`);
  console.log(`[${SERVICE_SLUG}] public  ${publicDir} (Vite panel: ${panelOk ? 'ok' : 'run npm run panel:build'})`);
  console.log(`[${SERVICE_SLUG}] health  ${base}/health`);
  if (shouldOpenControlPanelInBrowser()) openControlPanelInBrowser();
  if (shouldOpenMerchantDash()) openMerchantDash();

  const saved = getBackendConnection();
  if (saved) {
    appendServiceLog('[boot] restoring backend WebSocket from disk');
    const apiSh = String(saved.apiBaseUrl || '')
      .trim()
      .replace(/\/+$/, '');
    console.log(
      `[${SERVICE_SLUG}] backend WS  credentials on disk - connecting to ${apiSh || '(no url)'}`,
    );
    startBackendWs(saved);
  } else {
    appendServiceLog(
      '[boot] Backend kimliği yok — sunucuya WebSocket bağlanmadı (uzaktan fiş/POS işi gelmez). Aynı PC’den işletme paneli → Ayarlar > Yazdırma ile oturumu Helper’a yazın.',
    );
    console.warn(
      `[${SERVICE_SLUG}] backend WS  disabled - no saved credentials (open merchant dashboard on this PC: Settings > Printing)`,
    );
  }

  setTimeout(() => {
    appendServiceLog('background printer scan starting');
    runScan()
      .then((r) => {
        appendServiceLog(`background scan done: ${r.printers.length} printer(s) in ${r.elapsed}ms`);
        console.log(`[${SERVICE_SLUG}] background scan: ${r.printers.length} printer(s) found (${r.elapsed}ms)`);
      })
      .catch((err) => {
        appendServiceLog(`background scan failed: ${err.message || err}`);
        console.error(`[${SERVICE_SLUG}] background scan failed:`, err.message || err);
      });
  }, 2000);
});

server.on('error', (err) => {
  appendServiceLog(`listen(): ${err.code || ''} ${err.message || err}`);
  if (!isElectron) {
    showPackagedWindowsError(
      'QRPaydot Helper',
      `Port dinlenemiyor (${PORT}). Başka bir kopya çalışıyor olabilir veya izin gerekir.\n\n${err.message || err}`,
    );
    process.exit(1);
  }
});

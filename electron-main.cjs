'use strict';

require('./src/loadEnv');

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const autoUpdater = require('./src/lib/autoUpdater');

const ROOT = __dirname;
const PORT = Number(process.env.PRINT_BRIDGE_PORT || 17888);
const PANEL_URL = `http://127.0.0.1:${PORT}/`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

function resolveIcon() {
  const candidates = [
    path.join(ROOT, 'installer', 'app-icon.png'),
    path.join(process.resourcesPath || '', 'app-icon.png'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
}

const ICON_PATH = resolveIcon();

let mainWindow = null;
let tray = null;
let isQuitting = false;

/* ── Icon ── */
function loadIcon() {
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    if (!img.isEmpty()) return img;
  } catch {}
  return undefined;
}

/* ── Health poller ── */
function waitForHealth(timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const req = http.get(HEALTH_URL, (res) => {
        if (res.statusCode === 200) { res.resume(); resolve(); }
        else if (Date.now() < deadline) setTimeout(poll, 200);
        else reject(new Error('health timeout'));
      });
      req.on('error', () => {
        if (Date.now() < deadline) setTimeout(poll, 200);
        else reject(new Error('health timeout'));
      });
    };
    poll();
  });
}

/* ── Menü çubuğu: Windows/Linux’ta gizli; macOS’ta yalnızca uygulama menüsü (Cmd+Q vb.) ── */
function setApplicationMenuChromeless() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

/* ── System tray ── */
function createTray() {
  const icon = loadIcon();
  if (!icon) return;

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('QRPaydot Helper — Arka planda çalışıyor');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Helper\'ı aç', click: showWindow },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { isQuitting = true; app.quit(); } },
  ]));

  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** F11: çerçevesiz tam ekran (tarayıcıdaki gibi); tekrar F11 ile çıkış. */
function attachF11FullscreenToggle(browserWindow) {
  if (!browserWindow) return;
  browserWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11') return;
    event.preventDefault();
    if (browserWindow.isDestroyed()) return;
    browserWindow.setFullScreen(!browserWindow.isFullScreen());
  });
}

/* ── Main window ── */
function createWindow() {
  const icon = loadIcon();

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 768,
    minWidth: 920,
    minHeight: 580,
    show: false,
    autoHideMenuBar: true,
    title: 'QRPaydot Helper',
    backgroundColor: '#07080c',
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const revealMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', revealMainWindow);
  mainWindow.webContents.once('did-fail-load', revealMainWindow);

  attachF11FullscreenToggle(mainWindow);

  mainWindow.loadURL(PANEL_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('https://wa.me')) {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }

    if (mainWindow) mainWindow.hide();

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        fullscreen: false,
        show: false,
        autoHideMenuBar: true,
        title: 'İşletme paneli — QRPaydot',
        backgroundColor: '#07080c',
        ...(loadIcon() ? { icon: loadIcon() } : {}),
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });

  mainWindow.webContents.on('did-create-window', (childWindow) => {
    attachF11FullscreenToggle(childWindow);
    childWindow.webContents.once('did-finish-load', () => {
      if (childWindow.isDestroyed()) return;
      childWindow.maximize();
      childWindow.show();
    });
    childWindow.on('closed', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ── Boot the Express server in-process ── */
function startServer() {
  process.env.PRINT_BRIDGE_OPEN_BROWSER = '0';
  process.env.MERCHANT_DASH_OPEN = '0';

  try {
    require('./src/index.js');
  } catch (err) {
    console.error('[qrpaydot-helper-desktop] server load failed:', err);
    dialog.showErrorBox(
      'QRPaydot Helper — Sunucu hatası',
      `Sunucu başlatılamadı:\n\n${err.message || err}`,
    );
  }
}

/* ── App lifecycle ── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setName('QRPaydot Helper');

  app.whenReady().then(async () => {
    setApplicationMenuChromeless();
    createTray();
    startServer();
    autoUpdater.init();

    try {
      await waitForHealth(35000);
      createWindow();
    } catch (err) {
      console.error('[qrpaydot-helper-desktop]', err.message);
      dialog.showErrorBox(
        'QRPaydot Helper',
        `Sunucu yanıt vermiyor. Port ${PORT} meşgul olabilir.\n\n${err.message}`,
      );
    }
  });

  app.on('window-all-closed', () => {
    // Don't quit — keep running in tray
  });

  app.on('before-quit', () => {
    isQuitting = true;
    autoUpdater.destroy();
    if (tray) { tray.destroy(); tray = null; }
  });
}

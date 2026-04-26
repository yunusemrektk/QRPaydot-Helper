'use strict';

/**
 * Electron auto-updater wrapper — silent mode.
 *
 * Uses electron-updater (backed by GitHub Releases).
 * - Checks on launch, then every CHECK_INTERVAL_MS.
 * - Downloads in background, installs silently on next app quit.
 * - No user dialog — update happens transparently.
 * - Exposes state so the Express API + panel can show progress.
 * - Writes a "just-updated" flag before restart so the panel can
 *   show a welcome modal on next launch.
 *
 * Only initialises inside a packaged Electron app.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute (test mode)
const JUST_UPDATED_PATH = path.join(os.tmpdir(), 'qrpaydot-helper-just-updated.json');

const state = {
  /** @type {'idle'|'checking'|'available'|'downloading'|'downloaded'|'error'} */
  status: 'idle',
  /** @type {string|null} */
  currentVersion: null,
  /** @type {string|null} */
  availableVersion: null,
  /** @type {number} download progress 0-100 */
  progress: 0,
  /** @type {string|null} */
  error: null,
};

/** @type {import('electron-updater').AppUpdater|null} */
let updater = null;
let intervalId = null;

function getState() {
  return { ...state };
}

function init() {
  if (updater) return;

  let isPackaged = false;
  try {
    isPackaged = require('electron').app?.isPackaged === true;
  } catch {
    return;
  }
  if (!isPackaged) {
    console.log('[auto-updater] dev mode — skipping auto-update init');
    return;
  }

  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;

  state.currentVersion = updater.currentVersion?.version ?? null;

  updater.on('checking-for-update', () => {
    state.status = 'checking';
    state.error = null;
    console.log('[auto-updater] checking for updates…');
  });

  updater.on('update-available', (info) => {
    state.status = 'available';
    state.availableVersion = info?.version ?? null;
    console.log('[auto-updater] update available:', info?.version);
  });

  updater.on('update-not-available', (info) => {
    state.status = 'idle';
    state.availableVersion = null;
    console.log('[auto-updater] up to date:', info?.version);
  });

  updater.on('download-progress', (prog) => {
    state.status = 'downloading';
    state.progress = Math.round(prog?.percent ?? 0);
  });

  updater.on('update-downloaded', (info) => {
    state.status = 'downloaded';
    state.availableVersion = info?.version ?? state.availableVersion;
    state.progress = 100;
    console.log('[auto-updater] downloaded:', info?.version, '— silent restart');
    try {
      fs.writeFileSync(JUST_UPDATED_PATH, JSON.stringify({
        from: state.currentVersion,
        to: info?.version ?? state.availableVersion,
        ts: new Date().toISOString(),
      }));
    } catch (e) {
      console.error('[auto-updater] could not write just-updated flag:', e?.message);
    }
    setTimeout(() => {
      updater.quitAndInstall(true, true);
    }, 1500);
  });

  updater.on('error', (err) => {
    state.status = 'error';
    state.error = err?.message ?? String(err);
    console.error('[auto-updater]', err);
  });

  console.log('[auto-updater] initialised — checking on launch');
  updater.checkForUpdates().catch((e) => {
    console.error('[auto-updater] initial check failed:', e?.message);
  });

  intervalId = setInterval(() => {
    updater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL_MS);
}

function checkNow() {
  if (!updater) {
    return Promise.resolve({ supported: false, reason: 'not-packaged' });
  }
  return updater
    .checkForUpdates()
    .then((result) => ({
      supported: true,
      updateAvailable: result?.updateInfo?.version !== state.currentVersion,
      version: result?.updateInfo?.version ?? null,
    }))
    .catch((err) => ({
      supported: true,
      error: err?.message ?? String(err),
    }));
}

function quitAndInstall() {
  if (!updater) return false;
  if (state.status !== 'downloaded') return false;
  updater.quitAndInstall(true, true);
  return true;
}

function destroy() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * If the app just restarted after an update, returns { from, to, ts }.
 * Clears the flag so it only fires once.
 */
function consumeJustUpdated() {
  try {
    if (!fs.existsSync(JUST_UPDATED_PATH)) return null;
    const raw = fs.readFileSync(JUST_UPDATED_PATH, 'utf-8');
    fs.unlinkSync(JUST_UPDATED_PATH);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = { init, getState, checkNow, quitAndInstall, destroy, consumeJustUpdated };

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { LOG_DIR, LOGS_SUBDIR, dailyServiceLogPath, legacyFlatServiceLogPath, listServiceLogsIndex } = require('./logger');

const DATA_DIR = LOG_DIR;

function printersJsonPath() {
  return path.join(DATA_DIR, 'printers.json');
}

function posOperationsJsonPath() {
  return path.join(DATA_DIR, 'pos-operations.json');
}

function pathExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function statSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function resolveLogFileForDate(date) {
  const idx = listServiceLogsIndex();
  const meta = idx.files[date];
  if (meta?.path) return meta.path;
  return dailyServiceLogPath(date);
}

/** @returns {Array<{ id: string; label: string; path: string; exists: boolean; size?: number|null; category: string }>} */
function listHelperDataPaths(options = {}) {
  const date = options.date || null;
  const items = [
    {
      id: 'dataDir',
      label: 'Veri klasörü',
      path: DATA_DIR,
      exists: pathExists(DATA_DIR),
      category: 'data',
    },
    {
      id: 'logsDir',
      label: 'Günlük klasörü',
      path: LOGS_SUBDIR,
      exists: pathExists(LOGS_SUBDIR),
      category: 'logs',
    },
    {
      id: 'printersJson',
      label: 'printers.json (yazıcı + kimlik)',
      path: printersJsonPath(),
      exists: pathExists(printersJsonPath()),
      size: statSize(printersJsonPath()),
      category: 'data',
    },
    {
      id: 'posOperationsJson',
      label: 'pos-operations.json (POS kuyruk)',
      path: posOperationsJsonPath(),
      exists: pathExists(posOperationsJsonPath()),
      size: statSize(posOperationsJsonPath()),
      category: 'data',
    },
  ];

  const legacy = legacyFlatServiceLogPath();
  if (pathExists(legacy)) {
    items.push({
      id: 'legacyServiceLog',
      label: 'service.log (eski tek dosya)',
      path: legacy,
      exists: true,
      size: statSize(legacy),
      category: 'logs',
    });
  }

  if (date) {
    const logPath = resolveLogFileForDate(date);
    items.push({
      id: 'logFile',
      label: `Günlük dosyası (${date})`,
      path: logPath,
      exists: pathExists(logPath),
      size: statSize(logPath),
      category: 'logs',
    });
  }

  return items;
}

function normalizeForCompare(p) {
  return path.resolve(String(p || '')).toLowerCase();
}

function isPathUnderRoot(targetPath, rootDir) {
  const root = normalizeForCompare(rootDir);
  const target = normalizeForCompare(targetPath);
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}

function resolveOpenTarget(body = {}) {
  const id = String(body.id || '').trim();
  const date = String(body.date || '').trim();
  const items = listHelperDataPaths(date || undefined);
  const known = items.find((x) => x.id === id);
  if (known) return known.path;

  const raw = String(body.path || '').trim();
  if (raw && isPathUnderRoot(raw, DATA_DIR)) {
    return path.resolve(raw);
  }

  return null;
}

function ensureDirForOpen(targetPath, selectFile) {
  if (selectFile) {
    if (pathExists(targetPath)) return targetPath;
    const parent = path.dirname(targetPath);
    try {
      fs.mkdirSync(parent, { recursive: true });
    } catch {
      /* ignore */
    }
    return parent;
  }
  try {
    fs.mkdirSync(targetPath, { recursive: true });
  } catch {
    /* ignore */
  }
  return targetPath;
}

function tryElectronShell() {
  try {
    if (!process.versions?.electron) return null;
    const { shell } = require('electron');
    return shell;
  } catch {
    return null;
  }
}

async function revealInExplorer(targetPath, options = {}) {
  let selectFile = Boolean(options.selectFile);
  let resolved = path.resolve(String(targetPath || ''));
  if (!isPathUnderRoot(resolved, DATA_DIR)) {
    return { ok: false, error: 'path_not_allowed' };
  }

  if (selectFile && !pathExists(resolved)) {
    selectFile = false;
    resolved = path.dirname(resolved);
  }
  resolved = ensureDirForOpen(resolved, selectFile);

  const shell = tryElectronShell();
  if (shell) {
    try {
      if (selectFile && pathExists(resolved)) {
        shell.showItemInFolder(resolved);
        return { ok: true, path: resolved };
      }
      const errMsg = await shell.openPath(resolved);
      if (errMsg) return { ok: false, error: errMsg };
      return { ok: true, path: resolved };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  if (process.platform === 'win32') {
    const { spawn } = require('child_process');
    const windir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const explorer = path.join(windir, 'explorer.exe');
    const args =
      selectFile && pathExists(resolved)
        ? [`/select,${resolved}`]
        : [selectFile ? path.dirname(resolved) : resolved];
    return new Promise((resolve) => {
      try {
        const child = spawn(explorer, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', (err) => resolve({ ok: false, error: err.message || String(err) }));
        child.unref();
        // explorer.exe often exits with code 1 even when the folder opened successfully
        resolve({ ok: true, path: resolved });
      } catch (err) {
        resolve({ ok: false, error: err.message || String(err) });
      }
    });
  }

  if (process.platform === 'darwin') {
    const args = selectFile && pathExists(resolved) ? ['-R', resolved] : [resolved];
    return new Promise((resolve) => {
      execFile('open', args, (err) => {
        if (err) resolve({ ok: false, error: err.message || String(err) });
        else resolve({ ok: true, path: resolved });
      });
    });
  }

  return { ok: false, error: 'unsupported_platform' };
}

module.exports = {
  DATA_DIR,
  LOGS_SUBDIR,
  listHelperDataPaths,
  resolveLogFileForDate,
  resolveOpenTarget,
  revealInExplorer,
};

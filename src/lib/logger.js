'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { isPkgExe } = require('../config');

const LOG_DIR = path.join(process.env.APPDATA || os.homedir(), 'QRPaydotHelper');
const LOGS_SUBDIR = path.join(LOG_DIR, 'logs');
const LOG_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 45 * 60 * 1000;

const PID = process.pid;
let lastPruneAt = 0;
let legacyMigrateAttempted = false;

function formatLocalYmd(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dailyServiceLogPath(forDate) {
  const ymd = typeof forDate === 'string' ? forDate : formatLocalYmd(forDate);
  return path.join(LOGS_SUBDIR, `service-${ymd}.log`);
}

/** @deprecated Eski tek dosya yolu; okuma uyumluluğu için. */
function legacyFlatServiceLogPath() {
  return path.join(LOG_DIR, 'service.log');
}

function serviceLogFile() {
  return dailyServiceLogPath(new Date());
}

function migrateLegacyServiceLogIfNeeded() {
  if (legacyMigrateAttempted) return;
  legacyMigrateAttempted = true;
  const legacy = legacyFlatServiceLogPath();
  try {
    if (!fs.existsSync(legacy)) return;
    fs.mkdirSync(LOGS_SUBDIR, { recursive: true });
    const st = fs.statSync(legacy);
    const ymd = formatLocalYmd(new Date(st.mtimeMs));
    let dest = path.join(LOGS_SUBDIR, `service-${ymd}-legacy.log`);
    let n = 0;
    while (fs.existsSync(dest)) {
      n += 1;
      dest = path.join(LOGS_SUBDIR, `service-${ymd}-legacy-${n}.log`);
    }
    fs.renameSync(legacy, dest);
  } catch {
    /* ignore */
  }
}

function maybePruneOldLogs() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    pruneServiceLogsOlderThan(LOG_RETENTION_DAYS);
  } catch {
    /* ignore */
  }
}

/**
 * Yerel takvim gününde `maxDays` gün (bugün dahil) tutulur; daha eski günlük dosyaları siler.
 */
function pruneServiceLogsOlderThan(maxDays = LOG_RETENTION_DAYS) {
  if (!fs.existsSync(LOGS_SUBDIR)) return;
  const keepFrom = new Date();
  keepFrom.setHours(0, 0, 0, 0);
  keepFrom.setDate(keepFrom.getDate() - (maxDays - 1));
  const re = /^service-(\d{4})-(\d{2})-(\d{2})(?:-legacy(?:-\d+)?)?\.log$/;
  const names = fs.readdirSync(LOGS_SUBDIR);
  for (const name of names) {
    const m = name.match(re);
    if (!m) continue;
    const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    fileDay.setHours(0, 0, 0, 0);
    if (fileDay < keepFrom) {
      try {
        fs.unlinkSync(path.join(LOGS_SUBDIR, name));
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Son `maxDays` gün için yerel takvim günü listesi (bugün dahil, esiden yeniye).
 */
function listServiceLogDayKeys(maxDays = LOG_RETENTION_DAYS) {
  const out = [];
  for (let i = maxDays - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push(formatLocalYmd(d));
  }
  return out;
}

/**
 * @returns {{ dates: string[], files: Record<string, { path: string; size: number } | null>, retentionDays: number }}
 */
function listServiceLogsIndex() {
  const retentionDays = LOG_RETENTION_DAYS;
  const dates = listServiceLogDayKeys(retentionDays);
  const files = {};
  for (const ymd of dates) {
    const p = dailyServiceLogPath(ymd);
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        files[ymd] = { path: p, size: st.size, legacy: false };
      } else {
        files[ymd] = null;
      }
    } catch {
      files[ymd] = null;
    }
  }
  try {
    if (fs.existsSync(LOGS_SUBDIR)) {
      const extra = fs.readdirSync(LOGS_SUBDIR);
      const re = /^service-(\d{4}-\d{2}-\d{2})-legacy(?:-\d+)?\.log$/;
      const dateSet = new Set(dates);
      for (const name of extra) {
        const m = name.match(re);
        if (!m) continue;
        const ymd = m[1];
        if (!dateSet.has(ymd)) continue;
        if (files[ymd]) continue;
        const p = path.join(LOGS_SUBDIR, name);
        try {
          const st = fs.statSync(p);
          files[ymd] = { path: p, size: st.size, legacy: true };
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { dates, files, retentionDays };
}

function appendLineToFile(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stamp = new Date().toISOString();
  fs.appendFileSync(filePath, `[${stamp}] [pid:${PID}] ${line}\n`, 'utf8');
}

function appendServiceLogEarly(line) {
  try {
    migrateLegacyServiceLogIfNeeded();
    appendLineToFile(dailyServiceLogPath(new Date()), line);
    maybePruneOldLogs();
  } catch {
    /* ignore */
  }
}

function appendServiceLog(line) {
  try {
    migrateLegacyServiceLogIfNeeded();
    appendLineToFile(dailyServiceLogPath(new Date()), line);
    maybePruneOldLogs();
  } catch {
    /* ignore */
  }
}

function parseYmdOrToday(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return formatLocalYmd(new Date());
}

/**
 * @param {{ maxBytes?: number; maxLines?: number; date?: string }} [options]
 * @returns {{ lines: string[]; truncated: boolean; fileExists: boolean; date: string; pathUsed?: string }}
 */
function readServiceLogTail(options = {}) {
  const maxBytes = Math.min(Math.max(Number(options.maxBytes) || 120_000, 1024), 500_000);
  const maxLines = Math.min(Math.max(Number(options.maxLines) || 500, 10), 5000);
  const date = parseYmdOrToday(options.date);

  const candidates = [];
  const primary = dailyServiceLogPath(date);
  candidates.push(primary);
  try {
    if (fs.existsSync(LOGS_SUBDIR)) {
      const extra = fs.readdirSync(LOGS_SUBDIR);
      const legacyRe = new RegExp(`^service-${date.replace(/-/g, '\\-')}-legacy(?:-\\d+)?\\.log$`);
      for (const name of extra) {
        if (legacyRe.test(name)) {
          candidates.push(path.join(LOGS_SUBDIR, name));
        }
      }
    }
  } catch {
    /* ignore */
  }

  const legacyFlat = legacyFlatServiceLogPath();
  if (date === formatLocalYmd(new Date()) && fs.existsSync(legacyFlat)) {
    candidates.push(legacyFlat);
  }

  let p = candidates.find((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  });

  if (!p) {
    return { lines: [], truncated: false, fileExists: false, date };
  }

  try {
    const stat = fs.statSync(p);
    if (!stat.size) {
      return { lines: [], truncated: false, fileExists: true, date, pathUsed: p };
    }
    const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
    const toRead = stat.size - start;
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, start);
      const text = buf.toString('utf8');
      let allLines = text.split(/\r?\n/);
      if (start > 0 && allLines.length) {
        allLines[0] = `… ${allLines[0]}`;
      }
      let truncated = start > 0;
      if (allLines.length > maxLines) {
        allLines = allLines.slice(-maxLines);
        truncated = true;
      }
      while (allLines.length && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }
      return { lines: allLines, truncated, fileExists: true, date, pathUsed: p };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], truncated: false, fileExists: false, date };
  }
}

function showPackagedWindowsError(title, message) {
  if (!isPkgExe || process.platform !== 'win32') return;
  const esc = (s) =>
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "''")
      .replace(/\r?\n/g, ' ');
  execFile(
    path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-STA',
      '-WindowStyle',
      'Hidden',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${esc(message)}','${esc(title)}','OK','Error')`,
    ],
    { windowsHide: true },
    () => {},
  );
}

module.exports = {
  LOG_DIR,
  LOGS_SUBDIR,
  LOG_RETENTION_DAYS,
  serviceLogFile,
  legacyFlatServiceLogPath,
  dailyServiceLogPath,
  appendServiceLogEarly,
  appendServiceLog,
  readServiceLogTail,
  listServiceLogsIndex,
  pruneServiceLogsOlderThan,
  showPackagedWindowsError,
};

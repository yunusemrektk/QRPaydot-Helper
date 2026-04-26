'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { isPkgExe } = require('../config');

const LOG_DIR = path.join(process.env.APPDATA || os.homedir(), 'QRPaydotHelper');

function serviceLogFile() {
  return path.join(LOG_DIR, 'service.log');
}

function appendServiceLogEarly(line) {
  try {
    const p = path.join(LOG_DIR, 'service.log');
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function appendServiceLog(line) {
  try {
    const p = serviceLogFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* ignore */
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
  serviceLogFile,
  appendServiceLogEarly,
  appendServiceLog,
  showPackagedWindowsError,
};

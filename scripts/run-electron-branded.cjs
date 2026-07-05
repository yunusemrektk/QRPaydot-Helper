'use strict';

/**
 * Geliştirmede `electron .` yerine markalı kopya çalıştırır.
 * Görev Yöneticisi / görev çubuğu "Electron" yerine "QRPaydot Helper" gösterir.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { applyExeBranding, APP_NAME } = require('./embedExeBranding.cjs');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const cacheDir = path.join(root, '.cache', 'qrpaydot-helper');
const brandedExe = path.join(cacheDir, `${APP_NAME}.exe`);
const stampFile = path.join(cacheDir, '.branding-stamp');

function electronVersion() {
  return require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
}

function needsRefresh() {
  if (!fs.existsSync(brandedExe)) return true;
  try {
    const stamp = fs.readFileSync(stampFile, 'utf8').trim();
    return stamp !== `${electronVersion()}:${fs.statSync(electronBin).mtimeMs}`;
  } catch {
    return true;
  }
}

function ensureBrandedExe() {
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!needsRefresh()) return brandedExe;

  fs.copyFileSync(electronBin, brandedExe);
  applyExeBranding(brandedExe, root);
  fs.writeFileSync(stampFile, `${electronVersion()}:${fs.statSync(electronBin).mtimeMs}`, 'utf8');
  console.log(`[run-electron-branded] ${brandedExe}`);
  return brandedExe;
}

const exe = process.platform === 'win32' ? ensureBrandedExe() : electronBin;
const child = spawn(exe, ['.'], { cwd: root, stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

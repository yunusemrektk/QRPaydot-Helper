'use strict';

/**
 * Geliştirmede `electron .` yerine markalı kopya çalıştırır.
 * Görev Yöneticisi / görev çubuğu "Electron" yerine "QRPaydot Helper" gösterir.
 *
 * Yalnızca electron.exe kopyalamak yetmez — ffmpeg.dll vb. aynı klasörde olmalı.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { applyExeBranding, APP_NAME } = require('./embedExeBranding.cjs');

const root = path.join(__dirname, '..');
const electronDistSrc = path.join(root, 'node_modules', 'electron', 'dist');
const cacheRoot = path.join(root, '.cache', 'qrpaydot-helper');
const cacheDist = path.join(cacheRoot, 'dist');
const brandedExeName = `${APP_NAME}.exe`;
const brandedExe = path.join(cacheDist, brandedExeName);
const stampFile = path.join(cacheRoot, '.branding-stamp');

function electronVersion() {
  return require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
}

function sourceStamp() {
  const srcExe = path.join(electronDistSrc, 'electron.exe');
  return `${electronVersion()}:${fs.statSync(srcExe).mtimeMs}`;
}

function needsRefresh() {
  if (!fs.existsSync(brandedExe)) return true;
  try {
    return fs.readFileSync(stampFile, 'utf8').trim() !== sourceStamp();
  } catch {
    return true;
  }
}

function ensureBrandedExe() {
  if (!needsRefresh()) return brandedExe;

  fs.rmSync(cacheRoot, { recursive: true, force: true });
  fs.cpSync(electronDistSrc, cacheDist, { recursive: true });

  const originalExe = path.join(cacheDist, 'electron.exe');
  if (fs.existsSync(originalExe)) {
    fs.renameSync(originalExe, brandedExe);
  }

  applyExeBranding(brandedExe, root);
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(stampFile, sourceStamp(), 'utf8');
  console.log(`[run-electron-branded] ${brandedExe}`);
  return brandedExe;
}

const exe = process.platform === 'win32' ? ensureBrandedExe() : require('electron');
const child = spawn(exe, ['.'], { cwd: root, stdio: 'inherit', env: process.env });
child.on('error', (err) => {
  console.error('[run-electron-branded] failed to start:', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

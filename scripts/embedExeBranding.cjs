'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'QRPaydot Helper';
const COMPANY = 'QRPaydot';

function readAppVersion(projectRoot) {
  try {
    const v = require(path.join(projectRoot, 'package.json')).version;
    return typeof v === 'string' && v ? v : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function resolveRcedit(projectRoot) {
  const p = path.join(projectRoot, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  return fs.existsSync(p) ? p : null;
}

function resolveIco(projectRoot) {
  return path.join(projectRoot, 'installer', 'QRPaydotHelper.ico');
}

/** Windows .exe: ikon + sürüm metinleri (Görev Yöneticisi, özellikler, bildirimler). */
function applyExeBranding(exePath, projectRoot) {
  if (process.platform !== 'win32') return false;
  const rcedit = resolveRcedit(projectRoot);
  if (!fs.existsSync(exePath) || !rcedit) {
    console.warn('[embedExeBranding] skip — missing exe or rcedit');
    return false;
  }

  const ico = resolveIco(projectRoot);
  const version = readAppVersion(projectRoot);
  const args = [exePath];

  if (fs.existsSync(ico)) {
    args.push('--set-icon', ico);
  }

  const strings = [
    ['FileDescription', APP_NAME],
    ['ProductName', APP_NAME],
    ['InternalName', 'QRPaydotHelper'],
    ['OriginalFilename', `${APP_NAME}.exe`],
    ['CompanyName', COMPANY],
    ['LegalCopyright', `Copyright © ${new Date().getFullYear()} ${COMPANY}`],
  ];
  for (const [key, value] of strings) {
    args.push('--set-version-string', key, value);
  }
  args.push('--set-product-version', version, '--set-file-version', version);

  execFileSync(rcedit, args, { stdio: 'inherit' });
  return true;
}

module.exports = { APP_NAME, applyExeBranding, resolveRcedit };

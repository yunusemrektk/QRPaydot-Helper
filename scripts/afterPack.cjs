'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  const exe = path.join(context.appOutDir, 'QRPaydot Helper.exe');
  const ico = path.join(context.packager.projectDir, 'installer', 'QRPaydotHelper.ico');
  const rcedit = path.join(context.packager.projectDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');

  if (!fs.existsSync(exe) || !fs.existsSync(ico) || !fs.existsSync(rcedit)) {
    console.log('afterPack: skipping icon patch (missing files)');
    return;
  }

  execFileSync(rcedit, [exe, '--set-icon', ico], { stdio: 'inherit' });
  console.log('afterPack: icon embedded into', exe);
};

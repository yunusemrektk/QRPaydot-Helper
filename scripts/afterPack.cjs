'use strict';

const path = require('path');
const fs = require('fs');
const { applyExeBranding } = require('./embedExeBranding.cjs');

module.exports = async function afterPack(context) {
  const exe = path.join(context.appOutDir, 'QRPaydot Helper.exe');
  if (!fs.existsSync(exe)) {
    console.log('afterPack: skip — exe not found at', exe);
    return;
  }
  if (applyExeBranding(exe, context.packager.projectDir)) {
    console.log('afterPack: branding applied to', exe);
  }
};

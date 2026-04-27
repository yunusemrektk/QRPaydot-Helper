'use strict';

/**
 * Load .env files: merchant-dash sibling → print-bridge local → %APPDATA%\QRPaydotHelper\.env.
 * Paketli Setup’ta repo yok; son kullanıcı isteğe bağlı ortam değişkenleri için AppData yolu.
 */
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');

const srcDir = __dirname;
const printBridgeRoot = path.join(srcDir, '..');
const parentDir = path.join(printBridgeRoot, '..');
const merchantDashRoot = path.join(parentDir, 'merchant-dash');
const appDataHelperEnv = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'QRPaydotHelper',
  '.env',
);

dotenv.config({ path: path.join(merchantDashRoot, '.env'), override: false });
dotenv.config({ path: path.join(printBridgeRoot, '.env'), override: true });
dotenv.config({ path: appDataHelperEnv, override: true });

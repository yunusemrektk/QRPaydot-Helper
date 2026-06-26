'use strict';

/**
 * Load .env: merchant-dash sibling (monorepo) → print-bridge kök (.env) → .env.local (kişisel LAN override).
 * Üretim müşteri PC’de repo yok; API tabanı kurulumda gömülü `embedBackendApi.cjs` + işletme panelinden kayıt.
 */
const path = require('path');
const dotenv = require('dotenv');

const srcDir = __dirname;
const printBridgeRoot = path.join(srcDir, '..');
const parentDir = path.join(printBridgeRoot, '..');
const merchantDashRoot = path.join(parentDir, 'merchant-dash');

dotenv.config({ path: path.join(merchantDashRoot, '.env'), override: false });
dotenv.config({ path: path.join(printBridgeRoot, '.env'), override: true });
dotenv.config({ path: path.join(printBridgeRoot, '.env.local'), override: true });

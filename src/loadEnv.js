'use strict';

/**
 * Load the same .env files merchant-dash uses (Vite reads repo-root .env).
 * Order: merchant-dash root → print-bridge/local (local overrides).
 */
const path = require('path');
const dotenv = require('dotenv');

const srcDir = __dirname;
const printBridgeRoot = path.join(srcDir, '..');
const merchantDashRoot = path.join(printBridgeRoot, '..');

dotenv.config({ path: path.join(merchantDashRoot, '.env'), override: false });
dotenv.config({ path: path.join(printBridgeRoot, '.env'), override: true });

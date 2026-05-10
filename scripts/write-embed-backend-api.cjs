'use strict';

/**
 * PRINT_BRIDGE_BUILD_PROFILE=production → src/generated/embedBackendApi.cjs (installer’a girer).
 * Geliştirmede dosya boş kalır; çalışırken print-bridge/.env içindeki VITE_PRINT_BRIDGE_API_BASE_URL kullanılabilir.
 *
 * Üretim’de gömülecek URL:
 *   1) PRINT_BRIDGE_PROD_API_BASE_URL
 *   2) VITE_PRINT_BRIDGE_API_BASE_URL (localhost / LAN değilse; aksi halde yanlışlıkla Setup’a LAN yazılmasın)
 *   3) https://api.qrpaydot.com/api
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'src', 'generated');
const outFile = path.join(outDir, 'embedBackendApi.cjs');

dotenv.config({ path: path.join(root, '.env') });

function trim(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s && s !== 'undefined' ? s : '';
}

/** Publish embed’e LAN/localhost yazılmasın (günlük .env’de 192.168 kalabilir). */
function isLocalOrPrivateApiUrl(raw) {
  if (!raw) return true;
  try {
    const u = new URL(raw);
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h);
  } catch {
    return true;
  }
}

const profile = trim(process.env.PRINT_BRIDGE_BUILD_PROFILE) || 'development';
const isProd = profile === 'production';

const defaultProd = 'https://api.qrpaydot.com/api';
let fromEnv = trim(process.env.PRINT_BRIDGE_PROD_API_BASE_URL);
const viteUrl = trim(process.env.VITE_PRINT_BRIDGE_API_BASE_URL);
if (isProd && !fromEnv && viteUrl && !isLocalOrPrivateApiUrl(viteUrl)) {
  fromEnv = viteUrl;
}
const embedded = isProd ? (fromEnv || defaultProd).replace(/\/+$/, '') : '';

const body = `'use strict';
/* Otomatik üretildi — ${isProd ? 'production' : 'development'} (${new Date().toISOString()}) */
module.exports = {
  EMBEDDED_BACKEND_API_BASE: ${JSON.stringify(embedded)},
};
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, body, 'utf8');
console.log(`[embed-backend-api] profile=${profile} embedded=${embedded || '(none)'}`);

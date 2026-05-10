'use strict';

/**
 * İstemci `getServicePin()` ile eşleşmeli: önce `PRINT_BRIDGE_SERVICE_PIN`,
 * yoksa yüklenen `.env` içindeki `VITE_SERVICE_PIN` (merchant-dash ile ortak),
 * son çare geliştirme varsayılanı `424242`.
 */
function getExpectedServicePin() {
  const fromEnv =
    process.env.PRINT_BRIDGE_SERVICE_PIN ||
    process.env.VITE_SERVICE_PIN;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  return '424242';
}

function requireServicePin(req, res, next) {
  const expected = getExpectedServicePin();
  const header = String(req.get('X-QRPaydot-Service-Pin') || '').trim();
  if (header !== expected) {
    return res.status(401).json({ error: 'invalid_service_pin', ok: false });
  }
  next();
}

module.exports = { requireServicePin, getExpectedServicePin };

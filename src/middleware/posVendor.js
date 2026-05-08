'use strict';

const SUPPORTED = new Set(['hugin']);

/**
 * `/v1/pos` altında: `?vendor=hugin` (varsayılan hugin). Bilinmeyen vendor → 501.
 * Legacy `/v1/hugin` mount'unda bu middleware kullanılmaz; vendor daima Hugin kabul edilir.
 */
function posVendorMiddleware(req, res, next) {
  const raw = String(req.query.vendor ?? 'hugin').trim().toLowerCase();
  if (!SUPPORTED.has(raw)) {
    return res.status(501).json({
      status: 'ERROR',
      error: {
        title: 'Unsupported POS vendor',
        description: raw || 'vendor query required',
      },
    });
  }
  req.posVendor = raw;
  next();
}

module.exports = posVendorMiddleware;

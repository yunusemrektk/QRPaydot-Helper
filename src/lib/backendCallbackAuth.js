'use strict';

/**
 * Helper → cloud POST /complete çağrıları: JWT veya köprü anahtarı (Authorization Bearer).
 */
function backendBearerForApi(cfg) {
  if (!cfg) return '';
  const t = cfg.token != null ? String(cfg.token).trim() : '';
  if (t) return t;
  const k = cfg.bridgeKey != null ? String(cfg.bridgeKey).trim() : '';
  return k || '';
}

function hasBackendCallbackAuth(cfg) {
  if (!cfg || !String(cfg.apiBaseUrl || '').trim()) return false;
  return Boolean(backendBearerForApi(cfg));
}

module.exports = { backendBearerForApi, hasBackendCallbackAuth };

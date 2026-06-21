'use strict';

const { fetch: undiciFetch } = require('undici');
const { getBackendConnection } = require('./printerStore');
const { backendBearerForApi, hasBackendCallbackAuth } = require('./backendCallbackAuth');
const { appendServiceLog } = require('./logger');

function apiBase(cfg) {
  return String(cfg.apiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
}

async function registerFiscalPending(merchantId, body) {
  const cfg = getBackendConnection();
  if (!cfg || !hasBackendCallbackAuth(cfg)) {
    appendServiceLog('[pos-op] fiscal-pending register skipped: no backend credentials');
    return { ok: false, error: 'no_backend_credentials' };
  }
  const mid = String(merchantId || cfg.merchantId || '').trim();
  const url = `${apiBase(cfg)}/merchants/${encodeURIComponent(mid)}/pos-fiscal-pending`;
  try {
    const r = await undiciFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backendBearerForApi(cfg)}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      appendServiceLog(`[pos-op] fiscal-pending register HTTP ${r.status} ${t.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    appendServiceLog(`[pos-op] fiscal-pending register failed: ${e.message || e}`);
    return { ok: false, error: e.message || String(e) };
  }
}

async function settleFiscalPending(merchantId, externalDocumentId, paymentId) {
  const cfg = getBackendConnection();
  if (!cfg || !hasBackendCallbackAuth(cfg)) {
    return { ok: false, error: 'no_backend_credentials' };
  }
  const mid = String(merchantId || cfg.merchantId || '').trim();
  const docKey = encodeURIComponent(String(externalDocumentId || '').trim());
  const url = `${apiBase(cfg)}/merchants/${encodeURIComponent(mid)}/pos-fiscal-pending/${docKey}/settle`;
  try {
    const r = await undiciFetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backendBearerForApi(cfg)}`,
      },
      body: JSON.stringify({ paymentId: String(paymentId || '').trim() }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      appendServiceLog(`[pos-op] fiscal-pending settle HTTP ${r.status} ${t.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    appendServiceLog(`[pos-op] fiscal-pending settle failed: ${e.message || e}`);
    return { ok: false, error: e.message || String(e) };
  }
}

async function dismissFiscalPending(merchantId, externalDocumentId) {
  const cfg = getBackendConnection();
  if (!cfg || !hasBackendCallbackAuth(cfg)) {
    return { ok: false, error: 'no_backend_credentials' };
  }
  const mid = String(merchantId || cfg.merchantId || '').trim();
  const docKey = encodeURIComponent(String(externalDocumentId || '').trim());
  const url = `${apiBase(cfg)}/merchants/${encodeURIComponent(mid)}/pos-fiscal-pending/${docKey}/dismiss`;
  try {
    const r = await undiciFetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backendBearerForApi(cfg)}`,
      },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      appendServiceLog(`[pos-op] fiscal-pending dismiss HTTP ${r.status} ${t.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    appendServiceLog(`[pos-op] fiscal-pending dismiss failed: ${e.message || e}`);
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  registerFiscalPending,
  settleFiscalPending,
  dismissFiscalPending,
};

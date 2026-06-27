'use strict';

const { fetch: undiciFetch } = require('undici');
const { PORT } = require('../config');
const { appendServiceLog } = require('./logger');
const { getBackendConnection } = require('./printerStore');
const { backendBearerForApi, hasBackendCallbackAuth } = require('./backendCallbackAuth');
const { buildFinalizeBody } = require('./posPaymentJobRunner');

function padSoftwareId10(raw) {
  const s = String(raw || '').trim();
  if (s.length >= 10) return s.slice(0, 10);
  return s.padEnd(10, '0');
}

function parseHuginAmountTry(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.round(raw * 100) / 100;
  }
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function sumActiveDocumentEftAmountTry(stData) {
  if (!stData || typeof stData !== 'object') return null;
  const ad = stData.activeDocument;
  if (!ad || typeof ad !== 'object' || Array.isArray(ad)) return null;
  const eft = ad.eftPayments;
  if (!Array.isArray(eft) || !eft.length) return null;
  let sum = 0;
  for (const p of eft) {
    if (!p || typeof p !== 'object') continue;
    const amt = parseHuginAmountTry(p.amount);
    if (amt != null) sum += amt;
  }
  return sum > 0 ? Math.round(sum * 100) / 100 : null;
}

/**
 * Mobil panelden uzaktan belge resume/cancel/finalize → yerel Helper Hugin'e iletir.
 */
async function handlePosHuginDocAction(wsMsgData) {
  const data = wsMsgData || {};
  const probeId = String(data.probeId || '').trim();
  const merchantId = String(data.merchantId || '').trim();
  const posDeviceId = String(data.posDeviceId || '').trim();
  const serialNo = String(data.serialNo || '').trim();
  const vkn = String(data.vkn || '').trim();
  const documentId = String(data.documentId || '').trim();
  const action = String(data.action || '').trim().toLowerCase();

  if (!probeId || !merchantId || !posDeviceId || !serialNo || !vkn || !documentId) {
    appendServiceLog('[backend-ws] POS_HUGIN_DOC_ACTION missing fields');
    return;
  }

  const cfg = getBackendConnection();
  if (!cfg || !hasBackendCallbackAuth(cfg)) {
    appendServiceLog('[backend-ws] POS_HUGIN_DOC_ACTION: no credentials');
    return;
  }

  const softwareId = padSoftwareId10(vkn);
  const qs = new URLSearchParams({
    posDeviceId,
    softwareId,
    serialNo,
    vendor: 'hugin',
  });

  const localBase = `http://127.0.0.1:${PORT}`;
  const api = String(cfg.apiBaseUrl || '').replace(/\/+$/, '');
  const completeUrl = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-remote-hugin-doc-action/${encodeURIComponent(probeId)}/complete`;

  let ok = false;
  let errMsg = '';

  try {
    if (action === 'finalize') {
      const amountTry = Number(data.amountTry);
      const paymentType = String(data.paymentType || '').trim().toUpperCase();
      if (!(amountTry > 0)) {
        errMsg = 'amountTry geçersiz';
      } else if (paymentType !== 'CASH' && paymentType !== 'EFT_POS') {
        errMsg = 'paymentType geçersiz';
      } else {
        let resolvedAmountTry = amountTry;
        if (paymentType === 'EFT_POS') {
          try {
            const stRes = await undiciFetch(`${localBase}/v1/pos/status?${qs.toString()}`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
            });
            const stJson = await stRes.json().catch(() => null);
            const { classifyHuginStatusJson } = require('./huginReachability');
            const cls = classifyHuginStatusJson(stJson);
            const stData =
              cls.kind === 'ok' || cls.kind === 'reachable_issue' ? cls.data : null;
            const fromStatus = stData ? sumActiveDocumentEftAmountTry(stData) : null;
            if (fromStatus != null && fromStatus > 0) {
              resolvedAmountTry = fromStatus;
            }
          } catch {
            /* istemci amountTry ile devam */
          }
        }
        const finBody = buildFinalizeBody({
          amountTry: resolvedAmountTry,
          paymentType,
          items: Array.isArray(data.items) ? data.items : undefined,
          totals: data.totals && typeof data.totals === 'object' ? data.totals : undefined,
          saleType: data.saleType,
          customer: data.customer,
          invoiceId: data.invoiceId,
        });
        const docRes = await undiciFetch(
          `${localBase}/v1/pos/documents/${encodeURIComponent(documentId)}?${qs.toString()}`,
          {
            method: 'PUT',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(finBody),
          },
        );
        const docJson = await docRes.json().catch(() => null);
        ok = !!(docJson && docJson.status === 'SUCCESS');
        if (!ok) {
          const e = docJson && docJson.error;
          const title = e && typeof e === 'object' ? e.title || e.message : '';
          errMsg = title ? String(title).slice(0, 380) : 'Hugin finalize sonucu beklenenden farklı';
        }
      }
    } else {
      const path =
        action === 'resume'
          ? `documents/${encodeURIComponent(documentId)}/resume`
          : action === 'cancel'
            ? `documents/${encodeURIComponent(documentId)}/cancel`
            : '';

      if (!path) {
        appendServiceLog(`[backend-ws] POS_HUGIN_DOC_ACTION unknown action=${action}`);
        return;
      }

      const docRes = await undiciFetch(`${localBase}/v1/pos/${path}?${qs.toString()}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const docJson = await docRes.json().catch(() => null);
      ok = !!(docJson && docJson.status === 'SUCCESS');
      if (!ok) {
        const e = docJson && docJson.error;
        const title = e && typeof e === 'object' ? e.title || e.message : '';
        errMsg = title ? String(title).slice(0, 380) : 'Hugin işlem sonucu beklenenden farklı';
      }
    }
  } catch (e) {
    ok = false;
    errMsg = e && e.message ? String(e.message).slice(0, 380) : 'DOC_ACTION fetch failed';
  }

  try {
    await undiciFetch(completeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backendBearerForApi(cfg)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ok, error: ok ? '' : errMsg }),
    });
  } catch (e) {
    appendServiceLog(`[backend-ws] POS_HUGIN_DOC_ACTION complete POST failed ${e.message || e}`);
  }
}

module.exports = {
  handlePosHuginDocAction,
};

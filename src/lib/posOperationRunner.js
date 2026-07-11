'use strict';

const { fetch: undiciFetch } = require('undici');
const { PORT } = require('../config');
const { getPosAssignment } = require('./printerStore');
const { updateOperation } = require('./posOperationStore');
const { registerFiscalPending } = require('./posBackendFiscalPending');
const { buildFinalizeBody } = require('./posPaymentJobRunner');
const { classifyHuginStatusJson, isLikelyLostPosResponseError } = require('./huginReachability');
const { appendServiceLog } = require('./logger');
const { parseEftPaymentMeta } = require('./parseEftPaymentMeta');
const { findSuccessfulFiscalDocumentInLastDocuments } = require('./fiscalFinalize');

function padSoftwareId10(raw) {
  const s = String(raw || '').trim();
  if (s.length >= 10) return s.slice(0, 10);
  return s.padEnd(10, '0');
}

function toFixed2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return v.toFixed(2);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function parseHuginAmountTry(raw, fallback) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  const num = Number(s.replace(',', '.'));
  return Number.isFinite(num) ? num : fallback;
}

function formatHuginErr(err) {
  if (!err || typeof err !== 'object') return 'POS error';
  const code = err.code ? String(err.code).trim() : '';
  const title = err.title ? String(err.title).trim() : '';
  const desc = err.description ? String(err.description).trim() : '';
  const main = [code && `[${code}]`, title].filter(Boolean).join(' ');
  if (main && desc) return `${main} — ${desc}`;
  return main || desc || 'POS error';
}

function eftMetaPatch(meta) {
  return {
    posEftTransactionId: meta.transactionId ?? null,
    posAcquirerId: meta.acquirerId ?? null,
    posBankReferenceNo: meta.bankReferenceNo ?? null,
  };
}

async function pollDocumentSuccessOnDevice(localBase, qBase, documentId, expectedSaleType, opts) {
  const attempts = opts && Number(opts.attempts) > 0 ? Math.floor(Number(opts.attempts)) : 3;
  const delayMs = opts && Number(opts.delayMs) > 0 ? Math.floor(Number(opts.delayMs)) : 650;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    const stRes = await undiciFetch(`${localBase}/v1/pos/status?${qBase.toString()}`, { method: 'GET' });
    const stJson = await stRes.json().catch(() => null);
    const cls = classifyHuginStatusJson(stJson);
    if (cls.kind === 'reachable_issue') return false;
    if (cls.kind === 'unreachable') continue;
    if (findSuccessfulFiscalDocumentInLastDocuments(cls.data, documentId, expectedSaleType)) return true;
  }
  return false;
}

const FINALIZE_RECOVERY_POLL = { attempts: 8, delayMs: 800 };

function classifyPaymentError(err) {
  const title = err && err.title ? String(err.title).trim().toLowerCase() : '';
  const desc = err && err.description ? String(err.description).trim().toLowerCase() : '';
  const code = err && err.code ? String(err.code).trim().toUpperCase() : '';
  const blob = `${title} ${desc} ${code}`;
  if (blob.includes('timeout') || blob.includes('timed out')) {
    return { code: 'CARD_TIMEOUT', message: formatHuginErr(err) };
  }
  if (
    blob.includes('cancel') ||
    blob.includes('iptal') ||
    blob.includes('vazge') ||
    blob.includes('user') ||
    blob.includes('kullan') ||
    code === 'ERR_USER_CANCELLED'
  ) {
    return { code: 'USER_CANCEL', message: formatHuginErr(err) };
  }
  return { code: 'PAYMENT_FAILED', message: formatHuginErr(err) };
}

function failOperation(operationId, errorCode, errorMessage) {
  return updateOperation(operationId, {
    status: 'FAILED',
    phase: 'failed',
    errorCode: errorCode || 'FAILED',
    errorMessage: String(errorMessage || 'POS operation failed').slice(0, 500),
  });
}

/**
 * Runs a local POS billing operation asynchronously; updates posOperationStore as it progresses.
 * @param {string} operationId
 */
async function runPosOperation(operationId) {
  const { getOperation } = require('./posOperationStore');
  const op = getOperation(operationId);
  if (!op) return;
  if (op.status === 'CANCELLED' || op.status === 'SUCCEEDED' || op.status === 'FAILED') return;

  const posDeviceId = String(op.posDeviceId || '').trim();
  const ep = getPosAssignment(posDeviceId) || getPosAssignment(posDeviceId.toLowerCase());
  if (!ep || !ep.host) {
    failOperation(operationId, 'NO_LAN_ASSIGNMENT', 'POS cihazı LAN ataması yok');
    return;
  }

  updateOperation(operationId, { status: 'PROCESSING', phase: 'checking_terminal' });

  const serialNo = String(op.serialNo || '').trim();
  const softwareId = padSoftwareId10(op.softwareId);
  const posMethod = op.posMethod === 'cash' ? 'cash' : 'card';
  const amount = round2(Number(op.amountTry));
  const huginLines = Array.isArray(op.huginLines) ? op.huginLines : null;
  const merchantId = String(op.merchantId || '').trim();
  const localBase = `http://127.0.0.1:${PORT}`;
  const { resolveSaleType, sanitizeCustomer } = require('./fiscalFinalize');
  const saleType = resolveSaleType(op.saleType);
  const customer = sanitizeCustomer(op.customer);
  const invoiceId = op.invoiceId != null ? String(op.invoiceId).trim() : '';
  const expectedSaleType = saleType !== 'RECEIPT' ? saleType : undefined;
  const finalizeExtras =
    saleType !== 'RECEIPT' && customer
      ? { saleType, customer, ...(invoiceId ? { invoiceId } : {}) }
      : {};

  const qBase = new URLSearchParams({
    posDeviceId,
    softwareId,
    serialNo,
    vendor: 'hugin',
  });

  try {
    const stRes = await undiciFetch(`${localBase}/v1/pos/status?${qBase.toString()}`, { method: 'GET' });
    const stJson = await stRes.json().catch(() => null);
    const stCls = classifyHuginStatusJson(stJson);
    if (stCls.kind === 'unreachable') {
      throw Object.assign(new Error(stCls.message || 'POS status unreachable'), { code: 'UNREACHABLE' });
    }
    if (stCls.kind === 'reachable_issue') {
      throw Object.assign(new Error(stCls.message || 'POS not ready'), { code: 'NOT_READY' });
    }
    const stateRaw = stCls.data && stCls.data.state != null ? String(stCls.data.state).trim().toUpperCase() : '';
    if (stateRaw === 'SERVICE' || stateRaw === 'PREPARATION' || stateRaw === 'ERROR') {
      throw Object.assign(new Error(`ÖKC durumu uygun değil (state: ${stCls.data.state}).`), {
        code: 'BAD_STATE',
      });
    }

    const itemsTotal = huginLines && huginLines.length
      ? round2(huginLines.reduce((s, l) => s + round2(Number(l.amount) || 0), 0))
      : amount;
    if (!(itemsTotal > 0)) {
      throw Object.assign(new Error('Geçersiz ödeme tutarı'), { code: 'INVALID_AMOUNT' });
    }

    updateOperation(operationId, { phase: 'opening_document', amountTry: itemsTotal });

    const ensureRes = await undiciFetch(`${localBase}/v1/pos/ensure-sale-document?${qBase.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const ensured = await ensureRes.json().catch(() => null);
    if (!ensured || ensured.status !== 'SUCCESS' || !ensured.data?.documentId) {
      throw Object.assign(new Error(formatHuginErr(ensured && ensured.error) || 'POS document start failed'), {
        code: 'DOC_START_FAILED',
      });
    }
    const documentId = String(ensured.data.documentId).trim();
    updateOperation(operationId, { documentId, phase: posMethod === 'card' ? 'awaiting_card' : 'finalizing' });

    const billingSnapshot = op.billingSnapshot && typeof op.billingSnapshot === 'object' ? op.billingSnapshot : null;
    if (billingSnapshot && billingSnapshot.tableId) {
      const regBody = {
        tableId: String(billingSnapshot.tableId).trim(),
        sessionId: billingSnapshot.sessionId != null ? String(billingSnapshot.sessionId).trim() || null : null,
        posDeviceId,
        externalDocumentId: documentId,
        amountTry: itemsTotal,
        posMethod,
        payloadJson: {
          flow: billingSnapshot.flow,
          ...(Array.isArray(billingSnapshot.paymentItems) && billingSnapshot.paymentItems.length
            ? { paymentItems: billingSnapshot.paymentItems }
            : {}),
        },
      };
      const reg = await registerFiscalPending(merchantId, regBody);
      if (!reg.ok) {
        appendServiceLog(`[pos-op] fiscal-pending register failed op=${operationId} err=${reg.error}`);
      }
    }

    if (posMethod === 'card') {
      const paidRes = await undiciFetch(
        `${localBase}/v1/pos/documents/${encodeURIComponent(documentId)}/payments/EFT_POS?${qBase.toString()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: toFixed2(itemsTotal),
            installmentCount: 0,
            currencyCode: '949',
            UTID: 'default',
            detailedResponse: true,
          }),
        },
      );
      const paid = await paidRes.json().catch(() => null);
      if (!paid || paid.status !== 'SUCCESS') {
        if (isLikelyLostPosResponseError(paid && paid.error) && (await pollDocumentSuccessOnDevice(localBase, qBase, documentId, expectedSaleType))) {
          updateOperation(operationId, {
            status: 'SUCCEEDED',
            phase: 'done',
            recordedAmount: itemsTotal,
            errorMessage: null,
            errorCode: null,
          });
          appendServiceLog(`[pos-op] recovered via lastDocuments op=${operationId}`);
          return;
        }
        const cls = classifyPaymentError(paid && paid.error);
        failOperation(operationId, cls.code, cls.message);
        return;
      }

      const eftMeta = parseEftPaymentMeta(paid);
      const eftTransactionId = eftMeta.transactionId;
      updateOperation(operationId, { phase: 'finalizing', ...eftMetaPatch(eftMeta) });
      const bankAmount = parseHuginAmountTry(paid.data && paid.data.amount, itemsTotal);
      const diff = round2(itemsTotal - bankAmount);

      const detailedItems = huginLines && huginLines.length
        ? huginLines.map((l) => {
            const qty = Number(l.quantity ?? 1);
            const lineAmount = round2(Number(l.amount));
            return {
              name: l.name,
              quantity: qty,
              unitPrice: round2(l.unitPrice ?? (qty > 0 ? lineAmount / qty : lineAmount)),
              amount: lineAmount,
              vatRate: l.vatRate,
              ...(l.departmentId !== undefined ? { departmentId: l.departmentId } : {}),
            };
          })
        : undefined;

      const totalsBlock =
        Math.abs(diff) > 0.01
          ? {
              documentTotal: itemsTotal,
              netTotal: bankAmount,
              discounts: diff > 0 ? [{ amount: diff, note: 'POS DÜZELTME' }] : [],
            }
          : undefined;

      const finBody = buildFinalizeBody({
        amountTry: bankAmount,
        paymentType: 'EFT_POS',
        items: detailedItems,
        totals: totalsBlock,
        ...finalizeExtras,
      });

      const finRes = await undiciFetch(
        `${localBase}/v1/pos/documents/${encodeURIComponent(documentId)}?${qBase.toString()}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(finBody),
        },
      );
      const fin = await finRes.json().catch(() => null);
      if (!fin || fin.status !== 'SUCCESS') {
        if (
          isLikelyLostPosResponseError(fin && fin.error) &&
          (await pollDocumentSuccessOnDevice(
            localBase,
            qBase,
            documentId,
            expectedSaleType,
            FINALIZE_RECOVERY_POLL,
          ))
        ) {
          updateOperation(operationId, {
            status: 'SUCCEEDED',
            phase: 'done',
            recordedAmount: itemsTotal,
            ...eftMetaPatch(eftMeta),
          });
          appendServiceLog(`[pos-op] finalize recovered via lastDocuments op=${operationId}`);
          return;
        }
        failOperation(operationId, 'FINALIZE_FAILED', formatHuginErr(fin && fin.error) || 'POS finalize failed');
        return;
      }

      updateOperation(operationId, {
        status: 'SUCCEEDED',
        phase: 'done',
        recordedAmount: itemsTotal,
        ...eftMetaPatch(eftMeta),
      });
      appendServiceLog(
        `[pos-op] ok op=${operationId} card amount=${itemsTotal}` +
          (eftTransactionId != null ? ` eftTxnId=${eftTransactionId}` : '') +
          (eftMeta.bankReferenceNo ? ` bankRef=${eftMeta.bankReferenceNo}` : ''),
      );
      return;
    }

    // cash
    const finBody = buildFinalizeBody({
      amountTry: itemsTotal,
      paymentType: 'CASH',
      items:
        huginLines && huginLines.length
          ? huginLines.map((l) => {
              const qty = Number(l.quantity ?? 1);
              const lineAmount = round2(Number(l.amount));
              return {
                name: l.name,
                quantity: qty,
                unitPrice: round2(l.unitPrice ?? (qty > 0 ? lineAmount / qty : lineAmount)),
                amount: lineAmount,
                vatRate: l.vatRate,
                ...(l.departmentId !== undefined ? { departmentId: l.departmentId } : {}),
              };
            })
          : undefined,
      ...finalizeExtras,
    });

    const finRes = await undiciFetch(
      `${localBase}/v1/pos/documents/${encodeURIComponent(documentId)}?${qBase.toString()}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finBody),
      },
    );
    const fin = await finRes.json().catch(() => null);
    if (!fin || fin.status !== 'SUCCESS') {
      if (
        isLikelyLostPosResponseError(fin && fin.error) &&
        (await pollDocumentSuccessOnDevice(
          localBase,
          qBase,
          documentId,
          expectedSaleType,
          FINALIZE_RECOVERY_POLL,
        ))
      ) {
        updateOperation(operationId, {
          status: 'SUCCEEDED',
          phase: 'done',
          recordedAmount: itemsTotal,
        });
        appendServiceLog(`[pos-op] cash finalize recovered op=${operationId}`);
        return;
      }
      failOperation(operationId, 'FINALIZE_FAILED', formatHuginErr(fin && fin.error) || 'POS finalize failed');
      return;
    }

    updateOperation(operationId, {
      status: 'SUCCEEDED',
      phase: 'done',
      recordedAmount: itemsTotal,
    });
    appendServiceLog(`[pos-op] ok op=${operationId} cash amount=${itemsTotal}`);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    const code = e && e.code ? String(e.code) : 'FAILED';
    appendServiceLog(`[pos-op] failed op=${operationId}: ${msg}`);
    console.error('[qrpaydot-helper] POS operation', msg);
    failOperation(operationId, code, msg);
  }
}

function schedulePosOperation(operationId) {
  setImmediate(() => {
    void runPosOperation(operationId);
  });
}

module.exports = {
  runPosOperation,
  schedulePosOperation,
};

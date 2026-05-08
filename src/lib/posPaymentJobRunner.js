'use strict';

const { fetch: undiciFetch } = require('undici');
const { PORT } = require('../config');
const { getPosAssignment, getBackendConnection } = require('./printerStore');
const { appendServiceLog } = require('./logger');

let lastPosJobId = '';
let lastPosJobAt = 0;
const POS_JOB_DEDUPE_MS = 4000;

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

function getLastDocumentsList(statusData) {
  let cur = statusData;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object' && !Array.isArray(cur); depth++) {
    const ld = cur.lastDocuments ?? cur.LastDocuments;
    if (Array.isArray(ld)) return ld;
    const inner = cur.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      cur = inner;
      continue;
    }
    break;
  }
  return [];
}

function normDocId(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase();
}

/** EFT/finalize yanıtı gelmezse POS fişi yine de SUCCESS olmuş olabilir. */
function findSuccessfulReceiptInLastDocuments(statusData, documentId) {
  const want = normDocId(documentId);
  if (!want) return false;
  for (const entry of getLastDocumentsList(statusData)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = normDocId(entry.documentId ?? entry.DocumentId);
    if (id !== want) continue;
    const st = String(entry.documentStatus ?? entry.DocumentStatus ?? '')
      .trim()
      .toUpperCase();
    if (st !== 'SUCCESS') continue;
    const docCat = String(entry.docCategory ?? entry.DocCategory ?? '')
      .trim()
      .toUpperCase();
    const saleType = String(entry.saleType ?? entry.SaleType ?? '')
      .trim()
      .toUpperCase();
    if (docCat && docCat !== 'SALE') continue;
    if (saleType && saleType !== 'RECEIPT') continue;
    return true;
  }
  return false;
}

async function pollDocumentSuccessOnDevice(localBase, qBase, documentId) {
  const attempts = 3;
  const delayMs = 650;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    const stRes = await undiciFetch(`${localBase}/v1/pos/status?${qBase.toString()}`, { method: 'GET' });
    const stJson = await stRes.json().catch(() => null);
    if (!stJson || stJson.status !== 'SUCCESS' || !stJson.data) continue;
    if (findSuccessfulReceiptInLastDocuments(stJson.data, documentId)) return true;
  }
  return false;
}

/**
 * @param {object} data — WS `POS_PAYMENT_JOB` gövdesi (serialNo, vkn, posDeviceId, …)
 */
async function runPosPaymentJobFromWs(data) {
  const jobId = data && data.jobId != null ? String(data.jobId).trim() : '';
  const posDeviceId = data && data.posDeviceId != null ? String(data.posDeviceId).trim() : '';
  if (!jobId || !posDeviceId) {
    appendServiceLog('[backend-ws] POS_PAYMENT_JOB missing jobId or posDeviceId');
    return;
  }
  const ep = getPosAssignment(posDeviceId) || getPosAssignment(posDeviceId.toLowerCase());
  if (!ep || !ep.host) {
    appendServiceLog(`[backend-ws] POS_PAYMENT_JOB no LAN assignment posDeviceId=${posDeviceId}`);
    return;
  }

  const now = Date.now();
  if (jobId === lastPosJobId && now - lastPosJobAt < POS_JOB_DEDUPE_MS) {
    appendServiceLog(`[backend-ws] POS_PAYMENT_JOB deduped jobId=${jobId}`);
    return;
  }
  lastPosJobId = jobId;
  lastPosJobAt = now;

  const cfg = getBackendConnection();
  if (!cfg || !cfg.token || !cfg.merchantId || !cfg.apiBaseUrl) {
    appendServiceLog('[backend-ws] POS_PAYMENT_JOB: no credentials');
    return;
  }

  const merchantId = String(data.merchantId || cfg.merchantId).trim();
  const serialNo = String(data.serialNo || '').trim();
  const vkn = String(data.vkn || '').trim();
  const softwareId = padSoftwareId10(vkn);
  const posMethod = String(data.posMethod || '').toLowerCase() === 'card' ? 'card' : 'cash';
  const amount = round2(Number(data.amount));
  const huginLines = Array.isArray(data.huginLines) ? data.huginLines : null;

  if (!serialNo || !vkn) {
    await postJobComplete(cfg, merchantId, jobId, { status: 'FAILED', errorMessage: 'missing_serial_or_vkn' });
    return;
  }

  const localBase = `http://127.0.0.1:${PORT}`;

  const qBase = new URLSearchParams({
    posDeviceId,
    softwareId,
    serialNo,
    vendor: 'hugin',
  });

  try {
    // Terminal hazır mı (BillingModal assertHuginTerminalIdle)
    const stRes = await undiciFetch(`${localBase}/v1/pos/status?${qBase.toString()}`, { method: 'GET' });
    const stJson = await stRes.json().catch(() => null);
    if (!stJson || stJson.status !== 'SUCCESS') {
      throw new Error(formatHuginErr(stJson && stJson.error));
    }
    const stateRaw = stJson.data && stJson.data.state != null ? String(stJson.data.state).trim().toUpperCase() : '';
    if (stateRaw === 'SERVICE' || stateRaw === 'PREPARATION' || stateRaw === 'ERROR') {
      throw new Error(`ÖKC durumu uygun değil (state: ${stJson.data.state}).`);
    }

    const itemsTotal = huginLines && huginLines.length
      ? round2(huginLines.reduce((s, l) => s + round2(Number(l.amount) || 0), 0))
      : amount;
    if (!(itemsTotal > 0)) {
      throw new Error('Geçersiz ödeme tutarı');
    }

    const ensureRes = await undiciFetch(`${localBase}/v1/pos/ensure-sale-document?${qBase.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const ensured = await ensureRes.json().catch(() => null);
    if (!ensured || ensured.status !== 'SUCCESS' || !ensured.data?.documentId) {
      throw new Error(formatHuginErr(ensured && ensured.error) || 'POS document start failed');
    }
    const documentId = String(ensured.data.documentId).trim();

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
            detailedResponse: false,
          }),
        },
      );
      const paid = await paidRes.json().catch(() => null);
      if (!paid || paid.status !== 'SUCCESS') {
        if (await pollDocumentSuccessOnDevice(localBase, qBase, documentId)) {
          appendServiceLog(`[backend-ws] POS_PAYMENT_JOB recovered via lastDocuments jobId=${jobId}`);
          await postJobComplete(cfg, merchantId, jobId, {
            status: 'SUCCESS',
            recordedAmount: itemsTotal,
          });
          return;
        }
        throw new Error(formatHuginErr(paid && paid.error) || 'POS payment failed');
      }
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
        if (await pollDocumentSuccessOnDevice(localBase, qBase, documentId)) {
          appendServiceLog(
            `[backend-ws] POS_PAYMENT_JOB recovered via lastDocuments (finalize) jobId=${jobId}`,
          );
          await postJobComplete(cfg, merchantId, jobId, {
            status: 'SUCCESS',
            recordedAmount: itemsTotal,
          });
          return;
        }
        throw new Error(formatHuginErr(fin && fin.error) || 'POS finalize failed');
      }

      await postJobComplete(cfg, merchantId, jobId, {
        status: 'SUCCESS',
        recordedAmount: itemsTotal,
      });
      appendServiceLog(
        `[backend-ws] POS_PAYMENT_JOB ok jobId=${jobId} card itemsTotal=${itemsTotal} bankAmount=${bankAmount}`,
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
      if (await pollDocumentSuccessOnDevice(localBase, qBase, documentId)) {
        appendServiceLog(
          `[backend-ws] POS_PAYMENT_JOB recovered via lastDocuments (cash finalize) jobId=${jobId}`,
        );
        await postJobComplete(cfg, merchantId, jobId, { status: 'SUCCESS', recordedAmount: itemsTotal });
        return;
      }
      throw new Error(formatHuginErr(fin && fin.error) || 'POS finalize failed');
    }

    await postJobComplete(cfg, merchantId, jobId, { status: 'SUCCESS', recordedAmount: itemsTotal });
    appendServiceLog(`[backend-ws] POS_PAYMENT_JOB ok jobId=${jobId} cash`);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    appendServiceLog(`[backend-ws] POS_PAYMENT_JOB failed jobId=${jobId}: ${msg}`);
    console.error('[qrpaydot-helper] POS_PAYMENT_JOB', msg);
    await postJobComplete(cfg, merchantId, jobId, { status: 'FAILED', errorMessage: msg.slice(0, 500) });
  }
}

function buildFinalizeBody({ amountTry, paymentType, items, totals }) {
  const totalAmount = toFixed2(amountTry);
  const hasDetailedItems = Array.isArray(items) && items.length > 0;
  const mappedItems = hasDetailedItems
    ? items.map((it) => {
        const qty = Number(it.quantity ?? 1);
        const lineAmount = toFixed2(it.amount);
        const unitPrice = toFixed2(it.unitPrice ?? (qty > 0 ? Number(it.amount) / qty : Number(it.amount)));
        const line = {
          name: it.name,
          quantity: String(qty),
          unit: 'AD',
          unitPrice,
          amount: lineAmount,
          vatRate: Number(it.vatRate),
        };
        if (it.departmentId !== undefined && it.departmentId !== null) {
          line.departmentId = it.departmentId;
        }
        return line;
      })
    : [
        {
          name: 'Masa Ödemesi',
          departmentId: '1',
          quantity: '1',
          unit: 'ADET',
          unitPrice: totalAmount,
          amount: totalAmount,
          vatRate: '0',
        },
      ];

  const body = {
    saleType: 'RECEIPT',
    items: mappedItems,
    payments: [{ type: paymentType, amount: totalAmount }],
  };
  if (!hasDetailedItems) {
    body.totals = {
      documentTotal: totalAmount,
      vatTotal: '0.00',
      netTotal: totalAmount,
      discounts: [],
    };
  } else if (totals) {
    const t = {};
    if (totals.documentTotal !== undefined) t.documentTotal = toFixed2(totals.documentTotal);
    if (totals.netTotal !== undefined) t.netTotal = toFixed2(totals.netTotal);
    if (Array.isArray(totals.discounts) && totals.discounts.length > 0) {
      t.discounts = totals.discounts.map((d) => ({
        amount: toFixed2(d.amount),
        ...(d.note ? { note: d.note } : {}),
      }));
    }
    if (Object.keys(t).length > 0) body.totals = t;
  }
  return body;
}

async function postJobComplete(cfg, merchantId, jobId, payload) {
  const api = String(cfg.apiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const url = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-payment-jobs/${encodeURIComponent(jobId)}/complete`;
  try {
    const r = await undiciFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      appendServiceLog(`[backend-ws] complete job HTTP ${r.status} ${t.slice(0, 200)}`);
    }
  } catch (e) {
    appendServiceLog(`[backend-ws] complete job fetch failed: ${e.message || e}`);
  }
}

module.exports = { runPosPaymentJobFromWs };

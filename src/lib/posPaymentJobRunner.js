'use strict';

const { fetch: undiciFetch } = require('undici');
const { PORT } = require('../config');
const { getPosAssignment, getBackendConnection } = require('./printerStore');
const { backendBearerForApi, hasBackendCallbackAuth } = require('./backendCallbackAuth');
const { classifyHuginStatusJson, isLikelyLostPosResponseError } = require('./huginReachability');
const { appendServiceLog } = require('./logger');
const { parseEftPaymentMeta } = require('./parseEftPaymentMeta');
const { registerFiscalPending } = require('./posBackendFiscalPending');
const { ensureDepartmentsForJob } = require('./posDepartmentsSync');
const {
  sanitizeCustomer,
  resolveSaleType,
  findSuccessfulFiscalDocumentInLastDocuments,
  extractFiscalDocMetaFromHuginResponse,
} = require('./fiscalFinalize');

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

/** GİB / PC Link geçerli KDV oranları; fallback departman seçim önceliği. */
const HUGIN_FISCAL_VAT_RATES = [0, 1, 10, 20];

function pickFallbackDepartment(departments) {
  for (const rate of HUGIN_FISCAL_VAT_RATES) {
    const m = departments.find((d) => Number(d.vatRate) === rate);
    if (m) return m;
  }
  return departments[0] || null;
}

/**
 * Satır KDV oranı + departmentId'sini cihaz departmanlarıyla tutarlı yap (PC ile aynı mantık):
 *  1) Satırın departmentId'si cihazda varsa → o departmanın vatRate'i.
 *  2) Yoksa vatRate'i eşleşen departman → onun id + vatRate'i.
 *  3) Hiçbiri yoksa → geçerli KDV oranlı ilk (fallback) departman.
 * Tutar (amount/unitPrice/quantity) değişmez.
 */
function remapHuginLinesToDeviceDepartments(lines, departments) {
  if (!Array.isArray(lines) || lines.length === 0) return lines;
  if (!Array.isArray(departments) || departments.length === 0) return lines;

  const deptById = new Map(departments.map((d) => [Number(d.id), d]));
  const deptByVat = new Map();
  for (const d of departments) {
    const v = Number(d.vatRate);
    if (!deptByVat.has(v)) deptByVat.set(v, d);
  }
  const fallback = pickFallbackDepartment(departments);

  return lines.map((l) => {
    const lineDeptId = l.departmentId != null ? Number(l.departmentId) : null;
    const lineVat = l.vatRate != null && Number.isFinite(Number(l.vatRate)) ? Number(l.vatRate) : null;

    let dept = null;
    if (lineDeptId != null && deptById.has(lineDeptId)) {
      dept = deptById.get(lineDeptId);
    } else if (lineVat != null && deptByVat.has(lineVat)) {
      dept = deptByVat.get(lineVat);
    } else {
      dept = fallback;
    }
    if (!dept) return l;
    return { ...l, vatRate: Number(dept.vatRate), departmentId: dept.id };
  });
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

function buildJobSuccessPayload(recordedAmount, eftMeta, fiscalDocumentId, fiscalDocMeta) {
  const payload = { status: 'SUCCESS', recordedAmount };
  if (fiscalDocumentId) payload.fiscalDocumentId = String(fiscalDocumentId).trim();
  if (eftMeta && eftMeta.transactionId != null) payload.posEftTransactionId = eftMeta.transactionId;
  if (eftMeta && eftMeta.acquirerId != null) payload.posAcquirerId = eftMeta.acquirerId;
  if (eftMeta && eftMeta.bankReferenceNo) payload.posBankReferenceNo = eftMeta.bankReferenceNo;
  if (fiscalDocMeta && typeof fiscalDocMeta === 'object') {
    const resultPayload = {};
    if (fiscalDocMeta.invoiceId) resultPayload.invoiceId = fiscalDocMeta.invoiceId;
    if (fiscalDocMeta.receiptNo) resultPayload.receiptNo = fiscalDocMeta.receiptNo;
    if (fiscalDocMeta.eDocumentNo) resultPayload.eDocumentNo = fiscalDocMeta.eDocumentNo;
    if (Object.keys(resultPayload).length > 0) payload.resultPayload = resultPayload;
  }
  return payload;
}


async function pollDocumentSuccessOnDevice(localBase, qBase, documentId, expectedSaleType) {
  const attempts = 3;
  const delayMs = 650;
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
  if (!cfg || !cfg.merchantId || !cfg.apiBaseUrl || !hasBackendCallbackAuth(cfg)) {
    appendServiceLog('[backend-ws] POS_PAYMENT_JOB: no credentials');
    return;
  }

  const merchantId = String(data.merchantId || cfg.merchantId).trim();
  const serialNo = String(data.serialNo || '').trim();
  const vkn = String(data.vkn || '').trim();
  const softwareId = padSoftwareId10(vkn);
  const posMethod = String(data.posMethod || '').toLowerCase() === 'card' ? 'card' : 'cash';
  const amount = round2(Number(data.amount));
  let huginLines = Array.isArray(data.huginLines) ? data.huginLines : null;
  const tableId = data.tableId != null ? String(data.tableId).trim() : '';
  const sessionId = data.sessionId != null ? String(data.sessionId).trim() : null;
  const saleType = resolveSaleType(data.saleType);
  const customer = sanitizeCustomer(data.customer);
  const invoiceId = data.invoiceId != null ? String(data.invoiceId).trim() : '';
  const expectedSaleType = saleType !== 'RECEIPT' ? saleType : undefined;
  const finalizeExtras =
    saleType !== 'RECEIPT' && customer
      ? { saleType, customer, ...(invoiceId ? { invoiceId } : {}) }
      : {};

  if (!serialNo || !vkn) {
    await postJobCompleteWithRetry(cfg, merchantId, jobId, { status: 'FAILED', errorMessage: 'missing_serial_or_vkn' });
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
    patchJobPhase(cfg, merchantId, jobId, 'PROCESSING');
    patchJobPhase(cfg, merchantId, jobId, 'CHECKING_TERMINAL');

    const statusPromise = undiciFetch(`${localBase}/v1/pos/status?${qBase.toString()}`, { method: 'GET' }).then((r) =>
      r.json().catch(() => null),
    );
    const departmentsPromise =
      huginLines && huginLines.length
        ? ensureDepartmentsForJob(
            cfg,
            merchantId,
            posDeviceId,
            { serialNo, vkn },
            { skipDeviceFetch: true },
          )
        : Promise.resolve([]);

    const [stJson, departments] = await Promise.all([statusPromise, departmentsPromise]);

    const stCls = classifyHuginStatusJson(stJson);
    if (stCls.kind === 'unreachable') {
      throw new Error(stCls.message || 'POS status unreachable');
    }
    if (stCls.kind === 'reachable_issue') {
      throw new Error(stCls.message || 'POS not ready');
    }
    const stateRaw = stCls.data && stCls.data.state != null ? String(stCls.data.state).trim().toUpperCase() : '';
    if (stateRaw === 'SERVICE' || stateRaw === 'PREPARATION' || stateRaw === 'ERROR') {
      throw new Error(`ÖKC durumu uygun değil (state: ${stCls.data.state}).`);
    }

    if (huginLines && huginLines.length) {
      if (departments.length) {
        huginLines = remapHuginLinesToDeviceDepartments(huginLines, departments);
      } else {
        appendServiceLog(`[backend-ws] POS_PAYMENT_JOB device departments empty jobId=${jobId} (KDV remap atlandı)`);
      }
    }

    const itemsTotal = huginLines && huginLines.length
      ? round2(huginLines.reduce((s, l) => s + round2(Number(l.amount) || 0), 0))
      : amount;
    if (!(itemsTotal > 0)) {
      throw new Error('Geçersiz ödeme tutarı');
    }

    patchJobPhase(cfg, merchantId, jobId, 'OPENING_DOCUMENT');
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

    if (tableId) {
      const regBody = {
        tableId,
        sessionId: sessionId || null,
        posDeviceId,
        externalDocumentId: documentId,
        amountTry: itemsTotal,
        posMethod,
        payloadJson: {
          flow: 'pos_payment_job',
          jobId,
          paymentItems: Array.isArray(data.items) ? data.items : [],
        },
      };
      void registerFiscalPending(merchantId, regBody).then((reg) => {
        if (!reg.ok) {
          appendServiceLog(`[backend-ws] fiscal-pending register failed jobId=${jobId} err=${reg.error}`);
        }
      });
    }

    patchJobPhase(cfg, merchantId, jobId, 'SENT_TO_POS', { fiscalDocumentId: documentId });

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
          appendServiceLog(`[backend-ws] POS_PAYMENT_JOB recovered via lastDocuments jobId=${jobId}`);
          await postJobCompleteWithRetry(
            cfg,
            merchantId,
            jobId,
            buildJobSuccessPayload(itemsTotal, null, documentId),
          );
          return;
        }
        throw new Error(formatHuginErr(paid && paid.error) || 'POS payment failed');
      }
      const eftMeta = parseEftPaymentMeta(paid);
      const eftTransactionId = eftMeta.transactionId;
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

      // FINALIZING: dash poll hızlı kalsın (WAITING_RESULT kart backoff 0.6–2.2s gecikme yaratıyordu).
      patchJobPhase(cfg, merchantId, jobId, 'FINALIZING', { fiscalDocumentId: documentId });
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
        if (isLikelyLostPosResponseError(fin && fin.error) && (await pollDocumentSuccessOnDevice(localBase, qBase, documentId, expectedSaleType))) {
          appendServiceLog(
            `[backend-ws] POS_PAYMENT_JOB recovered via lastDocuments (finalize) jobId=${jobId}`,
          );
          await postJobCompleteWithRetry(
            cfg,
            merchantId,
            jobId,
            buildJobSuccessPayload(itemsTotal, eftMeta, documentId, extractFiscalDocMetaFromHuginResponse(fin)),
          );
          return;
        }
        // Kart çekildi; yalnızca fiş finalize başarısız — frontend cihazı sorgulamadan job sonucundan devam eder.
        const finalizeErr = formatHuginErr(fin && fin.error) || 'POS finalize failed';
        appendServiceLog(
          `[backend-ws] POS_PAYMENT_JOB EFT_OK_FINALIZE_PENDING jobId=${jobId}: ${finalizeErr}`,
        );
        await postJobCompleteWithRetry(cfg, merchantId, jobId, {
          status: 'EFT_OK_FINALIZE_PENDING',
          errorMessage: finalizeErr.slice(0, 500),
          recordedAmount: itemsTotal,
          fiscalDocumentId: documentId,
          posEftTransactionId: eftMeta.transactionId,
          posAcquirerId: eftMeta.acquirerId,
          posBankReferenceNo: eftMeta.bankReferenceNo,
          resultPayload: {
            finalizePending: true,
            finalizeBody: finBody,
            posEftTransactionId: eftMeta.transactionId,
            posAcquirerId: eftMeta.acquirerId,
            posBankReferenceNo: eftMeta.bankReferenceNo,
          },
        });
        return;
      }

      const fiscalDocMeta = extractFiscalDocMetaFromHuginResponse(fin);
      await postJobCompleteWithRetry(
        cfg,
        merchantId,
        jobId,
        buildJobSuccessPayload(itemsTotal, eftMeta, documentId, fiscalDocMeta),
      );
      appendServiceLog(
        `[backend-ws] POS_PAYMENT_JOB ok jobId=${jobId} card itemsTotal=${itemsTotal} bankAmount=${bankAmount}` +
          (eftTransactionId != null ? ` eftTxnId=${eftTransactionId}` : '') +
          (eftMeta.bankReferenceNo ? ` bankRef=${eftMeta.bankReferenceNo}` : ''),
      );
      return;
    }

    // cash — fiş basılırken FINALIZING (dash hızlı poll)
    patchJobPhase(cfg, merchantId, jobId, 'FINALIZING', { fiscalDocumentId: documentId });
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
      if (isLikelyLostPosResponseError(fin && fin.error) && (await pollDocumentSuccessOnDevice(localBase, qBase, documentId, expectedSaleType))) {
        appendServiceLog(
          `[backend-ws] POS_PAYMENT_JOB recovered via lastDocuments (cash finalize) jobId=${jobId}`,
        );
        await postJobCompleteWithRetry(
          cfg,
          merchantId,
          jobId,
          buildJobSuccessPayload(itemsTotal, null, documentId, extractFiscalDocMetaFromHuginResponse(fin)),
        );
        return;
      }
      throw new Error(formatHuginErr(fin && fin.error) || 'POS finalize failed');
    }

    const cashFiscalMeta = extractFiscalDocMetaFromHuginResponse(fin);
    await postJobCompleteWithRetry(
      cfg,
      merchantId,
      jobId,
      buildJobSuccessPayload(itemsTotal, null, documentId, cashFiscalMeta),
    );
    appendServiceLog(`[backend-ws] POS_PAYMENT_JOB ok jobId=${jobId} cash`);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    appendServiceLog(`[backend-ws] POS_PAYMENT_JOB failed jobId=${jobId}: ${msg}`);
    console.error('[qrpaydot-helper] POS_PAYMENT_JOB', msg);
    await postJobCompleteWithRetry(cfg, merchantId, jobId, { status: 'FAILED', errorMessage: msg.slice(0, 500) });
  }
}

function buildFinalizeBody({ amountTry, paymentType, items, totals, saleType, customer, invoiceId }) {
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

  const resolvedSaleType = resolveSaleType(saleType);
  const sanitizedCustomer = resolvedSaleType !== 'RECEIPT' ? sanitizeCustomer(customer) : null;

  const body = {
    saleType: resolvedSaleType,
    items: mappedItems,
    payments: [{ type: paymentType, amount: totalAmount }],
  };
  if (resolvedSaleType !== 'RECEIPT' && sanitizedCustomer) {
    body.customer = sanitizedCustomer;
  }
  if (invoiceId != null && String(invoiceId).trim()) {
    body.invoiceId = String(invoiceId).trim();
  }
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

/** Panel ilerleme göstergesi — ödeme kritik yolunu bekletmez. */
function patchJobPhase(cfg, merchantId, jobId, phase, extra = {}) {
  const api = String(cfg.apiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const url = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-payment-jobs/${encodeURIComponent(jobId)}/phase`;
  void undiciFetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${backendBearerForApi(cfg)}`,
    },
    body: JSON.stringify({ phase, ...extra }),
  })
    .then(async (r) => {
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        appendServiceLog(`[backend-ws] phase PATCH HTTP ${r.status} ${t.slice(0, 120)}`);
      }
    })
    .catch((e) => {
      appendServiceLog(`[backend-ws] phase PATCH failed: ${e.message || e}`);
    });
}

async function postJobCompleteWithRetry(cfg, merchantId, jobId, payload) {
  const api = String(cfg.apiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const url = `${api}/merchants/${encodeURIComponent(merchantId)}/pos-payment-jobs/${encodeURIComponent(jobId)}/complete`;
  const delays = [2000, 4000, 8000, 15000];

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const r = await undiciFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${backendBearerForApi(cfg)}`,
        },
        body: JSON.stringify(payload),
      });
      if (r.ok) return true;
      const t = await r.text().catch(() => '');
      appendServiceLog(
        `[backend-ws] complete job attempt ${attempt + 1} HTTP ${r.status} ${t.slice(0, 200)}`,
      );
    } catch (e) {
      appendServiceLog(`[backend-ws] complete job attempt ${attempt + 1} fetch failed: ${e.message || e}`);
    }
    if (attempt < delays.length) {
      await new Promise((resolve) => {
        setTimeout(resolve, delays[attempt]);
      });
    }
  }

  appendServiceLog(`[backend-ws] complete job all retries exhausted jobId=${jobId}`);
  return false;
}

async function postJobComplete(cfg, merchantId, jobId, payload) {
  return postJobCompleteWithRetry(cfg, merchantId, jobId, payload);
}

module.exports = { runPosPaymentJobFromWs, buildFinalizeBody };

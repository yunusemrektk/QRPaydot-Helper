'use strict';

function parsePosInt(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return undefined;
}

/**
 * Hugin EFT_POS yanıtından transactionId, acquirerId ve bankReferenceNo çıkarır.
 * detailedResponse: true ile gelen alanlar `data.additionalData` altında olabilir.
 *
 * @param {unknown} paid
 * @returns {{ transactionId?: number, acquirerId?: number, bankReferenceNo?: string }}
 */
function parseEftPaymentMeta(paid) {
  const data =
    paid && typeof paid === 'object' && paid.data && typeof paid.data === 'object' ? paid.data : {};
  const additional =
    data.additionalData && typeof data.additionalData === 'object' ? data.additionalData : {};

  const transactionId = parsePosInt(data.transactionId);

  const acquirerRaw = data.acquirerId ?? data.bankId ?? additional.acquirerId ?? additional.bankId;
  const acquirerId = parsePosInt(acquirerRaw);

  const bankRefRaw = data.bankReferenceNo ?? additional.bankReferenceNo;
  const bankReferenceNo =
    bankRefRaw != null && String(bankRefRaw).trim()
      ? String(bankRefRaw).trim().slice(0, 32)
      : undefined;

  return { transactionId, acquirerId, bankReferenceNo };
}

/** @deprecated use parseEftPaymentMeta */
function parseEftTransactionId(paid) {
  return parseEftPaymentMeta(paid).transactionId;
}

module.exports = {
  parseEftPaymentMeta,
  parseEftTransactionId,
};

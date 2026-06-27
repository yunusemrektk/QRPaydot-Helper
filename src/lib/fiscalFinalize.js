'use strict';

const FISCAL_SUCCESS_SALE_TYPES = new Set(['RECEIPT', 'E_INVOICE', 'E_ARCHIVE']);

function normalizeTaxId(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

function sanitizeCustomer(customer) {
  if (!customer || typeof customer !== 'object') return null;
  const taxName = String(customer.taxName ?? '').trim();
  const taxId = normalizeTaxId(customer.taxId);
  const taxOffice = String(customer.taxOffice ?? '').trim();
  if (!taxName || !taxId || !taxOffice) return null;
  const out = { taxName, taxId, taxOffice };
  const email = String(customer.email ?? '').trim();
  if (email) out.email = email;
  const addressInfo = customer.addressInfo;
  if (addressInfo && typeof addressInfo === 'object' && !Array.isArray(addressInfo)) {
    out.addressInfo = addressInfo;
  }
  return out;
}

function resolveSaleType(saleType) {
  const u = String(saleType ?? '').trim().toUpperCase();
  if (u === 'E_INVOICE' || u === 'E_ARCHIVE') return u;
  return 'RECEIPT';
}

/**
 * @param {object} statusData
 * @param {string} documentId
 * @param {string} [expectedSaleType]
 */
function findSuccessfulFiscalDocumentInLastDocuments(statusData, documentId, expectedSaleType) {
  const want = String(documentId ?? '')
    .trim()
    .toLowerCase();
  if (!want) return false;
  const expected = expectedSaleType ? String(expectedSaleType).trim().toUpperCase() : '';

  let cur = statusData;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object' && !Array.isArray(cur); depth++) {
    const ld = cur.lastDocuments ?? cur.LastDocuments;
    if (Array.isArray(ld)) {
      for (const entry of ld) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String(entry.documentId ?? entry.DocumentId ?? '')
          .trim()
          .toLowerCase();
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
        if (saleType && !FISCAL_SUCCESS_SALE_TYPES.has(saleType)) continue;
        if (expected && saleType && saleType !== expected) continue;
        return true;
      }
      return false;
    }
    const inner = cur.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      cur = inner;
      continue;
    }
    break;
  }
  return false;
}

/** @deprecated use findSuccessfulFiscalDocumentInLastDocuments */
function findSuccessfulReceiptInLastDocuments(statusData, documentId) {
  return findSuccessfulFiscalDocumentInLastDocuments(statusData, documentId);
}

function extractFiscalDocMetaFromHuginResponse(finJson) {
  const data = finJson && finJson.data;
  if (!data || typeof data !== 'object') return {};
  const invoiceId =
    data.invoiceId != null && String(data.invoiceId).trim()
      ? String(data.invoiceId).trim()
      : null;
  const receiptNo =
    data.receiptNo != null && String(data.receiptNo).trim()
      ? String(data.receiptNo).trim()
      : null;
  const eDocumentNo =
    data.eDocumentNo != null && String(data.eDocumentNo).trim()
      ? String(data.eDocumentNo).trim()
      : invoiceId;
  return {
    ...(invoiceId ? { invoiceId } : {}),
    ...(receiptNo ? { receiptNo } : {}),
    ...(eDocumentNo ? { eDocumentNo } : {}),
  };
}

module.exports = {
  FISCAL_SUCCESS_SALE_TYPES,
  sanitizeCustomer,
  resolveSaleType,
  findSuccessfulFiscalDocumentInLastDocuments,
  findSuccessfulReceiptInLastDocuments,
  extractFiscalDocMetaFromHuginResponse,
};

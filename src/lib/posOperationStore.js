'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STORE_DIR = path.join(process.env.APPDATA || os.homedir(), 'QRPaydotHelper');
const STORE_FILE = path.join(STORE_DIR, 'pos-operations.json');

/** @typedef {'PENDING'|'PROCESSING'|'SUCCEEDED'|'FAILED'|'CANCELLED'} PosOperationStatus */

/** @typedef {'queued'|'checking_terminal'|'opening_document'|'awaiting_card'|'finalizing'|'done'|'failed'|'cancelled'} PosOperationPhase */

/**
 * @typedef {object} PosOperationRecord
 * @property {string} id
 * @property {string} posDeviceId
 * @property {string} merchantId
 * @property {string} [tableId]
 * @property {string|null} [sessionId]
 * @property {PosOperationStatus} status
 * @property {PosOperationPhase} phase
 * @property {number} amountTry
 * @property {'card'|'cash'} posMethod
 * @property {string} [documentId]
 * @property {string} [softwareId]
 * @property {string} [serialNo]
 * @property {number|null} [posEftTransactionId]
 * @property {number|null} [posAcquirerId]
 * @property {string|null} [posBankReferenceNo]
 * @property {number|null} [recordedAmount]
 * @property {string|null} [errorMessage]
 * @property {string|null} [errorCode]
 * @property {object|null} [billingSnapshot]
 * @property {Array<object>|null} [huginLines]
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} paymentStartedAt
 */

const TTL_MS = 2 * 60 * 60 * 1000;
const PROCESSING_STALE_MS = 15 * 60 * 1000;

function emptyStore() {
  return { operations: {} };
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.operations || typeof data.operations !== 'object') {
      return emptyStore();
    }
    return { operations: { ...data.operations } };
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('[qrpaydot-helper] posOperationStore save failed:', err.message || err);
  }
}

function newOperationId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function pruneExpired(store) {
  const now = Date.now();
  let changed = false;
  for (const [id, op] of Object.entries(store.operations)) {
    if (!op || typeof op !== 'object') {
      delete store.operations[id];
      changed = true;
      continue;
    }
    const age = now - Number(op.updatedAt || op.createdAt || 0);
    if (age > TTL_MS) {
      delete store.operations[id];
      changed = true;
    }
  }
  return changed;
}

function markStaleProcessingFailed(store) {
  const now = Date.now();
  let changed = false;
  for (const op of Object.values(store.operations)) {
    if (!op || op.status !== 'PROCESSING') continue;
    const age = now - Number(op.updatedAt || op.createdAt || 0);
    if (age > PROCESSING_STALE_MS) {
      op.status = 'FAILED';
      op.phase = 'failed';
      op.errorMessage = 'Operation timed out (helper restarted or stale processing)';
      op.errorCode = 'STALE_PROCESSING';
      op.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

function getOperation(id) {
  const store = loadStore();
  if (pruneExpired(store) || markStaleProcessingFailed(store)) saveStore(store);
  const op = store.operations[String(id || '').trim()];
  return op && typeof op === 'object' ? { ...op } : null;
}

function listOperationsForDevice(posDeviceId) {
  const store = loadStore();
  if (pruneExpired(store)) saveStore(store);
  const key = String(posDeviceId || '').trim();
  return Object.values(store.operations).filter(
    (op) => op && String(op.posDeviceId || '').trim() === key,
  );
}

function hasActiveProcessingForDevice(posDeviceId) {
  return listOperationsForDevice(posDeviceId).some((op) => op.status === 'PROCESSING');
}

/**
 * @param {object} input
 * @returns {{ ok: true, operation: PosOperationRecord } | { ok: false, code: string, message: string, activeOperationId?: string }}
 */
function createOperation(input) {
  const store = loadStore();
  pruneExpired(store);

  const posDeviceId = String(input.posDeviceId || '').trim();
  const merchantId = String(input.merchantId || '').trim();
  if (!posDeviceId || !merchantId) {
    return { ok: false, code: 'INVALID_INPUT', message: 'posDeviceId and merchantId required' };
  }

  const active = listOperationsForDevice(posDeviceId).find((op) => op.status === 'PROCESSING');
  if (active) {
    return {
      ok: false,
      code: 'DEVICE_BUSY',
      message: 'POS device has an active operation',
      activeOperationId: active.id,
    };
  }

  const now = Date.now();
  const op = {
    id: newOperationId(),
    posDeviceId,
    merchantId,
    tableId: input.tableId != null ? String(input.tableId).trim() : '',
    sessionId: input.sessionId != null ? String(input.sessionId).trim() || null : null,
    status: 'PENDING',
    phase: 'queued',
    amountTry: Number(input.amountTry) || 0,
    posMethod: String(input.posMethod || '').toLowerCase() === 'cash' ? 'cash' : 'card',
    softwareId: String(input.softwareId || '').trim(),
    serialNo: String(input.serialNo || '').trim(),
    documentId: '',
    posEftTransactionId: null,
    posAcquirerId: null,
    posBankReferenceNo: null,
    recordedAmount: null,
    errorMessage: null,
    errorCode: null,
    billingSnapshot: input.billingSnapshot && typeof input.billingSnapshot === 'object' ? input.billingSnapshot : null,
    huginLines: Array.isArray(input.huginLines) ? input.huginLines : null,
    createdAt: now,
    updatedAt: now,
    paymentStartedAt: now,
  };

  store.operations[op.id] = op;
  saveStore(store);
  return { ok: true, operation: { ...op } };
}

/**
 * @param {string} id
 * @param {Partial<PosOperationRecord>} patch
 */
function updateOperation(id, patch) {
  const store = loadStore();
  const key = String(id || '').trim();
  const op = store.operations[key];
  if (!op) return null;
  Object.assign(op, patch, { updatedAt: Date.now() });
  saveStore(store);
  return { ...op };
}

function cancelOperation(id) {
  const store = loadStore();
  const key = String(id || '').trim();
  const op = store.operations[key];
  if (!op) return { ok: false, code: 'NOT_FOUND', message: 'Operation not found' };
  if (op.status === 'SUCCEEDED' || op.status === 'CANCELLED') {
    return { ok: false, code: 'NOT_CANCELLABLE', message: `Operation is ${op.status}` };
  }
  op.status = 'CANCELLED';
  op.phase = 'cancelled';
  op.updatedAt = Date.now();
  saveStore(store);
  return { ok: true, operation: { ...op } };
}

function wireOperationForApi(op) {
  if (!op) return null;
  return {
    id: op.id,
    posDeviceId: op.posDeviceId,
    merchantId: op.merchantId,
    tableId: op.tableId || null,
    sessionId: op.sessionId ?? null,
    status: op.status,
    phase: op.phase,
    amountTry: op.amountTry,
    posMethod: op.posMethod,
    documentId: op.documentId || null,
    proxyArgs: op.posDeviceId && op.softwareId && op.serialNo
      ? { posDeviceId: op.posDeviceId, softwareId: op.softwareId, serialNo: op.serialNo }
      : null,
    posEftTransactionId: op.posEftTransactionId ?? null,
    posAcquirerId: op.posAcquirerId ?? null,
    posBankReferenceNo: op.posBankReferenceNo ?? null,
    recordedAmount: op.recordedAmount ?? null,
    errorMessage: op.errorMessage ?? null,
    errorCode: op.errorCode ?? null,
    paymentStartedAt: op.paymentStartedAt,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  };
}

module.exports = {
  TTL_MS,
  getOperation,
  createOperation,
  updateOperation,
  cancelOperation,
  hasActiveProcessingForDevice,
  wireOperationForApi,
};

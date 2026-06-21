'use strict';

const express = require('express');
const {
  getOperation,
  cancelOperation,
  wireOperationForApi,
} = require('../lib/posOperationStore');
const { settleFiscalPending, dismissFiscalPending } = require('../lib/posBackendFiscalPending');

const router = express.Router();

router.post('/v1/pos-operations', (_req, res) => {
  return res.status(410).json({
    status: 'ERROR',
    error: {
      code: 'DEPRECATED',
      title: 'Local POS operations deprecated — use backend pos-payment-jobs',
    },
  });
});

router.get('/v1/pos-operations/:id', (req, res) => {
  const op = getOperation(req.params.id);
  if (!op) {
    return res.status(404).json({
      status: 'ERROR',
      error: { code: 'NOT_FOUND', title: 'Operation not found' },
    });
  }
  return res.json({ status: 'SUCCESS', data: wireOperationForApi(op) });
});

router.delete('/v1/pos-operations/:id', (req, res) => {
  const out = cancelOperation(req.params.id);
  if (!out.ok) {
    const status = out.code === 'NOT_FOUND' ? 404 : 409;
    return res.status(status).json({
      status: 'ERROR',
      error: { code: out.code, title: out.message },
    });
  }
  return res.json({ status: 'SUCCESS', data: wireOperationForApi(out.operation) });
});

/** BillingModal ödeme kaydı sonrası fiscal-pending settle. */
router.post('/v1/pos-operations/:id/ack-payment', async (req, res) => {
  const op = getOperation(req.params.id);
  if (!op) {
    return res.status(404).json({
      status: 'ERROR',
      error: { code: 'NOT_FOUND', title: 'Operation not found' },
    });
  }
  const paymentId = req.body && req.body.paymentId != null ? String(req.body.paymentId).trim() : '';
  if (!paymentId) {
    return res.status(400).json({
      status: 'ERROR',
      error: { code: 'INVALID_INPUT', title: 'paymentId required' },
    });
  }
  if (op.documentId) {
    const st = await settleFiscalPending(op.merchantId, op.documentId, paymentId);
    if (!st.ok) {
      await dismissFiscalPending(op.merchantId, op.documentId);
    }
  }
  return res.json({ status: 'SUCCESS', data: { ok: true } });
});

module.exports = router;

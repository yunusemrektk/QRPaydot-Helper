'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const iconv = require('iconv-lite');
const { SERVICE_VERSION } = require('../config');
const {
  normalizePrintEncoding,
  resolveCodePage,
  transliterateTurkishForCp1252,
  prepareTurkish857String,
  prepareAsciiReceiptString,
} = require('../lib/encoding');
const { buildEscPosPayload, withTrailingFeeds } = require('../lib/escpos');
const { sendToPrinter } = require('../lib/printer');
const { getPrintDefaults } = require('../lib/printerStore');

const router = Router();

/** Tarayıcı PRINT_JOB yedek yolu + doğrudan /v1/print aynı anda tetiklenirse tek fiziksel çıktı. */
let lastV1PrintKey = '';
let lastV1PrintAt = 0;
const V1_PRINT_DEDUPE_MS = 3500;

function v1PrintFingerprint(host, port, text) {
  const h = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
  return `${host}:${port}|${h}`;
}

/**
 * POST /v1/print
 * Body: { target: { host, port? }, text, cut?, encoding?, codePage?, cancelDoubleByte?, debug? }
 */
router.post('/v1/print', async (req, res) => {
  try {
    const body = req.body || {};
    const target = body.target;
    const text = typeof body.text === 'string' ? body.text : '';
    const cut = body.cut !== false;
    const enc = normalizePrintEncoding(body.encoding ?? getPrintDefaults().encoding);
    const wantDebug = body.debug === true || body.debug === 1 || body.debug === '1';
    const cancelDoubleByte =
      body.cancelDoubleByte === true || body.cancelDoubleByte === 1 || body.cancelDoubleByte === '1';
    const codePageRaw = body.codePage;
    const codePageOverride =
      typeof codePageRaw === 'number' && Number.isFinite(codePageRaw)
        ? codePageRaw
        : typeof codePageRaw === 'string' && /^\d+$/.test(codePageRaw.trim())
          ? Number(codePageRaw.trim())
          : undefined;

    if (!target || typeof target.host !== 'string' || !target.host.trim()) {
      return res.status(400).json({ error: 'target.host is required' });
    }
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const host = target.host.trim();
    const port = Number(target.port) > 0 ? Number(target.port) : 9100;

    const fp = v1PrintFingerprint(host, port, text);
    const now = Date.now();
    if (fp === lastV1PrintKey && now - lastV1PrintAt < V1_PRINT_DEDUPE_MS) {
      return res.json({ ok: true, deduped: true });
    }
    lastV1PrintKey = fp;
    lastV1PrintAt = now;

    const buf = buildEscPosPayload(text, enc, codePageOverride, { cancelDoubleByte });
    await sendToPrinter(host, port, [buf], cut);

    if (!wantDebug) {
      return res.json({ ok: true });
    }

    const sample = text.slice(0, 200);
    const codepoints = [];
    for (const ch of sample) {
      const cp = ch.codePointAt(0);
      codepoints.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    const tFeeds = withTrailingFeeds(text);
    const afterPrepare =
      enc === 'ascii'
        ? prepareAsciiReceiptString(tFeeds)
        : enc === 'turkish1252'
          ? transliterateTurkishForCp1252(tFeeds)
          : enc === 'turkish857'
            ? prepareTurkish857String(tFeeds)
            : null;
    let payloadBodyHex = null;
    if (afterPrepare != null) {
      if (enc === 'ascii') {
        payloadBodyHex = iconv.encode(afterPrepare, 'CP437').toString('hex');
      } else if (enc === 'turkish857') {
        payloadBodyHex = iconv.encode(afterPrepare, 'CP857').toString('hex');
      } else {
        payloadBodyHex = iconv.encode(afterPrepare, 'windows-1252').toString('hex');
      }
    }
    return res.json({
      ok: true,
      debug: {
        bridgeVersion: SERVICE_VERSION,
        encoding: enc,
        codePage: resolveCodePage(codePageOverride, enc),
        cancelDoubleByte,
        textSampleLength: text.length,
        textCodepointsFirst200: codepoints,
        afterPrepare,
        payloadBodyHex,
        escPosPayloadHexPrefix: buf.toString('hex').slice(0, 200),
      },
    });
  } catch (err) {
    console.error('[qrpaydot-helper] /v1/print', err.message || err);
    let message = err.message || 'print failed';
    if (/socket timeout|ETIMEDOUT|timed out/i.test(String(message))) {
      message +=
        ' — Ağ yolu yok veya yazıcı TCP 9100 dinlemiyor. USB-only bağlantıda fişteki Ethernet IP\'si kullanılamaz; RJ45 ile aynı ağa bağlayın veya PC\'nin o subnet\'e eriştiğini doğrulayın (ping).';
    } else if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i.test(String(message))) {
      message +=
        ' — Hedefe TCP ile ulaşılamıyor. IP/port ve kablosuz/kablolu ağ ayarlarını kontrol edin.';
    }
    res.status(500).json({ error: message });
  }
});

module.exports = router;

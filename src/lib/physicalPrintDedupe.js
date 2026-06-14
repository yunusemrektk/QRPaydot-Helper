'use strict';

const crypto = require('crypto');

/** WS PRINT_JOB ile tarayıcı /v1/print yedek yolu aynı metni kısa sürede iki kez basmasın. */
let lastFingerprint = '';
let lastAt = 0;
let lastDigestFingerprint = '';
let lastDigestAt = 0;
const DEDUPE_MS = 3500;

function textDigest(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 32);
}

function buildFingerprint(opts) {
  const text = typeof opts.text === 'string' ? opts.text : '';
  if (!text) return null;

  const digest = textDigest(text);
  const dedupeKey =
    opts.printDedupeKey != null && String(opts.printDedupeKey).trim()
      ? String(opts.printDedupeKey).trim().slice(0, 512)
      : '';

  if (dedupeKey) {
    return `${dedupeKey}|${digest}`;
  }
  if (opts.printerId) {
    return `p:${String(opts.printerId).trim()}|${digest}`;
  }
  if (opts.host) {
    const port = Number(opts.port) > 0 ? Number(opts.port) : 9100;
    return `h:${String(opts.host).trim()}:${port}|${digest}`;
  }
  return digest;
}

/**
 * @param {{ text: string, printDedupeKey?: string | null, printerId?: string | null, host?: string | null, port?: number | null }} opts
 * @returns {boolean} true → bu istek atlanmalı (yakın zamanda başarıyla basıldı)
 */
function shouldSkipDuplicatePhysicalPrint(opts) {
  const fp = buildFingerprint(opts);
  if (!fp) return false;

  const digestOnly = `d:${textDigest(opts.text)}`;
  const now = Date.now();
  if (fp === lastFingerprint && now - lastAt < DEDUPE_MS) {
    return true;
  }
  if (digestOnly === lastDigestFingerprint && now - lastDigestAt < DEDUPE_MS) {
    return true;
  }
  return false;
}

/**
 * Başarılı fiziksel baskıdan sonra dedupe kaydı güncellenir (başarısız deneme tekrarı engellemez).
 */
function recordSuccessfulPhysicalPrint(opts) {
  const fp = buildFingerprint(opts);
  if (!fp) return;
  const digestOnly = `d:${textDigest(opts.text)}`;
  const now = Date.now();
  lastFingerprint = fp;
  lastAt = now;
  lastDigestFingerprint = digestOnly;
  lastDigestAt = now;
}

module.exports = { shouldSkipDuplicatePhysicalPrint, recordSuccessfulPhysicalPrint };

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

/**
 * @param {{ text: string, printDedupeKey?: string | null, printerId?: string | null, host?: string | null, port?: number | null }} opts
 * @returns {boolean} true → bu istek atlanmalı (yakın zamanda basıldı)
 */
function shouldSkipDuplicatePhysicalPrint(opts) {
  const text = typeof opts.text === 'string' ? opts.text : '';
  if (!text) return false;

  const digest = textDigest(text);
  const dedupeKey =
    opts.printDedupeKey != null && String(opts.printDedupeKey).trim()
      ? String(opts.printDedupeKey).trim().slice(0, 512)
      : '';

  let fp;
  if (dedupeKey) {
    fp = `${dedupeKey}|${digest}`;
  } else if (opts.printerId) {
    fp = `p:${String(opts.printerId).trim()}|${digest}`;
  } else if (opts.host) {
    const port = Number(opts.port) > 0 ? Number(opts.port) : 9100;
    fp = `h:${String(opts.host).trim()}:${port}|${digest}`;
  } else {
    fp = digest;
  }

  const digestOnly = `d:${digest}`;
  const now = Date.now();
  if (fp === lastFingerprint && now - lastAt < DEDUPE_MS) {
    return true;
  }
  if (digestOnly === lastDigestFingerprint && now - lastDigestAt < DEDUPE_MS) {
    return true;
  }

  lastFingerprint = fp;
  lastAt = now;
  lastDigestFingerprint = digestOnly;
  lastDigestAt = now;
  return false;
}

module.exports = { shouldSkipDuplicatePhysicalPrint };

'use strict';

const iconv = require('iconv-lite');
const {
  transliterateTurkishForCp1252,
  prepareTurkish857String,
  prepareAsciiReceiptString,
  resolveCodePage,
} = require('./encoding');

/** ESC @ — reset */
const ESCPOS_INIT = Buffer.from([0x1b, 0x40]);

/** ESC/POS full cut (GS V 0) */
const CUT_FULL = Buffer.from([0x1d, 0x56, 0x00]);

/**
 * FS . (0x1C 0x2E) — cancel Kanji/Chinese double-byte mode.
 * Many Xprinter/SPRT-style firmwares default to GBK.
 */
const ESCPOS_CANCEL_DOUBLE_BYTE = Buffer.from([0x1c, 0x2e]);

/** ESC t n — select single-byte code table */
function escSelectCodePage(n) {
  return Buffer.from([0x1b, 0x74, n & 0xff]);
}

/** Extra blank lines before cut so the last text clears the cutter (tune 6–12 per printer). */
const TRAILING_LINE_FEEDS = '\n'.repeat(4);

function withTrailingFeeds(text) {
  return (text.endsWith('\n') ? text : `${text}\n`) + TRAILING_LINE_FEEDS;
}

function buildEscPosPayload(text, enc, codePageOverride, opts) {
  const cancelDoubleByte = Boolean(opts && opts.cancelDoubleByte);
  const t = withTrailingFeeds(text);
  let body;
  if (enc === 'ascii') {
    body = iconv.encode(prepareAsciiReceiptString(t), 'CP437');
  } else if (enc === 'turkish857') {
    body = iconv.encode(prepareTurkish857String(t), 'CP857');
  } else if (enc === 'turkish1252') {
    body = iconv.encode(transliterateTurkishForCp1252(t), 'windows-1252');
  } else if (enc === 'windows1252') {
    body = iconv.encode(t, 'windows-1252');
  } else if (enc === 'windows1254') {
    body = iconv.encode(t, 'windows-1254');
  } else if (enc === 'latin1') {
    body = Buffer.from(t, 'latin1');
  } else if (enc === 'cp857') {
    body = iconv.encode(t, 'CP857');
  } else if (enc === 'iso88599') {
    body = iconv.encode(t, 'iso-8859-9');
  } else {
    body = Buffer.from(t, 'utf8');
  }

  const cp = resolveCodePage(codePageOverride, enc);
  const parts = [ESCPOS_INIT];
  if (cancelDoubleByte) parts.push(ESCPOS_CANCEL_DOUBLE_BYTE);
  if (cp != null) parts.push(escSelectCodePage(cp));
  parts.push(body);
  return Buffer.concat(parts);
}

module.exports = {
  ESCPOS_INIT,
  CUT_FULL,
  ESCPOS_CANCEL_DOUBLE_BYTE,
  escSelectCodePage,
  withTrailingFeeds,
  buildEscPosPayload,
};

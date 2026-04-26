'use strict';

/** Epson/SPRT ESC/POS code page constants */
const CODEPAGE_WPC1252 = 16;
const CODEPAGE_PC857_TR = 13;
/** IBM PC437 (USA) — ASCII fişler (v1.0.1 termal uyumu) */
const CODEPAGE_PC437_US = 0;

function sanitizeReceiptUnicode(text) {
  let s = String(text)
    .replace(/\uFEFF/g, '')
    .replace(/[\u200B-\u200D\u2060]/g, '');
  s = s.normalize('NFKC').normalize('NFC');
  s = s.replace(/\u0069\u0307/g, 'i');
  return s;
}

/**
 * Maps Turkish letters that have no Windows-1252 code point to ASCII so bytes match WPC1252 glyphs.
 * u U o O c C stay; s/s, g, I (and decomposed i), i -> ASCII-safe.
 */
function transliterateTurkishForCp1252(text) {
  let s = sanitizeReceiptUnicode(text);

  const map = {
    '\u0131': 'i',
    '\u0130': 'I',
    '\u015F': 's',
    '\u015E': 'S',
    '\u0219': 's',
    '\u0218': 'S',
    '\u011F': 'g',
    '\u011E': 'G',
    '\u0406': 'I',
    '\u0456': 'i',
  };

  let out = '';
  for (const ch of s) {
    out += map[ch] ?? ch;
  }
  out = out.replace(/\u0307/g, '');
  return out;
}

/**
 * Fiş metni: Türkçe harfler ASCII’ye, kalan Latin aksanlar NFD ile sökülür, hâlâ >127 ise '?'.
 * CP437 / dar termal charset ile uyumlu çıktı.
 */
function prepareAsciiReceiptString(text) {
  let s = transliterateTurkishForCp1252(text);
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ch;
    } else if (cp >= 32 && cp <= 126) {
      out += ch;
    } else if (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) {
      out += ' ';
    } else {
      out += '?';
    }
  }
  return out;
}

/** PC857 Turkish — keeps s g I i; best match for SPRT / many ESC/POS units vs WPC1252. */
function prepareTurkish857String(text) {
  let s = sanitizeReceiptUnicode(text);
  const cy = { '\u0406': 'I', '\u0456': 'i' };
  let out = '';
  for (const ch of s) {
    out += cy[ch] ?? ch;
  }
  return out.replace(/\u0307/g, '');
}

/**
 * @param {string | undefined} raw
 * @returns {'ascii' | 'utf8' | 'turkish857' | 'turkish1252' | 'windows1252' | 'windows1254' | 'latin1' | 'cp857' | 'iso88599'}
 */
function normalizePrintEncoding(raw) {
  const s =
    raw == null || raw === ''
      ? 'ascii'
      : String(raw)
          .toLowerCase()
          .replace(/[-_\s]/g, '');
  if (s === 'utf8') return 'utf8';
  if (
    s === 'ascii' ||
    s === 'receiptascii' ||
    s === 'receipt' ||
    s === 'usascii' ||
    s === 'cp437ascii' ||
    s === 'cp437us'
  ) {
    return 'ascii';
  }
  if (s === 'turkish857' || s === 'pc857tr' || s === 'sprt' || s === 'sprtturkish') return 'turkish857';
  if (s === 'turkish1252' || s === 'cp1252tr' || s === 'wpc1252tr') return 'turkish1252';
  if (s === 'windows1252' || s === 'cp1252') return 'windows1252';
  if (s === 'windows1254' || s === 'cp1254' || s === 'win1254') return 'windows1254';
  if (s === 'latin1' || s === 'iso88591') return 'latin1';
  if (s === 'cp857' || s === 'ibm857' || s === 'pc857') return 'cp857';
  if (s === 'iso88599' || s === 'latin5' || s === 'iso8859') return 'iso88599';
  return 'ascii';
}

/**
 * @param {number | undefined} override from JSON `codePage` (wins when set)
 * @param {string} enc normalized encoding id
 * @returns {number | null}
 */
function resolveCodePage(override, enc) {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0 && override <= 255) {
    return override | 0;
  }
  if (enc === 'ascii') return CODEPAGE_PC437_US;
  if (enc === 'turkish857') return CODEPAGE_PC857_TR;
  if (enc === 'turkish1252') return CODEPAGE_WPC1252;
  return null;
}

module.exports = {
  CODEPAGE_WPC1252,
  CODEPAGE_PC857_TR,
  CODEPAGE_PC437_US,
  sanitizeReceiptUnicode,
  transliterateTurkishForCp1252,
  prepareTurkish857String,
  prepareAsciiReceiptString,
  normalizePrintEncoding,
  resolveCodePage,
};

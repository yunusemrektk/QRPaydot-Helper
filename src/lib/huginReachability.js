'use strict';

const TRANSPORT_ERROR_TITLES = new Set([
  'failed to fetch',
  'request timed out',
  'invalid response',
]);

function formatErr(err) {
  if (!err || typeof err !== 'object') return '';
  const code = err.code ? String(err.code).trim() : '';
  const title = err.title ? String(err.title).trim() : '';
  const desc = err.description ? String(err.description).trim() : '';
  const main = [code && `[${code}]`, title].filter(Boolean).join(' ');
  if (main && desc) return `${main} — ${desc}`;
  return main || desc;
}

function isHuginTransportError(error) {
  if (!error || typeof error !== 'object') return true;
  const title = String(error.title || error.message || '').trim().toLowerCase();
  if (TRANSPORT_ERROR_TITLES.has(title)) return true;
  if (title.includes('atanmadı')) return true;
  return false;
}

function isLikelyLostPosResponseError(error) {
  if (!error) return true;
  return isHuginTransportError(error);
}

function terminalStateIssueMessage(state) {
  return `ÖKC durumu uygun değil (state: ${state}).`;
}

function classifyHuginStatusJson(stJson) {
  if (stJson && stJson.status === 'SUCCESS' && stJson.data) {
    const stateRaw =
      stJson.data.state != null ? String(stJson.data.state).trim().toUpperCase() : '';
    if (stateRaw === 'SERVICE' || stateRaw === 'PREPARATION' || stateRaw === 'ERROR') {
      const rawState = stJson.data.state != null ? String(stJson.data.state).trim() : stateRaw;
      return {
        kind: 'reachable_issue',
        message: terminalStateIssueMessage(rawState),
        data: stJson.data,
      };
    }
    return { kind: 'ok', data: stJson.data };
  }

  const errObj = stJson && stJson.error;
  if (isHuginTransportError(errObj)) {
    return { kind: 'unreachable', message: formatErr(errObj) || 'POS unreachable' };
  }

  return {
    kind: 'reachable_issue',
    message: formatErr(errObj) || 'POS error',
    data: null,
  };
}

module.exports = {
  isHuginTransportError,
  isLikelyLostPosResponseError,
  classifyHuginStatusJson,
  formatErr,
};

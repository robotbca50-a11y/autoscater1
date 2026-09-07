function klaimExtractRecords(data) {
  let list = null;
  const candidates = [
    data?.data, data?.data?.records, data?.data?.list, data?.data?.result,
    data?.result, data?.records, data?.list, data?.transactions,
    data?.rows, data?.Data, data?.data?.Data, data?.data?.data,
    data?.response?.data, data?.result?.records, Array.isArray(data) ? data : null
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) { list = c; break; }
  }
  if (!list) list = klaimDeepFindArray(data);
  return list || [];
}

function klaimDeepFindArray(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
    if (['debet','debit','bet','betting','amount','stake','transactionId','sid','id'].some(k => k in (obj[0] || {}))) return obj;
  }
  for (const key of Object.keys(obj)) {
    const found = klaimDeepFindArray(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function klaimRecordSid(record) {
  return String(record?.transactionId ?? record?.transactionID ?? record?.transaction_id
    ?? record?.keteranganId ?? record?.billNo ?? record?.orderId ?? record?.orderID ?? record?.id
    ?? record?.sid ?? record?.sId ?? record?.SID ?? record?.kode ?? record?.code
    ?? record?.reff ?? record?.reference ?? record?.bonusCode ?? record?.txId
    ?? record?.trxId ?? record?.no ?? record?.gameId ?? '').trim();
}

function klaimDebitValue(record) {
  for (const key of ['debet', 'debit', 'bet', 'betting', 'amount', 'stake', 'actualStake']) {
    if (record && (record[key] !== undefined && record[key] !== null && record[key] !== '')) {
      const n = parseAmount(record[key]);
      if (n > 0) return n;
    }
  }
  return 0;
}

function klaimFindDebitRecord(records, sId) {
  const sid = String(sId || '').trim();
  let record = records.find(item => { const rs = String(klaimRecordSid(item) || '').trim(); return (rs === sid || rs.includes(sid)) && klaimDebitValue(item) > 0; });
  if (!record) record = records.find(item => klaimDebitValue(item) > 0) || null;
  return record;
}

function klaimGameId(record) {
  const raw = String(record?.gameName ?? record?.gameId ?? record?.gameID ?? record?.gameCode ?? '').trim();
  const colon = raw.split(':').pop().trim();
  return colon.match(/\d+/)?.[0] || raw.match(/\d+/)?.[0] || '74';
}

function klaimNormalizeBet(value) {
  return Number(String(value ?? '').replace(/[^\d]/g, '')) || 0;
}

function klaimNormalizeScatter(value) {
  const m = String(value ?? '').match(/\d+/);
  return Math.min(m ? Number(m[0]) : 0, 5);
}

function klaimFormatBet(value) {
  const n = klaimNormalizeBet(value);
  return n ? 'Rp ' + n.toLocaleString('id-ID') : '-';
}

function klaimFormatScatter(value) {
  const n = klaimNormalizeScatter(value);
  return n ? 'x' + n : '-';
}

function klaimCompareResult(expectedBet, actualBet, expectedScatter, actualScatter, errorText = '') {
  if (errorText) return { state: 'mismatch', label: 'GAGAL', detail: errorText, isApprove: false, betMatch: false, scatterMatch: false };
  const betMatch = klaimNormalizeBet(expectedBet) === klaimNormalizeBet(actualBet);
  const scatterMatch = klaimNormalizeScatter(expectedScatter) === klaimNormalizeScatter(actualScatter);
  if (betMatch && scatterMatch) return { state: 'match', label: 'COCOK', detail: 'Bet dan scatter cocok', isApprove: true, betMatch, scatterMatch };
  const misses = [];
  if (!betMatch) misses.push(`Bet beda: input ${klaimFormatBet(expectedBet)} / cek ${klaimFormatBet(actualBet)}`);
  if (!scatterMatch) misses.push(`Scatter beda: input ${klaimFormatScatter(expectedScatter)} / cek ${klaimFormatScatter(actualScatter)}`);
  return { state: 'mismatch', label: 'TIDAK COCOK', detail: misses.join('; '), isApprove: false, betMatch, scatterMatch };
}

function klaimUiRejectReason(cmp) {
  return (cmp && !cmp.isApprove) ? `${cmp.label} — ${cmp.detail}` : '';
}

function klaimClassifyBonusError(errMsg) {
  const e = String(errMsg || '').toLowerCase();
  if (e.includes('data mungkin belum siap') || e.includes('belum siap') || e.includes('belum tersedia')) return 'RETRY';
  if (e.includes('token belum') || e.includes('belum ada') || e.includes('header sniffer') || e.includes('gagal akses admin') || e.includes('cek token')) return 'SESSION_TIMEOUT';
  if (e.includes('token history') || e.includes('gagal akses json') || e.includes('timeout')) return 'RETRY';
  return 'REJECT';
}

function isSessionOrUnknownError(errMsg) {
  const e = String(errMsg || '').toLowerCase();
  return e.includes('session timeout') || e.includes('unknown error') || e.includes('token history') || e.includes('gagal akses json') || e.includes('401') || e.includes('403') || e.includes('unauthorized');
}

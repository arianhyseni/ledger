const CURRENCY_CODES = { '348': 'HUF', '826': 'GBP', '840': 'USD', '978': 'EUR' };

function decimalToCents(value) {
  const normalized = String(value || '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function result(format, fields = {}) {
  return {
    recognized: true,
    format,
    provider: null,
    amountCents: null,
    currency: null,
    accountReference: null,
    ...fields
  };
}

function parseEpc(payload) {
  const lines = payload.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== 'BCD' || lines[3] !== 'SCT') return null;
  const amount = /^([A-Z]{3})(\d+(?:[.,]\d{1,2})?)$/.exec((lines[7] || '').trim());
  return result('epc', {
    provider: (lines[5] || '').trim() || null,
    amountCents: amount ? decimalToCents(amount[2]) : null,
    currency: amount ? amount[1] : null,
    accountReference: (lines[9] || '').trim() || (lines[10] || '').trim() || (lines[6] || '').trim() || null
  });
}

function parseTlv(payload) {
  const tags = new Map();
  let offset = 0;
  while (offset + 4 <= payload.length) {
    const tag = payload.slice(offset, offset + 2);
    const lengthText = payload.slice(offset + 2, offset + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) return null;
    const length = Number(lengthText);
    const end = offset + 4 + length;
    if (end > payload.length) return null;
    tags.set(tag, payload.slice(offset + 4, end));
    offset = end;
  }
  return offset === payload.length ? tags : null;
}

function parseEmv(payload) {
  if (!payload.startsWith('0002')) return null;
  const tags = parseTlv(payload);
  if (!tags) return null;
  const additional = tags.has('62') ? parseTlv(tags.get('62')) : null;
  const provider = (tags.get('59') || '').trim() || null;
  const amountCents = decimalToCents(tags.get('54'));
  const currency = CURRENCY_CODES[tags.get('53')] || null;
  const accountReference = additional
    ? (additional.get('05') || additional.get('01') || '').trim() || null
    : null;
  if (!provider && amountCents === null && !accountReference) return null;
  return result('emv', { provider, amountCents, currency, accountReference });
}

function firstParam(params, aliases) {
  const lowered = new Map(Array.from(params.entries(), ([key, value]) => [key.toLowerCase(), value]));
  for (const alias of aliases) {
    const value = (lowered.get(alias) || '').trim();
    if (value) return value;
  }
  return null;
}

function parsePaymentUrl(payload) {
  let url;
  try { url = new URL(payload); } catch (_) { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const provider = firstParam(url.searchParams, ['provider', 'merchant', 'name', 'payee']);
  const amountCents = decimalToCents(firstParam(url.searchParams, ['amount', 'amt', 'value']));
  const currencyText = firstParam(url.searchParams, ['currency', 'ccy']);
  const accountReference = firstParam(url.searchParams, ['reference', 'ref', 'invoice', 'invoice_id', 'bill']);
  if (!provider && amountCents === null && !currencyText && !accountReference) return null;
  return result('payment-url', {
    provider,
    amountCents,
    currency: currencyText ? currencyText.toUpperCase() : null,
    accountReference
  });
}

export function parseBillPaymentCode(value, { allowLinear = false } = {}) {
  const payload = String(value || '').trim();
  if (!payload || payload.length > 16384) return { recognized: false, format: 'unknown' };
  const structured = parseEpc(payload) || parseEmv(payload) || parsePaymentUrl(payload);
  if (structured) return structured;
  if (allowLinear && payload.length <= 256 && /^[\p{L}\d][\p{L}\d./_-]{4,255}$/u.test(payload)) {
    return result('linear-barcode', { accountReference: payload });
  }
  return {
    recognized: false,
    format: 'unknown'
  };
}

export function parseBillQrPayload(value) {
  return parseBillPaymentCode(value);
}

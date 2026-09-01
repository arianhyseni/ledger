import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBillPaymentCode, parseBillQrPayload } from '../src/bill-qr.js';

function tlv(tag, value) {
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

test('EPC payment QR data autofills beneficiary, amount, currency, and reference', () => {
  const payload = [
    'BCD', '002', '1', 'SCT', '', 'Example Energy',
    'DE89370400440532013000', 'EUR42.75', '', 'RF18539007547034', '', ''
  ].join('\n');
  const parsed = parseBillQrPayload(payload);

  assert.equal(parsed.recognized, true);
  assert.equal(parsed.format, 'epc');
  assert.equal(parsed.provider, 'Example Energy');
  assert.equal(parsed.amountCents, 4275);
  assert.equal(parsed.currency, 'EUR');
  assert.equal(parsed.accountReference, 'RF18539007547034');
});

test('EMV payment QR data parses standard merchant fields', () => {
  const additional = tlv('05', 'INV-2026-09');
  const payload = [
    tlv('00', '01'), tlv('53', '348'), tlv('54', '12500.00'),
    tlv('59', 'Budapest Water'), tlv('62', additional)
  ].join('');
  const parsed = parseBillQrPayload(payload);

  assert.equal(parsed.format, 'emv');
  assert.equal(parsed.provider, 'Budapest Water');
  assert.equal(parsed.amountCents, 1250000);
  assert.equal(parsed.currency, 'HUF');
  assert.equal(parsed.accountReference, 'INV-2026-09');
});

test('payment URLs are read as data and unsupported QR payloads are rejected', () => {
  const parsed = parseBillQrPayload('https://pay.example.test/start?provider=FastNet&amount=19.99&currency=EUR&ref=ABC123');
  assert.equal(parsed.format, 'payment-url');
  assert.equal(parsed.provider, 'FastNet');
  assert.equal(parsed.amountCents, 1999);
  assert.equal(parsed.accountReference, 'ABC123');
  assert.deepEqual(parseBillQrPayload('plain barcode data'), { recognized: false, format: 'unknown' });
});

test('a linear bill barcode is retained as the payment reference', () => {
  const parsed = parseBillPaymentCode('10001234567890123456', { allowLinear: true });
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.format, 'linear-barcode');
  assert.equal(parsed.accountReference, '10001234567890123456');
  assert.equal(parseBillPaymentCode('10001234567890123456').recognized, false);
});

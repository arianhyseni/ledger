import test from 'node:test';
import assert from 'node:assert/strict';

import { extractBillFields, parseBillMoney } from '../src/bill-ocr.js';

test('parses European and English money formats into integer cents', () => {
  assert.equal(parseBillMoney('12 345,67 Ft'), 1234567);
  assert.equal(parseBillMoney('€1,249.50'), 124950);
  assert.equal(parseBillMoney('8.420 HUF'), 842000);
});

test('extracts fields from a Hungarian electricity bill', () => {
  const result = extractBillFields(`
    MVM Next Energiakereskedelmi Zrt.
    Villamos energia számla
    Felhasználó azonosító: 1234567890
    Fizetési határidő: 2026. 09. 18.
    Fogyasztás: 184 kWh
    Fizetendő összeg: 12 345 Ft
  `);

  assert.equal(result.provider, 'MVM Next Energiakereskedelmi Zrt.');
  assert.equal(result.utilityType, 'electricity');
  assert.equal(result.accountReference, '1234567890');
  assert.equal(result.dueDate, '2026-09-18');
  assert.equal(result.amountCents, 1234500);
  assert.equal(result.currency, 'HUF');
  assert.equal(result.usage, 184);
  assert.equal(result.usageUnit, 'kWh');
});

test('extracts fields from an English water bill', () => {
  const result = extractBillFields(`
    Provider: City Water Services Ltd
    Water utility bill
    Customer number: CW-2048-19
    Payment due: 18/09/2026
    Consumption: 12.4 m3
    Total due: EUR 48.75
  `);

  assert.equal(result.provider, 'City Water Services Ltd');
  assert.equal(result.utilityType, 'water');
  assert.equal(result.accountReference, 'CW-2048-19');
  assert.equal(result.dueDate, '2026-09-18');
  assert.equal(result.amountCents, 4875);
  assert.equal(result.currency, 'EUR');
  assert.equal(result.usage, 12.4);
  assert.equal(result.usageUnit, 'm³');
});

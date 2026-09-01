import test from 'node:test';
import assert from 'node:assert/strict';

import { extractBillFields, parseBillMoney, pdfTextFromItems } from '../src/bill-ocr.js';

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

test('extracts boxed Albanian fields from a Kosovo electricity bill', () => {
  const result = extractBillFields(`
    KESCO Energy
    Fatura e energjisë elektrike
    ID e konsumatorit:
    1234567890
    Afati i pagesës:
    18.09.2026
    Konsumi:
    184 kWh
    Shuma për pagesë:
    24,56 €
  `);

  assert.equal(result.provider, 'KESCO Energy');
  assert.equal(result.utilityType, 'electricity');
  assert.equal(result.accountReference, '1234567890');
  assert.equal(result.dueDate, '2026-09-18');
  assert.equal(result.amountCents, 2456);
  assert.equal(result.currency, 'EUR');
  assert.equal(result.usage, 184);
  assert.equal(result.usageUnit, 'kWh');
});

test('extracts Serbian Cyrillic labels from an electricity bill', () => {
  const result = extractBillFields(`
    EPS Снабдевање
    Рачун за електричну енергију
    Број купца: 99887766
    Рок плаћања: 20-09-2026
    Потрошња: 210 kWh
    Износ за плаћање: 35,20 EUR
  `);

  assert.equal(result.provider, 'EPS Снабдевање');
  assert.equal(result.utilityType, 'electricity');
  assert.equal(result.accountReference, '99887766');
  assert.equal(result.dueDate, '2026-09-20');
  assert.equal(result.amountCents, 3520);
  assert.equal(result.currency, 'EUR');
  assert.equal(result.usage, 210);
});

test('reconstructs PDF table rows by their coordinates before field extraction', () => {
  const text = pdfTextFromItems([
    { str: '24,56 €', transform: [1, 0, 0, 1, 260, 500] },
    { str: 'KESCO Energy', transform: [1, 0, 0, 1, 20, 700] },
    { str: 'Shuma për pagesë:', transform: [1, 0, 0, 1, 20, 500] },
    { str: '18.09.2026', transform: [1, 0, 0, 1, 260, 540] },
    { str: 'Afati i pagesës:', transform: [1, 0, 0, 1, 20, 540] }
  ]);
  assert.deepEqual(text.split('\n'), [
    'KESCO Energy',
    'Afati i pagesës: 18.09.2026',
    'Shuma për pagesë: 24,56 €'
  ]);
  const result = extractBillFields(text);
  assert.equal(result.dueDate, '2026-09-18');
  assert.equal(result.amountCents, 2456);
});

test('does not mistake a payment deadline or tariff row for the amount due', () => {
  const result = extractBillFields(`
    KESCO Energy
    Afati për pagesë: 18.09.2026
    Tarifa ditore: 0,12 EUR/kWh
    TVSH: 8%
  `);
  assert.equal(result.dueDate, '2026-09-18');
  assert.equal(result.amountCents, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRecurringActiveInMonth, monthsToMaterialize, durationLabel
} from '../src/recurring-expense-schedule.js';

test('an open-ended recurring expense is active every month from its start', () => {
  const rec = { start_month: '2026-03', duration_mode: 'open' };
  assert.equal(isRecurringActiveInMonth(rec, '2026-02'), false);
  assert.equal(isRecurringActiveInMonth(rec, '2026-03'), true);
  assert.equal(isRecurringActiveInMonth(rec, '2030-01'), true);
});

test('a fixed-months recurring expense stops after its span', () => {
  const rec = { start_month: '2026-01', duration_mode: 'months', duration_months: 3 };
  assert.equal(isRecurringActiveInMonth(rec, '2026-03'), true);
  assert.equal(isRecurringActiveInMonth(rec, '2026-04'), false);
});

test('an until-month recurring expense stops after that month, inclusive', () => {
  const rec = { start_month: '2026-01', duration_mode: 'until', until_month: '2026-06' };
  assert.equal(isRecurringActiveInMonth(rec, '2026-06'), true);
  assert.equal(isRecurringActiveInMonth(rec, '2026-07'), false);
});

test('stopping a recurring expense excludes the stop month onward but keeps history', () => {
  const rec = { start_month: '2026-01', duration_mode: 'open', stopped_from_month: '2026-05' };
  assert.equal(isRecurringActiveInMonth(rec, '2026-04'), true);
  assert.equal(isRecurringActiveInMonth(rec, '2026-05'), false);
});

test('monthsToMaterialize lists every active month up to the horizon, inclusive', () => {
  const rec = { start_month: '2026-01', duration_mode: 'months', duration_months: 2 };
  assert.deepEqual(monthsToMaterialize(rec, '2026-06'), ['2026-01', '2026-02']);
});

test('monthsToMaterialize returns nothing before the start month', () => {
  const rec = { start_month: '2026-05', duration_mode: 'open' };
  assert.deepEqual(monthsToMaterialize(rec, '2026-03'), []);
});

test('duration labels read naturally', () => {
  assert.equal(durationLabel({ duration_mode: 'open' }), 'Until stopped');
  assert.equal(durationLabel({ duration_mode: 'months', duration_months: 1 }), '1 month');
  assert.equal(durationLabel({ duration_mode: 'months', duration_months: 12 }), '12 months');
  assert.equal(durationLabel({ duration_mode: 'until', until_month: '2027-06' }), 'Until 2027-06');
});

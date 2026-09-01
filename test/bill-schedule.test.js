import test from 'node:test';
import assert from 'node:assert/strict';

import { billTiming, nextBillDueDate, recurrenceLabel } from '../src/bill-schedule.js';

test('recurring bill dates retain their preferred day when shorter months intervene', () => {
  assert.equal(nextBillDueDate('2026-01-31', 'monthly', 31), '2026-02-28');
  assert.equal(nextBillDueDate('2026-02-28', 'monthly', 31), '2026-03-31');
  assert.equal(nextBillDueDate('2027-11-30', 'quarterly', 30), '2028-02-29');
});

test('one-off and invalid bills do not create another due date', () => {
  assert.equal(nextBillDueDate('2026-01-31', 'once', 31), null);
  assert.equal(nextBillDueDate('not-a-date', 'monthly', 1), null);
});

test('bill timing distinguishes paid, overdue, soon, and later bills', () => {
  assert.equal(billTiming({ status: 'paid', due_date: '2026-09-01' }, '2026-09-01'), 'paid');
  assert.equal(billTiming({ status: 'due', due_date: '2026-08-31' }, '2026-09-01'), 'overdue');
  assert.equal(billTiming({ status: 'due', due_date: '2026-09-08' }, '2026-09-01'), 'soon');
  assert.equal(billTiming({ status: 'due', due_date: '2026-09-09' }, '2026-09-01'), 'due');
});

test('recurrence labels are user-facing', () => {
  assert.equal(recurrenceLabel('quarterly'), 'Every 3 months');
  assert.equal(recurrenceLabel('unknown'), 'One-off');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBillAlerts, buildBillTrend } from '../src/bill-insights.js';

const accounts = [
  { id: 'power', name: 'City Power' },
  { id: 'water', name: 'City Water' }
];

test('bill alerts report overdue, due soon, and unusual usage without flagging paid bills', () => {
  const bills = [
    { id: 'p1', account_id: 'power', due_date: '2026-05-01', amount: 1000, usage: 100, usage_unit: 'kWh', status: 'paid' },
    { id: 'p2', account_id: 'power', due_date: '2026-06-01', amount: 1100, usage: 105, usage_unit: 'kWh', status: 'paid' },
    { id: 'p3', account_id: 'power', due_date: '2026-08-28', amount: 1800, usage: 150, usage_unit: 'kWh', status: 'due' },
    { id: 'w1', account_id: 'water', due_date: '2026-09-04', amount: 2500, usage: null, usage_unit: '', status: 'due' },
    { id: 'w2', account_id: 'water', due_date: '2026-08-01', amount: 2200, usage: null, usage_unit: '', status: 'paid' }
  ];

  const alerts = buildBillAlerts(bills, accounts, '2026-09-01');
  assert.deepEqual(alerts.map(alert => alert.kind), ['overdue', 'due-soon', 'usage-spike']);
  assert.equal(alerts[0].days, 4);
  assert.equal(alerts[1].days, 3);
  assert.equal(alerts[2].percent, 46);
});

test('bill trends prefer usage history and fall back to cost', () => {
  const usageBills = [
    { id: '1', account_id: 'power', due_date: '2026-06-01', amount: 2000, usage: 80, usage_unit: 'kWh' },
    { id: '2', account_id: 'power', due_date: '2026-07-01', amount: 2200, usage: 100, usage_unit: 'kWh' },
    { id: '3', account_id: 'power', due_date: '2026-08-01', amount: 2400, usage: 120, usage_unit: 'kWh' },
    { id: 'future', account_id: 'power', due_date: '2026-10-01', amount: 9999, usage: 999, usage_unit: 'kWh' }
  ];
  const usageTrend = buildBillTrend(usageBills, 'power', '2026-09-01');
  assert.equal(usageTrend.metric, 'usage');
  assert.deepEqual(usageTrend.points.map(point => point.value), [80, 100, 120]);
  assert.equal(usageTrend.changePercent, 20);

  const costTrend = buildBillTrend([
    { id: '1', account_id: 'water', due_date: '2026-07-01', amount: 2000, usage: null, usage_unit: '' },
    { id: '2', account_id: 'water', due_date: '2026-08-01', amount: 2500, usage: null, usage_unit: '' }
  ], 'water', '2026-09-01');
  assert.equal(costTrend.metric, 'cost');
  assert.deepEqual(costTrend.points.map(point => point.value), [2000, 2500]);
});

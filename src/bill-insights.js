const DAY_MS = 24 * 60 * 60 * 1000;

function dateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function accountBills(bills, accountId, currentDate) {
  const todayValue = dateValue(currentDate);
  return bills
    .filter(bill => !bill.deleted && bill.account_id === accountId && dateValue(bill.due_date) <= todayValue)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
}

export function buildBillTrend(bills, accountId, currentDate, limit = 6) {
  const history = accountBills(bills, accountId, currentDate);
  if (history.length < 2) return null;

  const usageHistory = history.filter(bill =>
    bill.usage !== null && bill.usage !== undefined && bill.usage !== '' &&
    Number.isFinite(Number(bill.usage)) && Number(bill.usage) >= 0 && bill.usage_unit
  );
  const source = usageHistory.length >= 2 ? usageHistory : history.filter(bill => Number(bill.amount) > 0);
  if (source.length < 2) return null;

  const metric = usageHistory.length >= 2 ? 'usage' : 'cost';
  const selected = source.slice(-Math.max(2, limit));
  const points = selected.map(bill => ({
    billId: bill.id,
    dueDate: bill.due_date,
    value: metric === 'usage' ? Number(bill.usage) : Number(bill.amount)
  }));
  const latest = points.at(-1).value;
  const previous = points.at(-2).value;
  const changePercent = previous > 0 ? ((latest - previous) / previous) * 100 : null;
  const recentAmounts = history.filter(bill => Number(bill.amount) > 0).slice(-3).map(bill => Number(bill.amount));

  return {
    accountId,
    metric,
    unit: metric === 'usage' ? String(source.at(-1).usage_unit || 'units') : '',
    points,
    latest,
    average: average(points.map(point => point.value)),
    typicalAmountCents: average(recentAmounts),
    changePercent
  };
}

function spikeAlert(history, account, metric) {
  const usable = history.filter(bill => metric === 'usage'
    ? bill.usage !== null && bill.usage !== undefined && bill.usage !== '' &&
      Number.isFinite(Number(bill.usage)) && Number(bill.usage) >= 0 && bill.usage_unit
    : Number(bill.amount) > 0
  );
  if (usable.length < 3) return null;

  const latestBill = usable.at(-1);
  const previousBills = usable.slice(-4, -1);
  if (previousBills.length < 2) return null;
  const value = metric === 'usage' ? Number(latestBill.usage) : Number(latestBill.amount);
  const baseline = average(previousBills.map(bill =>
    metric === 'usage' ? Number(bill.usage) : Number(bill.amount)
  ));
  if (!baseline || value < baseline * 1.25) return null;
  if (metric === 'cost' && value - baseline < 500) return null;

  return {
    kind: metric === 'usage' ? 'usage-spike' : 'cost-spike',
    tone: 'warn',
    accountId: account.id,
    billId: latestBill.id,
    provider: account.name,
    dueDate: latestBill.due_date,
    value,
    baseline,
    percent: Math.round(((value - baseline) / baseline) * 100),
    unit: metric === 'usage' ? latestBill.usage_unit : ''
  };
}

export function buildBillAlerts(bills, accounts, currentDate) {
  const currentValue = dateValue(currentDate);
  if (!Number.isFinite(currentValue)) return [];
  const accountById = Object.fromEntries(accounts.filter(account => !account.deleted).map(account => [account.id, account]));
  const alerts = [];

  for (const bill of bills) {
    const account = accountById[bill.account_id];
    if (!account || bill.deleted || bill.status === 'paid') continue;
    const dueValue = dateValue(bill.due_date);
    if (!Number.isFinite(dueValue)) continue;
    const days = Math.round((dueValue - currentValue) / DAY_MS);
    if (days < 0) {
      alerts.push({
        kind: 'overdue', tone: 'bad', accountId: account.id, billId: bill.id,
        provider: account.name, dueDate: bill.due_date, days: Math.abs(days), amountCents: Number(bill.amount) || 0
      });
    } else if (days <= 7) {
      alerts.push({
        kind: 'due-soon', tone: 'warn', accountId: account.id, billId: bill.id,
        provider: account.name, dueDate: bill.due_date, days, amountCents: Number(bill.amount) || 0
      });
    }
  }

  for (const account of Object.values(accountById)) {
    const history = accountBills(bills, account.id, currentDate);
    const usageSpike = spikeAlert(history, account, 'usage');
    if (usageSpike) alerts.push(usageSpike);
    else {
      const costSpike = spikeAlert(history, account, 'cost');
      if (costSpike) alerts.push(costSpike);
    }
  }

  const priority = { overdue: 0, 'due-soon': 1, 'usage-spike': 2, 'cost-spike': 3 };
  return alerts.sort((a, b) =>
    priority[a.kind] - priority[b.kind] || a.dueDate.localeCompare(b.dueDate)
  );
}

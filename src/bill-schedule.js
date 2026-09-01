export const BILL_RECURRENCE_MONTHS = Object.freeze({
  monthly: 1,
  quarterly: 3,
  yearly: 12
});

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function nextBillDueDate(currentDueDate, recurrence, preferredDay) {
  const current = parseIsoDate(currentDueDate);
  const months = BILL_RECURRENCE_MONTHS[recurrence];
  if (!current || !months) return null;

  const targetMonthIndex = current.year * 12 + current.month - 1 + months;
  const year = Math.floor(targetMonthIndex / 12);
  const month = targetMonthIndex % 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const requestedDay = Number(preferredDay) || current.day;
  return isoDate(year, month, Math.min(Math.max(requestedDay, 1), lastDay));
}

export function billTiming(bill, currentDate) {
  if (bill && bill.status === 'paid') return 'paid';
  const today = parseIsoDate(currentDate);
  const due = parseIsoDate(bill && bill.due_date);
  if (!today || !due) return 'due';
  if (bill.due_date < currentDate) return 'overdue';

  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const dueUtc = Date.UTC(due.year, due.month - 1, due.day);
  return dueUtc - todayUtc <= 7 * 86400000 ? 'soon' : 'due';
}

export function recurrenceLabel(recurrence) {
  return ({
    monthly: 'Monthly',
    quarterly: 'Every 3 months',
    yearly: 'Yearly',
    once: 'One-off'
  })[recurrence] || 'One-off';
}

/* ---------------------------------------------------------
   recurring-expense-schedule.js — pure date math for recurring
   expenses (loan payments, subscriptions, kindergarten, etc.)

   Unlike bills, a recurring expense has no due date or OCR —
   it is a plain categorized amount that applies to a run of
   months. Kept as pure functions, same split as bill-schedule.js,
   so the scheduling logic is unit-testable without Dexie.
--------------------------------------------------------- */

function parseMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [, year, month] = match.map(Number);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function monthIndex(month) {
  const parsed = parseMonth(month);
  if (!parsed) return null;
  return parsed.year * 12 + (parsed.month - 1);
}

export function monthFromIndex(index) {
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// Is `month` inside the recurring expense's active range? Accounts for
// its start month, an optional "stopped from" cutoff, and whichever
// duration mode it was set up with.
export function isRecurringActiveInMonth(rec, month) {
  const monthIdx = monthIndex(month);
  const startIdx = monthIndex(rec && rec.start_month);
  if (monthIdx === null || startIdx === null) return false;
  if (monthIdx < startIdx) return false;

  if (rec.stopped_from_month) {
    const stopIdx = monthIndex(rec.stopped_from_month);
    if (stopIdx !== null && monthIdx >= stopIdx) return false;
  }

  if (rec.duration_mode === 'months' && rec.duration_months) {
    const endIdx = startIdx + Number(rec.duration_months); // exclusive
    if (monthIdx >= endIdx) return false;
  }

  if (rec.duration_mode === 'until' && rec.until_month) {
    const untilIdx = monthIndex(rec.until_month);
    if (untilIdx !== null && monthIdx > untilIdx) return false;
  }

  return true;
}

// Every month from start_month through horizonMonth (inclusive) that
// this recurring expense should have a generated expense row in.
export function monthsToMaterialize(rec, horizonMonth) {
  const startIdx = monthIndex(rec && rec.start_month);
  const horizonIdx = monthIndex(horizonMonth);
  if (startIdx === null || horizonIdx === null) return [];

  const out = [];
  for (let i = startIdx; i <= horizonIdx; i++) {
    const month = monthFromIndex(i);
    if (isRecurringActiveInMonth(rec, month)) out.push(month);
  }
  return out;
}

// Human label for the duration a recurring expense runs.
export function durationLabel(rec) {
  if (!rec) return '';
  if (rec.duration_mode === 'months' && rec.duration_months) {
    return `${rec.duration_months} month${rec.duration_months === 1 ? '' : 's'}`;
  }
  if (rec.duration_mode === 'until' && rec.until_month) {
    return `Until ${rec.until_month}`;
  }
  return 'Until stopped';
}

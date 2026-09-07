/* ---------------------------------------------------------
   recurring-expenses.js — recurring spend (loan, subscriptions,
   kindergarten, etc.) and the monthly expense rows it generates

   Mirrors bills.js's materialization pattern, but recurring
   expenses have no due date, OCR, or paid status — they are
   plain categorized amounts that generate a real row in
   `expenses` for every month they are active.
--------------------------------------------------------- */

let recurringScheduleQueue = Promise.resolve();

function ensureScheduledRecurringExpenses(month) {
  const run = recurringScheduleQueue.then(() => materializeRecurringExpenses(month));
  // Same reasoning as bills' queue: keep it usable after a failed run
  // while still returning the real rejection to the caller.
  recurringScheduleQueue = run.catch(() => {});
  return run;
}

async function materializeRecurringExpenses(month) {
  const recs = await live('recurring_expenses');
  const horizon = month > monthOf(today()) ? month : monthOf(today());
  let changed = false;

  for (const rec of recs) {
    const months = window.TillRollRecurring.monthsToMaterialize(rec, horizon);
    for (const m of months) {
      const existing = await db.expenses
        .where('[recurring_expense_id+month]')
        .equals([rec.id, m])
        .first();
      if (existing && !existing.deleted) continue;

      await db.expenses.put(stamp({
        id: uuid(),
        date: `${m}-01`,
        month: m,
        amount: rec.amount,
        category_id: rec.category_id,
        store_id: null,
        note: rec.note || '',
        has_receipt: false,
        recurring_expense_id: rec.id
      }));
      changed = true;
    }
  }

  if (changed) scheduleSync();
}

/* ---------- CRUD ---------- */

async function saveRecurringExpense({ id, name, categoryId, amount, startMonth, durationMode, durationMonths, untilMonth, note }) {
  const recurringId = id || uuid();
  const existing = id ? await db.recurring_expenses.get(id) : null;

  const row = stamp({
    ...(existing || {}),
    id: recurringId,
    name: name.trim(),
    category_id: categoryId,
    amount,
    start_month: startMonth,
    duration_mode: durationMode,
    duration_months: durationMode === 'months' ? Number(durationMonths) || 1 : null,
    until_month: durationMode === 'until' ? untilMonth : null,
    active: true,
    stopped_from_month: null,
    note: note || ''
  });

  await db.recurring_expenses.put(row);
  await ensureScheduledRecurringExpenses(state.month);
  scheduleSync();
  return row;
}

// Updates an already-generated month's amount without touching the
// recurring template — "this month only" in the edit-scope sheet.
async function editGeneratedExpenseAmount(expenseId, amount) {
  const row = await db.expenses.get(expenseId);
  if (!row || row.deleted) return;
  await db.expenses.put(stamp({ ...row, amount }));
  await renderActive();
  scheduleSync();
}

// Updates the recurring template's amount going forward, and patches
// any months already materialized but still in the future so they
// don't disagree with the new figure until the schedule catches up.
async function editRecurringExpenseAmount(recurringId, amount) {
  const rec = await db.recurring_expenses.get(recurringId);
  if (!rec || rec.deleted) return;

  await db.recurring_expenses.put(stamp({ ...rec, amount }));

  const currentMonth = monthOf(today());
  const generated = await liveWhere('expenses', 'recurring_expense_id', recurringId);
  for (const row of generated) {
    if (row.month >= currentMonth) {
      await db.expenses.put(stamp({ ...row, amount }));
    }
  }

  await renderActive();
  scheduleSync();
}

async function stopRecurringExpense(id) {
  const rec = await db.recurring_expenses.get(id);
  if (!rec || rec.deleted || !rec.active) return;
  if (!await appConfirm(
    `Stop ${rec.name}? Months already generated stay in your history.`,
    { okLabel: 'Stop from next month', danger: true }
  )) return;

  const stopMonth = window.TillRollRecurring.monthFromIndex(
    window.TillRollRecurring.monthIndex(monthOf(today())) + 1
  );
  await db.recurring_expenses.put(stamp({ ...rec, active: false, stopped_from_month: stopMonth }));
  await renderActive();
  toast('Future months stopped.');
  scheduleSync();
}

async function deleteRecurringExpense(id) {
  const rec = await db.recurring_expenses.get(id);
  if (!rec || rec.deleted) return;
  if (!await appConfirm(
    'Delete this recurring expense? Months already generated stay in your history.',
    { okLabel: 'Delete', danger: true }
  )) return;
  await db.recurring_expenses.put(stamp({ ...rec, deleted: 1 }));
  await renderActive();
  toast('Recurring expense deleted.');
  scheduleSync();
}

/* ---------- edit-scope sheet ----------
   Tapping a generated row in the Expenses list needs to ask "this
   month only, or every month from here on?" before an amount change
   can be applied — the same ambiguity a recurring calendar event has
   when you edit one occurrence. */
async function openGeneratedExpenseSheet(expenseId) {
  const row = await db.expenses.get(expenseId);
  if (!row || row.deleted) return;
  const rec = row.recurring_expense_id ? await db.recurring_expenses.get(row.recurring_expense_id) : null;

  const html = `
    <div class="sheet-handle"></div>
    <div class="sheet-title">${escapeHtml(rec ? rec.name : 'Recurring expense')}</div>
    <p class="hint">${fromCents(row.amount)} this month.</p>
    <div class="sheet-options">
      <button type="button" class="sheet-option" data-action="month">
        <span class="sheet-option-label">Edit amount — this month only</span>
      </button>
      <button type="button" class="sheet-option" data-action="all" ${rec ? '' : 'disabled'}>
        <span class="sheet-option-label">Edit amount — this and future months</span>
      </button>
      <button type="button" class="sheet-option" data-action="manage" ${rec ? '' : 'disabled'}>
        <span class="sheet-option-label">Manage recurring expense</span>
      </button>
      <button type="button" class="sheet-option" data-action="delete">
        <span class="sheet-option-label">Delete this month's expense</span>
      </button>
    </div>`;

  openBottomSheet(html, sheet => {
    sheet.querySelector('[data-action="month"]').onclick = async () => {
      closeBottomSheet();
      const value = await appPrompt('New amount for this month only:', fromCents(row.amount));
      if (value === null) return;
      const amount = toCents(value);
      if (amount <= 0) { toast('Enter an amount above zero.'); return; }
      await editGeneratedExpenseAmount(expenseId, amount);
      toast('This month updated.');
    };

    sheet.querySelector('[data-action="all"]').onclick = async () => {
      closeBottomSheet();
      if (!rec) return;
      const value = await appPrompt('New amount from this month on:', fromCents(row.amount));
      if (value === null) return;
      const amount = toCents(value);
      if (amount <= 0) { toast('Enter an amount above zero.'); return; }
      await editRecurringExpenseAmount(rec.id, amount);
      toast('Recurring expense updated.');
    };

    sheet.querySelector('[data-action="manage"]').onclick = () => {
      closeBottomSheet();
      if (!rec) return;
      switchScreen('settings');
      openRecurringEditor(rec.id);
    };

    sheet.querySelector('[data-action="delete"]').onclick = async () => {
      closeBottomSheet();
      await deleteExpense(expenseId);
    };
  });
}

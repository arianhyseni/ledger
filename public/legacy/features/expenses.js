/* ---------------------------------------------------------
   expenses.js — income, expense entry, list, budget strip
--------------------------------------------------------- */

// Shared on window, not a bare script-scoped variable, because the
// Add-expense sheet (compiled as an ES module in main.js, a separate
// top-level scope from this classic script) needs to read/write it too.
window.pendingReceiptPhoto = null;

function initExpenses() {
  $('incomeInput').onchange = saveIncome;
  $('debtInput').onchange = saveIncome;
  $('expenseForm').onsubmit = saveExpense;
  $('exDate').value = today();

  $('exPhoto').onchange = e => {
    window.pendingReceiptPhoto = e.target.files[0] || null;
    $('photoLabel').textContent = window.pendingReceiptPhoto ? 'Receipt attached' : 'Attach receipt';
    $('exPhoto').parentElement.classList.toggle('has', !!window.pendingReceiptPhoto);
  };

  $('viewerClose').onclick = closeViewer;
  // Backdrop click may close here — a receipt view holds no unsaved input.
  $('viewer').onclick = e => { if (e.target.id === 'viewer') closeViewer(); };
}

/* ---------- lookups ---------- */

async function fillCategorySelects() {
  const cats = (await live('categories')).sort((a, b) => a.name.localeCompare(b.name));
  const options = cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  $('exCategory').innerHTML = options;
  $('recCategory').innerHTML = options;

  // Bills have their own workflow. Keep this category available for paid-bill
  // expenses and reporting, but do not offer it when classifying products.
  $('pCategory').innerHTML = cats
    .filter(c => c.name.trim().toLowerCase() !== 'bills & utilities')
    .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join('');
}

async function fillStoreLists() {
  const stores = (await live('stores')).sort((a, b) => a.name.localeCompare(b.name));
  $('storeList').innerHTML = stores.map(s => `<option value="${escapeHtml(s.name)}">`).join('');
}

async function resolveStore(name) {
  const clean = name.trim();
  if (!clean) return null;

  const stores = await live('stores');
  const found = stores.find(s => s.name.toLowerCase() === clean.toLowerCase());
  if (found) return found.id;

  const row = stamp({ id: uuid(), name: clean, location: '', note: '' });
  await db.stores.put(row);
  await fillStoreLists();
  return row.id;
}

/* ---------- income ---------- */

async function saveIncome() {
  const amount = toCents($('incomeInput').value);
  const debt   = toCents($('debtInput').value);
  const rows = await liveWhere('income', 'month', state.month);

  if (rows.length) {
    await db.income.put(stamp({ ...rows[0], amount, debt }));
  } else {
    await db.income.put(stamp({
      id: uuid(), month: state.month, amount, debt, source: '', note: ''
    }));
  }

  await renderExpenses();
  scheduleSync();
}

/* ---------- expense CRUD ---------- */

// Shared by the inline form and the Add-expense sheet: builds one
// expense row (optionally with a receipt photo). When `repeat` is
// given, this instead creates a recurring_expenses template — its own
// materialization step generates this month's row, so no second row
// is inserted here; the photo (a device-local attachment, not part of
// the template) is attached to that generated row afterward.
async function buildAndSaveExpense({ amount, date, categoryId, storeName, note, photo, repeat }) {
  if (amount <= 0) throw new Error('Enter an amount above zero.');

  const resolvedDate = date || today();

  if (repeat) {
    const rec = await saveRecurringExpense({
      name: 'Recurring expense',
      categoryId,
      amount,
      startMonth: monthOf(resolvedDate),
      durationMode: repeat.durationMode,
      durationMonths: repeat.durationMonths,
      untilMonth: repeat.untilMonth,
      note
    });
    const generated = await db.expenses
      .where('[recurring_expense_id+month]')
      .equals([rec.id, monthOf(resolvedDate)])
      .first();
    if (generated && photo) {
      await db.expenses.put(stamp({ ...generated, has_receipt: true }));
      await db.receipts.put({ id: uuid(), expense_id: generated.id, blob: photo, created_at: now() });
    }
    state.month = monthOf(resolvedDate);
    await renderActive();
    return generated;
  }

  const store_id = storeName ? await resolveStore(storeName) : null;
  const id = uuid();
  const row = stamp({
    id,
    date: resolvedDate,
    month: monthOf(resolvedDate),
    amount,
    category_id: categoryId || null,
    store_id,
    note: (note || '').trim(),
    has_receipt: !!photo,
    recurring_expense_id: null
  });
  await db.expenses.put(row);

  if (photo) {
    await db.receipts.put({ id: uuid(), expense_id: id, blob: photo, created_at: now() });
  }

  state.month = monthOf(resolvedDate);
  await renderActive();
  scheduleSync();
  return row;
}

async function saveExpense(e) {
  e.preventDefault();

  const amount = toCents($('exAmount').value);
  if (amount <= 0) { toast('Enter an amount above zero.'); return; }

  try {
    await buildAndSaveExpense({
      amount,
      date: $('exDate').value,
      categoryId: $('exCategory').value,
      storeName: $('exStore').value,
      note: $('exNote').value,
      photo: window.pendingReceiptPhoto
    });
  } catch (err) {
    toast(err.message);
    return;
  }

  // Keep date and store — expenses usually come in batches.
  $('exAmount').value = '';
  $('exNote').value = '';
  window.pendingReceiptPhoto = null;
  $('exPhoto').value = '';
  $('photoLabel').textContent = 'Attach receipt';
  $('exPhoto').parentElement.classList.remove('has');

  $('exAmount').focus();
  toast('Expense saved.');
}

async function deleteExpense(id) {
  if (!await appConfirm('Delete this expense?', { okLabel: 'Delete', danger: true })) return;

  const row = await db.expenses.get(id);
  if (!row) return;

  // Soft delete, so the removal reaches other devices.
  await db.expenses.put(stamp({ ...row, deleted: 1 }));

  const items = await db.expense_items.where('expense_id').equals(id).toArray();
  for (const i of items) await db.expense_items.put(stamp({ ...i, deleted: 1 }));

  // Photos are local-only, so they go for good.
  await db.receipts.where('expense_id').equals(id).delete();

  await renderExpenses();
  scheduleSync();
}

/* ---------- receipt viewer ---------- */

let viewerReturnFocus = null;

function onViewerKey(e) {
  if (e.key === 'Escape') closeViewer();
}

async function openReceipt(expenseId) {
  const r = await db.receipts.where('expense_id').equals(expenseId).first();
  if (!r) { toast('Receipt is stored on the device it was taken on.'); return; }

  const exp = await db.expenses.get(expenseId);
  openViewerBlob(r.blob, {
    label: 'Receipt',
    alt: exp
    ? `Receipt for ${fromCents(exp.amount)} on ${dayLabel(exp.date)}`
      : 'Receipt'
  });
}

function openViewerBlob(blob, { label, alt } = {}) {
  viewerReturnFocus = document.activeElement;
  const objectUrl = URL.createObjectURL(blob);
  const viewer = $('viewer');
  const image = $('viewerImg');
  const pdf = $('viewerPdf');
  viewer.setAttribute('aria-label', label || 'Document');
  viewer.dataset.objectUrl = objectUrl;

  if (blob.type === 'application/pdf') {
    image.hidden = true;
    image.src = '';
    pdf.hidden = false;
    pdf.src = objectUrl;
  } else {
    pdf.hidden = true;
    pdf.removeAttribute('src');
    image.hidden = false;
    image.alt = alt || label || 'Document';
    image.src = objectUrl;
  }
  $('viewer').hidden = false;
  document.addEventListener('keydown', onViewerKey);
  $('viewerClose').focus();
}

function closeViewer() {
  const viewer = $('viewer');
  if (viewer.dataset.objectUrl) URL.revokeObjectURL(viewer.dataset.objectUrl);
  delete viewer.dataset.objectUrl;
  $('viewerImg').src = '';
  $('viewerImg').hidden = false;
  $('viewerPdf').removeAttribute('src');
  $('viewerPdf').hidden = true;
  viewer.hidden = true;
  document.removeEventListener('keydown', onViewerKey);
  if (viewerReturnFocus && viewerReturnFocus.isConnected) viewerReturnFocus.focus();
  viewerReturnFocus = null;
}

/* ---------- render ---------- */

async function renderExpenses() {
  await ensureScheduledRecurringExpenses(state.month);
  const [incomeRows, expenses, cats, stores] = await Promise.all([
    liveWhere('income', 'month', state.month),
    liveWhere('expenses', 'month', state.month),
    live('categories'),
    live('stores')
  ]);

  const catName   = Object.fromEntries(cats.map(c => [c.id, c.name]));
  const storeName = Object.fromEntries(stores.map(s => [s.id, s.name]));

  const income = incomeRows.length ? incomeRows[0].amount : 0;
  const debt   = incomeRows.length ? (incomeRows[0].debt || 0) : 0;
  const spent  = expenses.reduce((s, e) => s + e.amount, 0);

  $('incomeInput').value = income ? fromCents(income) : '';
  $('debtInput').value   = debt ? fromCents(debt) : '';
  document.querySelectorAll('.cur-sym').forEach(el => el.textContent = window.CURRENCY);

  renderStrip(income, debt, spent, await debtAlreadyCounted());
  renderExpenseList(expenses, catName, storeName);
}

// True once the one-time debt migration has converted a month's Loan /
// debt figure into a recurring expense: that recurring expense's
// generated row is already inside `spent`, so subtracting `debt` too
// would count the same loan payment twice.
async function debtAlreadyCounted() {
  return !!(await getMeta('debtMigratedRecurringExpenseId', null));
}

// Pure budget math, shared by the Expenses strip and the Home hero so
// the two screens can never show different numbers for the same month.
function computeBudget(month, income, debt, spent, debtCounted) {
  const effectiveDebt = debtCounted ? 0 : debt;
  const available  = income - effectiveDebt;         // may be <= 0
  const remaining  = available - spent;
  const total      = daysInMonth(month);
  const elapsedRaw = daysElapsed(month);              // 0 for future months
  const nowMonth   = monthOf(today());
  const isFuture   = month > nowMonth;
  const isCurrent  = month === nowMonth;
  const avgPerDay  = spent / Math.max(elapsedRaw, 1);
  // A projection from zero elapsed days is meaningless — never fake one.
  const projected  = isFuture ? 0 : Math.round(avgPerDay * total);
  const target     = Number(window.SAVINGS_TARGET || 20);
  const base       = Math.max(available, 0);
  const pctSpent   = base > 0 ? Math.min(spent / base * 100, 100) : 0;
  const pctProj    = base > 0 ? Math.min(projected / base * 100, 100) : 0;
  const cap        = available - Math.round(income * target / 100);
  const pctCap     = base > 0 ? cap / base * 100 : 0;
  const saveRate   = income > 0 && !isFuture
    ? Math.round((income - effectiveDebt - projected) / income * 100)
    : null;

  return {
    income, debt: effectiveDebt, spent, available, remaining,
    total, elapsedRaw, isFuture, isCurrent, avgPerDay, projected, target,
    base, pctSpent, pctProj, pctCap, saveRate,
    daysLeft: isCurrent ? total - elapsedRaw : (isFuture ? total : 0)
  };
}

// The loan repayment is money already committed, so everything
// is measured against what is actually left to spend. The headline
// answers §10.1 of the product brief in order: what is available,
// am I on pace, and what changed — with honest states when income
// is missing, debt exceeds income, or the month hasn't started.
function renderStrip(income, debt, spent, debtCounted) {
  const b = computeBudget(state.month, income, debt, spent, debtCounted);
  const {
    available, remaining, total, elapsedRaw, isFuture, isCurrent,
    projected, avgPerDay, saveRate, daysLeft, base, pctSpent, pctProj, pctCap
  } = b;
  debt = b.debt; // legacy-debt already zeroed out once migrated

  /* ---- headline ---- */
  const eyebrow = $('heroEyebrow');
  const big     = $('heroRemaining');
  const eq      = $('heroEquation');
  const status  = $('heroStatus');

  if (income <= 0) {
    // Without income, spending is not automatically overspending.
    eyebrow.textContent = 'Spent so far';
    big.textContent = fmtCents(spent);
    big.classList.remove('neg');
    eq.hidden = true;
    status.textContent = spent > 0
      ? 'Set your income above to see what is actually available this month.'
      : 'Set your income above, then add expenses as they happen.';
  } else if (available <= 0) {
    eyebrow.textContent = 'Committed above income';
    big.textContent = fmtCents(available);
    big.classList.add('neg');
    eq.hidden = false;
    eq.textContent = `${money(income)} income − ${money(debt)} loan`;
    status.textContent = 'The loan commitment meets or exceeds income this month, so there is no available amount to measure spending against.';
  } else {
    eyebrow.textContent = remaining >= 0 ? 'Available this month' : 'Above available by';
    big.textContent = fmtCents(Math.abs(remaining));
    big.classList.toggle('neg', remaining < 0);
    eq.hidden = false;
    eq.textContent = debt > 0
      ? `${money(income)} income − ${money(debt)} loan − ${money(spent)} spent`
      : `${money(income)} income − ${money(spent)} spent`;

    if (isFuture) {
      status.textContent = 'This month has not started yet.';
    } else if (!spent) {
      status.textContent = 'Nothing spent yet this month.';
    } else if (isCurrent) {
      status.textContent = projected <= available
        ? `On pace to keep ${money(available - projected)} of the ${money(available)} available after the loan.`
        : `On pace to finish ${money(projected - available)} above the ${money(available)} available after the loan.`;
    } else {
      status.textContent = remaining >= 0
        ? `Finished with ${money(remaining)} kept of the ${money(available)} available.`
        : `Finished ${money(-remaining)} above the ${money(available)} available.`;
    }
  }

  /* ---- progress track (visuals clamp; text stays exact) ---- */
  const fill = $('stripFill');
  fill.style.width = pctSpent + '%';
  fill.classList.toggle('over', base > 0 && spent > base);

  const marker = $('stripMarker');
  marker.hidden = base <= 0 || isFuture || !spent;
  marker.style.left = pctProj + '%';

  // Savings-target marker: the spend level that would still meet the
  // target. Hidden near the edges where its label cannot fit legibly.
  const targetEl = $('stripTarget');
  const showTarget = income > 0 && base > 0 && pctCap > 6 && pctCap < 94;
  targetEl.hidden = !showTarget;
  if (showTarget) targetEl.style.left = pctCap + '%';

  $('stripSpent').textContent = fmtCents(spent) + ' spent';
  $('stripLeft').textContent  = base > 0
    ? (base - spent >= 0 ? fmtCents(base - spent) + ' left'
                         : fmtCents(spent - base) + ' over')
    : (income > 0 ? 'nothing to spend after the loan' : 'set your income');

  /* ---- supporting metrics ---- */
  $('mAvg').textContent  = isFuture ? '—' : fromCents(Math.round(avgPerDay));
  $('mProj').textContent = isFuture ? '—' : fromCents(projected);
  $('mSave').textContent = saveRate === null ? '—' : saveRate + '%';
  $('mDays').textContent = String(daysLeft);
}

// Generated (recurring) rows are shown flat and separately from
// hand-entered ones — a recurring expense already has at most one row
// per month, so day-grouping would add nothing there; it's exactly
// what a recurring template collapses.
function renderExpenseList(expenses, catName, storeName) {
  const generated = expenses.filter(e => e.recurring_expense_id);
  const manual = expenses.filter(e => !e.recurring_expense_id);
  renderGeneratedSection(generated, catName);
  renderManualSection(manual, catName, storeName);
}

function renderGeneratedSection(generated, catName) {
  $('recurringExpensesHead').hidden = !generated.length;
  const total = generated.reduce((s, e) => s + e.amount, 0);
  $('recurringExpensesTotal').textContent = generated.length ? fromCents(total) : '';

  $('recurringExpensesList').innerHTML = generated.length
    ? `<div class="daygroup recurring-card">${generated.map(e => `
        <button class="entry" type="button" data-generated-expense="${e.id}" onclick="openGeneratedExpenseSheet('${e.id}')">
          <div class="meta">
            <div class="cat">${escapeHtml(catName[e.category_id] || 'Uncategorised')}</div>
            <div class="sub"><span class="chip chip-recurring">Recurring</span> ${escapeHtml(e.note || dayLabel(e.date))}</div>
          </div>
          <div class="amt">${fromCents(e.amount)}</div>
        </button>`).join('')}</div>`
    : '';
}

function renderManualSection(manual, catName, storeName) {
  const list = $('expenseList');
  $('entryCount').textContent = manual.length ? manual.length + ' total' : '';

  if (!manual.length) {
    // A current month with nothing at all gets a first-run nudge
    // rather than a bare grey box (§10.4); other months stay factual.
    const firstRun = state.month === monthOf(today());
    list.innerHTML = firstRun
      ? `<div class="blank blank-start">
           <strong>Start with this month</strong>
           <span>1. Set your income (and any loan) above.</span>
           <span>2. Add an expense as it happens — it takes seconds.</span>
           <span>3. Entries appear here, grouped by day.</span>
         </div>`
      : '<div class="blank">No expenses recorded for this month.</div>';
    return;
  }

  manual.sort((a, b) =>
    b.date.localeCompare(a.date) || (b.updated_at || '').localeCompare(a.updated_at || ''));

  const byDay = {};
  for (const e of manual) (byDay[e.date] ||= []).push(e);

  list.innerHTML = Object.entries(byDay).map(([date, items]) => {
    const dayTotal = items.reduce((s, e) => s + e.amount, 0);
    const rows = items.map(e => {
      const bits = [storeName[e.store_id], e.note].filter(Boolean).join(' \u00B7 ');
      return `
        <div class="entry">
          <div class="meta">
            <div class="cat">${escapeHtml(catName[e.category_id] || 'Uncategorised')}</div>
            ${bits ? `<div class="sub">${escapeHtml(bits)}</div>` : ''}
          </div>
          ${e.has_receipt ? `<button class="chip" onclick="openReceipt('${e.id}')" aria-label="View receipt">receipt</button>` : ''}
          <div class="amt">${fromCents(e.amount)}</div>
          <button class="del" onclick="deleteExpense('${e.id}')" aria-label="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg></button>
        </div>`;
    }).join('');

    return `
      <div class="daygroup">
        <div class="dayhead"><span>${dayLabel(date)}</span><span>${fromCents(dayTotal)}</span></div>
        ${rows}
      </div>`;
  }).join('');
}

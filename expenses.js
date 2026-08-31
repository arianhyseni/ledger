/* ---------------------------------------------------------
   expenses.js — income, expense entry, list, budget strip
--------------------------------------------------------- */

let pendingPhoto = null;

function initExpenses() {
  $('incomeInput').onchange = saveIncome;
  $('expenseForm').onsubmit = saveExpense;
  $('exDate').value = today();

  $('exPhoto').onchange = e => {
    pendingPhoto = e.target.files[0] || null;
    $('photoLabel').textContent = pendingPhoto ? 'Receipt attached' : 'Attach receipt';
    $('exPhoto').parentElement.classList.toggle('has', !!pendingPhoto);
  };

  $('viewerClose').onclick = closeViewer;
}

/* ---------- lookups ---------- */

async function fillCategorySelects() {
  const cats = await db.categories.orderBy('name').toArray();
  const html = cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  $('exCategory').innerHTML = html;
  $('pCategory').innerHTML = html;
}

async function fillStoreLists() {
  const stores = await db.stores.orderBy('name').toArray();
  $('storeList').innerHTML = stores.map(s => `<option value="${escapeHtml(s.name)}">`).join('');
}

async function resolveStore(name) {
  const clean = name.trim();
  if (!clean) return null;
  const found = await db.stores
    .filter(s => s.name.toLowerCase() === clean.toLowerCase()).first();
  if (found) return found.id;
  const id = await db.stores.add({ name: clean, location: '', note: '' });
  await fillStoreLists();
  return id;
}

/* ---------- income ---------- */

async function saveIncome() {
  const cents = toCents($('incomeInput').value);
  const row = await db.income.where('month').equals(state.month).first();
  if (row) await db.income.update(row.id, { amount: cents });
  else     await db.income.add({ month: state.month, amount: cents, source: '', note: '' });
  await renderExpenses();
}

/* ---------- expense CRUD ---------- */

async function saveExpense(e) {
  e.preventDefault();

  const amount = toCents($('exAmount').value);
  if (amount <= 0) { toast('Enter an amount above zero.'); return; }

  const date = $('exDate').value || today();
  const storeId = await resolveStore($('exStore').value);

  const expenseId = await db.expenses.add({
    date,
    month: monthOf(date),
    amount,
    categoryId: Number($('exCategory').value),
    storeId,
    note: $('exNote').value.trim(),
    hasReceipt: !!pendingPhoto
  });

  if (pendingPhoto) {
    await db.receipts.add({ expenseId, blob: pendingPhoto, createdAt: new Date().toISOString() });
  }

  // Keep date and store — expenses usually come in batches.
  $('exAmount').value = '';
  $('exNote').value = '';
  pendingPhoto = null;
  $('exPhoto').value = '';
  $('photoLabel').textContent = 'Attach receipt';
  $('exPhoto').parentElement.classList.remove('has');

  state.month = monthOf(date);
  await renderActive();
  $('exAmount').focus();
  toast('Expense saved.');
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  await db.transaction('rw', db.expenses, db.expenseItems, db.receipts, async () => {
    await db.expenses.delete(id);
    await db.expenseItems.where('expenseId').equals(id).delete();
    await db.receipts.where('expenseId').equals(id).delete();
  });
  await renderExpenses();
}

/* ---------- receipt viewer ---------- */

async function openReceipt(expenseId) {
  const r = await db.receipts.where('expenseId').equals(expenseId).first();
  if (!r) { toast('No receipt stored.'); return; }
  $('viewerImg').src = URL.createObjectURL(r.blob);
  $('viewer').hidden = false;
}

function closeViewer() {
  if ($('viewerImg').src.startsWith('blob:')) URL.revokeObjectURL($('viewerImg').src);
  $('viewerImg').src = '';
  $('viewer').hidden = true;
}

/* ---------- render ---------- */

async function renderExpenses() {
  const [incomeRow, expenses, cats, stores] = await Promise.all([
    db.income.where('month').equals(state.month).first(),
    db.expenses.where('month').equals(state.month).toArray(),
    db.categories.toArray(),
    db.stores.toArray()
  ]);

  const catName   = Object.fromEntries(cats.map(c => [c.id, c.name]));
  const storeName = Object.fromEntries(stores.map(s => [s.id, s.name]));

  const income = incomeRow ? incomeRow.amount : 0;
  const spent  = expenses.reduce((s, e) => s + e.amount, 0);

  $('incomeInput').value = income ? fromCents(income) : '';
  document.querySelectorAll('.cur-sym').forEach(el => el.textContent = window.CURRENCY);

  renderStrip(income, spent);
  renderExpenseList(expenses, catName, storeName);
}

function renderStrip(income, spent) {
  const elapsed   = Math.max(daysElapsed(state.month), 1);
  const total     = daysInMonth(state.month);
  const avgPerDay = spent / elapsed;
  const projected = Math.round(avgPerDay * total);

  const pctSpent = income > 0 ? Math.min(spent / income * 100, 100) : 0;
  const pctProj  = income > 0 ? Math.min(projected / income * 100, 100) : 0;

  const fill = $('stripFill');
  fill.style.width = pctSpent + '%';
  fill.classList.toggle('over', income > 0 && spent > income);

  const marker = $('stripMarker');
  marker.hidden = income <= 0;
  marker.style.left = pctProj + '%';

  $('stripSpent').textContent = money(spent) + ' spent';
  $('stripLeft').textContent  = income > 0
    ? (income - spent >= 0 ? money(income - spent) + ' left'
                           : money(spent - income) + ' over')
    : 'set your income';

  $('mAvg').textContent  = fromCents(Math.round(avgPerDay));
  $('mProj').textContent = fromCents(projected);
  $('mSave').textContent = income > 0
    ? Math.round((income - projected) / income * 100) + '%'
    : '—';
}

function renderExpenseList(expenses, catName, storeName) {
  const list = $('expenseList');
  $('entryCount').textContent = expenses.length ? expenses.length + ' total' : '';

  if (!expenses.length) {
    list.innerHTML = '<div class="blank">No expenses recorded for this month yet.</div>';
    return;
  }

  expenses.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  const byDay = {};
  for (const e of expenses) (byDay[e.date] ||= []).push(e);

  list.innerHTML = Object.entries(byDay).map(([date, items]) => {
    const dayTotal = items.reduce((s, e) => s + e.amount, 0);
    const rows = items.map(e => {
      const bits = [storeName[e.storeId], e.note].filter(Boolean).join(' \u00B7 ');
      return `
        <div class="entry">
          <div class="meta">
            <div class="cat">${escapeHtml(catName[e.categoryId] || 'Uncategorised')}</div>
            ${bits ? `<div class="sub">${escapeHtml(bits)}</div>` : ''}
          </div>
          ${e.hasReceipt ? `<button class="chip" onclick="openReceipt(${e.id})">receipt</button>` : ''}
          <div class="amt">${fromCents(e.amount)}</div>
          <button class="del" onclick="deleteExpense(${e.id})" aria-label="Delete">&times;</button>
        </div>`;
    }).join('');

    return `
      <div class="daygroup">
        <div class="dayhead"><span>${dayLabel(date)}</span><span>${fromCents(dayTotal)}</span></div>
        ${rows}
      </div>`;
  }).join('');
}

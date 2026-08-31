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
  const cats = (await live('categories')).sort((a, b) => a.name.localeCompare(b.name));
  const html = cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  $('exCategory').innerHTML = html;
  $('pCategory').innerHTML = html;
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
  const rows = await liveWhere('income', 'month', state.month);

  if (rows.length) {
    await db.income.put(stamp({ ...rows[0], amount }));
  } else {
    await db.income.put(stamp({
      id: uuid(), month: state.month, amount, source: '', note: ''
    }));
  }

  await renderExpenses();
  scheduleSync();
}

/* ---------- expense CRUD ---------- */

async function saveExpense(e) {
  e.preventDefault();

  const amount = toCents($('exAmount').value);
  if (amount <= 0) { toast('Enter an amount above zero.'); return; }

  const date = $('exDate').value || today();
  const store_id = await resolveStore($('exStore').value);
  const id = uuid();

  await db.expenses.put(stamp({
    id,
    date,
    month: monthOf(date),
    amount,
    category_id: $('exCategory').value || null,
    store_id,
    note: $('exNote').value.trim(),
    has_receipt: !!pendingPhoto
  }));

  if (pendingPhoto) {
    await db.receipts.put({
      id: uuid(), expense_id: id, blob: pendingPhoto, created_at: now()
    });
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
  scheduleSync();
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;

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

async function openReceipt(expenseId) {
  const r = await db.receipts.where('expense_id').equals(expenseId).first();
  if (!r) { toast('Receipt is stored on the device it was taken on.'); return; }
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
  const [incomeRows, expenses, cats, stores] = await Promise.all([
    liveWhere('income', 'month', state.month),
    liveWhere('expenses', 'month', state.month),
    live('categories'),
    live('stores')
  ]);

  const catName   = Object.fromEntries(cats.map(c => [c.id, c.name]));
  const storeName = Object.fromEntries(stores.map(s => [s.id, s.name]));

  const income = incomeRows.length ? incomeRows[0].amount : 0;
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

  expenses.sort((a, b) =>
    b.date.localeCompare(a.date) || (b.updated_at || '').localeCompare(a.updated_at || ''));

  const byDay = {};
  for (const e of expenses) (byDay[e.date] ||= []).push(e);

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
          ${e.has_receipt ? `<button class="chip" onclick="openReceipt('${e.id}')">receipt</button>` : ''}
          <div class="amt">${fromCents(e.amount)}</div>
          <button class="del" onclick="deleteExpense('${e.id}')" aria-label="Delete">&times;</button>
        </div>`;
    }).join('');

    return `
      <div class="daygroup">
        <div class="dayhead"><span>${dayLabel(date)}</span><span>${fromCents(dayTotal)}</span></div>
        ${rows}
      </div>`;
  }).join('');
}

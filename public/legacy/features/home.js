/* ---------------------------------------------------------
   home.js — dashboard: available-this-month, needs vs wants,
   recent expenses. The landing screen; the fuller Pace metrics
   and complete entry list live on the Expenses tab.
--------------------------------------------------------- */

function initHome() {
  $('homeSeeAll').onclick = () => switchScreen('expenses');
  $('homeNeedsWants').onclick = () => switchScreen('insights');
}

async function renderHome() {
  await ensureScheduledRecurringExpenses(state.month);

  const [incomeRows, expenses, cats] = await Promise.all([
    liveWhere('income', 'month', state.month),
    liveWhere('expenses', 'month', state.month),
    live('categories')
  ]);

  const income = incomeRows.length ? incomeRows[0].amount : 0;
  const debt   = incomeRows.length ? (incomeRows[0].debt || 0) : 0;
  const spent  = expenses.reduce((s, e) => s + e.amount, 0);
  document.querySelectorAll('.cur-sym').forEach(el => el.textContent = window.CURRENCY);

  const b = computeBudget(state.month, income, debt, spent, await debtAlreadyCounted());
  $('homeAvailable').textContent = fmtCents(Math.abs(b.remaining));
  $('homeAvailable').classList.toggle('neg', b.remaining < 0);

  $('homePillFill').style.width = b.pctSpent + '%';
  $('homePillFill').classList.toggle('over', b.base > 0 && spent > b.base);
  $('homePillLabel').textContent = Math.round(b.pctSpent) + '% used';

  renderHomeNeedsWants(expenses, cats);
  renderHomeRecent(expenses, cats);
}

function groupOf(cats, categoryId) {
  const cat = cats.find(c => c.id === categoryId);
  return (cat && cat.group) || 'variable';
}

function renderHomeNeedsWants(expenses, cats) {
  const box = $('homeNeedsWants');
  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  if (!spent) { box.hidden = true; return; }

  const totals = { fixed: 0, variable: 0, wants: 0 };
  for (const e of expenses) totals[groupOf(cats, e.category_id)] += e.amount;

  box.hidden = false;
  const share = g => Math.round(totals[g] / spent * 100);
  const shares = { fixed: share('fixed'), variable: share('variable'), wants: share('wants') };
  const needsPct = shares.fixed + shares.variable;

  $('homeMiniBar').innerHTML = ['fixed', 'variable', 'wants'].map(g =>
    `<div class="segbar-seg segbar-${g}" style="width:${shares[g]}%"></div>`).join('');
  $('homeNeedsPct').textContent = needsPct + '% needs';
  $('homeWantsPct').textContent = shares.wants + '% wants';
}

function renderHomeRecent(expenses, cats) {
  const catName = Object.fromEntries(cats.map(c => [c.id, c.name]));
  const recent = [...expenses]
    .sort((a, b) => b.date.localeCompare(a.date) || (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 4);

  const list = $('homeRecentList');
  if (!recent.length) {
    list.innerHTML = '<div class="blank">No expenses recorded for this month yet.</div>';
    return;
  }

  list.innerHTML = `<div class="daygroup">${recent.map(e => `
    <div class="entry">
      <span class="icon-tile icon-tile-${groupOf(cats, e.category_id)}">${categoryIconSvg(catName[e.category_id])}</span>
      <div class="meta">
        <div class="cat">${escapeHtml(catName[e.category_id] || 'Uncategorised')}</div>
        <div class="sub">${escapeHtml(e.recurring_expense_id ? 'Recurring' : dayLabel(e.date))}</div>
      </div>
      <div class="amt">${fromCents(e.amount)}</div>
    </div>`).join('')}</div>`;
}

/* ---------------------------------------------------------
   year.js — twelve months at a glance

   Reads straight from the local tables, so it works offline
   like everything else.
--------------------------------------------------------- */

let yearShown = new Date().getFullYear();
let yearReturnFocus = null;

function initYear() {
  $('yearBtn').onclick = () => {
    yearShown = Number(state.month.slice(0, 4));
    openYear();
  };
  $('yearClose').onclick = closeYear;
  $('yearPrev').onclick = () => { yearShown--; renderYear(); };
  $('yearNext').onclick = () => { yearShown++; renderYear(); };

  // Backdrop click may close — the year view holds no unsaved input.
  $('yearView').onclick = e => {
    if (e.target.id === 'yearView') closeYear();
  };
}

function onYearKey(e) {
  if (e.key === 'Escape') closeYear();
}

async function openYear() {
  yearReturnFocus = document.activeElement;
  $('yearView').hidden = false;
  document.addEventListener('keydown', onYearKey);
  await renderYear();
  $('yearClose').focus();
}

function closeYear() {
  $('yearView').hidden = true;
  document.removeEventListener('keydown', onYearKey);
  if (yearReturnFocus && yearReturnFocus.isConnected) yearReturnFocus.focus();
  yearReturnFocus = null;
}

async function renderYear() {
  $('yearLabel').textContent = yearShown;

  const [expenses, incomes] = await Promise.all([live('expenses'), live('income')]);

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = yearShown + '-' + String(m).padStart(2, '0');
    const spend = expenses.filter(e => e.month === key)
                          .reduce((s, e) => s + e.amount, 0);
    const inc = incomes.find(i => i.month === key);
    months.push({
      key,
      label: monthShort(key),
      spend,
      income: inc ? inc.amount : 0,
      debt: inc ? (inc.debt || 0) : 0
    });
  }

  const max = Math.max(...months.map(m => Math.max(m.spend, m.income)), 1);
  const thisMonth = monthOf(today());

  $('yearGrid').innerHTML = months.map(m => {
    const available = m.income - m.debt;
    const over = available > 0 && m.spend > available;
    const empty = !m.spend && !m.income;

    return `
      <button class="ycell ${m.key === state.month ? 'sel' : ''} ${m.key === thisMonth ? 'now' : ''} ${empty ? 'empty' : ''}"
              onclick="jumpToMonth('${m.key}')">
        <span class="ylabel">${m.label}</span>
        <span class="ybar"><i style="height:${Math.round(m.spend / max * 100)}%" class="${over ? 'over' : ''}"></i></span>
        <span class="yamt">${m.spend ? fromCents(m.spend) : '—'}</span>
      </button>`;
  }).join('');

  const totalSpend  = months.reduce((s, m) => s + m.spend, 0);
  const totalIncome = months.reduce((s, m) => s + m.income, 0);
  const totalDebt   = months.reduce((s, m) => s + m.debt, 0);
  const monthsWithData = months.filter(m => m.spend).length;
  const saved = totalIncome - totalDebt - totalSpend;

  $('yearTotals').innerHTML = `
    <dl class="metrics four">
      <div><dt>Income</dt><dd>${fromCents(totalIncome)}</dd></div>
      <div><dt>Loan</dt><dd>${fromCents(totalDebt)}</dd></div>
      <div><dt>Spent</dt><dd>${fromCents(totalSpend)}</dd></div>
      <div><dt>Kept</dt><dd class="${saved >= 0 ? 'good' : 'bad'}">${fromCents(saved)}</dd></div>
    </dl>
    ${monthsWithData
      ? `<p class="hint">Averaging ${money(Math.round(totalSpend / monthsWithData))} a month across ${monthsWithData} month${monthsWithData > 1 ? 's' : ''} with entries.</p>`
      : '<p class="hint">No entries recorded in this year.</p>'}`;
}

function jumpToMonth(month) {
  state.month = month;
  closeYear();
  if (!MONTHLY.includes(state.screen)) switchScreen('expenses');
  else renderActive();
}

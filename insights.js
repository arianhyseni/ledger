/* ---------------------------------------------------------
   insights.js — analytics, averages and saving advice
   Every number is derived at render time. Nothing is cached.
--------------------------------------------------------- */

function lastMonths(endMonth, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftMonth(endMonth, -i));
  return out;
}

async function renderInsights() {
  const window6  = lastMonths(state.month, 6);
  const previous = window6.slice(0, 5);

  const [allExpenses, allIncome, cats, stores] = await Promise.all([
    live('expenses'), live('income'), live('categories'), live('stores')
  ]);

  const expenses = allExpenses.filter(e => window6.includes(e.month));
  const incomes  = allIncome.filter(i => window6.includes(i.month));

  const catName   = Object.fromEntries(cats.map(c => [c.id, c.name]));
  const storeName = Object.fromEntries(stores.map(s => [s.id, s.name]));
  const incomeOf  = Object.fromEntries(incomes.map(i => [i.month, i.amount]));

  const cur       = expenses.filter(e => e.month === state.month);
  const spent     = cur.reduce((s, e) => s + e.amount, 0);
  const income    = incomeOf[state.month] || 0;
  const elapsed   = Math.max(daysElapsed(state.month), 1);
  const total     = daysInMonth(state.month);
  const avgDay    = spent / elapsed;
  const projected = Math.round(avgDay * total);
  const target    = Number(window.SAVINGS_TARGET || 20);

  /* ---- category breakdown vs baseline ---- */
  const curByCat = {};
  for (const e of cur) curByCat[e.category_id] = (curByCat[e.category_id] || 0) + e.amount;

  const prevMonthsWithData = new Set(
    expenses.filter(e => previous.includes(e.month)).map(e => e.month)
  );
  const prevCount = prevMonthsWithData.size || 1;

  const baseByCat = {};
  for (const e of expenses) {
    if (previous.includes(e.month)) {
      baseByCat[e.category_id] = (baseByCat[e.category_id] || 0) + e.amount;
    }
  }
  for (const k in baseByCat) baseByCat[k] = Math.round(baseByCat[k] / prevCount);

  const breakdown = Object.entries(curByCat)
    .map(([id, amount]) => ({
      id,
      name: catName[id] || 'Uncategorised',
      amount,
      share: spent ? amount / spent * 100 : 0,
      base: baseByCat[id] || 0
    }))
    .sort((a, b) => b.amount - a.amount);

  /* ---- store averages ---- */
  const byStore = {};
  for (const e of cur) {
    if (!e.store_id) continue;
    (byStore[e.store_id] ||= []).push(e.amount);
  }
  const storeStats = Object.entries(byStore).map(([id, list]) => ({
    name: storeName[id] || 'Unknown',
    trips: list.length,
    avg: Math.round(list.reduce((s, v) => s + v, 0) / list.length),
    total: list.reduce((s, v) => s + v, 0)
  })).sort((a, b) => b.total - a.total);

  /* ---- six month trend ---- */
  const trend = window6.map(m => ({
    month: m,
    spend: expenses.filter(e => e.month === m).reduce((s, e) => s + e.amount, 0),
    income: incomeOf[m] || 0
  }));

  $('insightsBody').innerHTML = [
    headlineCard(income, spent, projected, avgDay, target),
    breakdownCard(breakdown, spent),
    trendCard(trend),
    storeCard(storeStats),
    adviceCard(await buildAdvice({
      income, spent, projected, avgDay, target, breakdown, storeStats,
      daysLeft: Math.max(total - elapsed, 0)
    }))
  ].join('');
}

/* ---------- cards ---------- */

function headlineCard(income, spent, projected, avgDay, target) {
  const rate = income > 0 ? Math.round((income - projected) / income * 100) : null;
  const cls  = rate === null ? '' : (rate >= target ? 'good' : (rate >= 0 ? 'warn' : 'bad'));
  return `
    <div class="card">
      <span class="eyebrow">${escapeHtml(monthLabel(state.month))}</span>
      <dl class="metrics four">
        <div><dt>Income</dt><dd>${fromCents(income)}</dd></div>
        <div><dt>Spent</dt><dd>${fromCents(spent)}</dd></div>
        <div><dt>Projected</dt><dd>${fromCents(projected)}</dd></div>
        <div><dt>Save rate</dt><dd class="${cls}">${rate === null ? '—' : rate + '%'}</dd></div>
      </dl>
      <p class="hint">Target ${target}% \u00B7 average ${fromCents(Math.round(avgDay))} per day so far.</p>
    </div>`;
}

function breakdownCard(rows, spent) {
  if (!rows.length) {
    return `<div class="card empty"><span class="eyebrow">By category</span>
      <p>No expenses this month, so there is nothing to break down.</p></div>`;
  }
  const max = rows[0].amount;
  return `
    <div class="card">
      <span class="eyebrow">By category</span>
      <div class="bars">
        ${rows.map(r => {
          const delta = r.base ? Math.round((r.amount - r.base) / r.base * 100) : null;
          const tag = delta === null ? '<span class="dim">new</span>'
            : `<span class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '\u25B2' : '\u25BC'} ${Math.abs(delta)}%</span>`;
          return `
            <div class="barrow">
              <div class="barhead">
                <span>${escapeHtml(r.name)}</span>
                <span class="num">${fromCents(r.amount)}</span>
              </div>
              <div class="bartrack"><div class="barfill" style="width:${r.amount / max * 100}%"></div></div>
              <div class="barfoot">
                <span class="dim">${Math.round(r.share)}% of spend</span>
                <span class="dim">6-mo avg ${fromCents(r.base)} ${tag}</span>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function trendCard(trend) {
  const max = Math.max(...trend.map(t => Math.max(t.spend, t.income)), 1);
  const W = 320, H = 130, pad = 18;
  const bw = (W - pad * 2) / trend.length;

  const bars = trend.map((t, i) => {
    const h = (t.spend / max) * (H - pad * 2);
    const x = pad + i * bw + bw * 0.18;
    return `<rect x="${x.toFixed(1)}" y="${(H - pad - h).toFixed(1)}"
      width="${(bw * 0.64).toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}"
      rx="2" class="${t.month === state.month ? 'bar-cur' : 'bar'}"></rect>`;
  }).join('');

  const pts = trend.map((t, i) => {
    const x = pad + i * bw + bw / 2;
    const y = H - pad - (t.income / max) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const labels = trend.map((t, i) => {
    const x = pad + i * bw + bw / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 5}" class="axis">${monthShort(t.month)}</text>`;
  }).join('');

  return `
    <div class="card">
      <span class="eyebrow">Six months</span>
      <svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="Spending per month against income">
        ${bars}
        <polyline points="${pts}" class="incline"></polyline>
        ${labels}
      </svg>
      <div class="key">
        <span><i class="sw-bar"></i> spent</span>
        <span><i class="sw-line"></i> income</span>
      </div>
    </div>`;
}

function storeCard(rows) {
  if (!rows.length) {
    return `<div class="card empty"><span class="eyebrow">Stores</span>
      <p>Tag expenses with a store to see your average basket per shop.</p></div>`;
  }
  return `
    <div class="card">
      <span class="eyebrow">Average basket</span>
      <table class="ptable">
        <thead><tr><th>Store</th><th>Trips</th><th>Avg</th><th>Total</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td>${escapeHtml(r.name)}</td>
            <td class="num dim">${r.trips}</td>
            <td class="num">${fromCents(r.avg)}</td>
            <td class="num">${fromCents(r.total)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function adviceCard(items) {
  return `
    <div class="card">
      <span class="eyebrow">Advice</span>
      <ul class="advice">
        ${items.map(i => `<li class="${i.tone}">${i.text}</li>`).join('')}
      </ul>
    </div>`;
}

/* ---------- advice engine ---------- */

async function buildAdvice(ctx) {
  const out = [];
  const { income, spent, projected, avgDay, target, breakdown, storeStats, daysLeft } = ctx;

  if (!income) {
    out.push({ tone: 'warn', text: 'Set your income for this month — without it nothing can be measured against a budget.' });
    return out;
  }

  if (!spent) {
    out.push({ tone: 'ok', text: 'No spending recorded yet this month. Add entries as they happen, not at month end.' });
    return out;
  }

  const keep = Math.round(income * target / 100);
  const budget = income - keep;

  if (projected > income) {
    out.push({ tone: 'bad',
      text: `At ${money(Math.round(avgDay))} a day you finish the month ${money(projected - income)} above your income. Daily spend has to drop to ${money(Math.round(budget / daysInMonth(state.month)))} to stay inside it.` });
  } else if (projected > budget) {
    const cut = projected - budget;
    const perDay = daysLeft > 0 ? Math.round(cut / daysLeft) : cut;
    out.push({ tone: 'warn',
      text: `You will stay inside your income but miss the ${target}% savings target by ${money(cut)}. Trimming ${money(perDay)} a day for the remaining ${daysLeft} days closes the gap.` });
  } else {
    out.push({ tone: 'ok',
      text: `On track. Projected spend of ${money(projected)} leaves ${money(income - projected)} — that is ${Math.round((income - projected) / income * 100)}% against a ${target}% target. Move it out of your current account before you see it.` });
  }

  const top = breakdown[0];
  if (top && top.share > 40) {
    out.push({ tone: 'warn',
      text: `${escapeHtml(top.name)} is ${Math.round(top.share)}% of everything you spent. One category that dominant is where any real saving has to come from.` });
  }

  for (const r of breakdown) {
    if (r.base && r.amount > r.base * 1.3 && r.amount - r.base > 1000) {
      out.push({ tone: 'warn',
        text: `${escapeHtml(r.name)} is ${money(r.amount - r.base)} above its six-month average of ${money(r.base)}. Worth checking whether that was one-off.` });
      break;
    }
  }

  const saving = await cheapestStoreSaving();
  if (saving.total > 0) {
    out.push({ tone: 'ok',
      text: `Across ${saving.products} products with prices in more than one store, buying each at its cheapest shop would save ${money(saving.total)} per full basket.` });
  }

  if (storeStats.length > 1) {
    const dear = storeStats.reduce((a, b) => a.avg > b.avg ? a : b);
    out.push({ tone: 'ok',
      text: `Your dearest trip is to ${escapeHtml(dear.name)} at ${money(dear.avg)} on average. Fewer, bigger trips there usually beat frequent small ones.` });
  }

  return out;
}

async function cheapestStoreSaving() {
  const prices = await live('prices');
  const byProduct = {};
  for (const r of prices) (byProduct[r.product_id] ||= []).push(r);

  let total = 0, products = 0;
  for (const rows of Object.values(byProduct)) {
    const stats = statsByStore(rows);
    if (stats.length < 2) continue;
    products++;
    total += stats[stats.length - 1].avg - stats[0].avg;
  }
  return { total, products };
}

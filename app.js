/* ---------------------------------------------------------
   app.js — shell: state, boot, navigation
--------------------------------------------------------- */

const $ = id => document.getElementById(id);

const state = {
  month: monthOf(today()),
  screen: 'expenses'
};

// Screens that are tied to a specific month.
const MONTHLY = ['expenses', 'insights'];

document.addEventListener('DOMContentLoaded', async () => {
  await seed();
  await bootData();

  initExpenses();
  initPrices();
  initSettings();

  $('prevMonth').onclick = () => { state.month = shiftMonth(state.month, -1); renderActive(); };
  $('nextMonth').onclick = () => { state.month = shiftMonth(state.month,  1); renderActive(); };

  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => switchScreen(tab.dataset.screen);
  });

  await renderActive();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

// Reload anything cached in memory from the database.
async function bootData() {
  window.CURRENCY = await getSetting('currency', '\u20AC');
  window.SAVINGS_TARGET = await getSetting('savingsTarget', 20);
  await fillCategorySelects();
  await fillStoreLists();
}

function switchScreen(name) {
  state.screen = name;
  document.querySelectorAll('.screen').forEach(s => s.hidden = (s.id !== 'screen-' + name));
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === name));
  renderActive();
}

async function renderActive() {
  const monthly = MONTHLY.includes(state.screen);

  $('prevMonth').hidden = !monthly;
  $('nextMonth').hidden = !monthly;
  $('topEyebrow').textContent = monthly ? 'Month' : 'Ledger';
  $('monthLabel').textContent = monthly
    ? monthLabel(state.month)
    : (state.screen === 'prices' ? 'Prices & products' : 'Settings');

  if (state.screen === 'expenses') await renderExpenses();
  if (state.screen === 'prices')   await renderPrices();
  if (state.screen === 'insights') await renderInsights();
  if (state.screen === 'settings') await renderSettings();
}

/* ---------- toast ---------- */

let toastTimer = null;

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

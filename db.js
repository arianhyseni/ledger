/* ---------------------------------------------------------
   db.js — schema, seed, settings, helpers
   Money is stored as INTEGER CENTS. Dates as "YYYY-MM-DD".
--------------------------------------------------------- */

const db = new Dexie('FinanceDB');

db.version(1).stores({
  settings:     'key',
  income:       '++id, month',
  categories:   '++id, name, type',
  stores:       '++id, name',
  products:     '++id, name, categoryId, barcode',
  prices:       '++id, productId, storeId, date, [productId+storeId]',
  expenses:     '++id, date, categoryId, storeId, month',
  expenseItems: '++id, expenseId, productId',
  receipts:     '++id, expenseId'
});

const TABLES = ['settings','income','categories','stores','products',
                'prices','expenses','expenseItems'];

/* ---------- seed ---------- */

const SEED_CATEGORIES = [
  'Groceries', 'Household', 'Transport', 'Bills & utilities',
  'Health', 'Clothing', 'Eating out', 'Kids',
  'Entertainment', 'Other'
];

// Wrapped in one transaction so two boots in a row can never double-seed.
async function seed() {
  await db.transaction('rw', db.categories, db.settings, async () => {
    if (await db.categories.count() === 0) {
      await db.categories.bulkAdd(
        SEED_CATEGORIES.map(name => ({ name, type: 'expense', monthlyBudget: 0 }))
      );
    }
    if (await db.settings.count() === 0) {
      await db.settings.bulkPut([
        { key: 'currency', value: '\u20AC' },
        { key: 'savingsTarget', value: 20 }
      ]);
    }
  });
}

async function getSetting(key, fallback) {
  const row = await db.settings.get(key);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

/* ---------- money ---------- */

function toCents(value) {
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

// Uses the currency symbol chosen in Settings.
function money(cents) {
  return fromCents(cents) + ' ' + (window.CURRENCY || '\u20AC');
}

/* ---------- dates ---------- */

function today() { return isoDate(new Date()); }

function isoDate(d) {
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

function monthOf(dateStr) { return dateStr.slice(0, 7); }

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function daysElapsed(month) {
  const now = new Date();
  const cur = monthOf(isoDate(now));
  if (month === cur) return now.getDate();
  if (month > cur) return 0;
  return daysInMonth(month);
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function monthShort(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
}

function dayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d)
    .toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
}

/* ---------- backup ---------- */
/* Receipt photos are deliberately excluded — they would inflate the
   export from kilobytes to hundreds of megabytes. */

async function exportAll() {
  const dump = { app: 'ledger', version: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const t of TABLES) dump.data[t] = await db[t].toArray();
  return dump;
}

async function importAll(dump) {
  if (!dump || dump.app !== 'ledger') throw new Error('Not a Ledger export file.');
  await db.transaction('rw', TABLES.map(t => db[t]), async () => {
    for (const t of TABLES) {
      await db[t].clear();
      if (dump.data[t] && dump.data[t].length) await db[t].bulkAdd(dump.data[t]);
    }
  });
}

async function wipeAll() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
}

/* ---------- misc ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

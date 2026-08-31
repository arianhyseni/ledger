/* ---------------------------------------------------------
   db.js — schema, seed, helpers, legacy migration

   Money is INTEGER CENTS. Dates are "YYYY-MM-DD".
   IDs are client-generated UUIDs so a row created offline
   already has its final identity.

   Every synced row carries:
     updated_at  ISO timestamp
     deleted     0 | 1   soft delete, so removals propagate
     dirty       0 | 1   has local changes not yet pushed
--------------------------------------------------------- */

const db = new Dexie('TillrollDB');

db.version(1).stores({
  settings:      'key, dirty',
  income:        'id, month, dirty, updated_at',
  categories:    'id, name, dirty, updated_at',
  stores:        'id, name, dirty, updated_at',
  products:      'id, name, category_id, barcode, dirty, updated_at',
  prices:        'id, product_id, store_id, date, [product_id+store_id], dirty, updated_at',
  expenses:      'id, date, category_id, store_id, month, dirty, updated_at',
  expense_items: 'id, expense_id, product_id, dirty, updated_at',
  receipts:      'id, expense_id',
  meta:          'key'
});

// Tables that sync, in dependency order — parents before children.
const SYNC_TABLES = [
  'categories', 'stores', 'products',
  'expenses', 'prices', 'expense_items',
  'income', 'settings'
];

/* ---------- identity ---------- */

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older WebViews.
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function now() {
  return new Date().toISOString();
}

// Stamp a row as locally changed and awaiting push.
function stamp(row) {
  row.updated_at = now();
  row.deleted = row.deleted ? 1 : 0;
  row.dirty = 1;
  return row;
}

/* ---------- reads that ignore deleted rows ---------- */

async function live(table) {
  return (await db[table].toArray()).filter(r => !r.deleted);
}

async function liveWhere(table, index, value) {
  return (await db[table].where(index).equals(value).toArray())
    .filter(r => !r.deleted);
}

/* ---------- seed ---------- */

const SEED_CATEGORIES = [
  'Groceries', 'Household', 'Transport', 'Bills & utilities',
  'Health', 'Clothing', 'Eating out', 'Kids',
  'Entertainment', 'Other'
];

async function seed() {
  await db.transaction('rw', db.categories, db.settings, async () => {
    if (await db.categories.count() === 0) {
      await db.categories.bulkAdd(SEED_CATEGORIES.map(name => stamp({
        id: uuid(), name, type: 'expense', monthly_budget: 0
      })));
    }
    if (await db.settings.count() === 0) {
      await db.settings.bulkPut([
        stamp({ key: 'currency', value: '\u20AC' }),
        stamp({ key: 'savingsTarget', value: 20 })
      ]);
    }
  });
}

async function getSetting(key, fallback) {
  const row = await db.settings.get(key);
  return row && !row.deleted ? row.value : fallback;
}

async function setSetting(key, value) {
  await db.settings.put(stamp({ key, value }));
}

async function getMeta(key, fallback) {
  const row = await db.meta.get(key);
  return row ? row.value : fallback;
}

async function setMeta(key, value) {
  await db.meta.put({ key, value });
}

/* ---------- money ---------- */

function toCents(value) {
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

// Display-only formatting: locale thousands grouping and a true minus
// sign (U+2212). Stored values stay integer cents; fromCents stays
// ungrouped because it also feeds <input> values, which must parse.
function fmtCents(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const units = Math.floor(abs / 100).toLocaleString();
  return (neg ? '\u2212' : '') + units + '.' + String(abs % 100).padStart(2, '0');
}

function money(cents) {
  return fmtCents(cents) + ' ' + (window.CURRENCY || '\u20AC');
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
  const n = new Date();
  const cur = monthOf(isoDate(n));
  if (month === cur) return n.getDate();
  if (month > cur) return 0;
  return daysInMonth(month);
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1)
    .toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
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

async function exportAll() {
  const dump = { app: 'ledger', version: 2, exportedAt: now(), data: {} };
  for (const t of SYNC_TABLES) dump.data[t] = await db[t].toArray();
  return dump;
}

async function importAll(dump) {
  if (!dump || dump.app !== 'ledger') throw new Error('Not a Ledger export file.');

  // Version 1 exports used integer ids and camelCase fields.
  const data = dump.version === 1 ? convertV1(dump.data) : dump.data;

  await db.transaction('rw', SYNC_TABLES.map(t => db[t]), async () => {
    for (const t of SYNC_TABLES) {
      await db[t].clear();
      if (data[t] && data[t].length) {
        await db[t].bulkPut(data[t].map(r => stamp({ ...r })));
      }
    }
  });
}

async function wipeLocal() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
}

/* ---------- migration from the integer-id version ---------- */
/* The old database cannot be upgraded in place: IndexedDB will
   not let a store's primary key change type. So it is read out,
   translated, and written into the new one. */

function convertV1(old) {
  const map = {};                       // "table:oldId" -> uuid
  const id = (table, oldId) => {
    if (oldId === null || oldId === undefined) return null;
    const k = table + ':' + oldId;
    return (map[k] ||= uuid());
  };

  const out = {};

  out.categories = (old.categories || []).map(c => ({
    id: id('categories', c.id),
    name: c.name,
    type: c.type || 'expense',
    monthly_budget: c.monthlyBudget || 0
  }));

  out.stores = (old.stores || []).map(s => ({
    id: id('stores', s.id),
    name: s.name,
    location: s.location || '',
    note: s.note || ''
  }));

  out.products = (old.products || []).map(p => ({
    id: id('products', p.id),
    name: p.name,
    category_id: id('categories', p.categoryId),
    unit: p.unit || 'pcs',
    barcode: p.barcode || '',
    note: p.note || ''
  }));

  out.expenses = (old.expenses || []).map(e => ({
    id: id('expenses', e.id),
    date: e.date,
    month: e.month,
    amount: e.amount,
    category_id: id('categories', e.categoryId),
    store_id: id('stores', e.storeId),
    note: e.note || '',
    has_receipt: !!e.hasReceipt
  }));

  out.prices = (old.prices || []).map(p => ({
    id: id('prices', p.id),
    product_id: id('products', p.productId),
    store_id: id('stores', p.storeId),
    price: p.price,
    date: p.date,
    is_promo: !!p.isPromo
  }));

  out.expense_items = (old.expenseItems || []).map(i => ({
    id: id('expense_items', i.id),
    expense_id: id('expenses', i.expenseId),
    product_id: id('products', i.productId),
    qty: i.qty || 1,
    unit_price: i.unitPrice || 0
  }));

  out.income = (old.income || []).map(i => ({
    id: id('income', i.id),
    month: i.month,
    amount: i.amount,
    source: i.source || '',
    note: i.note || ''
  }));

  out.settings = (old.settings || []).map(s => ({
    key: s.key,
    value: s.value
  }));

  return out;
}

// Runs once. Pulls everything out of the old FinanceDB, if present.
async function migrateLegacy() {
  if (await getMeta('legacyMigrated', false)) return false;

  const names = await Dexie.getDatabaseNames();
  if (!names.includes('FinanceDB')) {
    await setMeta('legacyMigrated', true);
    return false;
  }

  const oldDb = new Dexie('FinanceDB');
  oldDb.version(1).stores({
    settings: 'key', income: '++id, month', categories: '++id, name, type',
    stores: '++id, name', products: '++id, name, categoryId, barcode',
    prices: '++id, productId, storeId, date, [productId+storeId]',
    expenses: '++id, date, categoryId, storeId, month',
    expenseItems: '++id, expenseId, productId', receipts: '++id, expenseId'
  });

  try {
    await oldDb.open();
    const old = {};
    for (const t of ['settings','income','categories','stores','products',
                     'prices','expenses','expenseItems']) {
      old[t] = await oldDb[t].toArray();
    }

    const hasData = Object.values(old).some(rows => rows.length);
    if (hasData) {
      const data = convertV1(old);
      await db.transaction('rw', SYNC_TABLES.map(t => db[t]), async () => {
        for (const t of SYNC_TABLES) {
          if (data[t] && data[t].length) {
            await db[t].bulkPut(data[t].map(r => stamp({ ...r })));
          }
        }
      });
    }

    oldDb.close();
    await setMeta('legacyMigrated', true);
    return hasData;
  } catch (err) {
    logError('Legacy migration skipped', err);
    await setMeta('legacyMigrated', true);
    return false;
  }
}

/* ---------- misc ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

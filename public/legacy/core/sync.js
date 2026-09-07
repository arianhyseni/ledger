/* ---------------------------------------------------------
   sync.js — local-first two-way sync

   Writes always land in IndexedDB first, so the app works
   with no signal. Rows marked dirty are pushed when a
   connection exists; rows changed elsewhere are pulled by
   comparing updated_at.

   Conflict rule: a dirty local row wins over the incoming
   remote copy, because the user made that change on this
   device and has not sent it yet. Otherwise the newer
   updated_at wins.

   Receipt photos and bill documents never sync. They are the only large
   objects in the app and would burn the storage quota for no benefit.
--------------------------------------------------------- */

// Columns that exist on the server, per table.
const REMOTE_FIELDS = {
  categories:          ['id', 'name', 'type', 'monthly_budget', 'group'],
  stores:              ['id', 'name', 'location', 'note'],
  products:            ['id', 'name', 'category_id', 'unit', 'barcode', 'note'],
  bill_accounts:       ['id', 'name', 'utility_type', 'account_reference', 'category_id', 'recurrence', 'default_amount', 'due_day', 'next_due_date', 'note', 'active'],
  recurring_expenses:  ['id', 'name', 'category_id', 'amount', 'start_month', 'duration_mode', 'duration_months', 'until_month', 'active', 'stopped_from_month', 'note'],
  expenses:            ['id', 'date', 'month', 'amount', 'category_id', 'store_id', 'note', 'has_receipt', 'recurring_expense_id'],
  bills:               ['id', 'account_id', 'due_date', 'month', 'amount', 'usage', 'usage_unit', 'status', 'paid_date', 'expense_id', 'note', 'has_document'],
  prices:              ['id', 'product_id', 'store_id', 'price', 'date', 'is_promo'],
  expense_items:       ['id', 'expense_id', 'product_id', 'qty', 'unit_price'],
  income:              ['id', 'month', 'amount', 'debt', 'source', 'note'],
  settings:            ['key', 'value']
};

// settings has no deleted column — it is a key/value store.
const HAS_DELETED = t => t !== 'settings';
const LOCAL_KEY   = t => (t === 'settings' ? 'key' : 'id');

let syncing = false;
let syncTimer = null;
let syncState = navigator.onLine ? 'ok' : 'offline';
let syncDetail = '';

/* ---------- entry points ---------- */

function scheduleSync(delay) {
  if (!CLOUD_ENABLED || !currentUser) return;
  clearTimeout(syncTimer);
  // A local write is already safe, but it is not synced yet. Reflect that
  // immediately instead of leaving a stale green "Synced" label visible
  // during the debounce window.
  void setSyncStatus(navigator.onLine ? 'pending' : 'offline');
  syncTimer = setTimeout(syncNow, delay === undefined ? 2500 : delay);
}

// Resolves true only when both halves completed, so callers can
// tell a real sync from a skipped or failed one.
async function syncNow() {
  if (!CLOUD_ENABLED || !currentUser || syncing) return false;

  if (!navigator.onLine) {
    await setSyncStatus('offline');
    return false;
  }

  syncing = true;
  await setSyncStatus('syncing');
  log('Sync starting');

  try {
    await pushAll();
    await pullAll();
    await setMeta('lastSync', now());
    await setSyncStatus('ok');
    await renderActive();
    log('Sync completed');
    return true;
  } catch (err) {
    logError('Sync failed', err);
    await setSyncStatus('error', err.message || String(err));
    return false;
  } finally {
    syncing = false;
  }
}

/* ---------- push ---------- */

async function pushAll() {
  for (const table of SYNC_TABLES) {
    const dirty = await db[table].where('dirty').equals(1).toArray();
    if (!dirty.length) continue;

    const payload = dirty.map(row => toRemote(table, row));

    // income is unique per (user, month), so a row created on a
    // second device must merge rather than collide.
    const options = table === 'income'
      ? { onConflict: 'user_id,month' }
      : table === 'settings'
        ? { onConflict: 'user_id,key' }
        : undefined;

    // Ask Postgres for the row back rather than trusting the client's own
    // guess at updated_at: bill_accounts_touch_updated_at (and its sibling
    // triggers) overwrite it server-side on an UPDATE, so the value this
    // device sent is only ever right for a brand-new INSERT. Comparisons
    // in applyRemote() and the pull cursor above both need the real one.
    const key = LOCAL_KEY(table);
    const { data: saved, error } = await sb.from(table).upsert(payload, options)
      .select(key + ', updated_at');
    if (error) throw new Error(table + ': ' + error.message);

    const savedAt = Object.fromEntries((saved || []).map(r => [r[key], r.updated_at]));
    await db.transaction('rw', db[table], async () => {
      for (const row of dirty) {
        const patch = { dirty: 0 };
        if (savedAt[row[key]]) patch.updated_at = savedAt[row[key]];
        await db[table].update(row[key], patch);
      }
    });
  }
}

function toRemote(table, row) {
  const out = { user_id: currentUser.id };
  for (const f of REMOTE_FIELDS[table]) {
    out[f] = row[f] === undefined ? null : row[f];
  }
  if (HAS_DELETED(table)) out.deleted = !!row.deleted;
  return out;
}

/* ---------- pull ---------- */

async function pullAll() {
  for (const table of SYNC_TABLES) {
    const since = await getMeta('pull:' + table, '1970-01-01T00:00:00Z');

    const { data, error } = await sb
      .from(table)
      .select('*')
      .gt('updated_at', since)
      .order('updated_at', { ascending: true })
      .limit(5000);

    if (error) throw new Error(table + ': ' + error.message);
    if (!data || !data.length) continue;

    await applyRemote(table, data);

    // Two rows can legitimately share the same updated_at instant (a
    // batch upsert stamps them together), and a strict ">" cursor would
    // silently and permanently skip whichever of them lands on the far
    // side of a later page boundary. Stepping the cursor back by one
    // microsecond re-fetches that instant next time; applyRemote's own
    // per-row "already have this" check makes the tiny re-fetch a no-op.
    const last = data[data.length - 1].updated_at;
    const lastMs = Date.parse(last);
    const cursor = Number.isFinite(lastMs) ? new Date(lastMs - 1).toISOString() : last;
    await setMeta('pull:' + table, cursor);
  }
}

async function applyRemote(table, rows) {
  const key = LOCAL_KEY(table);

  await db.transaction('rw', db[table], async () => {
    for (const remote of rows) {
      const local = await db[table].get(remote[key]);

      // Local edits that have not been pushed take precedence.
      if (local && local.dirty) continue;

      // Older than what we already hold — ignore. Both sides are
      // compared as real instants, not as raw strings: the server
      // returns "timestamptz" without milliseconds while the client
      // writes Date#toISOString() with them, and those two formats do
      // not always sort the same way as plain strings that ">" needs.
      if (local && local.updated_at && Date.parse(local.updated_at) > Date.parse(remote.updated_at)) continue;

      const row = { dirty: 0, updated_at: remote.updated_at };
      for (const f of REMOTE_FIELDS[table]) row[f] = remote[f];
      if (HAS_DELETED(table)) row.deleted = remote.deleted ? 1 : 0;

      await db[table].put(row);
    }
  });

  if (table === 'income') await dedupeIncome();
  if (table === 'categories') await dedupeByName('categories');
  if (table === 'stores') await dedupeByName('stores');
}

// One income row per month. A merge on the server can leave a
// second local row with a different id pointing at the same month.
async function dedupeIncome() {
  const rows = await db.income.toArray();
  const byMonth = {};
  for (const r of rows) (byMonth[r.month] ||= []).push(r);

  for (const list of Object.values(byMonth)) {
    if (list.length < 2) continue;
    list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    for (const extra of list.slice(1)) await db.income.delete(extra.id);
  }
}

// Categories and stores are seeded (or freely typed) client-side with a
// fresh uuid each time, so two devices that both create the same-named
// row before ever syncing with each other end up with two rows that
// differ only by id — the account keeps both forever, and every picker
// built from this table shows the name twice. Keep the oldest surviving
// row (whatever other rows already point at it stays valid) and fold
// every later duplicate's references onto it before deleting them.
async function dedupeByName(table) {
  const rows = (await db[table].toArray()).filter(r => !r.deleted);
  const byName = {};
  for (const r of rows) (byName[r.name.trim().toLowerCase()] ||= []).push(r);

  for (const list of Object.values(byName)) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''));
    const [keep, ...extras] = list;
    for (const extra of extras) {
      await relinkReferences(table, extra.id, keep.id);
      await db[table].put(stamp({ ...extra, deleted: 1 }));
    }
  }
}

// Foreign-key columns that point at a categories/stores row, per table.
const REFERRERS = {
  categories: [
    ['expenses', 'category_id'], ['products', 'category_id'],
    ['bill_accounts', 'category_id'], ['recurring_expenses', 'category_id']
  ],
  stores:     [['expenses', 'store_id'], ['prices', 'store_id']]
};

async function relinkReferences(table, fromId, toId) {
  for (const [refTable, field] of REFERRERS[table] || []) {
    const referring = await db[refTable].where(field).equals(fromId).toArray();
    for (const row of referring) {
      await db[refTable].put(stamp({ ...row, [field]: toId }));
    }
  }
}

/* ---------- status ---------- */

async function setSyncStatus(state, detail) {
  const pending = await pendingCount();
  const last = await getMeta('lastSync', null);

  // A successful attempt cannot be presented as fully synced while a local
  // row is still dirty (for example, if a write landed during the request).
  if (state === 'ok' && pending > 0) state = 'pending';

  syncState = state;
  syncDetail = detail || '';

  const el = $('syncStatus');
  if (!el) return;

  const changeLabel = pending + ' change' + (pending === 1 ? '' : 's');

  // Offline is a state, not an error (§6.6): changes are safe on the
  // device, so the wording says so and never goes red.
  const labels = {
    syncing: 'Syncing…',
    ok:      'Synced',
    pending: pending ? changeLabel + ' waiting to sync' : 'Sync queued',
    offline: pending
      ? 'Offline — ' + changeLabel + ' saved on this device'
      : 'Offline — saved on this device',
    error:   pending
      ? 'Sync could not finish — ' + changeLabel + ' safe on this device'
      : 'Sync could not finish — try again'
  };

  el.textContent = labels[state] || '';
  el.className = 'syncstatus ' + state;
  el.title = detail || (last ? 'Last sync ' + new Date(last).toLocaleString() : '');

  const badge = $('syncBadge');
  if (badge) {
    badge.hidden = !(state === 'syncing' || state === 'pending' || pending > 0 || state === 'error');
    badge.className = 'badge ' + state;
    // The dot itself is decorative; the words live in Settings.
    badge.setAttribute('aria-hidden', 'true');
    badge.title = labels[state] || '';
  }

  const button = $('syncBtn');
  if (button) {
    button.disabled = state === 'syncing';
    button.textContent = state === 'syncing'
      ? 'Syncing…'
      : (state === 'error' ? 'Retry sync' : 'Sync now');
  }
}

// Repaint the last real state after Settings rerenders. In particular, do
// not turn an error green merely because the user opened this screen.
function refreshSyncStatus() {
  return setSyncStatus(syncState, syncDetail);
}

async function pendingCount() {
  let n = 0;
  for (const t of SYNC_TABLES) {
    n += await db[t].where('dirty').equals(1).count();
  }
  return n;
}

/* ---------- triggers ---------- */

function initSync() {
  if (!CLOUD_ENABLED) return;

  window.addEventListener('online',  () => syncNow());
  window.addEventListener('offline', () => setSyncStatus('offline'));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleSync(500);
  });

  // A quiet safety net for long sessions left open.
  setInterval(() => syncNow(), 5 * 60 * 1000);
}

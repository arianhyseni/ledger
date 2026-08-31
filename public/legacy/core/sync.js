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

   Receipt photos never sync. They are the only large objects
   in the app and would burn the storage quota for no benefit.
--------------------------------------------------------- */

// Columns that exist on the server, per table.
const REMOTE_FIELDS = {
  categories:    ['id', 'name', 'type', 'monthly_budget'],
  stores:        ['id', 'name', 'location', 'note'],
  products:      ['id', 'name', 'category_id', 'unit', 'barcode', 'note'],
  expenses:      ['id', 'date', 'month', 'amount', 'category_id', 'store_id', 'note', 'has_receipt'],
  prices:        ['id', 'product_id', 'store_id', 'price', 'date', 'is_promo'],
  expense_items: ['id', 'expense_id', 'product_id', 'qty', 'unit_price'],
  income:        ['id', 'month', 'amount', 'debt', 'source', 'note'],
  settings:      ['key', 'value']
};

// settings has no deleted column — it is a key/value store.
const HAS_DELETED = t => t !== 'settings';
const LOCAL_KEY   = t => (t === 'settings' ? 'key' : 'id');

let syncing = false;
let syncTimer = null;

/* ---------- entry points ---------- */

function scheduleSync(delay) {
  if (!CLOUD_ENABLED || !currentUser) return;
  clearTimeout(syncTimer);
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

    const { error } = await sb.from(table).upsert(payload, options);
    if (error) throw new Error(table + ': ' + error.message);

    const key = LOCAL_KEY(table);
    await db.transaction('rw', db[table], async () => {
      for (const row of dirty) {
        await db[table].update(row[key], { dirty: 0 });
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
    await setMeta('pull:' + table, data[data.length - 1].updated_at);
  }
}

async function applyRemote(table, rows) {
  const key = LOCAL_KEY(table);

  await db.transaction('rw', db[table], async () => {
    for (const remote of rows) {
      const local = await db[table].get(remote[key]);

      // Local edits that have not been pushed take precedence.
      if (local && local.dirty) continue;

      // Older than what we already hold — ignore.
      if (local && local.updated_at && local.updated_at > remote.updated_at) continue;

      const row = { dirty: 0, updated_at: remote.updated_at };
      for (const f of REMOTE_FIELDS[table]) row[f] = remote[f];
      if (HAS_DELETED(table)) row.deleted = remote.deleted ? 1 : 0;

      await db[table].put(row);
    }
  });

  if (table === 'income') await dedupeIncome();
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

/* ---------- status ---------- */

async function setSyncStatus(state, detail) {
  const el = $('syncStatus');
  if (!el) return;

  const pending = await pendingCount();
  const last = await getMeta('lastSync', null);

  const labels = {
    syncing: 'Syncing…',
    ok:      pending ? pending + ' waiting' : 'Synced',
    offline: pending ? 'Offline · ' + pending + ' waiting' : 'Offline',
    error:   'Sync error'
  };

  el.textContent = labels[state] || '';
  el.className = 'syncstatus ' + state;
  el.title = detail || (last ? 'Last sync ' + new Date(last).toLocaleString() : '');

  const badge = $('syncBadge');
  if (badge) {
    badge.hidden = !(state === 'syncing' || pending > 0 || state === 'error');
    badge.className = 'badge ' + state;
  }
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

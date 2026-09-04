/* ---------------------------------------------------------
   settings.js — preferences, categories, stores, backup, account
--------------------------------------------------------- */

function initSettings() {
  $('setCurrency').onchange = async () => {
    const v = $('setCurrency').value.trim() || '\u20AC';
    await setSetting('currency', v);
    window.CURRENCY = v;
    await renderActive();
    scheduleSync();
  };

  $('setTarget').onchange = async () => {
    const v = Math.max(0, Math.min(90, Number($('setTarget').value) || 0));
    await setSetting('savingsTarget', v);
    window.SAVINGS_TARGET = v;
    $('setTarget').value = v;
    scheduleSync();
  };

  $('addCategory').onclick = async () => {
    const name = $('newCategory').value.trim();
    if (!name) return;
    await db.categories.put(stamp({
      id: uuid(), name, type: 'expense', monthly_budget: 0
    }));
    $('newCategory').value = '';
    await fillCategorySelects();
    await renderSettings();
    scheduleSync();
  };

  $('addStore').onclick = async () => {
    const name = $('newStore').value.trim();
    if (!name) return;
    await db.stores.put(stamp({ id: uuid(), name, location: '', note: '' }));
    $('newStore').value = '';
    await fillStoreLists();
    await renderSettings();
    scheduleSync();
  };

  $('exportBtn').onclick = doExport;
  $('importFile').onchange = doImport;
  $('syncBtn').onclick = () => syncNow();

  $('deleteDataBtn').onclick = deleteAllData;
}

/* ---------- categories & stores ---------- */

async function renameCategory(id, current) {
  const name = prompt('Rename category', current);
  if (!name || !name.trim()) return;
  const row = await db.categories.get(id);
  await db.categories.put(stamp({ ...row, name: name.trim() }));
  await fillCategorySelects();
  await renderSettings();
  scheduleSync();
}

async function removeCategory(id) {
  const used = (await liveWhere('expenses', 'category_id', id)).length;
  if (used) { toast(`In use by ${used} expenses. Rename it instead.`); return; }
  const row = await db.categories.get(id);
  await db.categories.put(stamp({ ...row, deleted: 1 }));
  await fillCategorySelects();
  await renderSettings();
  scheduleSync();
}

async function renameStore(id, current) {
  const name = prompt('Rename store', current);
  if (!name || !name.trim()) return;
  const row = await db.stores.get(id);
  await db.stores.put(stamp({ ...row, name: name.trim() }));
  await fillStoreLists();
  await renderSettings();
  scheduleSync();
}

async function removeStore(id) {
  const used = (await liveWhere('expenses', 'store_id', id)).length
             + (await liveWhere('prices', 'store_id', id)).length;
  if (used) { toast(`In use by ${used} records. Rename it instead.`); return; }
  const row = await db.stores.get(id);
  await db.stores.put(stamp({ ...row, deleted: 1 }));
  await fillStoreLists();
  await renderSettings();
  scheduleSync();
}

/* ---------- backup ---------- */

async function doExport() {
  const dump = await exportAll();
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ledger-backup-' + today() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup exported. Receipt photos are not included.');
}

async function doImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Importing replaces everything currently on this device. Continue?')) {
    e.target.value = ''; return;
  }
  try {
    const dump = JSON.parse(await file.text());
    await importAll(dump);
    await bootData();
    await renderActive();
    await renderSettings();
    toast('Backup restored.');
    scheduleSync(500);
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
  e.target.value = '';
}

/* ---------- delete everything ---------- */

async function deleteAllData() {
  if (!confirm('Delete every expense, product, price and setting?')) return;
  if (!confirm('This removes them from the server as well as this device, and cannot be undone. Continue?')) return;

  if (CLOUD_ENABLED && currentUser) {
    if (!navigator.onLine) {
      toast('You are offline. Connect first, or the server copy would survive.');
      return;
    }
    try {
      // Children before parents, so nothing trips a foreign key.
      for (const table of [...SYNC_TABLES].reverse()) {
        const { error } = await sb.from(table).delete().eq('user_id', currentUser.id);
        if (error) throw new Error(table + ': ' + error.message);
      }
    } catch (err) {
      toast('Server delete failed: ' + err.message + ' — nothing was removed locally.');
      return;
    }
  }

  await wipeLocal();

  if (CLOUD_ENABLED) {
    await sb.auth.signOut();
    location.reload();
    return;
  }

  await seed();
  await bootData();
  await renderActive();
  await renderSettings();
  toast('Everything deleted.');
}

/* ---------- render ---------- */

async function renderSettings() {
  $('setCurrency').value = window.CURRENCY;
  $('setTarget').value = window.SAVINGS_TARGET;

  await renderAccount();
  if (CLOUD_ENABLED && currentUser) await setSyncStatus('ok');

  const cats   = (await live('categories')).sort((a, b) => a.name.localeCompare(b.name));
  const stores = (await live('stores')).sort((a, b) => a.name.localeCompare(b.name));

  $('categoryList').innerHTML = cats.map(c => `
    <span class="tag">
      <button class="tagname" onclick="renameCategory('${c.id}', '${escapeAttr(c.name)}')">${escapeHtml(c.name)}</button>
      <button class="tagx" onclick="removeCategory('${c.id}')" aria-label="Remove">&times;</button>
    </span>`).join('');

  $('storeManageList').innerHTML = stores.length
    ? stores.map(s => `
      <span class="tag">
        <button class="tagname" onclick="renameStore('${s.id}', '${escapeAttr(s.name)}')">${escapeHtml(s.name)}</button>
        <button class="tagx" onclick="removeStore('${s.id}')" aria-label="Remove">&times;</button>
      </span>`).join('')
    : '<p class="hint">No stores yet. Add the shops you use, or just type a store name on an expense.</p>';
}

function escapeAttr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

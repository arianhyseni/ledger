/* ---------------------------------------------------------
   settings.js — preferences, categories, stores, backup
--------------------------------------------------------- */

function initSettings() {
  $('setCurrency').onchange = async () => {
    const v = $('setCurrency').value.trim() || '\u20AC';
    await setSetting('currency', v);
    window.CURRENCY = v;
    await renderActive();
  };

  $('setTarget').onchange = async () => {
    const v = Math.max(0, Math.min(90, Number($('setTarget').value) || 0));
    await setSetting('savingsTarget', v);
    window.SAVINGS_TARGET = v;
    $('setTarget').value = v;
  };

  $('addCategory').onclick = async () => {
    const name = $('newCategory').value.trim();
    if (!name) return;
    await db.categories.add({ name, type: 'expense', monthlyBudget: 0 });
    $('newCategory').value = '';
    await fillCategorySelects();
    await renderSettings();
  };

  $('addStore').onclick = async () => {
    const name = $('newStore').value.trim();
    if (!name) return;
    await db.stores.add({ name, location: '', note: '' });
    $('newStore').value = '';
    await fillStoreLists();
    await renderSettings();
  };

  $('exportBtn').onclick = doExport;
  $('importFile').onchange = doImport;

  $('wipeBtn').onclick = async () => {
    if (!confirm('Erase every expense, product and price on this device?')) return;
    if (!confirm('This cannot be undone. Export first if you have not. Continue?')) return;
    await wipeAll();
    await seed();
    await bootData();
    await renderActive();
    await renderSettings();
    toast('All data erased.');
  };
}

/* ---------- categories & stores ---------- */

async function renameCategory(id, current) {
  const name = prompt('Rename category', current);
  if (!name || !name.trim()) return;
  await db.categories.update(id, { name: name.trim() });
  await fillCategorySelects();
  await renderSettings();
}

async function removeCategory(id) {
  const used = await db.expenses.where('categoryId').equals(id).count();
  if (used) { toast(`In use by ${used} expenses. Rename it instead.`); return; }
  await db.categories.delete(id);
  await fillCategorySelects();
  await renderSettings();
}

async function renameStore(id, current) {
  const name = prompt('Rename store', current);
  if (!name || !name.trim()) return;
  await db.stores.update(id, { name: name.trim() });
  await fillStoreLists();
  await renderSettings();
}

async function removeStore(id) {
  const used = await db.expenses.where('storeId').equals(id).count()
             + await db.prices.where('storeId').equals(id).count();
  if (used) { toast(`In use by ${used} records. Rename it instead.`); return; }
  await db.stores.delete(id);
  await fillStoreLists();
  await renderSettings();
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
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
  e.target.value = '';
}

/* ---------- render ---------- */

async function renderSettings() {
  $('setCurrency').value = window.CURRENCY;
  $('setTarget').value = window.SAVINGS_TARGET;

  const [cats, stores] = await Promise.all([
    db.categories.orderBy('name').toArray(),
    db.stores.orderBy('name').toArray()
  ]);

  $('categoryList').innerHTML = cats.map(c => `
    <span class="tag">
      <button class="tagname" onclick="renameCategory(${c.id}, '${escapeAttr(c.name)}')">${escapeHtml(c.name)}</button>
      <button class="tagx" onclick="removeCategory(${c.id})" aria-label="Remove">&times;</button>
    </span>`).join('');

  $('storeManageList').innerHTML = stores.length
    ? stores.map(s => `
      <span class="tag">
        <button class="tagname" onclick="renameStore(${s.id}, '${escapeAttr(s.name)}')">${escapeHtml(s.name)}</button>
        <button class="tagx" onclick="removeStore(${s.id})" aria-label="Remove">&times;</button>
      </span>`).join('')
    : '<p class="hint">No stores yet. Add the shops you use, or just type a store name on an expense.</p>';
}

function escapeAttr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

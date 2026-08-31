/* ---------------------------------------------------------
   prices.js — products, store prices, averages, cheapest store
--------------------------------------------------------- */

let openProductId = null;

function initPrices() {
  $('prodSearch').oninput = () => renderPrices();
  $('toggleNewProduct').onclick = () => {
    const f = $('productForm');
    f.hidden = !f.hidden;
    $('toggleNewProduct').setAttribute('aria-expanded', String(!f.hidden));
    if (!f.hidden) $('pName').focus();
  };
  $('productForm').onsubmit = saveProduct;

  $('scanBtn').onclick = openScanner;
  $('scannerClose').onclick = closeScanner;
}

/* ---------- barcode scanner ----------
   Scanning only identifies the product — it opens the matching
   product (ready to record a new price the normal way) or preps the
   "+ New product" form with the barcode filled in. Price stays a
   manual entry either way, same as adding one without scanning. */

async function openScanner() {
  $('scannerView').hidden = false;
  $('scannerHint').textContent = 'Point the camera at a barcode';
  await startBarcodeScan('scannerVideo', onBarcodeScanned, onScanError);
}

function closeScanner() {
  stopBarcodeScan();
  $('scannerView').hidden = true;
}

function onScanError(err) {
  $('scannerHint').textContent = 'Could not open the camera' +
    (err && err.message ? ': ' + err.message : '.');
}

async function onBarcodeScanned(code) {
  closeScanner();

  const products = await live('products');
  const found = products.find(p => p.barcode && p.barcode === code);

  if (found) {
    openProductId = found.id;
    $('prodSearch').value = found.name;
    await renderPrices();
    toast('Found: ' + found.name + ' — record a price below.');
  } else {
    $('productForm').hidden = false;
    $('pBarcode').value = code;
    $('pName').focus();
    toast('New barcode — name it and save.');
  }
}

/* ---------- products ---------- */

async function saveProduct(e) {
  e.preventDefault();
  const name = $('pName').value.trim();
  if (!name) return;

  // Likely-duplicate check (§11.5): ask, never silently merge.
  const existing = (await live('products'))
    .find(p => p.name.trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    const goAhead = await appConfirm(
      `You already have a product called “${existing.name}”. Add this as a separate product anyway?`,
      { okLabel: 'Add anyway' });
    if (!goAhead) {
      openProductId = existing.id;
      $('productForm').hidden = true;
      $('toggleNewProduct').setAttribute('aria-expanded', 'false');
      $('prodSearch').value = existing.name;
      await renderPrices();
      return;
    }
  }

  const id = uuid();
  await db.products.put(stamp({
    id,
    name,
    category_id: $('pCategory').value || null,
    unit: $('pUnit').value,
    barcode: $('pBarcode').value.trim(),
    note: ''
  }));

  $('productForm').reset();
  $('productForm').hidden = true;
  openProductId = id;
  await renderPrices();
  toast('Product added. Now record a price.');
  scheduleSync();
}

async function deleteProduct(id) {
  const rows = await liveWhere('prices', 'product_id', id);
  if (!await appConfirm(rows.length
      ? `Delete this product and its ${rows.length} price records?`
      : 'Delete this product?', { okLabel: 'Delete', danger: true })) return;

  const product = await db.products.get(id);
  if (product) await db.products.put(stamp({ ...product, deleted: 1 }));
  for (const r of rows) await db.prices.put(stamp({ ...r, deleted: 1 }));

  openProductId = null;
  await renderPrices();
  scheduleSync();
}

function toggleProduct(id) {
  openProductId = (openProductId === id) ? null : id;
  renderPrices();
}

/* ---------- prices ---------- */

async function savePrice(productId) {
  const price = toCents($('np_' + productId).value);
  const store_id = $('ns_' + productId).value;
  const date = $('nd_' + productId).value || today();

  if (price <= 0) { toast('Enter a price above zero.'); return; }
  if (!store_id)  { toast('Pick a store first — add stores in Settings.'); return; }

  await db.prices.put(stamp({
    id: uuid(),
    product_id: productId,
    store_id,
    price,
    date,
    is_promo: $('npr_' + productId).checked
  }));

  await renderPrices();
  toast('Price recorded.');
  scheduleSync();
}

async function deletePrice(id) {
  const row = await db.prices.get(id);
  if (row) await db.prices.put(stamp({ ...row, deleted: 1 }));
  await renderPrices();
  scheduleSync();
}

/* ---------- stats ---------- */
/* Averages are always computed from the price rows, never stored. */

function statsByStore(rows) {
  const byStore = {};
  for (const r of rows) (byStore[r.store_id] ||= []).push(r);

  return Object.entries(byStore).map(([store_id, list]) => {
    list.sort((a, b) => b.date.localeCompare(a.date));
    const sum = list.reduce((s, r) => s + r.price, 0);
    return {
      store_id,
      count: list.length,
      latest: list[0].price,
      latestDate: list[0].date,
      avg: Math.round(sum / list.length)
    };
  }).sort((a, b) => a.avg - b.avg);
}

/* ---------- render ---------- */

// "updated 6 days ago" (§11.2) — a 12-month-old price must not read
// as authoritatively as one recorded this week.
function recencyLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const nowD = new Date();
  const days = Math.floor((new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()) - then) / 864e5);
  if (days <= 0) return 'updated today';
  if (days === 1) return 'updated yesterday';
  if (days < 60) return 'updated ' + days + ' days ago';
  return 'last updated ' + dateStr;
}

async function renderPrices() {
  const [products, prices, stores, cats] = await Promise.all([
    live('products'), live('prices'), live('stores'), live('categories')
  ]);

  products.sort((a, b) => a.name.localeCompare(b.name));
  stores.sort((a, b) => a.name.localeCompare(b.name));

  const storeName = Object.fromEntries(stores.map(s => [s.id, s.name]));
  const catName   = Object.fromEntries(cats.map(c => [c.id, c.name]));

  const q = $('prodSearch').value.trim().toLowerCase();
  const shown = q
    ? products.filter(p => p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q))
    : products;

  $('productCount').textContent = products.length
    ? shown.length + ' of ' + products.length : '';

  const list = $('productList');

  if (!products.length) {
    list.innerHTML = '<div class="blank">No products yet. Add one, then record what it costs in each store.</div>';
    return;
  }
  if (!shown.length) {
    list.innerHTML = '<div class="blank">Nothing matches that search.</div>';
    return;
  }

  const storeOptions = stores
    .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  // Prices are recorded per store, so with none configured nothing on
  // this screen can be recorded at all. Say that once, at the top,
  // instead of repeating a dead end inside every product (§11.7).
  const noStoreNotice = stores.length ? '' : `
    <div class="notice">
      <p class="hint">Prices are recorded per store, and you have not added any stores yet.
        Add one and every product here becomes recordable.</p>
      <button class="ghost" type="button" onclick="switchScreen('settings')">Add a store in Settings</button>
    </div>`;

  list.innerHTML = noStoreNotice + shown.map(p => {
    const rows   = prices.filter(r => r.product_id === p.id);
    const stats  = statsByStore(rows);
    const best   = stats[0];
    const spread = stats.length > 1 ? stats[stats.length - 1].avg - stats[0].avg : 0;
    const open   = openProductId === p.id;

    const summary = best
      ? `${money(best.avg)} best recorded avg · ${escapeHtml(storeName[best.store_id] || '—')}`
      : 'No prices recorded';

    const latestDate = rows.length
      ? rows.reduce((a, r) => (r.date > a ? r.date : a), rows[0].date)
      : null;
    const coverage = rows.length
      ? `${stats.length} store${stats.length === 1 ? '' : 's'} · ${rows.length} record${rows.length === 1 ? '' : 's'} · ${recencyLabel(latestDate)}`
      : '';

    const table = stats.length ? `
      <p class="hint">Averages come from your own recorded prices${stats.length === 1 ? ' — one store so far, so there is nothing to compare yet' : ''}.</p>
      <table class="ptable">
        <thead><tr><th>Store</th><th>Latest</th><th>Average</th><th>n</th></tr></thead>
        <tbody>
          ${stats.map((s, i) => `
            <tr class="${i === 0 && stats.length > 1 ? 'best' : ''}">
              <td>${escapeHtml(storeName[s.store_id] || 'Unknown')}${i === 0 && stats.length > 1 ? ' <span class="dim">· best recorded</span>' : ''}</td>
              <td class="num">${fromCents(s.latest)}</td>
              <td class="num">${fromCents(s.avg)}</td>
              <td class="num dim">${s.count}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${spread > 0 ? `<p class="hint">In your records, buying at ${escapeHtml(storeName[best.store_id])} saves
        ${money(spread)} per ${escapeHtml(p.unit || 'pcs')} versus the dearest store.</p>` : ''}
    ` : (stores.length
      ? '<p class="hint">No prices yet for this product. Record the first one below the next time you shop.</p>'
      : '<p class="hint">No prices yet for this product. Add a store first — prices are recorded per store.</p>');

    const history = rows.length ? `
      <div class="phist">
        ${rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map(r => `
          <div class="phrow">
            <span class="dim">${r.date}</span>
            <span>${escapeHtml(storeName[r.store_id] || '—')}</span>
            ${r.is_promo ? '<span class="chip">sale</span>' : ''}
            <span class="num">${fromCents(r.price)}</span>
            <button class="del" onclick="deletePrice('${r.id}')" aria-label="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg></button>
          </div>`).join('')}
      </div>` : '';

    // Recording a price needs a store; the screen-level notice above
    // covers the case where none exist yet (§11.4).
    const addForm = stores.length ? `
      <div class="priceadd">
        <select id="ns_${p.id}" aria-label="Store">${storeOptions}</select>
        <input type="number" id="np_${p.id}" inputmode="decimal" step="0.01" placeholder="0.00" aria-label="Price">
        <input type="date" id="nd_${p.id}" value="${today()}" aria-label="Date">
        <label class="promo"><input type="checkbox" id="npr_${p.id}"> Sale price</label>
        <button class="ghost priceadd-save" type="button" onclick="savePrice('${p.id}')">Record price</button>
      </div>` : '';

    // Managing the product itself has nothing to do with stores, so it
    // lives outside the price form and is always reachable.
    const manage = `
      <div class="pmanage">
        <button class="linkdanger" type="button" onclick="deleteProduct('${p.id}')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>
          <span>Delete product</span>
        </button>
      </div>`;

    return `
      <div class="daygroup">
        <button class="prow" onclick="toggleProduct('${p.id}')" aria-expanded="${open}">
          <div class="meta">
            <div class="cat">${escapeHtml(p.name)}</div>
            <div class="sub">${escapeHtml(catName[p.category_id] || 'No category')} \u00B7 ${escapeHtml(p.unit || 'pcs')} \u00B7 ${summary}</div>
            ${coverage ? `<div class="sub sub2">${coverage}</div>` : ''}
          </div>
          <span class="caret${open ? ' open' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg></span>
        </button>
        ${open ? `<div class="pdetail">${table}${addForm}${history}${manage}</div>` : ''}
      </div>`;
  }).join('');

  // The store/date pickers above were just recreated from scratch —
  // enhance the fresh elements the same way the static ones at boot got.
  window.TillRollControls.enhance(list);
}

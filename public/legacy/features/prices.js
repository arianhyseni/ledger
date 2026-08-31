/* ---------------------------------------------------------
   prices.js — products, store prices, averages, cheapest store
--------------------------------------------------------- */

let openProductId = null;

function initPrices() {
  $('prodSearch').oninput = () => renderPrices();
  $('toggleNewProduct').onclick = () => {
    const f = $('productForm');
    f.hidden = !f.hidden;
    if (!f.hidden) $('pName').focus();
  };
  $('productForm').onsubmit = saveProduct;
}

/* ---------- products ---------- */

async function saveProduct(e) {
  e.preventDefault();
  const name = $('pName').value.trim();
  if (!name) return;

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

  list.innerHTML = shown.map(p => {
    const rows   = prices.filter(r => r.product_id === p.id);
    const stats  = statsByStore(rows);
    const best   = stats[0];
    const spread = stats.length > 1 ? stats[stats.length - 1].avg - stats[0].avg : 0;
    const open   = openProductId === p.id;

    const summary = best
      ? `${money(best.avg)} avg at ${escapeHtml(storeName[best.store_id] || '—')}`
      : 'No prices recorded';

    const table = stats.length ? `
      <table class="ptable">
        <thead><tr><th>Store</th><th>Latest</th><th>Average</th><th>n</th></tr></thead>
        <tbody>
          ${stats.map((s, i) => `
            <tr class="${i === 0 ? 'best' : ''}">
              <td>${escapeHtml(storeName[s.store_id] || 'Unknown')}</td>
              <td class="num">${fromCents(s.latest)}</td>
              <td class="num">${fromCents(s.avg)}</td>
              <td class="num dim">${s.count}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${spread > 0 ? `<p class="hint">Buying at ${escapeHtml(storeName[best.store_id])} saves
        ${money(spread)} per ${escapeHtml(p.unit || 'pcs')} versus the dearest store on record.</p>` : ''}
    ` : '<p class="hint">No prices yet for this product.</p>';

    const history = rows.length ? `
      <div class="phist">
        ${rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map(r => `
          <div class="phrow">
            <span class="dim">${r.date}</span>
            <span>${escapeHtml(storeName[r.store_id] || '—')}</span>
            ${r.is_promo ? '<span class="chip">promo</span>' : ''}
            <span class="num">${fromCents(r.price)}</span>
            <button class="del" onclick="deletePrice('${r.id}')" aria-label="Delete">&times;</button>
          </div>`).join('')}
      </div>` : '';

    const addForm = `
      <div class="priceadd">
        <select id="ns_${p.id}">${storeOptions || '<option value="">Add stores in Settings</option>'}</select>
        <input type="number" id="np_${p.id}" inputmode="decimal" step="0.01" placeholder="0.00">
        <input type="date" id="nd_${p.id}" value="${today()}">
        <label class="promo"><input type="checkbox" id="npr_${p.id}"> promo</label>
        <button class="ghost" onclick="savePrice('${p.id}')">Record</button>
      </div>`;

    return `
      <div class="daygroup">
        <button class="prow" onclick="toggleProduct('${p.id}')">
          <div class="meta">
            <div class="cat">${escapeHtml(p.name)}</div>
            <div class="sub">${escapeHtml(catName[p.category_id] || 'No category')} \u00B7 ${escapeHtml(p.unit || 'pcs')} \u00B7 ${summary}</div>
          </div>
          <span class="caret">${open ? '&#8722;' : '+'}</span>
        </button>
        ${open ? `<div class="pdetail">${table}${addForm}${history}
          <button class="linkdanger" onclick="deleteProduct('${p.id}')">Delete product</button>
        </div>` : ''}
      </div>`;
  }).join('');
}

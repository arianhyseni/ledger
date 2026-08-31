/* ---------------------------------------------------------
   prices.js — products, store prices, averages, cheapest store
--------------------------------------------------------- */

let openProductId = null;   // which product row is expanded

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

  const id = await db.products.add({
    name,
    categoryId: Number($('pCategory').value) || null,
    unit: $('pUnit').value,
    barcode: $('pBarcode').value.trim(),
    note: ''
  });

  $('productForm').reset();
  $('productForm').hidden = true;
  openProductId = id;
  await renderPrices();
  toast('Product added. Now record a price.');
}

async function deleteProduct(id) {
  const n = await db.prices.where('productId').equals(id).count();
  if (!confirm(n ? `Delete this product and its ${n} price records?` : 'Delete this product?')) return;
  await db.transaction('rw', db.products, db.prices, async () => {
    await db.products.delete(id);
    await db.prices.where('productId').equals(id).delete();
  });
  openProductId = null;
  await renderPrices();
}

function toggleProduct(id) {
  openProductId = (openProductId === id) ? null : id;
  renderPrices();
}

/* ---------- prices ---------- */

async function savePrice(productId) {
  const price = toCents($('np_' + productId).value);
  const storeId = Number($('ns_' + productId).value);
  const date = $('nd_' + productId).value || today();

  if (price <= 0)  { toast('Enter a price above zero.'); return; }
  if (!storeId)    { toast('Pick a store first — add stores in Settings.'); return; }

  await db.prices.add({
    productId, storeId, price, date,
    isPromo: $('npr_' + productId).checked
  });
  await renderPrices();
  toast('Price recorded.');
}

async function deletePrice(id) {
  await db.prices.delete(id);
  await renderPrices();
}

/* ---------- stats ---------- */
/* Averages are always computed from the price rows, never stored. */

function statsByStore(rows) {
  const byStore = {};
  for (const r of rows) {
    (byStore[r.storeId] ||= []).push(r);
  }
  return Object.entries(byStore).map(([storeId, list]) => {
    list.sort((a, b) => b.date.localeCompare(a.date));
    const sum = list.reduce((s, r) => s + r.price, 0);
    return {
      storeId: Number(storeId),
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
    db.products.orderBy('name').toArray(),
    db.prices.toArray(),
    db.stores.orderBy('name').toArray(),
    db.categories.toArray()
  ]);

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

  const storeOptions = stores.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  list.innerHTML = shown.map(p => {
    const rows  = prices.filter(r => r.productId === p.id);
    const stats = statsByStore(rows);
    const best  = stats[0];
    const spread = stats.length > 1 ? stats[stats.length - 1].avg - stats[0].avg : 0;
    const open  = openProductId === p.id;

    const summary = best
      ? `${money(best.avg)} avg at ${escapeHtml(storeName[best.storeId] || '—')}`
      : 'No prices recorded';

    const table = stats.length ? `
      <table class="ptable">
        <thead><tr><th>Store</th><th>Latest</th><th>Average</th><th>n</th></tr></thead>
        <tbody>
          ${stats.map((s, i) => `
            <tr class="${i === 0 ? 'best' : ''}">
              <td>${escapeHtml(storeName[s.storeId] || 'Unknown')}</td>
              <td class="num">${fromCents(s.latest)}</td>
              <td class="num">${fromCents(s.avg)}</td>
              <td class="num dim">${s.count}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${spread > 0 ? `<p class="hint">Buying at ${escapeHtml(storeName[best.storeId])} saves
        ${money(spread)} per ${p.unit} versus the dearest store on record.</p>` : ''}
    ` : '<p class="hint">No prices yet for this product.</p>';

    const history = rows.length ? `
      <div class="phist">
        ${rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map(r => `
          <div class="phrow">
            <span class="dim">${r.date}</span>
            <span>${escapeHtml(storeName[r.storeId] || '—')}</span>
            ${r.isPromo ? '<span class="chip">promo</span>' : ''}
            <span class="num">${fromCents(r.price)}</span>
            <button class="del" onclick="deletePrice(${r.id})" aria-label="Delete">&times;</button>
          </div>`).join('')}
      </div>` : '';

    const addForm = `
      <div class="priceadd">
        <select id="ns_${p.id}">${storeOptions || '<option value="">Add stores in Settings</option>'}</select>
        <input type="number" id="np_${p.id}" inputmode="decimal" step="0.01" placeholder="0.00">
        <input type="date" id="nd_${p.id}" value="${today()}">
        <label class="promo"><input type="checkbox" id="npr_${p.id}"> promo</label>
        <button class="ghost" onclick="savePrice(${p.id})">Record</button>
      </div>`;

    return `
      <div class="daygroup">
        <button class="prow" onclick="toggleProduct(${p.id})">
          <div class="meta">
            <div class="cat">${escapeHtml(p.name)}</div>
            <div class="sub">${escapeHtml(catName[p.categoryId] || 'No category')} \u00B7 ${escapeHtml(p.unit || 'pcs')} \u00B7 ${summary}</div>
          </div>
          <span class="caret">${open ? '&#8722;' : '+'}</span>
        </button>
        ${open ? `<div class="pdetail">${table}${addForm}${history}
          <button class="linkdanger" onclick="deleteProduct(${p.id})">Delete product</button>
        </div>` : ''}
      </div>`;
  }).join('');
}

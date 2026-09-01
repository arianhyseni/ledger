const OPEN_FOOD_FACTS_PRODUCT_API = 'https://world.openfoodfacts.org/api/v3/product';
const OPEN_FOOD_FACTS_PRODUCT_PAGE = 'https://world.openfoodfacts.org/product';
const LOOKUP_FIELDS = [
  'code',
  'product_name',
  'abbreviated_product_name',
  'generic_name',
  'brands',
  'quantity',
  'product_quantity',
  'product_quantity_unit'
];

export function normalizeProductBarcode(value) {
  const code = String(value || '').replace(/[\s-]/g, '');
  return /^\d{6,14}$/.test(code) ? code : null;
}

function cleanProductText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function productQuantity(product) {
  let quantity = cleanProductText(product.quantity);
  if (!quantity && product.product_quantity != null && product.product_quantity_unit) {
    quantity = `${product.product_quantity} ${product.product_quantity_unit}`;
  }
  return quantity
    .replace(/(\d+)\.0+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildProductDisplayName(product = {}) {
  const productName = cleanProductText(
    product.product_name || product.abbreviated_product_name || product.generic_name
  );
  if (!productName) return null;

  const brand = cleanProductText(product.brands).split(',')[0].trim();
  const quantity = productQuantity(product);
  const nameLower = productName.toLocaleLowerCase();
  const parts = [];

  if (brand && !nameLower.includes(brand.toLocaleLowerCase())) parts.push(brand);
  parts.push(productName);
  if (quantity && !nameLower.includes(quantity.toLocaleLowerCase())) parts.push(quantity);
  return parts.join(' ');
}

export async function lookupProductByBarcode(
  barcode,
  { signal, fetchImpl = fetch, timeoutMs = 6500 } = {}
) {
  const code = normalizeProductBarcode(barcode);
  if (!code) return { found: false, reason: 'unsupported-barcode' };

  const url = new URL(`${OPEN_FOOD_FACTS_PRODUCT_API}/${encodeURIComponent(code)}.json`);
  url.searchParams.set('fields', LOOKUP_FIELDS.join(','));
  // These parameters also make the calling app visible in server logs. A web
  // browser owns its User-Agent header and does not allow JavaScript to replace it.
  url.searchParams.set('app_name', 'TillRoll');
  url.searchParams.set('app_version', '1.0');

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (response.status === 404) return { found: false, reason: 'not-found' };
    if (!response.ok) throw new Error(`Product lookup failed (${response.status}).`);

    const data = await response.json();
    const name = data && data.product ? buildProductDisplayName(data.product) : null;
    if (!name) return { found: false, reason: 'missing-name' };

    return {
      found: true,
      code,
      name,
      sourceUrl: `${OPEN_FOOD_FACTS_PRODUCT_PAGE}/${encodeURIComponent(code)}`
    };
  } catch (err) {
    if (timedOut) throw new Error('Product lookup timed out.');
    throw err;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abortFromCaller);
  }
}

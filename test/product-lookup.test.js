import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProductDisplayName,
  lookupProductByBarcode,
  normalizeProductBarcode
} from '../src/product-lookup.js';

test('normalizes retail barcodes without losing leading zeroes', () => {
  assert.equal(normalizeProductBarcode(' 0 12345-678905 '), '012345678905');
  assert.equal(normalizeProductBarcode('ABC-123'), null);
});

test('builds a useful product name from brand, label, and package quantity', () => {
  assert.equal(buildProductDisplayName({
    brands: 'Ehrmann',
    product_name: 'High Protein Pudding Chocolate',
    quantity: '200.0 g'
  }), 'Ehrmann High Protein Pudding Chocolate 200 g');

  assert.equal(buildProductDisplayName({
    brands: 'Ehrmann',
    product_name: 'Ehrmann High Protein Pudding',
    product_quantity: 200,
    product_quantity_unit: 'g'
  }), 'Ehrmann High Protein Pudding 200 g');
});

test('looks up one product through Open Food Facts v3 and limits response fields', async () => {
  let requestedUrl;
  let requestedOptions;
  const fetchImpl = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return {
      status: 200,
      ok: true,
      json: async () => ({
        status: 'success',
        product: {
          brands: 'Ehrmann',
          product_name: 'High Protein Pudding',
          quantity: '200 g'
        }
      })
    };
  };

  const result = await lookupProductByBarcode('4000000000000', { fetchImpl });
  assert.deepEqual(result, {
    found: true,
    code: '4000000000000',
    name: 'Ehrmann High Protein Pudding 200 g',
    sourceUrl: 'https://world.openfoodfacts.org/product/4000000000000'
  });
  assert.equal(requestedUrl.origin, 'https://world.openfoodfacts.org');
  assert.equal(requestedUrl.pathname, '/api/v3/product/4000000000000.json');
  assert.match(requestedUrl.searchParams.get('fields'), /product_name/);
  assert.equal(requestedUrl.searchParams.get('app_name'), 'TillRoll');
  assert.equal(requestedOptions.headers.Accept, 'application/json');
});

test('treats a missing Open Food Facts product as an editable unknown barcode', async () => {
  const result = await lookupProductByBarcode('0000000000000', {
    fetchImpl: async () => ({ status: 404, ok: false })
  });
  assert.deepEqual(result, { found: false, reason: 'not-found' });
});

test('does not call the product service for an unsupported code', async () => {
  let called = false;
  const result = await lookupProductByBarcode('ABC123', {
    fetchImpl: async () => { called = true; }
  });
  assert.deepEqual(result, { found: false, reason: 'unsupported-barcode' });
  assert.equal(called, false);
});

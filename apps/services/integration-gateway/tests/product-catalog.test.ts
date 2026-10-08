import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createGetProductCatalog,
  projectCatalogSearchResults,
} from '../src/product-catalog.js';
import type { CatalogSearchResult } from '../src/product-catalog.js';
import { TEST_ACCESS_CONTEXT, TEST_TENANT_ID } from './trusted-context-fixture.js';

test('catalog projection groups Shop variant rows by product and omits internal identifiers', () => {
  const result = projectCatalogSearchResults([
    {
      productId: 'internal-product-id',
      productName: 'Travel Mug',
      description: 'Insulated steel mug.',
      productVariantName: 'Navy',
      inStock: true,
      currencyCode: 'USD',
      priceWithTax: { __typename: 'SinglePrice', value: 2_500 },
      sku: 'INTERNAL-SKU',
    },
    {
      productId: 'internal-product-id',
      productName: 'Travel Mug',
      description: 'Insulated steel mug.',
      productVariantName: 'Red',
      inStock: false,
      currencyCode: 'USD',
      priceWithTax: { __typename: 'PriceRange' },
      sku: 'INTERNAL-RED-SKU',
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      productId: `internal-${index + 1}`,
      productName: `Product ${index + 1}`,
      description: 'Public description.',
      productVariantName: 'Standard',
      inStock: true,
      currencyCode: 'USD',
      priceWithTax: { __typename: 'PriceRange' as const },
      sku: `PRIVATE-${index + 1}`,
    })),
  ] as unknown as CatalogSearchResult[]);

  assert.equal(result.schemaVersion, 1);
  assert.ok(result.matches.length <= 5);
  assert.deepEqual(result.matches[0], {
    name: 'Travel Mug',
    description: 'Insulated steel mug.',
    variants: [
      {
        name: 'Navy',
        availability: 'IN_STOCK',
        price: { amountMinor: 2_500, currency: 'USD' },
      },
      {
        name: 'Red',
        availability: 'OUT_OF_STOCK',
      },
    ],
  });
  assert.equal('availability' in result.matches[0]!, false);
  assert.doesNotMatch(JSON.stringify(result), /internal-|INTERNAL-|PRIVATE-/);
  assert.deepEqual(
    result.matches.map((match) => match.name),
    ['Travel Mug', 'Product 1', 'Product 2', 'Product 3', 'Product 4'],
  );
});

test('catalog rejects an unbound tenant or channel mapping before calling the catalog client', async () => {
  let calls = 0;
  const getProductCatalog = createGetProductCatalog({
    catalogClient: {
      async searchPublishedProducts() {
        calls += 1;
        return { schemaVersion: 1, matches: [] };
      },
    },
    expectedTenantId: TEST_TENANT_ID,
    channelToken: undefined,
    expectedChannelCode: 'tenant-local-channel',
  });

  await assert.rejects(
    () => getProductCatalog('mug', TEST_ACCESS_CONTEXT),
    /Product catalog is unavailable/,
  );
  await assert.rejects(
    () => createGetProductCatalog({
      catalogClient: {
        async searchPublishedProducts() {
          calls += 1;
          return { schemaVersion: 1, matches: [] };
        },
      },
      expectedTenantId: TEST_TENANT_ID,
      channelToken: 'tenant-local-channel',
      expectedChannelCode: 'tenant-local-channel',
    })('mug', { ...TEST_ACCESS_CONTEXT, tenantId: 'tenant-other' }),
    /Product catalog is unavailable/,
  );

  assert.equal(calls, 0);
});

test('catalog projection rejects invalid stock instead of converting missing or truthy values', () => {
  for (const inStock of [undefined, null, 'false', 0, 1]) {
    assert.throws(() => projectCatalogSearchResults([{
      productId: 'internal-id', productName: 'Mug', description: 'Mug.',
      productVariantName: 'Navy', currencyCode: 'USD',
      priceWithTax: { __typename: 'SinglePrice', value: 2_500 }, inStock,
    }] as unknown as CatalogSearchResult[]), /invalid.*stock/i);
  }
});

test('catalog projection rejects a product whose 101st row could hide a duplicate variant', () => {
  assert.throws(() => projectCatalogSearchResults(Array.from({ length: 101 }, (_, index) => ({
    productId: 'internal-id', productName: 'Mug', description: 'Mug.',
    productVariantName: index === 0 || index === 100 ? 'Mug Navy' : `Mug Navy Edition ${index}`, currencyCode: 'USD',
    priceWithTax: { __typename: 'PriceRange' as const }, inStock: index === 100,
  }))), /too many.*variants/i);
});

test('catalog projection keeps all 100 variants at the complete-product boundary', () => {
  const result = projectCatalogSearchResults(Array.from({ length: 100 }, (_, index) => ({
    productId: 'internal-id', productName: 'Mug', description: 'Mug.',
    productVariantName: `Variant ${index}`, currencyCode: 'USD',
    priceWithTax: { __typename: 'PriceRange' as const }, inStock: false,
  })));
  assert.equal(result.matches[0]?.variants.length, 100);
  assert.ok(result.matches[0]?.variants.every(variant => variant.availability === 'OUT_OF_STOCK'));
  assert.equal('availability' in result.matches[0]!, false);
});

test('catalog projection rejects overflowing products even beyond the five-product projection limit', () => {
  const row: CatalogSearchResult = { productId: 'overflow', productName: 'Mug', description: 'Mug.',
    productVariantName: 'Navy', inStock: true, currencyCode: 'USD', priceWithTax: { __typename: 'PriceRange' } };
  assert.throws(() => projectCatalogSearchResults([
    ...Array.from({ length: 5 }, (_, index) => ({ ...row, productId: `product-${index}` })),
    ...Array.from({ length: 101 }, () => row),
  ]), /too many.*variants/i);
});

test('catalog rejects a blank channel mapping before calling the catalog client', async () => {
  let calls = 0;
  const getProductCatalog = createGetProductCatalog({
    catalogClient: {
      async searchPublishedProducts() {
        calls += 1;
        return { schemaVersion: 1, matches: [] };
      },
    },
    expectedTenantId: TEST_TENANT_ID,
    channelToken: '   ',
    expectedChannelCode: 'tenant-local-channel',
  });

  await assert.rejects(
    () => getProductCatalog('mug', TEST_ACCESS_CONTEXT),
    /Product catalog is unavailable/,
  );

  assert.equal(calls, 0);
});

test('catalog rejects a missing expected channel code before calling the catalog client', async () => {
  let calls = 0;
  const getProductCatalog = createGetProductCatalog({
    catalogClient: {
      async searchPublishedProducts() {
        calls += 1;
        return { schemaVersion: 1, matches: [] };
      },
    },
    expectedTenantId: TEST_TENANT_ID,
    channelToken: 'tenant-local-token',
  });

  await assert.rejects(
    () => getProductCatalog('mug', TEST_ACCESS_CONTEXT),
    /Product catalog is unavailable/,
  );
  assert.equal(calls, 0);
});

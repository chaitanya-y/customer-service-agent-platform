import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createVendureCatalogClient } from '../src/vendure-catalog-client.js';

async function parseInstalledVendureGraphql(source: string): Promise<{
  definitions: Array<Record<string, unknown>>;
}> {
  const packagePath = await realpath(fileURLToPath(new URL(
    '../../../../tools/simulators/commerce-sandbox/node_modules/@vendure/core/package.json',
    import.meta.url,
  )));
  const { parse } = createRequire(packagePath)('graphql') as {
    parse(document: string): {
      definitions: Array<Record<string, unknown>>;
    };
  };
  return parse(source);
}

function fieldSelection(
  selectionSet: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const field = (selectionSet.selections as Array<Record<string, unknown>>)
    .find((selection) => (
      selection.kind === 'Field'
      && (selection.name as { value: string }).value === name
    ));
  assert.ok(field);
  assert.ok(field.selectionSet);
  return field.selectionSet as Record<string, unknown>;
}

test('Shop catalog client selects installed stock extension and returns per-variant indexed availability', async () => {
  let capturedUrl: string | URL | Request | undefined;
  let capturedRequest: RequestInit | undefined;
  const catalogClient = createVendureCatalogClient({
    shopApiUrl: 'http://vendure.test/shop-api',
    channelToken: 'tenant-local-channel',
    expectedChannelCode: 'tenant-local-channel',
    async fetcher(url, request) {
      capturedUrl = url;
      capturedRequest = request;
      return Response.json({
        data: {
          activeChannel: { code: 'tenant-local-channel' },
          search: {
            totalItems: 1,
            items: [
              {
                productId: 'internal-product-id',
                productName: 'Travel Mug',
                description: 'Insulated steel mug.',
                productVariantName: 'Navy',
                inStock: true,
                currencyCode: 'USD',
                priceWithTax: { __typename: 'SinglePrice', value: 2_500 },
              },
            ],
          },
        },
      });
    },
  });

  const result = await catalogClient.searchPublishedProducts('mug', 99);

  assert.equal(capturedUrl, 'http://vendure.test/shop-api');
  assert.ok(capturedRequest);
  assert.equal(capturedRequest.redirect, 'error');
  const headers = new Headers(capturedRequest.headers);
  assert.equal(headers.get('vendure-token'), 'tenant-local-channel');
  assert.equal(headers.get('vendure-api-key'), null);
  const body = JSON.parse(String(capturedRequest.body));
  assert.deepEqual(body.variables, { input: { term: 'mug', take: 500, groupByProduct: false } });
  assert.match(body.query, /search\(input: \$input\)/);
  assert.match(body.query, /activeChannel\s*\{\s*code\s*\}/);
  assert.match(body.query, /productId/);
  assert.match(body.query, /\binStock\b/);
  assert.match(body.query, /\btotalItems\b/);
  assert.doesNotMatch(body.query, /\benabled\b/);
  const shopSearchSchema = await readFile(
    new URL('../../../../tools/simulators/commerce-sandbox/node_modules/@vendure/core/dist/api/schema/common/product-search.type.graphql', import.meta.url),
    'utf8',
  );
  const searchResultDefinition = (await parseInstalledVendureGraphql(shopSearchSchema)).definitions.find(
    (definition) => (
      definition.kind === 'ObjectTypeDefinition'
      && (definition.name as { value: string }).value === 'SearchResult'
    ),
  );
  assert.ok(searchResultDefinition);
  const installedShopFields = new Set(
    ((searchResultDefinition.fields as Array<Record<string, unknown>>) ?? [])
      .map((field) => (field.name as { value: string }).value),
  );
  // Stock fields are a configured plugin extension, not part of the base schema.
  const pluginRequire = createRequire(await realpath(fileURLToPath(new URL(
    '../../../../tools/simulators/commerce-sandbox/node_modules/@vendure/core/package.json',
    import.meta.url,
  ))));
  const { stockStatusExtension } = pluginRequire('./dist/plugin/default-search-plugin/api/api-extensions.js');
  const searchResultExtension = stockStatusExtension.definitions.find(
    (definition: Record<string, unknown>) => definition.kind === 'ObjectTypeExtension'
      && (definition.name as { value: string }).value === 'SearchResult',
  );
  assert.ok(searchResultExtension);
  for (const field of searchResultExtension.fields) installedShopFields.add(field.name.value);
  const operation = (await parseInstalledVendureGraphql(body.query)).definitions.find(
    (definition) => definition.kind === 'OperationDefinition',
  );
  assert.ok(operation);
  const selectedSearchFields = (
    fieldSelection(
      fieldSelection(operation.selectionSet as Record<string, unknown>, 'search'),
      'items',
    ).selections as Array<Record<string, unknown>>
  ).filter((selection) => selection.kind === 'Field')
    .map((selection) => (selection.name as { value: string }).value);
  for (const field of selectedSearchFields) {
    assert.equal(installedShopFields.has(field), true, `${field} is not a Shop SearchResult field`);
  }
  assert.deepEqual(result, {
    schemaVersion: 1,
    matches: [
      {
        name: 'Travel Mug',
        description: 'Insulated steel mug.',
        variants: [
          {
            name: 'Navy',
            availability: 'IN_STOCK',
            price: { amountMinor: 2_500, currency: 'USD' },
          },
        ],
      },
    ],
  });
});

test('Shop catalog client rejects products from a different active channel', async () => {
  const catalogClient = createVendureCatalogClient({
    shopApiUrl: 'http://vendure.test/shop-api',
    channelToken: 'token-for-other-channel',
    expectedChannelCode: 'tenant-local-channel',
    async fetcher() {
      return Response.json({
        data: {
          activeChannel: { code: 'other-channel' },
          search: { totalItems: 1, items: [{
            productId: 'other-product',
            productName: 'Private Product',
            description: 'Not in this tenant.',
            productVariantName: 'Standard',
            inStock: true,
            currencyCode: 'USD',
            priceWithTax: { __typename: 'SinglePrice', value: 1_000 },
          }] },
        },
      });
    },
  });

  await assert.rejects(
    () => catalogClient.searchPublishedProducts('product', 5),
    /Product catalog is unavailable/,
  );
});

test('Shop catalog client rejects missing or invalid active channel data', async () => {
  for (const activeChannel of [undefined, null, { code: '' }, { code: 42 }]) {
    const catalogClient = createVendureCatalogClient({
      shopApiUrl: 'http://vendure.test/shop-api',
      channelToken: 'tenant-local-token',
      expectedChannelCode: 'tenant-local-channel',
      async fetcher() {
        return Response.json({
          data: {
            activeChannel,
            search: { totalItems: 0, items: [] },
          },
        });
      },
    });

    await assert.rejects(
      () => catalogClient.searchPublishedProducts('mug', 5),
      /Vendure catalog returned invalid GraphQL data/,
    );
  }
});

test('Shop catalog rejects the whole snapshot when any variant stock status is missing or nonboolean', async () => {
  for (const inStock of [undefined, null, 'false', 0, 1, {}]) {
    const catalogClient = createVendureCatalogClient({
      shopApiUrl: 'http://vendure.test/shop-api',
      channelToken: 'tenant-local-token',
      expectedChannelCode: 'tenant-local-channel',
      async fetcher() {
        const row = {
          productId: 'internal-id', productName: 'Travel Mug', description: 'Mug.',
          productVariantName: 'Navy', currencyCode: 'USD',
          priceWithTax: { __typename: 'SinglePrice', value: 2_500 },
        };
        return Response.json({ data: {
          activeChannel: { code: 'tenant-local-channel' },
          search: { totalItems: 2, items: [{ ...row, inStock: true }, { ...row, productVariantName: 'Red', inStock }] },
        } });
      },
    });
    await assert.rejects(() => catalogClient.searchPublishedProducts('mug', 5),
      /Vendure catalog returned invalid GraphQL data/);
  }
});

test('Shop catalog preserves mixed variant stock without producing product-wide availability', async () => {
  const client = createVendureCatalogClient({
    shopApiUrl: 'http://vendure.test/shop-api', channelToken: 'tenant-local-token',
    expectedChannelCode: 'tenant-local-channel',
    async fetcher() {
      const row = { productId: 'internal-id', productName: 'Travel Mug', description: 'Mug.',
        currencyCode: 'USD', priceWithTax: { __typename: 'SinglePrice', value: 2_500 } };
      return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, search: { totalItems: 2, items: [
        { ...row, productVariantName: 'Navy', inStock: true },
        { ...row, productVariantName: 'Red', inStock: false },
      ] } } });
    },
  });
  const result = await client.searchPublishedProducts('mug', 5);
  assert.deepEqual(result.matches[0]?.variants, [
    { name: 'Navy', availability: 'IN_STOCK', price: { amountMinor: 2_500, currency: 'USD' } },
    { name: 'Red', availability: 'OUT_OF_STOCK', price: { amountMinor: 2_500, currency: 'USD' } },
  ]);
  assert.equal('availability' in result.matches[0]!, false);
});

for (const totalItems of [undefined, null, true, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`Shop catalog rejects invalid completeness count ${JSON.stringify(totalItems)}`, async () => {
    const client = createVendureCatalogClient({
      shopApiUrl: 'http://vendure.test/shop-api', channelToken: 'tenant-local-token', expectedChannelCode: 'tenant-local-channel',
      async fetcher() { return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
        search: { totalItems, items: [] } } }); },
    });
    await assert.rejects(() => client.searchPublishedProducts('mug', 5), /invalid GraphQL data/);
  });
}

for (const totalItems of [0, 2, 501]) {
  test(`Shop catalog rejects incomplete or inconsistent search count ${totalItems} for one returned row`, async () => {
    const client = createVendureCatalogClient({
      shopApiUrl: 'http://vendure.test/shop-api', channelToken: 'tenant-local-token', expectedChannelCode: 'tenant-local-channel',
      async fetcher() { return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
        search: { totalItems, items: [{ productId: 'product-1', productName: 'Mug', description: 'Mug.',
          productVariantName: 'Navy', inStock: true, currencyCode: 'USD', priceWithTax: { __typename: 'PriceRange' } }] } } }); },
    });
    await assert.rejects(() => client.searchPublishedProducts('mug', 5), /incomplete.*search/i);
  });
}

test('Shop catalog accepts a verified complete empty search', async () => {
  const client = createVendureCatalogClient({
    shopApiUrl: 'http://vendure.test/shop-api', channelToken: 'tenant-local-token', expectedChannelCode: 'tenant-local-channel',
    async fetcher() { return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
      search: { totalItems: 0, items: [] } } }); },
  });
  assert.deepEqual(await client.searchPublishedProducts('mug', 5), { schemaVersion: 1, matches: [] });
});

for (const totalItems of [500, 501]) {
  test(`Shop catalog enforces complete coverage at the 500-row search boundary: ${totalItems} total rows`, async () => {
    const items = Array.from({ length: 500 }, (_, index) => ({
      productId: `product-${Math.floor(index / 100)}`, productName: `Mug ${Math.floor(index / 100)}`,
      description: 'Navy mug.', productVariantName: index === 0 ? 'Navy' : `Navy Edition ${index}`,
      inStock: true, currencyCode: 'USD', priceWithTax: { __typename: 'PriceRange' },
    }));
    const client = createVendureCatalogClient({
      shopApiUrl: 'http://vendure.test/shop-api', channelToken: 'tenant-local-token', expectedChannelCode: 'tenant-local-channel',
      async fetcher() { return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
        search: { totalItems, items } } }); },
    });
    if (totalItems === 501) {
      // The unseen row may duplicate the named variant, so visible uniqueness is insufficient.
      await assert.rejects(() => client.searchPublishedProducts('Navy', 5), /incomplete.*search/i);
    } else {
      const result = await client.searchPublishedProducts('Navy', 5);
      assert.equal(result.matches.length, 5);
      assert.ok(result.matches.every((product) => product.variants.length === 100));
    }
  });
}

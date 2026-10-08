import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { buildApp } from '../src/app.js';
import type { GetProductCatalog } from '../src/product-catalog.js';
import type { GetRecentOrderReferences } from '../src/recent-order-references.js';
import type {
  CommerceOrder,
  CommerceProvider,
} from '../src/commerce.js';
import { CONTEXT_ASSERTION_HEADER } from '../src/trusted-context.js';
import {
  createTestContextAssertion,
  TEST_CONTEXT_ASSERTION,
  verifyTestContextAssertion,
} from './trusted-context-fixture.js';

const commerceOrder: CommerceOrder = {
  source: {
    provider: 'vendure',
    orderId: '3',
  },
  reference: 'ORDER-123',
  status: 'Delivered',
  active: false,
  placedAt: '2026-07-25T23:59:40.265Z',
  customer: {
    id: 'customer-42',
    name: 'Private Customer',
    email: 'private@example.com',
  },
  total: {
    amountMinor: 10_000,
    currency: 'USD',
  },
  items: [],
  payments: [
    {
      id: 'payment-1',
      status: 'Settled',
      amount: {
        amountMinor: 10_000,
        currency: 'USD',
      },
      method: 'standard-payment',
      transactionReference: 'secret-transaction-reference',
      refunds: [],
    },
  ],
  fulfillments: [],
};

async function connectMcpClient(
  context: TestContext,
  commerceProvider: CommerceProvider,
  contextAssertion: string | null = TEST_CONTEXT_ASSERTION,
  getProductCatalog?: GetProductCatalog,
  getRecentOrderReferences?: GetRecentOrderReferences,
): Promise<Client> {
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
    ...(getProductCatalog ? { getProductCatalog } : {}),
    ...(getRecentOrderReferences ? { getRecentOrderReferences } : {}),
  });
  await app.listen({
    host: '127.0.0.1',
    port: 0,
  });
  context.after(() => app.close());

  const address = app.server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    contextAssertion
      ? {
          requestInit: {
            headers: {
              [CONTEXT_ASSERTION_HEADER]: contextAssertion,
            },
          },
        }
      : undefined,
  );
  const client = new Client({
    name: 'integration-gateway-test-client',
    version: '0.1.0',
  });
  await client.connect(transport);
  context.after(() => client.close());

  return client;
}

test('lookup_order_total exposes only tax-inclusive total of the owned order', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference() { return commerceOrder; },
  });
  const result = await client.callTool({ name: 'lookup_order_total', arguments: { orderReference: 'ORDER-123' } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    schemaVersion: '1', reference: 'ORDER-123', total: { amountMinor: 10000, currency: 'USD' },
  });
});

test('lookup_order_total hides other customer orders', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference() { return { ...commerceOrder, customer: { ...commerceOrder.customer!, id: 'other-customer' } }; },
  });
  const result = await client.callTool({ name: 'lookup_order_total', arguments: { orderReference: 'ORDER-123' } });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { error: { code: 'order_not_found', message: 'Order was not found' } });
});

test('MCP lists and calls the read-only lookup_order tool', async (context) => {
  let receivedReference: string | undefined;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference(reference) {
      receivedReference = reference;
      return commerceOrder;
    },
  };
  const client = await connectMcpClient(context, commerceProvider);

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 7);
  assert.equal(tools.tools[0]?.name, 'lookup_order');
  assert.equal(tools.tools[0]?.title, 'Look up order');
  assert.deepEqual(tools.tools[0]?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(tools.tools[1]?.name, 'lookup_order_status');
  assert.deepEqual(tools.tools[1]?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(tools.tools[2]?.name, 'lookup_order_items');
  assert.deepEqual(tools.tools[2]?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(tools.tools[3]?.name, 'lookup_payment_status');
  assert.equal(tools.tools[4]?.name, 'lookup_product_catalog');

  const result = await client.callTool({
    name: 'lookup_order',
    arguments: {
      orderReference: '  ORDER-123  ',
    },
  });

  assert.equal(receivedReference, 'ORDER-123');
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.reference, 'ORDER-123');
  assert.deepEqual(result.structuredContent?.customerRef, {
    customerId: 'customer-42',
  });

  const serializedResult = JSON.stringify(result);
  assert.doesNotMatch(serializedResult, /Private Customer/);
  assert.doesNotMatch(serializedResult, /private@example\.com/);
  assert.doesNotMatch(serializedResult, /secret-transaction-reference/);
});

test('lookup_recent_order_references returns only owned references from verified context', async (context) => {
  let receivedContext: unknown;
  const client = await connectMcpClient(context, {
    async getOrderByReference() { throw new Error('Unrelated lookup forbidden'); },
  }, TEST_CONTEXT_ASSERTION, undefined, async (identity) => {
    receivedContext = identity;
    return { schemaVersion: '1', orders: [{ reference: 'ABC-42', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: false };
  });
  const tools = await client.listTools();
  const tool = tools.tools.find((candidate) => candidate.name === 'lookup_recent_order_references');
  assert.ok(tool);
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual(tool.inputSchema.properties, {});
  assert.equal(tool.inputSchema.additionalProperties, false);
  const result = await client.callTool({ name: 'lookup_recent_order_references', arguments: {} });
  assert.deepEqual(receivedContext, {
    contextId: 'context-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
    routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1',
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    schemaVersion: '1', orders: [{ reference: 'ABC-42', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: false,
  });
  const parameterized = await client.callTool({ name: 'lookup_recent_order_references', arguments: { customerId: 'other' } });
  assert.equal(parameterized.isError, true);
});

test('lookup_recent_order_references fails closed without trusted context or safe provider data', async (context) => {
  let reads = 0;
  const unauthorized = await connectMcpClient(context, {
    async getOrderByReference() { throw new Error('Unrelated lookup forbidden'); },
  }, null, undefined, async () => { reads++; return { schemaVersion: '1', orders: [], hasMore: false }; });
  const missingContext = await unauthorized.callTool({ name: 'lookup_recent_order_references', arguments: {} });
  assert.equal(missingContext.isError, true);
  assert.deepEqual(missingContext.structuredContent, { error: { code: 'context_unauthorized', message: 'Trusted context is required' } });
  assert.equal(reads, 0);

  const malformed = await connectMcpClient(context, {
    async getOrderByReference() { throw new Error('Unrelated lookup forbidden'); },
  }, TEST_CONTEXT_ASSERTION, undefined, async () => ({
    schemaVersion: '1', orders: [{ reference: 'ABC-42', placedAt: '2026-10-01T12:00:00.000Z', payment: 'private' }], hasMore: false,
  }));
  const result = await malformed.callTool({ name: 'lookup_recent_order_references', arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { error: { code: 'recent_order_references_unavailable', message: 'Recent order references are unavailable' } });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('lookup_order_total never reads without authorization and masks uncertain sources', async (context) => {
  const unauthorized = await connectMcpClient(context, {
    async getOrderByReference() { throw new Error('Must never read without identity'); },
  }, null);
  const missingContext = await unauthorized.callTool({ name: 'lookup_order_total', arguments: { orderReference: 'ORDER-123' } });
  assert.deepEqual(missingContext.structuredContent, { error: { code: 'context_unauthorized', message: 'Trusted context is required' } });
  for (const total of [
    { amountMinor: -1, currency: 'USD' }, { amountMinor: 1.5, currency: 'USD' },
    { amountMinor: Number.NaN, currency: 'USD' }, { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'USD' },
    { amountMinor: 12345, currency: 'ZZZ' },
  ]) {
    const client = await connectMcpClient(context, { async getOrderByReference() { return { ...commerceOrder, total }; } });
    const result = await client.callTool({ name: 'lookup_order_total', arguments: { orderReference: 'ORDER-123' } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error: { code: 'commerce_provider_unavailable', message: 'Commerce provider request failed' } });
  }
});

test('lookup_order_items returns only names and quantities for an owned order', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference() {
      return { ...commerceOrder, items: [{
        id: 'private-line-id', sku: 'private-sku', name: 'Laptop 13 inch 8GB',
        quantity: 1, unitPrice: { amountMinor: 10000, currency: 'USD' },
        lineTotal: { amountMinor: 10000, currency: 'USD' },
      }] };
    },
  });

  const result = await client.callTool({
    name: 'lookup_order_items', arguments: { orderReference: 'ORDER-123' },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    schemaVersion: '1', reference: 'ORDER-123',
    items: [{ name: 'Laptop 13 inch 8GB', quantity: 1 }],
  });
  for (const privateValue of [
    'private-line-id', 'private-sku', 'customer-42', 'payment-1',
    'private@example.com', 'secret-transaction-reference', '10000',
  ]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('lookup_order_items masks unknown and other-customer orders alike', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference(reference) {
      return reference === 'FOREIGN'
        ? { ...commerceOrder, customer: { ...commerceOrder.customer!, id: 'other-customer' } }
        : null;
    },
  });
  const unknown = await client.callTool({
    name: 'lookup_order_items', arguments: { orderReference: 'UNKNOWN' },
  });
  const foreign = await client.callTool({
    name: 'lookup_order_items', arguments: { orderReference: 'FOREIGN' },
  });
  assert.equal(unknown.isError, true);
  assert.deepEqual(unknown.structuredContent, {
    error: { code: 'order_not_found', message: 'Order was not found' },
  });
  assert.deepEqual(foreign, unknown);
});

test('lookup_order_items fails closed without context, on provider errors, or malformed items', async (context) => {
  let providerCalls = 0;
  const provider: CommerceProvider = {
    async getOrderByReference() {
      providerCalls += 1;
      throw new Error('private provider failure');
    },
  };
  const unauthorized = await connectMcpClient(context, provider, null);
  const denied = await unauthorized.callTool({
    name: 'lookup_order_items', arguments: { orderReference: 'ORDER-123' },
  });
  assert.equal(providerCalls, 0);
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.structuredContent, {
    error: { code: 'context_unauthorized', message: 'Trusted context is required' },
  });

  const authorized = await connectMcpClient(context, provider);
  const outage = await authorized.callTool({
    name: 'lookup_order_items', arguments: { orderReference: 'ORDER-123' },
  });
  assert.equal(outage.isError, true);
  assert.deepEqual(outage.structuredContent, {
    error: { code: 'commerce_provider_unavailable', message: 'Commerce provider request failed' },
  });

  const malformed = await connectMcpClient(context, {
    async getOrderByReference() {
      return { ...commerceOrder, items: Array.from({ length: 21 }, () => ({
        id: 'private-line', sku: 'private-sku', name: 'Laptop', quantity: 1,
        unitPrice: { amountMinor: 10000, currency: 'USD' },
        lineTotal: { amountMinor: 10000, currency: 'USD' },
      })) };
    },
  });
  const invalid = await malformed.callTool({
    name: 'lookup_order_items', arguments: { orderReference: 'ORDER-123' },
  });
  assert.deepEqual(invalid, outage);
});

test('lookup_payment_status returns only safe aggregate fields for an owned order', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference() {
      return { ...commerceOrder, payments: [{
        ...commerceOrder.payments[0]!, refunds: [{
          id: 'private-refund-id', status: 'Pending',
          amount: { amountMinor: 2000, currency: 'USD' }, lineIds: ['private-line-id'],
        }],
      }] };
    },
  });
  const tools = await client.listTools();
  const tool = tools.tools.find((entry) => entry.name === 'lookup_payment_status');
  assert.deepEqual(tool?.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  });
  const result = await client.callTool({
    name: 'lookup_payment_status', arguments: { orderReference: ' ORDER-123 ' },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    schemaVersion: '1', reference: 'ORDER-123', paymentStatus: 'PAID', refundStatus: 'PENDING',
  });
  for (const privateValue of [
    'private-refund-id', 'private-line-id', 'payment-1', 'standard-payment',
    'secret-transaction-reference', 'customer-42', 'private@example.com', '2000',
  ]) assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('lookup_payment_status masks missing and foreign-customer orders identically', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference(reference) {
      return reference === 'FOREIGN'
        ? { ...commerceOrder, customer: { ...commerceOrder.customer!, id: 'foreign-customer' } }
        : null;
    },
  });
  const missing = await client.callTool({ name: 'lookup_payment_status', arguments: { orderReference: 'MISSING' } });
  const foreign = await client.callTool({ name: 'lookup_payment_status', arguments: { orderReference: 'FOREIGN' } });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent, { error: { code: 'order_not_found', message: 'Order was not found' } });
  assert.deepEqual(foreign, missing);
});

test('lookup_payment_status never calls provider without verified context and masks failures', async (context) => {
  let calls = 0;
  const provider: CommerceProvider = {
    async getOrderByReference() { calls += 1; throw new Error('private provider error'); },
  };
  const unauthorized = await connectMcpClient(context, provider, null);
  const denied = await unauthorized.callTool({ name: 'lookup_payment_status', arguments: { orderReference: 'ORDER-123' } });
  assert.equal(calls, 0);
  assert.deepEqual(denied.structuredContent, { error: { code: 'context_unauthorized', message: 'Trusted context is required' } });
  const authorized = await connectMcpClient(context, provider);
  const failure = await authorized.callTool({ name: 'lookup_payment_status', arguments: { orderReference: 'ORDER-123' } });
  assert.equal(failure.isError, true);
  assert.deepEqual(failure.structuredContent, { error: { code: 'commerce_provider_unavailable', message: 'Commerce provider request failed' } });
});

test('lookup_order_status serializes only owned customer-safe status fields', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference() {
      return {
        ...commerceOrder,
        fulfillments: [{
          id: 'fulfillment-private-1',
          status: 'Shipped',
          method: 'Private carrier method',
          trackingCode: 'TRACK-123',
        }],
      };
    },
  });

  const result = await client.callTool({
    name: 'lookup_order_status',
    arguments: { orderReference: 'ORDER-123' },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    schemaVersion: '1',
    reference: 'ORDER-123',
    status: 'Delivered',
    fulfillments: [{ status: 'Shipped', trackingCode: 'TRACK-123' }],
  });
  const serializedResult = JSON.stringify(result);
  for (const privateValue of [
    'customer-42', 'payment-1', 'fulfillment-private-1',
    'Private Customer', 'private@example.com', 'Private carrier method',
    'secret-transaction-reference', 'vendure',
  ]) {
    assert.equal(serializedResult.includes(privateValue), false);
  }
});

test('lookup_order_status masks unknown and other-customer orders alike', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference(reference) {
      return reference === 'FOREIGN'
        ? {
            ...commerceOrder,
            status: 'Private foreign order status',
            customer: { ...commerceOrder.customer!, id: 'other-customer' },
            fulfillments: [{
              id: 'foreign-fulfillment',
              status: 'Private foreign fulfillment status',
              method: 'Private foreign carrier',
              trackingCode: 'FOREIGN-TRACKING-SECRET',
            }],
          }
        : null;
    },
  });
  const unknown = await client.callTool({
    name: 'lookup_order_status', arguments: { orderReference: 'UNKNOWN' },
  });
  const foreign = await client.callTool({
    name: 'lookup_order_status', arguments: { orderReference: 'FOREIGN' },
  });

  assert.equal(unknown.isError, true);
  assert.deepEqual(unknown.structuredContent, {
    error: { code: 'order_not_found', message: 'Order was not found' },
  });
  assert.deepEqual(foreign, unknown);
  const serializedForeign = JSON.stringify(foreign);
  for (const privateValue of [
    'Private foreign order status',
    'Private foreign fulfillment status',
    'FOREIGN-TRACKING-SECRET',
  ]) {
    assert.equal(serializedForeign.includes(privateValue), false);
  }
});

test('lookup_order_status fails closed without trusted context or provider', async (context) => {
  let providerCalls = 0;
  const provider: CommerceProvider = {
    async getOrderByReference() {
      providerCalls += 1;
      throw new Error('private provider failure');
    },
  };
  const unauthorized = await connectMcpClient(context, provider, null);
  const denied = await unauthorized.callTool({
    name: 'lookup_order_status', arguments: { orderReference: 'ORDER-123' },
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual(denied.structuredContent, {
    error: { code: 'context_unauthorized', message: 'Trusted context is required' },
  });

  const authorized = await connectMcpClient(context, provider);
  const outage = await authorized.callTool({
    name: 'lookup_order_status', arguments: { orderReference: 'ORDER-123' },
  });
  assert.equal(outage.isError, true);
  assert.deepEqual(outage.structuredContent, {
    error: { code: 'commerce_provider_unavailable', message: 'Commerce provider request failed' },
  });
});

test('lookup_product_catalog returns only the configured read-only catalog projection', async (context) => {
  const seen: Array<{ query: string; tenantId: string }> = [];
  const getProductCatalog = (async (query, accessContext) => {
    seen.push({ query, tenantId: accessContext.tenantId });
    return {
      schemaVersion: 1 as const,
      matches: [{
        name: 'Ghee lip balm',
        description: 'Lip balm',
        variants: [{ name: '12 g', price: { amountMinor: 33600, currency: 'INR' } }],
        availability: 'IN_STOCK' as const,
      }],
    };
  }) satisfies GetProductCatalog;
  const client = await connectMcpClient(context, {
    async getOrderByReference() { return null; },
  }, TEST_CONTEXT_ASSERTION, getProductCatalog);

  const result = await client.callTool({
    name: 'lookup_product_catalog',
    arguments: { query: '  ghee lip balm  ' },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(seen, [{ query: 'ghee lip balm', tenantId: 'tenant-local' }]);
  assert.deepEqual(result.structuredContent, {
    schemaVersion: 1,
    matches: [{
      name: 'Ghee lip balm',
      description: 'Lip balm',
      variants: [{ name: '12 g', price: { amountMinor: 33600, currency: 'INR' } }],
      availability: 'IN_STOCK',
    }],
  });
});

test('lookup_product_catalog fails closed without channel mapping', async (context) => {
  const client = await connectMcpClient(context, {
    async getOrderByReference() { return null; },
  });

  const result = await client.callTool({
    name: 'lookup_product_catalog',
    arguments: { query: 'lip balm' },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: 'catalog_unavailable', message: 'Product catalog is unavailable' },
  });
});

test('lookup_product_catalog refuses to call provider without verified context', async (context) => {
  let called = false;
  const client = await connectMcpClient(context, {
    async getOrderByReference() { return null; },
  }, null, (async () => {
    called = true;
    return { schemaVersion: 1, matches: [] };
  }) satisfies GetProductCatalog);

  const result = await client.callTool({
    name: 'lookup_product_catalog',
    arguments: { query: 'lip balm' },
  });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: 'context_unauthorized', message: 'Trusted context is required' },
  });
});

test('lookup_order returns a stable error for an unknown order', async (
  context,
) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return null;
    },
  };
  const client = await connectMcpClient(context, commerceProvider);

  const result = await client.callTool({
    name: 'lookup_order',
    arguments: {
      orderReference: 'MISSING',
    },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: 'order_not_found',
      message: 'Order was not found',
    },
  });
});

test('lookup_order rejects an empty order reference', async (context) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      throw new Error('The provider should not be called');
    },
  };
  const client = await connectMcpClient(context, commerceProvider);

  const result = await client.callTool({
    name: 'lookup_order',
    arguments: {
      orderReference: '',
    },
  });

  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Invalid arguments/);
});

test('lookup_order rejects a missing trusted context', async (context) => {
  let providerCalled = false;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      providerCalled = true;
      return commerceOrder;
    },
  };
  const client = await connectMcpClient(
    context,
    commerceProvider,
    null,
  );

  const result = await client.callTool({
    name: 'lookup_order',
    arguments: {
      orderReference: 'ORDER-123',
    },
  });

  assert.equal(providerCalled, false);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: 'context_unauthorized',
      message: 'Trusted context is required',
    },
  });
});

test('lookup_order hides an order owned by another customer', async (
  context,
) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return commerceOrder;
    },
  };
  const client = await connectMcpClient(
    context,
    commerceProvider,
    createTestContextAssertion({ customerId: 'customer-other' }),
  );

  const result = await client.callTool({
    name: 'lookup_order',
    arguments: {
      orderReference: 'ORDER-123',
    },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: 'order_not_found',
      message: 'Order was not found',
    },
  });
});

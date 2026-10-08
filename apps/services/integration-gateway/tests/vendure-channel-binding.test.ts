import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVendureCommerceProvider } from '../src/vendure-client.js';
import { buildApp } from '../src/app.js';
import { verifyTestContextAssertion } from './trusted-context-fixture.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER, type RefundExecutionIntent } from '../src/workflow-access.js';

const binding = { channelToken: 'synthetic-channel-token', expectedChannelCode: 'tenant-local-channel' };
const order = {
  id: '3', code: 'ORDER-123', state: 'Delivered', active: false,
  currencyCode: 'USD', orderPlacedAt: null, totalWithTax: 10_000,
  customer: { id: 'customer-42', firstName: 'Test', lastName: 'Customer', emailAddress: 'test@example.invalid' },
  lines: [], payments: [{ id: 'payment-1', state: 'Settled', amount: 10_000,
    method: 'standard', transactionId: null, refunds: [] }], fulfillments: [],
};
const execution = { orderId: '3', paymentId: 'payment-1', amount: { amountMinor: 5_000, currency: 'USD' }, reason: 'DAMAGED' };

for (const field of ['channelToken', 'expectedChannelCode'] as const) {
  for (const value of [undefined, '', '   ']) {
    for (const operation of ['reference', 'id', 'refund'] as const) {
      test(`Vendure ${operation} fails closed before network with ${field}=${JSON.stringify(value)}`, async () => {
        let requests = 0;
        await assert.rejects(async () => {
          const provider = createVendureCommerceProvider({
            adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key',
            ...binding, [field]: value,
            async fetcher() { requests += 1; return Response.json({ data: { order,
              orders: { totalItems: 1, items: [order] }, refundOrder: { __typename: 'Refund', id: 'refund-1' } } }); },
          } as Parameters<typeof createVendureCommerceProvider>[0]);
          if (operation === 'reference') await provider.getOrderByReference('ORDER-123');
          else if (operation === 'id') await provider.getOrderById('3');
          else await provider.executeRefund!(execution);
        }, /channel/i);
        assert.equal(requests, 0);
      });
    }
  }
}

for (const lookup of ['reference', 'id'] as const) {
  test(`Vendure ${lookup} lookup selects and validates the configured channel`, async () => {
    const provider = createVendureCommerceProvider({
      adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
      async fetcher(_url, request) {
        assert.equal(new Headers(request?.headers).get('vendure-token'), 'synthetic-channel-token');
        assert.match(JSON.parse(String(request?.body)).query, /activeChannel\s*\{\s*code\s*\}/);
        return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
          ...(lookup === 'reference' ? { orders: { totalItems: 1, items: [order] } } : { order }) } });
      },
    });
    const result = lookup === 'reference' ? await provider.getOrderByReference('ORDER-123') : await provider.getOrderById('3');
    assert.equal(result?.source.orderId, '3');
  });

  for (const channel of [undefined, null, {}, { code: '' }, { code: '   ' }, { code: 'other-channel' }]) {
    test(`Vendure ${lookup} rejects unavailable or wrong active channel ${JSON.stringify(channel)}`, async () => {
      const provider = createVendureCommerceProvider({
        adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
        async fetcher() { return Response.json({ data: { activeChannel: channel,
          ...(lookup === 'reference' ? { orders: { totalItems: 1, items: [order] } } : { order }) } }); },
      });
      await assert.rejects(() => lookup === 'reference' ? provider.getOrderByReference('ORDER-123') : provider.getOrderById('3'));
    });
  }

  test(`Vendure ${lookup} rejects partial data even when channel and order match`, async () => {
    const provider = createVendureCommerceProvider({
      adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
      async fetcher() { return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
        ...(lookup === 'reference' ? { orders: { totalItems: 1, items: [order] } } : { order }) }, errors: [{ message: 'synthetic-error' }] }); },
    });
    await assert.rejects(() => lookup === 'reference' ? provider.getOrderByReference('ORDER-123') : provider.getOrderById('3'));
  });

  test(`Vendure ${lookup} rejects an order that does not match the requested identifier`, async () => {
    const wrongOrder = { ...order, id: 'other-order', code: 'OTHER-ORDER' };
    const provider = createVendureCommerceProvider({
      adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
      async fetcher() { return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
        ...(lookup === 'reference' ? { orders: { totalItems: 1, items: [wrongOrder] } } : { order: wrongOrder }) } }); },
    });
    await assert.rejects(() => lookup === 'reference' ? provider.getOrderByReference('ORDER-123') : provider.getOrderById('3'));
  });
}

test('Vendure reference lookup rejects inconsistent pagination instead of treating missing facts as not found', async () => {
  const provider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
    async fetcher() { return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, orders: { totalItems: 1, items: [] } } }); },
  });
  await assert.rejects(() => provider.getOrderByReference('ORDER-123'));
});

for (const scenario of [
  { name: 'missing order', source: null },
  { name: 'payment bound to another order', source: { ...order, payments: [{ ...order.payments[0], id: 'other-payment' }] } },
  { name: 'unsettled payment', source: { ...order, payments: [{ ...order.payments[0], state: 'Authorized' }] } },
  { name: 'changed currency', source: { ...order, currencyCode: 'EUR' } },
  { name: 'insufficient current payment balance', source: { ...order, payments: [{ ...order.payments[0], refunds: [{ id: 'prior-refund', state: 'Settled', total: 8_000, lines: [] }] }] } },
]) {
  test(`Vendure refund preflight rejects ${scenario.name} without a write`, async () => {
    let reads = 0;
    let writes = 0;
    const provider = createVendureCommerceProvider({
      adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
      async fetcher(_url, request) {
        const body = JSON.parse(String(request?.body));
        if (body.query.includes('mutation')) { writes += 1; return Response.json({ data: { refundOrder: { __typename: 'Refund', id: 'refund-1' } } }); }
        reads += 1;
        assert.deepEqual(body.variables, { id: '3' });
        return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, order: scenario.source } });
      },
    });
    assert.deepEqual(await provider.executeRefund!(execution), { status: 'FAILED' });
    assert.equal(reads, 1);
    assert.equal(writes, 0);
  });
}

test('Vendure refund does a fresh channel-checked order/payment preflight and sends the channel token on mutation', async () => {
  const operations: string[] = [];
  const provider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
    async fetcher(_url, request) {
      const body = JSON.parse(String(request?.body));
      assert.equal(new Headers(request?.headers).get('vendure-token'), 'synthetic-channel-token');
      assert.equal(request?.redirect, 'error');
      if (body.query.includes('mutation')) {
        operations.push('write');
        assert.deepEqual(body.variables.input, { paymentId: 'payment-1', amount: 5_000, reason: 'DAMAGED' });
        return Response.json({ data: { refundOrder: { __typename: 'Refund', id: 'refund-1' } } });
      }
      operations.push('read');
      assert.deepEqual(body.variables, { id: '3' });
      return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, order } });
    },
  });
  assert.deepEqual(await provider.executeRefund!(execution), { status: 'SUBMITTED', providerRefundId: 'refund-1' });
  assert.deepEqual(operations, ['read', 'write']);
});

test('same-owner wrong-channel order cannot reach Gateway refund mutation', async (context) => {
  let writes = 0;
  const provider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
    async fetcher(_url, request) {
      if (JSON.parse(String(request?.body)).query.includes('mutation')) {
        writes += 1;
        return Response.json({ data: { refundOrder: { __typename: 'Refund', id: 'refund-1' } } });
      }
      return Response.json({ data: { activeChannel: { code: 'other-channel' }, order } });
    },
  });
  const intent: RefundExecutionIntent = { orderId: '3', reasonCode: 'DAMAGED', amount: execution.amount,
    selection: { scope: 'FULL_ORDER', itemIds: [] }, previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1' };
  const app = buildApp({ commerceProvider: provider, verifyContextAssertion: verifyTestContextAssertion,
    async verifyWorkflowRefundExecutionAssertion() { return { contextId: 'workflow-1', tenantId: 'tenant-local',
      environmentId: 'local', subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', refundExecution: intent }; },
  });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/internal/v1/refunds',
    headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'synthetic-assertion' }, payload: intent });
  assert.notEqual(response.statusCode, 200);
  assert.equal(writes, 0);
});

test('wrong-channel refund preflight rejects before mutation even after an earlier valid lookup', async () => {
  let reads = 0;
  let writes = 0;
  const provider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'synthetic-api-key', ...binding,
    async fetcher(_url, request) {
      if (JSON.parse(String(request?.body)).query.includes('mutation')) { writes += 1; return Response.json({ data: { refundOrder: { __typename: 'Refund' } } }); }
      reads += 1;
      return Response.json({ data: { activeChannel: { code: reads === 1 ? 'tenant-local-channel' : 'other-channel' }, order } });
    },
  });
  assert.ok(await provider.getOrderById('3'));
  await assert.rejects(() => provider.executeRefund!(execution));
  assert.equal(reads, 2);
  assert.equal(writes, 0);
});

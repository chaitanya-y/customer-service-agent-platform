import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initializeTelemetry } from '@cso/observability-node';

import { createVendureCommerceProvider } from '../src/vendure-client.js';
import { toOrderContext } from '../src/order-context.js';
import { toOrderItems } from '../src/order-items.js';
import { toRefundContext } from '../src/refund-context.js';
import { toPaymentStatus } from '../src/payment-status.js';

const channelBinding = { channelToken: 'synthetic-channel-token', expectedChannelCode: 'tenant-local-channel' };
const activeChannel = { code: 'tenant-local-channel' };

const paymentStatusOrder = {
  id: '3', code: 'ORDER-123', state: 'Delivered', active: false,
  currencyCode: 'USD', orderPlacedAt: null, totalWithTax: 10000,
  customer: { id: 'customer-42', firstName: 'Test', lastName: 'Customer', emailAddress: 'test@example.invalid' },
  lines: [], payments: [], fulfillments: [],
};
const settledPayment = {
  id: 'payment-1', state: 'Settled', amount: 10000, method: 'standard',
  transactionId: null, refunds: [],
};

for (const lookup of ['reference', 'id'] as const) {
  for (const field of ['order total', 'payment amount', 'refund total'] as const) {
    for (const scenario of [
      { name: 'negative', value: -5000 },
      { name: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
      { name: 'fractional', value: 0.5 },
    ]) {
      test(`Vendure ${lookup} lookup rejects ${scenario.name} ${field} before normalization`, async () => {
        const source = {
          ...paymentStatusOrder,
          totalWithTax: field === 'order total' ? scenario.value : 10000,
          payments: [{
            ...settledPayment,
            amount: field === 'payment amount' ? scenario.value : 10000,
            refunds: [{
              id: 'refund-1', state: 'Settled',
              total: field === 'refund total' ? scenario.value : 0,
              lines: [],
            }],
          }],
        };
        const provider = createVendureCommerceProvider({
          ...channelBinding,
          adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key',
          async fetcher() {
            return Response.json({ data: lookup === 'reference'
              ? { activeChannel, orders: { totalItems: 1, items: [source] } }
              : { activeChannel, order: source } });
          },
        });
        await assert.rejects(() => lookup === 'reference'
          ? provider.getOrderByReference('ORDER-123') : provider.getOrderById('3'),
        /Vendure returned invalid GraphQL data/);
      });
    }
  }

  test(`Vendure ${lookup} lookup preserves valid zero order, payment and refund amounts`, async () => {
    const source = {
      ...paymentStatusOrder,
      totalWithTax: 0,
      payments: [{ ...settledPayment, amount: 0,
        refunds: [{ id: 'refund-zero', state: 'Settled', total: 0, lines: [] }] }],
    };
    const provider = createVendureCommerceProvider({
      ...channelBinding,
      adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key',
      async fetcher() {
        return Response.json({ data: lookup === 'reference'
          ? { activeChannel, orders: { totalItems: 1, items: [source] } }
          : { activeChannel, order: source } });
      },
    });
    const order = await (lookup === 'reference'
      ? provider.getOrderByReference('ORDER-123') : provider.getOrderById('3'));
    assert.ok(order);
    assert.deepEqual(order.total, { amountMinor: 0, currency: 'USD' });
    assert.deepEqual(order.payments[0].amount, { amountMinor: 0, currency: 'USD' });
    assert.deepEqual(order.payments[0].refunds[0].amount, { amountMinor: 0, currency: 'USD' });
    const context = toRefundContext(order, { scope: 'FULL_ORDER', itemIds: [] },
      { observationId: 'zero-balance', observedAt: '2026-10-02T00:00:00Z' });
    assert.equal(context.facts.transactionRefundable, false);
    assert.deepEqual(context.facts.refundableAmount, { amountMinor: 0, currency: 'USD' });
  });
}

for (const lookup of ['reference', 'id'] as const) {
  for (const scenario of [
    { name: 'null payments', payments: null },
    { name: 'missing payments', payments: undefined },
    { name: 'null refunds', payments: [{ ...settledPayment, refunds: null }] },
    { name: 'missing refunds', payments: [{ ...settledPayment, refunds: undefined }] },
  ]) {
    test(`Vendure ${lookup} lookup rejects ${scenario.name} instead of claiming empty payment history`, async () => {
      const source = { ...paymentStatusOrder, payments: scenario.payments };
      const provider = createVendureCommerceProvider({
        ...channelBinding,
        adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key',
        async fetcher() {
          return Response.json({ data: lookup === 'reference'
            ? { activeChannel, orders: { totalItems: 1, items: [source] } } : { activeChannel, order: source } });
        },
      });
      await assert.rejects(() => lookup === 'reference'
        ? provider.getOrderByReference('ORDER-123') : provider.getOrderById('3'),
      /Vendure returned invalid GraphQL data/);
    });
  }
}

test('Vendure preserves authoritative empty payment and refund arrays for payment status', async () => {
  for (const scenario of [
    { payments: [], paymentStatus: 'NOT_RECORDED' },
    { payments: [settledPayment], paymentStatus: 'PAID' },
  ]) {
    const provider = createVendureCommerceProvider({
      ...channelBinding,
      adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key',
      async fetcher() {
        return Response.json({ data: { activeChannel, orders: { totalItems: 1,
          items: [{ ...paymentStatusOrder, payments: scenario.payments }] } } });
      },
    });
    const order = await provider.getOrderByReference('ORDER-123');
    assert.ok(order);
    assert.deepEqual(toPaymentStatus(order), {
      schemaVersion: '1', reference: 'ORDER-123',
      paymentStatus: scenario.paymentStatus, refundStatus: 'NONE',
    });
  }
});

test('cancelled order lookup preserves item history without restoring refundable quantity', async () => {
  const provider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key',
    async fetcher(_input, request) {
      assert.match(JSON.parse(String(request?.body)).query, /orderPlacedQuantity/);
      return Response.json({ data: { activeChannel, orders: { totalItems: 1, items: [{
        id: '3', code: 'ORDER-123', state: 'Cancelled', active: false,
        currencyCode: 'USD', orderPlacedAt: '2026-07-25T23:59:40.265Z', totalWithTax: 0,
        customer: { id: '2', firstName: 'Test', lastName: 'Customer', emailAddress: 'test@example.com' },
        lines: [{ id: 'line-1', quantity: 0, orderPlacedQuantity: 2,
          unitPriceWithTax: 0, linePriceWithTax: 0,
          productVariant: { id: 'variant-1', sku: 'SKU-1', name: 'Test product' } }],
        payments: [], fulfillments: [],
      }] } } });
    },
  });
  const order = await provider.getOrderByReference('ORDER-123');
  assert.ok(order);
  assert.equal(order.items[0].quantity, 0);
  assert.equal(order.items[0].orderedQuantity, 2);
  const metadata = { observationId: 'observation-1', observedAt: '2026-07-26T12:00:00Z' };
  const context = toOrderContext(order, metadata);
  assert.equal(context.items[0].quantity, 0);
  assert.equal(context.items[0].orderedQuantity, 2);
  assert.throws(() => toOrderItems(context), /Invalid order items source/);
  for (const selection of [
    { scope: 'FULL_ORDER' as const, itemIds: [] },
    { scope: 'SELECTED_ITEMS' as const, itemIds: ['line-1'] },
  ]) {
    const refund = toRefundContext(order, selection, metadata);
    assert.equal(refund.facts.transactionRefundable, false);
    assert.equal(refund.facts.refundableAmount.amountMinor, 0);
  }
});

function makeTelemetry() {
  const spans = new InMemorySpanExporter();
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    environment: 'test',
    enabled: true,
    spanProcessor: new SimpleSpanProcessor(spans),
    metricReader: new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(), exportIntervalMillis: 10 }),
    logRecordProcessor: new SimpleLogRecordProcessor({ exporter: new InMemoryLogRecordExporter() }),
  });
  return { telemetry, spans };
}

test('Vendure provider authenticates and maps an order with a safe fallback for an empty fulfillment method', async () => {
  let capturedRequest: RequestInit | undefined;

  const commerceProvider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'test-api-key',
    async fetcher(_input, init) {
      capturedRequest = init;

      return new Response(
        JSON.stringify({
          data: {
            activeChannel,
            orders: {
              totalItems: 1,
              items: [
                {
                  id: '3',
                  code: 'ORDER-123',
                  state: 'Delivered',
                  active: false,
                  currencyCode: 'USD',
                  orderPlacedAt: '2026-07-25T23:59:40.265Z',
                  totalWithTax: 168_880,
                  customer: {
                    id: '2',
                    firstName: 'Siva',
                    lastName: 'Kumar',
                    emailAddress: 'siva@example.com',
                  },
                  lines: [
                    {
                      id: '3',
                      quantity: 1,
                      unitPriceWithTax: 167_880,
                      linePriceWithTax: 167_880,
                      productVariant: {
                        id: '2',
                        sku: 'LAPTOP-15',
                        name: 'Laptop 15 inch',
                      },
                    },
                  ],
                  payments: [
                    {
                      id: '2',
                      state: 'Settled',
                      amount: 168_880,
                      method: 'standard-payment',
                      transactionId: 'transaction-123',
                      refunds: [
                        {
                          id: 'refund-1',
                          state: 'Settled',
                          total: 10_000,
                          lines: [
                            {
                              orderLineId: '3',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                  fulfillments: [
                    {
                      id: '2',
                      state: 'Delivered',
                      method: '',
                      trackingCode: 'TRACK-123',
                    },
                  ],
                },
              ],
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    },
  });

  const order = await commerceProvider.getOrderByReference('ORDER-123');

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.redirect, 'error');
  assert.equal(
    new Headers(capturedRequest.headers).get('vendure-api-key'),
    'test-api-key',
  );
  assert.deepEqual(order, {
    source: {
      provider: 'vendure',
      orderId: '3',
    },
    reference: 'ORDER-123',
    status: 'Delivered',
    active: false,
    placedAt: '2026-07-25T23:59:40.265Z',
    customer: {
      id: '2',
      name: 'Siva Kumar',
      email: 'siva@example.com',
    },
    total: {
      amountMinor: 168_880,
      currency: 'USD',
    },
    items: [
      {
        id: '3',
        sku: 'LAPTOP-15',
        name: 'Laptop 15 inch',
        quantity: 1,
        unitPrice: {
          amountMinor: 167_880,
          currency: 'USD',
        },
        lineTotal: {
          amountMinor: 167_880,
          currency: 'USD',
        },
      },
    ],
    payments: [
      {
        id: '2',
        status: 'Settled',
        amount: {
          amountMinor: 168_880,
          currency: 'USD',
        },
        method: 'standard-payment',
        transactionReference: 'transaction-123',
        refunds: [
          {
            id: 'refund-1',
            status: 'Settled',
            amount: {
              amountMinor: 10_000,
              currency: 'USD',
            },
            lineIds: ['3'],
          },
        ],
      },
    ],
    fulfillments: [
      {
        id: '2',
        status: 'Delivered',
        method: 'unspecified',
        trackingCode: 'TRACK-123',
      },
    ],
  });
});

test('Vendure provider returns null when the order does not exist', async () => {
  const commerceProvider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'test-api-key',
    async fetcher() {
      return Response.json({
        data: {
          activeChannel,
          orders: {
            totalItems: 0,
            items: [],
          },
        },
      });
    },
  });

  const order = await commerceProvider.getOrderByReference('MISSING');

  assert.equal(order, null);
});

test('Vendure provider looks up an internal order ID with the order query', async () => {
  let capturedRequest: RequestInit | undefined;
  const commerceProvider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'test-api-key',
    async fetcher(_input, request) {
      capturedRequest = request;
      return Response.json({ data: { activeChannel, order: null } });
    },
  });

  const order = await commerceProvider.getOrderById('3');

  assert.equal(order, null);
  assert.ok(capturedRequest);
  assert.equal(capturedRequest.redirect, 'error');
  const body = JSON.parse(String(capturedRequest.body));
  assert.deepEqual(body.variables, { id: '3' });
  assert.match(body.query, /order\(id: \$id\)/);
});

test('Vendure refund request rejects redirects before forwarding the admin key or body', async () => {
  let capturedRequest: RequestInit | undefined;
  const commerceProvider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'synthetic-api-key',
    async fetcher(_input, request) {
      capturedRequest = request;
      if (!JSON.parse(String(request?.body)).query.includes('mutation')) {
        return Response.json({ data: { activeChannel, order: { ...paymentStatusOrder, payments: [settledPayment] } } });
      }
      return Response.json({ data: { refundOrder: { __typename: 'Refund', id: 'refund-1' } } });
    },
  });

  await commerceProvider.executeRefund!({
    orderId: '3', paymentId: 'payment-1', amount: { amountMinor: 100, currency: 'USD' }, reason: 'test',
  });

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.redirect, 'error');
});

test('Vendure order lookup emits a static successful child span without forwarding trace context', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  let capturedHeaders = new Headers();
  const commerceProvider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'CANARY-api-key',
    telemetry,
    async fetcher(_input, request) {
      capturedHeaders = new Headers(request?.headers);
      return Response.json({ data: { activeChannel, orders: { totalItems: 0, items: [] } } });
    },
  });

  assert.equal(await commerceProvider.getOrderByReference('MISSING'), null);
  assert.equal(capturedHeaders.get('vendure-api-key'), 'CANARY-api-key');
  assert.equal(capturedHeaders.get('traceparent'), null);
  const span = spans.getFinishedSpans()[0];
  assert.equal(span.name, 'vendure.order_lookup');
  assert.equal(span.attributes['http.response.status_code'], 200);
  assert.equal(span.status.code, 0);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('Vendure HTTP 200 GraphQL errors are safe application errors in telemetry', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const commerceProvider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'CANARY-api-key',
    telemetry,
    async fetcher() {
      return Response.json({ errors: [{ message: 'CANARY-provider-error' }] });
    },
  });

  await assert.rejects(() => commerceProvider.getOrderByReference('CANARY-order'), /GraphQL error/);
  const span = spans.getFinishedSpans()[0];
  assert.equal(span.attributes['http.response.status_code'], 200);
  assert.equal(span.attributes['error.type'], 'application_error');
  assert.equal(span.status.code, 2);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('Vendure order lookup timeouts use a fixed safe timeout category', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const commerceProvider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'CANARY-api-key',
    telemetry,
    async fetcher() {
      throw new DOMException('CANARY-timeout-detail', 'TimeoutError');
    },
  });

  await assert.rejects(() => commerceProvider.getOrderByReference('CANARY-order'), { name: 'TimeoutError' });
  const span = spans.getFinishedSpans()[0];
  assert.equal(span.attributes['error.type'], 'timeout');
  assert.equal(span.status.code, 2);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('Vendure response body timeouts remain timeout errors', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const commerceProvider = createVendureCommerceProvider({
    ...channelBinding,
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'CANARY-api-key',
    telemetry,
    async fetcher() {
      return {
        ok: true,
        status: 200,
        async json() { throw new DOMException('CANARY-body-timeout', 'TimeoutError'); },
      } as Response;
    },
  });

  await assert.rejects(() => commerceProvider.getOrderByReference('CANARY-order'), { name: 'TimeoutError' });
  const span = spans.getFinishedSpans()[0];
  assert.equal(span.attributes['error.type'], 'timeout');
  assert.equal('http.response.status_code' in span.attributes, false);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes('CANARY'), false);
  await telemetry.shutdown();
});

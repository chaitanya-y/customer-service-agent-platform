import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommerceOrder, CommerceProvider } from '../src/commerce.js';
import { CONTEXT_ASSERTION_HEADER } from '../src/trusted-context.js';
import {
  createTestContextAssertion,
  TEST_CONTEXT_ASSERTION,
  verifyTestContextAssertion,
} from './trusted-context-fixture.js';

const order: CommerceOrder = {
  source: { provider: 'vendure', orderId: 'private-order-id' },
  reference: 'ORDER-123',
  status: 'Delivered',
  active: false,
  placedAt: '2026-07-25T23:59:40.265Z',
  customer: {
    id: 'customer-42',
    name: 'Private Customer',
    email: 'private@example.com',
  },
  total: { amountMinor: 10_000, currency: 'USD' },
  items: [],
  payments: [{
    id: 'private-payment-id',
    status: 'Settled',
    amount: { amountMinor: 10_000, currency: 'USD' },
    method: 'private-payment-method',
    transactionReference: 'private-transaction-reference',
    refunds: [],
  }],
  fulfillments: [],
};

const url = '/internal/v1/delivery-order-ownership/ORDER-123';
const notFound = {
  error: { code: 'order_not_found', message: 'Order was not found' },
};

test('owned order returns only version and reference without order internals', async (context) => {
  let refundCalled = false;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() { return order; },
    async executeRefund() {
      refundCalled = true;
      throw new Error('refund must not execute');
    },
  };
  const app = buildApp({ commerceProvider, verifyContextAssertion: verifyTestContextAssertion });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET', url,
    headers: { [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { schemaVersion: '1', reference: 'ORDER-123' });
  assert.equal(refundCalled, false);
});

test('missing and foreign orders have identical masked responses', async (context) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference(reference) { return reference === 'MISSING' ? null : order; },
  };
  const app = buildApp({ commerceProvider, verifyContextAssertion: verifyTestContextAssertion });
  context.after(() => app.close());

  const headers = { [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION };
  const missing = await app.inject({
    method: 'GET', url: '/internal/v1/delivery-order-ownership/MISSING', headers,
  });
  const foreign = await app.inject({
    method: 'GET', url,
    headers: { [CONTEXT_ASSERTION_HEADER]: createTestContextAssertion({ customerId: 'other-customer' }) },
  });

  assert.equal(missing.statusCode, 404);
  assert.equal(foreign.statusCode, 404);
  assert.deepEqual(missing.json(), notFound);
  assert.deepEqual(foreign.json(), notFound);
});

test('a provider result for a different reference does not prove the requested order is owned', async (context) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() { return { ...order, reference: 'DIFFERENT' }; },
  };
  const app = buildApp({ commerceProvider, verifyContextAssertion: verifyTestContextAssertion });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET', url,
    headers: { [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), notFound);
});

test('invalid order reference is rejected before lookup', async (context) => {
  let lookups = 0;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() { lookups += 1; return order; },
  };
  const app = buildApp({ commerceProvider, verifyContextAssertion: verifyTestContextAssertion });
  context.after(() => app.close());

  for (const [reference, expectedStatus] of [['%20%20', 400], ['x'.repeat(101), 414]] as const) {
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/delivery-order-ownership/${reference}`,
      headers: { [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION },
    });
    assert.equal(response.statusCode, expectedStatus);
    if (expectedStatus === 400) {
      assert.deepEqual(response.json(), {
        error: { code: 'invalid_order_reference', message: 'Order reference is invalid' },
      });
    }
  }
  assert.equal(lookups, 0);
});

test('missing assertion is rejected before lookup', async (context) => {
  let lookups = 0;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() { lookups += 1; return order; },
  };
  const app = buildApp({ commerceProvider, verifyContextAssertion: verifyTestContextAssertion });
  context.after(() => app.close());

  const response = await app.inject({ method: 'GET', url });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: { code: 'context_unauthorized', message: 'Trusted context is required' },
  });
  assert.equal(lookups, 0);
});

test('wrong-audience assertion is rejected before lookup', async (context) => {
  let lookups = 0;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() { lookups += 1; return order; },
  };
  const app = buildApp({ commerceProvider, verifyContextAssertion: verifyTestContextAssertion });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET', url,
    headers: { [CONTEXT_ASSERTION_HEADER]: createTestContextAssertion({ audience: 'human-operations' }) },
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: { code: 'context_unauthorized', message: 'Trusted context is required' },
  });
  assert.equal(lookups, 0);
});

test('provider failure returns a safe unavailable response', async (context) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() { throw new Error('private provider failure'); },
  };
  const app = buildApp({ commerceProvider, verifyContextAssertion: verifyTestContextAssertion });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET', url,
    headers: { [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION },
  });
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: { code: 'commerce_provider_unavailable', message: 'Commerce provider request failed' },
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommerceOrder } from '../src/commerce.js';
import { InMemoryZeroTotalCancellationRepository } from '../src/zero-total-cancellation-repository.js';
import { CONTEXT_ASSERTION_HEADER } from '../src/trusted-context.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER } from '../src/workflow-access.js';

const intent = { orderId: '9', orderReference: 'TEST-ORDER', paymentId: 'payment-1', previewId: 'preview-1',
  previewExpiresAt: '2099-10-02T12:05:00.000Z', policyVersion: 'AUTHORIZED_DUMMY_V1' as const,
  providerFactsDigest: 'a'.repeat(64), idempotencyKey: 'authorized:workflow-1:preview-1' };
const baseOrder: CommerceOrder = { source: { provider: 'vendure', orderId: '9' }, reference: 'TEST-ORDER',
  status: 'PaymentAuthorized', active: false, placedAt: '2026-10-02T07:59:28.263Z',
  customer: { id: '7', name: 'Fixture', email: 'fixture@example.invalid' }, total: { amountMinor: 12500, currency: 'USD' },
  items: [{ id: '8', sku: 'ITEM', name: 'Fixture item', quantity: 1, orderedQuantity: 1,
    unitPrice: { amountMinor: 12500, currency: 'USD' }, lineTotal: { amountMinor: 12500, currency: 'USD' } }],
  payments: [{ id: 'payment-1', status: 'Authorized', amount: { amountMinor: 12500, currency: 'USD' },
    method: 'standard', transactionReference: null, refunds: [] }], fulfillments: [] };
const providerFacts = { orderId: '9', orderReference: 'TEST-ORDER', customerId: '7', channelIds: ['1'],
  orderType: 'Regular', state: 'PaymentAuthorized', active: false, placedAt: '2026-10-02T07:59:28.263Z',
  currencyCode: 'USD', totalWithTax: 12500, lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 1 }],
  paymentCount: 1, payment: { id: 'payment-1', state: 'Authorized', amount: 12500, method: 'standard',
    handlerCode: 'dummy-payment-handler', paymentMethodId: 'method-1', handlerArgsDigest: 'b'.repeat(64) },
  refundCount: 0, fulfillmentCount: 0, digest: 'a'.repeat(64), eligible: true };
const access = { contextId: 'workflow-1', workflowType: 'AUTHORIZED_DUMMY_CANCELLATION' as const,
  tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: '7', routingEpoch: 1,
  requestId: 'request-1', traceId: 'trace-1', authorizedDummyCancellation: intent };

function fixture(options: { customerId?: string; uncertain?: boolean; finalPaymentStatus?: string; factsEligible?: boolean } = {}) {
  let orderStatus = 'PaymentAuthorized';
  let paymentStatus = 'Authorized';
  let cancelCalls = 0;
  let marker: unknown = null;
  const repository = new InMemoryZeroTotalCancellationRepository();
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference(reference) { return reference === baseOrder.reference ? currentOrder() : null; },
      async getOrderById(id) { return id === '9' ? currentOrder() : null; },
    },
    verifyContextAssertion: async () => ({ ...access, contextId: 'customer-context', workflowType: undefined,
      authorizedDummyCancellation: undefined }),
    authorizedDummyCancellationProvider: {
      async getFacts() { return { ...providerFacts, eligible: options.factsEligible ?? true }; },
      async cancel(input) {
        cancelCalls += 1;
        if (options.uncertain) throw new Error('provider response lost');
        orderStatus = 'Cancelled';
        paymentStatus = options.finalPaymentStatus ?? 'Cancelled';
        marker = { operationId: input.operationId, orderId: '9', tenantId: 'tenant-local', environmentId: 'local',
          customerId: '7', orderReference: 'TEST-ORDER', paymentId: 'payment-1', factsDigest: input.expectedFactsDigest,
          workflowId: input.workflowId, previewId: input.previewId, previewExpiresAt: input.previewExpiresAt,
          policyVersion: input.policyVersion, idempotencyKey: input.idempotencyKey, status: 'SUCCEEDED' };
        return { status: 'SUCCEEDED' as const, operationId: input.operationId, paymentId: input.paymentId };
      },
      async getMarker() { return marker as never; },
    },
    authorizedDummyCancellationRepository: repository,
    authorizedDummyCancellationScope: { tenantId: 'tenant-local', environmentId: 'local' },
    verifyWorkflowAuthorizedDummyFactsAssertion: async () => ({ ...access, authorizedDummyCancellation: undefined }),
    verifyWorkflowAuthorizedDummyExecutionAssertion: async () => access,
    verifyWorkflowAuthorizedDummyReconciliationAssertion: async () => access,
  });
  function currentOrder(): CommerceOrder {
    return { ...baseOrder, status: orderStatus, customer: { ...baseOrder.customer!, id: options.customerId ?? '7' },
      items: baseOrder.items.map(item => ({ ...item, quantity: orderStatus === 'Cancelled' ? 0 : 1 })),
      payments: baseOrder.payments.map(payment => ({ ...payment, status: paymentStatus })) };
  }
  return { app, repository, get cancelCalls() { return cancelCalls; } };
}

const executeRequest = { method: 'POST' as const, url: '/internal/v1/authorized-dummy-cancellations',
  headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'signed-worker' }, payload: intent };

test('authorized facts are owner-scoped and omit payment handler internals', async context => {
  const owned = fixture(); context.after(() => owned.app.close());
  const request = { method: 'POST' as const, url: '/internal/v1/authorized-dummy-cancellation-facts',
    headers: { [CONTEXT_ASSERTION_HEADER]: 'signed-customer' }, payload: { orderReference: 'TEST-ORDER' } };
  const response = await owned.app.inject(request);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().payment, { id: 'payment-1', state: 'Authorized', amountMinor: 12500 });
  assert.equal(response.json().payment.handlerCode, undefined);
  const foreign = fixture({ customerId: 'another' }); context.after(() => foreign.app.close());
  assert.equal((await foreign.app.inject(request)).statusCode, 404);
});

test('exact authorization cancels once and requires both final provider states', async context => {
  const item = fixture(); context.after(() => item.app.close());
  assert.equal((await item.app.inject({ ...executeRequest, payload: { ...intent, paymentId: 'other' } })).statusCode, 401);
  assert.equal(item.cancelCalls, 0);
  const first = await item.app.inject(executeRequest);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, 'SUCCEEDED');
  assert.equal((await item.app.inject(executeRequest)).json().status, 'SUCCEEDED');
  assert.equal(item.cancelCalls, 1);
  const reconcile = await item.app.inject({ ...executeRequest,
    url: '/internal/v1/authorized-dummy-cancellation-reconciliations' });
  assert.equal(reconcile.json().status, 'SUCCEEDED');
});

test('order-only final state and uncertain provider response never complete or repeat a write', async context => {
  const partial = fixture({ finalPaymentStatus: 'Authorized' }); context.after(() => partial.app.close());
  assert.equal((await partial.app.inject(executeRequest)).json().status, 'PENDING_RECONCILIATION');
  assert.equal(partial.cancelCalls, 1);
  const uncertain = fixture({ uncertain: true }); context.after(() => uncertain.app.close());
  assert.equal((await uncertain.app.inject(executeRequest)).json().status, 'PENDING_RECONCILIATION');
  assert.equal((await uncertain.app.inject(executeRequest)).json().status, 'PENDING_RECONCILIATION');
  assert.equal(uncertain.cancelCalls, 1);
});

test('ineligible facts and expired consent cannot invoke authorized cancellation', async context => {
  const ineligible = fixture({ factsEligible: false }); context.after(() => ineligible.app.close());
  assert.equal((await ineligible.app.inject(executeRequest)).statusCode, 409);
  assert.equal(ineligible.cancelCalls, 0);
  const expired = fixture(); context.after(() => expired.app.close());
  const oldIntent = { ...intent, previewExpiresAt: '2020-10-02T12:05:00.000Z' };
  assert.equal((await expired.app.inject({ ...executeRequest, payload: oldIntent })).statusCode, 401);
  assert.equal(expired.cancelCalls, 0);
});

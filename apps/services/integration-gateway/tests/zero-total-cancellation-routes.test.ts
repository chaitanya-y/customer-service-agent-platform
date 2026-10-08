import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommerceOrder } from '../src/commerce.js';
import { InMemoryZeroTotalCancellationRepository } from '../src/zero-total-cancellation-repository.js';
import type { ZeroTotalCancellationIntent } from '../src/zero-total-cancellation-contract.js';
import { CONTEXT_ASSERTION_HEADER } from '../src/trusted-context.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER } from '../src/workflow-access.js';

const intent: ZeroTotalCancellationIntent = { orderId: '9', orderReference: 'TEST-ORDER', previewId: 'preview-1', previewExpiresAt: '2099-10-02T12:05:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', providerFactsDigest: 'a'.repeat(64), idempotencyKey: 'cancel:workflow-1:preview-1' };
const order: CommerceOrder = { source: { provider: 'vendure', orderId: '9' }, reference: 'TEST-ORDER', status: 'PaymentSettled', active: false, placedAt: '2026-10-02T07:59:28.263Z', customer: { id: '7', name: 'Fixture', email: 'fixture@example.invalid' }, total: { amountMinor: 0, currency: 'USD' }, items: [{ id: '8', sku: 'FREE', name: 'Free fixture', quantity: 1, unitPrice: { amountMinor: 0, currency: 'USD' }, lineTotal: { amountMinor: 0, currency: 'USD' } }], payments: [], fulfillments: [] };
const facts = { orderId: '9', orderReference: 'TEST-ORDER', customerId: '7', channelIds: ['1'], orderType: 'Regular', state: 'PaymentSettled', active: false, placedAt: '2026-10-02T07:59:28.263Z', currencyCode: 'USD', totalWithTax: 0, lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 1 }], paymentCount: 0, refundCount: 0, fulfillmentCount: 0, digest: 'a'.repeat(64), eligible: true };
const access = { contextId: 'workflow-1', workflowType: 'ZERO_TOTAL_CANCELLATION' as const, tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: '7', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', zeroTotalCancellation: intent };

function fixture(customerId = '7', authorizedIntent = intent, cancelOutcome: 'succeed' | 'unknown' = 'succeed', items = order.items) {
  let status = 'PaymentSettled';
  let cancelCalls = 0;
  let marker: unknown = null;
  const repository = new InMemoryZeroTotalCancellationRepository();
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference(reference) { return reference === order.reference ? { ...order, status, items, customer: { ...order.customer!, id: customerId } } : null; },
      async getOrderById(id) { return id === '9' ? { ...order, status, items, customer: { ...order.customer!, id: customerId } } : null; },
    },
    verifyContextAssertion: async () => ({ contextId: 'customer-context', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: '7', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1' }),
    zeroTotalCancellationProvider: {
      async getFacts() { return facts; },
      async cancel(input) { cancelCalls += 1; if (cancelOutcome === 'unknown') throw new Error('connection lost'); status = 'Cancelled'; marker = { operationId: input.operationId, orderId: '9', tenantId: 'tenant-local', environmentId: 'local', customerId: '7', orderReference: 'TEST-ORDER', factsDigest: facts.digest, workflowId: input.workflowId, previewId: input.previewId, previewExpiresAt: input.previewExpiresAt, policyVersion: input.policyVersion, idempotencyKey: input.idempotencyKey, status: 'SUCCEEDED' }; return { status: 'SUCCEEDED', operationId: input.operationId }; },
      async getMarker() { return marker as never; },
    },
    zeroTotalCancellationRepository: repository,
    zeroTotalCancellationScope: { tenantId: 'tenant-local', environmentId: 'local' },
    verifyWorkflowCancellationFactsAssertion: async () => ({ ...access, zeroTotalCancellation: undefined }),
    verifyWorkflowCancellationExecutionAssertion: async () => ({ ...access, zeroTotalCancellation: authorizedIntent }),
    verifyWorkflowCancellationReconciliationAssertion: async () => ({ ...access, zeroTotalCancellation: authorizedIntent }),
  });
  return { app, repository, get cancelCalls() { return cancelCalls; } };
}

test('facts route returns digest only for the owner, not a different customer', async context => {
  const owned = fixture(); context.after(() => owned.app.close());
  const request = { method: 'POST' as const, url: '/internal/v1/zero-total-cancellation-facts', headers: { [CONTEXT_ASSERTION_HEADER]: 'signed-customer' }, payload: { orderReference: 'TEST-ORDER' } };
  const response = await owned.app.inject(request);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().providerFactsDigest, 'a'.repeat(64));
  assert.deepEqual(response.json().lines, [{ id: '8', quantity: 1, orderPlacedQuantity: 1, displayName: 'Free fixture' }]);
  const other = fixture('another-customer'); context.after(() => other.app.close());
  const denied = await other.app.inject(request);
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.json().providerFactsDigest, undefined);
});

test('cancellation facts refuse missing, duplicate, or unsafe item-name joins', async context => {
  const request = { method: 'POST' as const, url: '/internal/v1/zero-total-cancellation-facts', headers: { [CONTEXT_ASSERTION_HEADER]: 'signed-customer' }, payload: { orderReference: 'TEST-ORDER' } };
  const invalidItems = [
    [{ ...order.items[0]!, id: 'other' }],
    [order.items[0]!, { ...order.items[0]!, name: 'Another product' }],
    [{ ...order.items[0]!, name: '  ' }],
    [{ ...order.items[0]!, name: 'Unsafe\nname' }],
    [{ ...order.items[0]!, name: '\u200B' }],
    [{ ...order.items[0]!, name: '\u0085' }],
    [{ ...order.items[0]!, name: 'Free\u200Bfixture' }],
    [{ ...order.items[0]!, name: 'Free\u202Efixture' }],
    [{ ...order.items[0]!, name: 'x'.repeat(301) }],
  ];
  for (const items of invalidItems) {
    const item = fixture('7', intent, 'succeed', items); context.after(() => item.app.close());
    const response = await item.app.inject(request);
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: { code: 'commerce_provider_unavailable' } });
  }
});

test('execute requires exact Worker-bound intent, then verifies marker and final order on retry', async context => {
  const item = fixture(); context.after(() => item.app.close());
  const request = { method: 'POST' as const, url: '/internal/v1/zero-total-cancellations', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'signed-worker' }, payload: intent };
  const tampered = await item.app.inject({ ...request, payload: { ...intent, orderId: 'other' } });
  assert.equal(tampered.statusCode, 401);
  assert.equal(item.cancelCalls, 0);
  const first = await item.app.inject(request);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, 'SUCCEEDED');
  const replay = await item.app.inject(request);
  assert.equal(replay.json().status, 'SUCCEEDED');
  assert.equal(item.cancelCalls, 1);
  const reconciliation = await item.app.inject({ ...request, url: '/internal/v1/zero-total-cancellation-reconciliations', payload: intent });
  assert.equal(reconciliation.json().status, 'SUCCEEDED');
});

test('expired preview is rejected for execution before a provider call', async context => {
  const expired = { ...intent, previewExpiresAt: '2020-10-02T12:05:00.000Z' };
  const item = fixture('7', expired); context.after(() => item.app.close());
  const response = await item.app.inject({ method: 'POST', url: '/internal/v1/zero-total-cancellations', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'signed-worker' }, payload: expired });
  assert.equal(response.statusCode, 409);
  assert.equal(item.cancelCalls, 0);
});

test('unknown provider response stays pending without an authoritative marker', async context => {
  const item = fixture('7', intent, 'unknown'); context.after(() => item.app.close());
  const request = { method: 'POST' as const, url: '/internal/v1/zero-total-cancellations', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'signed-worker' }, payload: intent };
  const response = await item.app.inject(request);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'PENDING_RECONCILIATION');
  assert.equal(item.cancelCalls, 1);
  const replay = await item.app.inject(request);
  assert.equal(replay.json().status, 'PENDING_RECONCILIATION');
  assert.equal(item.cancelCalls, 1, 'an uncertain provider write must only be reconciled, never repeated');
  const reconciliation = await item.app.inject({ method: 'POST', url: '/internal/v1/zero-total-cancellation-reconciliations', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'signed-worker' }, payload: intent });
  assert.equal(reconciliation.json().status, 'PENDING_RECONCILIATION');
});

test('reconciliation accepts an expired preview for an exact existing operation', async context => {
  const expired = { ...intent, previewExpiresAt: '2020-10-02T12:05:00.000Z' };
  const item = fixture('7', expired); context.after(() => item.app.close());
  await item.repository.reserve({ tenantId: 'tenant-local', environmentId: 'local', workflowId: 'workflow-1', customerId: '7', ...expired });
  const response = await item.app.inject({ method: 'POST', url: '/internal/v1/zero-total-cancellation-reconciliations', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'signed-worker' }, payload: expired });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'PENDING_RECONCILIATION');
  assert.equal(item.cancelCalls, 0);
});

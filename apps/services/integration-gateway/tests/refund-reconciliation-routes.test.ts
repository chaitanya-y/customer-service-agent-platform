import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { InMemoryRefundExecutionRepository } from '../src/refund-execution-repository.js';
import type { CommerceProvider } from '../src/commerce.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER } from '../src/workflow-access.js';
import { verifyTestContextAssertion } from './trusted-context-fixture.js';

test('reconciliation finds an authoritative completed refund without issuing another', async (context) => {
  const repository = new InMemoryRefundExecutionRepository();
  const reservation = await repository.reserve({ tenantId: 'tenant-local', environmentId: 'local', workflowId: 'workflow-1', previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1', orderId: '3', amountMinor: 5_000, currency: 'USD', selection: { scope: 'FULL_ORDER', itemIds: [] }, reasonCode: 'DAMAGED', occurredAt: '2026-10-02T12:00:00Z' });
  if (reservation.kind !== 'reserved') throw new Error('fixture reservation failed');
  await repository.recordOutcome(reservation.executionId, 'SUBMITTED', 'refund-1');
  const provider: CommerceProvider = { async getOrderByReference() { return { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 10_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: [{ id: 'refund-1', status: 'Settled', amount: { amountMinor: 5_000, currency: 'USD' }, lineIds: [] }] }], fulfillments: [] }; }, async getOrderById(orderId) { assert.equal(orderId, '3'); return { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 10_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: [{ id: 'refund-1', status: 'Settled', amount: { amountMinor: 5_000, currency: 'USD' }, lineIds: [] }] }], fulfillments: [] }; } };
  const app = buildApp({ commerceProvider: provider, refundExecutionRepository: repository, verifyContextAssertion: verifyTestContextAssertion, async verifyWorkflowRefundReconciliationAssertion(value) { assert.equal(value, 'worker-reconcile-assertion'); return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1' }; } });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/internal/v1/refund-reconciliations', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'worker-reconcile-assertion' }, payload: { orderId: '3', previewId: 'preview-1', amount: { amountMinor: 5_000, currency: 'USD' } } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'SUCCEEDED', providerRefundId: 'refund-1' });
});

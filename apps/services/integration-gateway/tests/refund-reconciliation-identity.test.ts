import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import type { CommerceOrder, CommerceProvider } from '../src/commerce.js';
import { InMemoryRefundExecutionRepository } from '../src/refund-execution-repository.js';
import { verifyTestContextAssertion } from './trusted-context-fixture.js';

type Refund = CommerceOrder['payments'][number]['refunds'][number];
const refund = (id: string, status: string, amountMinor = 5_000): Refund => ({ id, status, amount: { amountMinor, currency: 'USD' }, lineIds: [] });

// Same-amount history must not replace the identity of the current execution.
for (const scenario of [
  { name: 'current completed refund, older failed refund', storedId: 'refund-current', refunds: [refund('refund-old', 'Failed'), refund('refund-current', 'Settled')], expected: { status: 'SUCCEEDED', providerRefundId: 'refund-current' }, storedStatus: 'SUCCEEDED' },
  { name: 'current pending refund, older settled refund', storedId: 'refund-current', refunds: [refund('refund-old', 'Settled'), refund('refund-current', 'Pending')], expected: { status: 'PROCESSING', providerRefundId: 'refund-current' }, storedStatus: 'SUBMITTED' },
  { name: 'current failed refund, older settled refund', storedId: 'refund-current', refunds: [refund('refund-old', 'Settled'), refund('refund-current', 'Failed')], expected: { status: 'FAILED', providerRefundId: 'refund-current' }, storedStatus: 'FAILED' },
  { name: 'unknown provider ID, older settled refund', storedId: undefined, refunds: [refund('refund-old', 'Settled')], expected: { status: 'NOT_FOUND' }, storedStatus: 'PENDING_RECONCILIATION' },
  { name: 'missing current provider ID, older settled refund', storedId: 'refund-current', refunds: [refund('refund-old', 'Settled')], expected: { status: 'NOT_FOUND' }, storedStatus: 'SUBMITTED' },
  { name: 'current provider ID with mismatched amount', storedId: 'refund-current', refunds: [refund('refund-current', 'Settled', 6_000)], expected: { status: 'NOT_FOUND' }, storedStatus: 'SUBMITTED' },
] as const) {
  test(`reconciliation preserves execution identity: ${scenario.name}`, async (context) => {
    const repository = new InMemoryRefundExecutionRepository();
    const reservation = await repository.reserve({ tenantId: 'tenant-local', environmentId: 'local', idempotencyKey: 'refund:workflow-1:preview-1', workflowId: 'workflow-1', previewId: 'preview-1', orderId: '3', amountMinor: 5_000, currency: 'USD', selection: { scope: 'FULL_ORDER', itemIds: [] }, reasonCode: 'DAMAGED', occurredAt: '2026-10-02T12:00:00Z' });
    assert.equal(reservation.kind, 'reserved');
    if (reservation.kind !== 'reserved') throw new Error('fixture reservation failed');
    await repository.recordOutcome(reservation.executionId, scenario.storedId === undefined ? 'PENDING_RECONCILIATION' : 'SUBMITTED', scenario.storedId);
    const app = reconciliationApp(repository, [...scenario.refunds]);
    context.after(() => app.close());
    const response = await app.inject(reconciliationRequest);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), scenario.expected);
    const execution = await repository.findByWorkflowAndPreview('tenant-local', 'local', 'workflow-1', 'preview-1');
    assert.equal(execution?.status, scenario.storedStatus);
    assert.equal(execution?.providerRefundId, scenario.storedId);
  });
}

test('reconciliation cannot attribute a historical refund to an unreserved preview', async (context) => {
  const app = reconciliationApp(new InMemoryRefundExecutionRepository(), [refund('refund-old', 'Settled')]);
  context.after(() => app.close());
  const response = await app.inject(reconciliationRequest);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'NOT_FOUND' });
});

const reconciliationRequest = {
  method: 'POST' as const, url: '/internal/v1/refund-reconciliations',
  headers: { 'x-cso-workflow-assertion': 'worker-reconcile-assertion' },
  payload: { orderId: '3', previewId: 'preview-1', amount: { amountMinor: 5_000, currency: 'USD' } },
};

function reconciliationApp(repository: InMemoryRefundExecutionRepository, refunds: Refund[]) {
  const order: CommerceOrder = { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 10_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds }], fulfillments: [] };
  const provider: CommerceProvider = {
    async getOrderByReference() { return order; },
    async getOrderById(orderId) { assert.equal(orderId, '3'); return order; },
    async executeRefund() { throw new Error('reconciliation must not issue a refund'); },
  };
  return buildApp({ commerceProvider: provider, refundExecutionRepository: repository, verifyContextAssertion: verifyTestContextAssertion, async verifyWorkflowRefundReconciliationAssertion(value) { assert.equal(value, 'worker-reconcile-assertion'); return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1' }; } });
}

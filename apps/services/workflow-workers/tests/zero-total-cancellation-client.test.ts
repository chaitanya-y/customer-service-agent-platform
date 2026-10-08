import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIntegrationGatewayZeroTotalCancellationClient } from '../src/zero-total-cancellation-client.js';
import type { WorkflowAccessAssertionInput } from '../src/workflow-access-assertion.js';
import type { ZeroTotalCancellationActionInput } from '../src/zero-total-cancellation-activities.js';

const access = { tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
  requestId: 'request-1', traceId: 'trace-1' };
const intent: ZeroTotalCancellationActionInput['intent'] = {
  orderId: 'order-1', orderReference: 'ORDER-001', previewId: 'preview-1',
  previewExpiresAt: '2026-10-02T08:30:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1',
  providerFactsDigest: 'a'.repeat(64), idempotencyKey: 'zero-total-cancel:preview-1',
};

test('Gateway cancellation client uses purpose-bound assertion and exact intent body', async () => {
  const signed: WorkflowAccessAssertionInput[] = [];
  const requests: { path: string; body: unknown; redirect: RequestRedirect | undefined }[] = [];
  const client = createIntegrationGatewayZeroTotalCancellationClient({
    baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion(input) { signed.push(input); return 'signed'; },
    async fetchImpl(input, init) {
      requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), redirect: init?.redirect });
      if (requests.length === 1) return Response.json({ orderId: 'order-1', orderReference: 'ORDER-001',
        policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', providerFactsDigest: 'a'.repeat(64), eligible: true,
        placedAt: '2026-10-02T07:59:28.263Z', total: { amountMinor: 0, currency: 'USD' },
        lines: [{ id: 'line-1', quantity: 1, orderPlacedQuantity: 1, displayName: 'Free fixture' }] });
      return Response.json({ status: 'SUCCEEDED', operationId: 'operation-1' });
    },
  });
  const facts = await client.fetchZeroTotalCancellationFacts({ workflowId: 'workflow-1', access, orderReference: 'ORDER-001' });
  assert.equal((facts.lines[0] as { displayName?: string }).displayName, 'Free fixture');
  await client.executeZeroTotalCancellation({ workflowId: 'workflow-1', access, intent });
  await client.reconcileZeroTotalCancellation({ workflowId: 'workflow-1', access, intent });
  assert.deepEqual(requests.map(request => request.path), [
    '/internal/v1/zero-total-cancellation-facts', '/internal/v1/zero-total-cancellations',
    '/internal/v1/zero-total-cancellation-reconciliations',
  ]);
  assert.deepEqual(requests.map(request => request.body), [{ orderReference: 'ORDER-001' }, intent, intent]);
  assert.deepEqual(requests.map(request => request.redirect), ['error', 'error', 'error']);
  assert.deepEqual(signed.map(value => value.purpose), [
    'zero_total_cancel_facts', 'zero_total_cancel_execute', 'zero_total_cancel_reconcile',
  ]);
  assert.deepEqual(signed[1]?.zeroTotalCancellation, intent);
  assert.deepEqual(signed[2]?.zeroTotalCancellation, intent);
  assert.ok(signed.every(value => value.workflowType === 'ZERO_TOTAL_CANCELLATION'));
});

test('Gateway cancellation client refuses control and invisible item names', async () => {
  for (const displayName of ['\u200B', '\u0085', 'Free\u200Bfixture', 'Free\u202Efixture']) {
    const client = createIntegrationGatewayZeroTotalCancellationClient({
      baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
      async signWorkflowAccessAssertion() { return 'signed'; },
      async fetchImpl() { return Response.json({ orderId: 'order-1', orderReference: 'ORDER-001',
        policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', providerFactsDigest: 'a'.repeat(64), eligible: true,
        placedAt: '2026-10-02T07:59:28.263Z', total: { amountMinor: 0, currency: 'USD' },
        lines: [{ id: 'line-1', quantity: 1, orderPlacedQuantity: 1, displayName }] }); },
    });
    await assert.rejects(client.fetchZeroTotalCancellationFacts({ workflowId: 'workflow-1', access,
      orderReference: 'ORDER-001' }));
  }
});

test('lost execute response is uncertain; reconciliation read remains possible', async () => {
  let calls = 0;
  const client = createIntegrationGatewayZeroTotalCancellationClient({
    baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion() { return 'signed'; },
    async fetchImpl() { calls++; if (calls === 1) throw new Error('connection lost');
      return Response.json({ status: 'SUCCEEDED', operationId: 'operation-1' }); },
  });
  const input = { workflowId: 'workflow-1', access, intent };
  assert.equal((await client.executeZeroTotalCancellation(input)).status, 'PENDING_RECONCILIATION');
  assert.equal((await client.reconcileZeroTotalCancellation(input)).status, 'SUCCEEDED');
  assert.equal(calls, 2);
});

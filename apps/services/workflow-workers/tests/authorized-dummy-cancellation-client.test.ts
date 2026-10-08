import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIntegrationGatewayAuthorizedDummyCancellationClient } from '../src/authorized-dummy-cancellation-client.js';
import type { WorkflowAccessAssertionInput } from '../src/workflow-access-assertion.js';
import type { AuthorizedDummyCancellationActionInput } from '../src/authorized-dummy-cancellation-activities.js';

const access = { tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
  requestId: 'request-1', traceId: 'trace-1' };
const intent: AuthorizedDummyCancellationActionInput['intent'] = {
  orderId: 'order-1', orderReference: 'ORDER-001', paymentId: 'payment-1', previewId: 'preview-1',
  previewExpiresAt: '2026-10-02T08:30:00.000Z', policyVersion: 'AUTHORIZED_DUMMY_V1',
  providerFactsDigest: 'a'.repeat(64), idempotencyKey: 'authorized-dummy-cancel:preview-1',
};

test('Gateway cancellation client uses purpose-bound assertion and exact intent body', async () => {
  const signed: WorkflowAccessAssertionInput[] = [];
  const requests: { path: string; body: unknown; redirect: RequestRedirect | undefined }[] = [];
  const client = createIntegrationGatewayAuthorizedDummyCancellationClient({
    baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion(input) { signed.push(input); return 'signed'; },
    async fetchImpl(input, init) {
      requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), redirect: init?.redirect });
      if (requests.length === 1) return Response.json({ orderId: 'order-1', orderReference: 'ORDER-001',
        policyVersion: 'AUTHORIZED_DUMMY_V1', providerFactsDigest: 'a'.repeat(64), eligible: true,
        placedAt: '2026-10-02T07:59:28.263Z', total: { amountMinor: 2500, currency: 'USD' },
        payment: { id: 'payment-1', state: 'Authorized', amountMinor: 2500 },
        lines: [{ id: 'line-1', quantity: 1, orderPlacedQuantity: 1 }] });
      return Response.json({ status: 'SUCCEEDED', operationId: 'operation-1' });
    },
  });
  await client.fetchAuthorizedDummyCancellationFacts({ workflowId: 'workflow-1', access, orderReference: 'ORDER-001' });
  await client.executeAuthorizedDummyCancellation({ workflowId: 'workflow-1', access, intent });
  await client.reconcileAuthorizedDummyCancellation({ workflowId: 'workflow-1', access, intent });
  assert.deepEqual(requests.map(request => request.path), [
    '/internal/v1/authorized-dummy-cancellation-facts', '/internal/v1/authorized-dummy-cancellations',
    '/internal/v1/authorized-dummy-cancellation-reconciliations',
  ]);
  assert.deepEqual(requests.map(request => request.body), [{ orderReference: 'ORDER-001' }, intent, intent]);
  assert.deepEqual(requests.map(request => request.redirect), ['error', 'error', 'error']);
  assert.deepEqual(signed.map(value => value.purpose), [
    'authorized_dummy_cancel_facts', 'authorized_dummy_cancel_execute', 'authorized_dummy_cancel_reconcile',
  ]);
  assert.deepEqual(signed[1]?.authorizedDummyCancellation, intent);
  assert.deepEqual(signed[2]?.authorizedDummyCancellation, intent);
  assert.ok(signed.every(value => value.workflowType === 'AUTHORIZED_DUMMY_CANCELLATION'));
});

test('lost execute response is uncertain; reconciliation read remains possible', async () => {
  let calls = 0;
  const client = createIntegrationGatewayAuthorizedDummyCancellationClient({
    baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion() { return 'signed'; },
    async fetchImpl() { calls++; if (calls === 1) throw new Error('connection lost');
      return Response.json({ status: 'SUCCEEDED', operationId: 'operation-1' }); },
  });
  const input = { workflowId: 'workflow-1', access, intent };
  assert.equal((await client.executeAuthorizedDummyCancellation(input)).status, 'PENDING_RECONCILIATION');
  assert.equal((await client.reconcileAuthorizedDummyCancellation(input)).status, 'SUCCEEDED');
  assert.equal(calls, 2);
});

test('client rejects cross-tenant and cross-environment before any Gateway call', async () => {
  let calls = 0;
  const client = createIntegrationGatewayAuthorizedDummyCancellationClient({
    baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion() { calls++; return 'signed'; },
    async fetchImpl() { calls++; assert.fail('Wrong scope must not reach Gateway'); },
  });
  for (const wrongAccess of [{ ...access, tenantId: 'other' }, { ...access, environmentId: 'other' }]) {
    await assert.rejects(client.fetchAuthorizedDummyCancellationFacts({
      workflowId: 'workflow-1', access: wrongAccess, orderReference: 'ORDER-001',
    }), /WORKFLOW_ACCESS_SCOPE_MISMATCH/);
    await assert.rejects(client.executeAuthorizedDummyCancellation({
      workflowId: 'workflow-1', access: wrongAccess, intent,
    }), /WORKFLOW_ACCESS_SCOPE_MISMATCH/);
    await assert.rejects(client.reconcileAuthorizedDummyCancellation({
      workflowId: 'workflow-1', access: wrongAccess, intent,
    }), /WORKFLOW_ACCESS_SCOPE_MISMATCH/);
  }
  assert.equal(calls, 0);
});

test('unverified success and HTTP failures never become a successful cancellation', async () => {
  for (const [response, expected] of [
    [Response.json({ status: 'SUCCEEDED' }), 'PENDING_RECONCILIATION'],
    [Response.json({ status: 'SUCCEEDED', operationId: 'operation-1', paymentState: 'Authorized' }), 'PENDING_RECONCILIATION'],
    [Response.json({ error: 'unavailable' }, { status: 503 }), 'PENDING_RECONCILIATION'],
    [Response.json({ error: 'not allowed' }, { status: 409 }), 'FAILED'],
  ] as const) {
    const client = createIntegrationGatewayAuthorizedDummyCancellationClient({
      baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
      async signWorkflowAccessAssertion() { return 'signed'; },
      async fetchImpl() { return response; },
    });
    assert.equal((await client.executeAuthorizedDummyCancellation({ workflowId: 'workflow-1', access, intent })).status, expected);
  }
});

test('facts accept current nonempty provider payment states without treating them as eligible', async () => {
  for (const state of ['Cancelled', 'Settled', 'OtherProviderState', '']) {
    const client = createIntegrationGatewayAuthorizedDummyCancellationClient({
      baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
      async signWorkflowAccessAssertion() { return 'signed'; },
      async fetchImpl() {
        return Response.json({
          orderId: 'order-1', orderReference: 'ORDER-001', policyVersion: 'AUTHORIZED_DUMMY_V1',
          providerFactsDigest: 'a'.repeat(64), eligible: false, placedAt: '2026-10-02T07:59:28.263Z',
          total: { amountMinor: 2500, currency: 'USD' },
          payment: { id: 'payment-1', state, amountMinor: 2500 },
          lines: [{ id: 'line-1', quantity: 1, orderPlacedQuantity: 1 }],
        });
      },
    });
    const result = client.fetchAuthorizedDummyCancellationFacts({
      workflowId: 'workflow-1', access, orderReference: 'ORDER-001',
    });
    if (state === '') await assert.rejects(result);
    else {
      const refreshed = await result;
      assert.equal(refreshed.payment?.state, state);
      assert.equal(refreshed.eligible, false);
    }
  }
});

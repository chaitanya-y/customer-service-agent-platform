import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SignJWT } from 'jose';

import { createHmacWorkflowAccessAssertionVerifier } from '../src/workflow-access.js';

const secret = 'test-only-workflow-secret-with-at-least-32-bytes';
const now = new Date('2026-08-08T12:00:00.000Z');

function createVerifier(expectedPurpose: 'refund_fact_refresh' | 'refund_execute' = 'refund_fact_refresh') {
  return createHmacWorkflowAccessAssertionVerifier({
    secret,
    expectedIssuer: 'customer-service-os-workflow-workers',
    expectedAudience: 'integration-gateway',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    now: () => now,
    expectedPurpose,
  });
}

async function createAssertion({ tenantId = 'tenant-local', purpose = 'refund_fact_refresh', refundExecution }: { tenantId?: string; purpose?: string; refundExecution?: unknown } = {}): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({
    accessVersion: '1',
    workflow: { workflowId: 'refund-workflow-001' },
    tenant: { tenantId, environmentId: 'local' },
    subject: { customerId: 'customer-42' },
    purpose,
    ...(refundExecution === undefined ? {} : { refundExecution }),
    request: { requestId: 'request-001', traceId: 'trace-001' },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'cso-workflow+jwt' })
    .setIssuer('customer-service-os-workflow-workers')
    .setAudience('integration-gateway')
    .setIssuedAt(Math.floor(now.getTime() / 1_000))
    .setExpirationTime(Math.floor(now.getTime() / 1_000) + 60)
    .sign(key);
}

test('verifies a short-lived Workflow Worker fact-refresh assertion', async () => {
  const context = await createVerifier()(await createAssertion());

  assert.deepEqual(context, {
    contextId: 'refund-workflow-001',
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-42',
    routingEpoch: 1,
    requestId: 'request-001',
    traceId: 'trace-001',
  });
});

const execution = { orderId: '3', reasonCode: 'DAMAGED', amount: { amountMinor: 5_000, currency: 'USD' }, selection: { scope: 'FULL_ORDER', itemIds: [] }, previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1' };

test('refund_execute authorization includes the exact signed execution intent', async () => {
  const context = await createVerifier('refund_execute')(await createAssertion({ purpose: 'refund_execute', refundExecution: execution }));
  assert.deepEqual((context as typeof context & { refundExecution?: unknown }).refundExecution, execution);
});

test('refund_execute authorization rejects legacy assertions without an execution intent', async () => {
  await assert.rejects(createVerifier('refund_execute')(await createAssertion({ purpose: 'refund_execute' })), /WORKFLOW_ACCESS_UNAUTHORIZED/);
});

for (const selection of [
  { scope: 'SELECTED_ITEMS', itemIds: [] },
  { scope: 'SELECTED_ITEMS', itemIds: ['line-1', 'line-1'] },
  { scope: 'FULL_ORDER', itemIds: ['line-1'] },
]) {
  test(`signed execution rejects malformed selection ${JSON.stringify(selection)}`, async () => {
    await assert.rejects(createVerifier('refund_execute')(await createAssertion({
      purpose: 'refund_execute', refundExecution: { ...execution, selection },
    })), /WORKFLOW_ACCESS_UNAUTHORIZED/);
  });
}

test('refund_execute authorization rejects malformed execution intent and wrong purposes', async () => {
  for (const refundExecution of [{ ...execution, amount: { amountMinor: 0, currency: 'USD' } }, { ...execution, amount: { amountMinor: 5_000, currency: 'EUR' } }, { ...execution, unexpected: true }, { ...execution, previewId: '' }]) {
    await assert.rejects(createVerifier('refund_execute')(await createAssertion({ purpose: 'refund_execute', refundExecution })), /WORKFLOW_ACCESS_UNAUTHORIZED/);
  }
  await assert.rejects(createVerifier('refund_execute')(await createAssertion()), /WORKFLOW_ACCESS_UNAUTHORIZED/);
});

test('rejects a Workflow Worker assertion for another tenant', async () => {
  await assert.rejects(
    createVerifier()(await createAssertion({ tenantId: 'another-tenant' })),
    /WORKFLOW_ACCESS_UNAUTHORIZED/,
  );
});

const cancellationIntent = { orderId: '9', orderReference: 'TEST-ORDER', previewId: 'preview-1', previewExpiresAt: '2026-10-02T12:05:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', providerFactsDigest: 'a'.repeat(64), idempotencyKey: 'cancel:workflow-1:preview-1' };

test('zero-total cancellation worker assertion binds workflow type and exact intent', async () => {
  const key = new TextEncoder().encode(secret);
  async function sign(workflowType: string, intent: unknown, purpose = 'zero_total_cancel_execute') {
    return new SignJWT({ accessVersion: '1', workflow: { workflowId: 'cancel-workflow-1', workflowType }, tenant: { tenantId: 'tenant-local', environmentId: 'local' }, subject: { customerId: 'customer-42' }, purpose, zeroTotalCancellation: intent, request: { requestId: 'request-001', traceId: 'trace-001' } })
      .setProtectedHeader({ alg: 'HS256', typ: 'cso-workflow+jwt' }).setIssuer('customer-service-os-workflow-workers').setAudience('integration-gateway')
      .setIssuedAt(Math.floor(now.getTime() / 1_000)).setExpirationTime(Math.floor(now.getTime() / 1_000) + 60).sign(key);
  }
  const verifier = createHmacWorkflowAccessAssertionVerifier({ secret, expectedIssuer: 'customer-service-os-workflow-workers', expectedAudience: 'integration-gateway', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local', expectedPurpose: 'zero_total_cancel_execute', now: () => now });
  const verified = await verifier(await sign('ZERO_TOTAL_CANCELLATION', cancellationIntent));
  assert.deepEqual(verified.zeroTotalCancellation, cancellationIntent);
  assert.equal(verified.workflowType, 'ZERO_TOTAL_CANCELLATION');
  await assert.rejects(verifier(await sign('REFUND', cancellationIntent)), /WORKFLOW_ACCESS_UNAUTHORIZED/);
  await assert.rejects(verifier(await sign('ZERO_TOTAL_CANCELLATION', { ...cancellationIntent, orderId: '' })), /WORKFLOW_ACCESS_UNAUTHORIZED/);
  await assert.rejects(verifier(await sign('ZERO_TOTAL_CANCELLATION', undefined)), /WORKFLOW_ACCESS_UNAUTHORIZED/);
  await assert.rejects(verifier(await sign('ZERO_TOTAL_CANCELLATION', cancellationIntent, 'refund_execute')), /WORKFLOW_ACCESS_UNAUTHORIZED/);
});

test('authorized dummy cancellation assertion binds distinct purpose, workflow and payment', async () => {
  const key = new TextEncoder().encode(secret);
  const authorizedIntent = { ...cancellationIntent, paymentId: 'payment-1', policyVersion: 'AUTHORIZED_DUMMY_V1' };
  async function sign(purpose: string, workflowType: string, intent: unknown) {
    return new SignJWT({ accessVersion: '1', workflow: { workflowId: 'authorized-workflow-1', workflowType },
      tenant: { tenantId: 'tenant-local', environmentId: 'local' }, subject: { customerId: 'customer-42' },
      purpose, authorizedDummyCancellation: intent, request: { requestId: 'request-001', traceId: 'trace-001' } })
      .setProtectedHeader({ alg: 'HS256', typ: 'cso-workflow+jwt' })
      .setIssuer('customer-service-os-workflow-workers').setAudience('integration-gateway')
      .setIssuedAt(Math.floor(now.getTime() / 1_000)).setExpirationTime(Math.floor(now.getTime() / 1_000) + 60).sign(key);
  }
  const verifier = createHmacWorkflowAccessAssertionVerifier({ secret,
    expectedIssuer: 'customer-service-os-workflow-workers', expectedAudience: 'integration-gateway',
    expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
    expectedPurpose: 'authorized_dummy_cancel_execute', now: () => now });
  const verified = await verifier(await sign('authorized_dummy_cancel_execute', 'AUTHORIZED_DUMMY_CANCELLATION', authorizedIntent));
  assert.equal(verified.workflowType, 'AUTHORIZED_DUMMY_CANCELLATION');
  assert.deepEqual(verified.authorizedDummyCancellation, authorizedIntent);
  await assert.rejects(verifier(await sign('authorized_dummy_cancel_execute', 'ZERO_TOTAL_CANCELLATION', authorizedIntent)), /WORKFLOW_ACCESS_UNAUTHORIZED/);
  await assert.rejects(verifier(await sign('authorized_dummy_cancel_execute', 'AUTHORIZED_DUMMY_CANCELLATION', { ...authorizedIntent, paymentId: '' })), /WORKFLOW_ACCESS_UNAUTHORIZED/);
  await assert.rejects(verifier(await sign('authorized_dummy_cancel_execute', 'AUTHORIZED_DUMMY_CANCELLATION', undefined)), /WORKFLOW_ACCESS_UNAUTHORIZED/);
  await assert.rejects(verifier(await sign('zero_total_cancel_execute', 'AUTHORIZED_DUMMY_CANCELLATION', authorizedIntent)), /WORKFLOW_ACCESS_UNAUTHORIZED/);
});

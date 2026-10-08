import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jwtVerify } from 'jose';

import { createHmacWorkflowAccessAssertionSigner } from '../src/workflow-access-assertion.js';

const secret = 'synthetic-workflow-secret-with-at-least-32-bytes';
const access = {
  tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
  requestId: 'request-1', traceId: 'trace-1',
};
const refundExecution = {
  orderId: 'order-1', reasonCode: 'DAMAGED', amount: { amountMinor: 5000, currency: 'USD' as const },
  selection: { scope: 'FULL_ORDER' as const, itemIds: [] },
  previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1',
};

test('refund execution assertion signs the exact financial instruction', async () => {
  const sign = createHmacWorkflowAccessAssertionSigner({
    secret, issuer: 'workflow-worker', audience: 'integration-gateway',
  });
  const token = await sign({ workflowId: 'workflow-1', access, purpose: 'refund_execute', refundExecution });
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: 'workflow-worker', audience: 'integration-gateway',
  });
  assert.deepEqual(payload.refundExecution, refundExecution);
});

test('refund execution assertion refuses an unbound financial instruction', async () => {
  const sign = createHmacWorkflowAccessAssertionSigner({
    secret, issuer: 'workflow-worker', audience: 'integration-gateway',
  });
  await assert.rejects(
    sign({ workflowId: 'workflow-1', access, purpose: 'refund_execute' }),
  );
});

const zeroTotalCancellation = {
  orderId: 'order-1', orderReference: 'ORDER-001', previewId: 'preview-1',
  previewExpiresAt: '2026-10-02T08:30:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1' as const,
  providerFactsDigest: 'a'.repeat(64), idempotencyKey: 'zero-total-cancel:preview-1',
};

const authorizedDummyCancellation = {
  ...zeroTotalCancellation, paymentId: 'payment-1', policyVersion: 'AUTHORIZED_DUMMY_V1' as const,
  idempotencyKey: 'authorized-dummy-cancel:preview-1',
};

test('authorized dummy assertions bind payment and are isolated from zero-total and refund purposes', async () => {
  const sign = createHmacWorkflowAccessAssertionSigner({
    secret, issuer: 'workflow-worker', audience: 'integration-gateway',
  });
  for (const purpose of ['authorized_dummy_cancel_execute', 'authorized_dummy_cancel_reconcile'] as const) {
    const token = await sign({ workflowId: 'workflow-1', workflowType: 'AUTHORIZED_DUMMY_CANCELLATION',
      access, purpose, authorizedDummyCancellation });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: 'workflow-worker', audience: 'integration-gateway',
    });
    assert.deepEqual(payload.workflow, { workflowId: 'workflow-1', workflowType: 'AUTHORIZED_DUMMY_CANCELLATION' });
    assert.deepEqual(payload.authorizedDummyCancellation, authorizedDummyCancellation);
    assert.equal(payload.zeroTotalCancellation, undefined);
  }
});

test('authorized dummy signing fails closed on crossed purposes, missing payment, and missing intent', async () => {
  const sign = createHmacWorkflowAccessAssertionSigner({
    secret, issuer: 'workflow-worker', audience: 'integration-gateway',
  });
  await assert.rejects(sign({ workflowId: 'workflow-1', access, workflowType: 'AUTHORIZED_DUMMY_CANCELLATION',
    purpose: 'authorized_dummy_cancel_execute' }));
  await assert.rejects(sign({ workflowId: 'workflow-1', access, workflowType: 'AUTHORIZED_DUMMY_CANCELLATION',
    purpose: 'authorized_dummy_cancel_facts', authorizedDummyCancellation }));
  await assert.rejects(sign({ workflowId: 'workflow-1', access, workflowType: 'ZERO_TOTAL_CANCELLATION',
    purpose: 'zero_total_cancel_execute', zeroTotalCancellation, authorizedDummyCancellation }));
  await assert.rejects(sign({ workflowId: 'workflow-1', access, purpose: 'refund_execute',
    refundExecution, authorizedDummyCancellation }));
  await assert.rejects(sign({ workflowId: 'workflow-1', access, workflowType: 'AUTHORIZED_DUMMY_CANCELLATION',
    purpose: 'authorized_dummy_cancel_execute', authorizedDummyCancellation: { ...authorizedDummyCancellation, paymentId: '' } }));
});

test('cancellation execution and reconciliation assertions bind the complete write intent', async () => {
  const sign = createHmacWorkflowAccessAssertionSigner({
    secret, issuer: 'workflow-worker', audience: 'integration-gateway',
  });
  for (const purpose of ['zero_total_cancel_execute', 'zero_total_cancel_reconcile'] as const) {
    const token = await sign({ workflowId: 'workflow-1', workflowType: 'ZERO_TOTAL_CANCELLATION',
      access, purpose, zeroTotalCancellation });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: 'workflow-worker', audience: 'integration-gateway',
    });
    assert.deepEqual(payload.workflow, { workflowId: 'workflow-1', workflowType: 'ZERO_TOTAL_CANCELLATION' });
    assert.deepEqual(payload.zeroTotalCancellation, zeroTotalCancellation);
    assert.equal(payload.purpose, purpose);
  }
});

test('cancellation assertions reject missing or wrong-purpose intent', async () => {
  const sign = createHmacWorkflowAccessAssertionSigner({
    secret, issuer: 'workflow-worker', audience: 'integration-gateway',
  });
  await assert.rejects(sign({ workflowId: 'workflow-1', workflowType: 'ZERO_TOTAL_CANCELLATION',
    access, purpose: 'zero_total_cancel_execute' }));
  await assert.rejects(sign({ workflowId: 'workflow-1', workflowType: 'ZERO_TOTAL_CANCELLATION',
    access, purpose: 'zero_total_cancel_facts', zeroTotalCancellation }));
  await assert.rejects(sign({ workflowId: 'workflow-1', access,
    purpose: 'zero_total_cancel_execute', zeroTotalCancellation }));
});

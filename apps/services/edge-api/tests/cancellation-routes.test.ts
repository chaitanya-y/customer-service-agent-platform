import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { CancellationPreviewUnavailableError, CancellationWorkflowNotFoundError } from '../src/temporal-cancellation-client.js';

const owner = { principalId: 'customer-7', customerId: 'customer-7', tenantId: 'tenant-local', environmentId: 'local' };
const cancellationId = `cancel-${'b'.repeat(64)}`;
const preview = {
  previewId: 'preview-1', createdAt: '2026-10-02T12:00:00.000Z', validUntil: '2026-10-02T12:15:00.000Z',
  orderId: '9', orderReference: 'EJ4P5T4W2BKUH56Y', placedAt: '2026-10-02T11:00:00.000Z',
  total: { amountMinor: 0 as const, currency: 'USD' },
  lines: [{ id: 'line-1', quantity: 1, orderPlacedQuantity: 1 }],
  policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1' as const, providerFactsDigest: 'a'.repeat(64),
};

function baseOptions() {
  return {
    verifyCustomerIdentity: async () => owner,
    signContextAssertion: async () => 'signed-gateway-context',
    signAgentRuntimeContextAssertion: async () => 'signed-agent-context',
    signKnowledgeRagContextAssertion: async () => 'signed-knowledge-context',
    intakeRefund: async () => { throw new Error('refund must not run'); },
    startCancellationWorkflow: async ({ workflowId }: { workflowId: string }) => ({ workflowId }),
    getCancellationWorkflow: async () => ({ stage: 'AWAITING_CUSTOMER_CONFIRMATION' as const, preview }),
    confirmCancellationWorkflow: async () => {},
  };
}

test('customer cancellation starts a separate stable workflow and never starts refund', async (context) => {
  const starts: unknown[] = [];
  const app = buildApp({ ...baseOptions(), startCancellationWorkflow: async (input) => {
    starts.push(input); return { workflowId: input.workflowId };
  } });
  context.after(() => app.close());
  const headers = { authorization: 'Bearer customer-token' };
  const payload = { order_reference: 'ej4p5t4w2bkuh56y' };
  const first = await app.inject({ method: 'POST', url: '/v1/cancellations', headers, payload });
  const second = await app.inject({ method: 'POST', url: '/v1/cancellations', headers, payload });
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.json(), second.json());
  assert.match(first.json().workflow_id, /^cancel-[a-f0-9]{64}$/);
  assert.deepEqual(starts, [
    { workflowId: first.json().workflow_id, orderReference: 'EJ4P5T4W2BKUH56Y',
      policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', access: { tenantId: 'tenant-local', environmentId: 'local',
        subjectCustomerId: 'customer-7', requestId: starts[0] && (starts[0] as { access: { requestId: string } }).access.requestId,
        traceId: starts[0] && (starts[0] as { access: { traceId: string } }).access.traceId } },
    { workflowId: first.json().workflow_id, orderReference: 'EJ4P5T4W2BKUH56Y',
      policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', access: { tenantId: 'tenant-local', environmentId: 'local',
        subjectCustomerId: 'customer-7', requestId: starts[1] && (starts[1] as { access: { requestId: string } }).access.requestId,
        traceId: starts[1] && (starts[1] as { access: { traceId: string } }).access.traceId } },
  ]);
});

test('cancellation refuses unauthenticated or forged customer inputs before Temporal', async (context) => {
  let starts = 0;
  const app = buildApp({ ...baseOptions(), verifyCustomerIdentity: async () => { throw new Error('expired'); },
    startCancellationWorkflow: async ({ workflowId }) => { starts += 1; return { workflowId }; } });
  context.after(() => app.close());
  const invalid = await app.inject({ method: 'POST', url: '/v1/cancellations',
    payload: { order_reference: 'EJ4P5T4W2BKUH56Y', customer_id: 'another' } });
  assert.equal(invalid.statusCode, 400);
  const unauth = await app.inject({ method: 'POST', url: '/v1/cancellations',
    payload: { order_reference: 'EJ4P5T4W2BKUH56Y' } });
  assert.equal(unauth.statusCode, 401);
  assert.equal(starts, 0);
});

test('cancellation view strips provider internals and checks owner through Temporal', async (context) => {
  const reads: unknown[] = [];
  const app = buildApp({ ...baseOptions(), getCancellationWorkflow: async (input) => {
    reads.push(input); return { stage: 'AWAITING_CUSTOMER_CONFIRMATION' as const, preview };
  } });
  context.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: `/v1/cancellations/${cancellationId}`,
    headers: { authorization: 'Bearer customer-token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.json().stage, 'AWAITING_CUSTOMER_CONFIRMATION');
  assert.equal(response.json().preview.order_reference, preview.orderReference);
  assert.deepEqual(response.json().preview.lines, [{ item_id: 'line-1', quantity: 1 }], 'legacy previews remain readable');
  assert.equal(response.body.includes('providerFactsDigest'), false);
  assert.equal(response.body.includes('orderId'), false);
  assert.equal(reads.length, 1);
  assert.equal((reads[0] as { access: { subjectCustomerId: string } }).access.subjectCustomerId, 'customer-7');
});

test('cancellation view exposes only the trusted display name for a new preview', async context => {
  const app = buildApp({ ...baseOptions(), getCancellationWorkflow: async () => ({
    stage: 'AWAITING_CUSTOMER_CONFIRMATION' as const,
    preview: { ...preview, lines: [{ ...preview.lines[0]!, displayName: 'Free fixture' }] },
  }) });
  context.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: `/v1/cancellations/${cancellationId}`,
    headers: { authorization: 'Bearer customer-token' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().preview.lines, [{ item_id: 'line-1', quantity: 1, display_name: 'Free fixture' }]);
  assert.equal(response.body.includes('providerFactsDigest'), false);
});

test('cancellation view rejects malformed display names rather than projecting them', async context => {
  for (const displayName of ['Unsafe\nname', '\u200B', '\u0085', 'Free\u200Bfixture', 'Free\u202Efixture']) {
    const app = buildApp({ ...baseOptions(), getCancellationWorkflow: async () => ({
      stage: 'AWAITING_CUSTOMER_CONFIRMATION' as const,
      preview: { ...preview, lines: [{ ...preview.lines[0]!, displayName }] },
    }) });
    context.after(() => app.close());
    const response = await app.inject({ method: 'GET', url: `/v1/cancellations/${cancellationId}`,
      headers: { authorization: 'Bearer customer-token' } });
    assert.equal(response.statusCode, 503);
  }
});

test('cancellation confirmation sends exact preview and does not report order cancelled', async (context) => {
  const signals: unknown[] = [];
  const app = buildApp({ ...baseOptions(), confirmCancellationWorkflow: async (input) => { signals.push(input); } });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: `/v1/cancellations/${cancellationId}/confirmation`,
    headers: { authorization: 'Bearer customer-token' }, payload: { preview_id: 'preview-1', accepted: true } });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: 'confirmation_received' });
  assert.equal(signals.length, 1);
  assert.equal((signals[0] as { previewId: string }).previewId, 'preview-1');
});

test('cancellation maps owner mismatch and stale preview without leaking internals', async (context) => {
  const app = buildApp({ ...baseOptions(), getCancellationWorkflow: async () => { throw new CancellationWorkflowNotFoundError(); },
    confirmCancellationWorkflow: async () => { throw new CancellationPreviewUnavailableError(); } });
  context.after(() => app.close());
  const headers = { authorization: 'Bearer customer-token' };
  const view = await app.inject({ method: 'GET', url: `/v1/cancellations/${cancellationId}`, headers });
  assert.equal(view.statusCode, 404);
  const confirm = await app.inject({ method: 'POST', url: `/v1/cancellations/${cancellationId}/confirmation`, headers,
    payload: { preview_id: 'preview-1', accepted: true } });
  assert.equal(confirm.statusCode, 409);
});

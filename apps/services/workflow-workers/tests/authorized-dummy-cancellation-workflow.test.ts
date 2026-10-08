import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import {
  confirmAuthorizedDummyCancellation,
  getAuthorizedDummyCancellationAccess,
  getAuthorizedDummyCancellationState,
  authorizedDummyCancellationWorkflow,
  type AuthorizedDummyCancellationRequest,
} from '../src/authorized-dummy-cancellation-workflow.js';
import type {
  AuthorizedDummyCancellationActivities,
  AuthorizedDummyCancellationFacts,
} from '../src/authorized-dummy-cancellation-activities.js';
import { createIntegrationGatewayAuthorizedDummyCancellationClient } from '../src/authorized-dummy-cancellation-client.js';

const request: AuthorizedDummyCancellationRequest = {
  orderReference: 'ORDER-001', policyVersion: 'AUTHORIZED_DUMMY_V1',
  access: { tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
    requestId: 'request-1', traceId: 'trace-1' },
};
const facts: AuthorizedDummyCancellationFacts = {
  orderId: 'order-1', orderReference: 'ORDER-001', policyVersion: 'AUTHORIZED_DUMMY_V1',
  providerFactsDigest: 'a'.repeat(64), eligible: true, placedAt: '2026-10-02T07:59:28.263Z',
  total: { amountMinor: 2500, currency: 'USD' },
  payment: { id: 'payment-1', state: 'Authorized', amountMinor: 2500 },
  lines: [{ id: 'line-1', quantity: 1, orderPlacedQuantity: 1 }],
};

test('Gateway reports of a cancelled or settled payment invalidate the preview without writing', async () => {
  for (const paymentState of ['Cancelled', 'Settled']) {
    let reads = 0;
    const client = createIntegrationGatewayAuthorizedDummyCancellationClient({
      baseUrl: 'http://gateway.internal', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
      async signWorkflowAccessAssertion() { return 'synthetic'; },
      async fetchImpl(input) {
        assert.equal(new URL(String(input)).pathname, '/internal/v1/authorized-dummy-cancellation-facts',
          'A changed payment must never call the execution or reconciliation route');
        return Response.json(++reads === 1 ? facts : {
          ...facts, eligible: false,
          payment: { id: 'payment-1', state: paymentState, amountMinor: 2500 },
        });
      },
    });
    await withWorker(client, async (env, queue) => {
      const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow, {
        taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request],
      });
      const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
      assert.ok(state.preview);
      await handle.signal(confirmAuthorizedDummyCancellation, { previewId: state.preview.previewId, accepted: true });
      const result = await handle.result();
      assert.equal(result.stage, 'PREVIEW_INVALIDATED');
      assert.deepEqual(await handle.query(getAuthorizedDummyCancellationState), result);
      assert.equal(reads, 2);
    });
  }
});

test('a changed payment identity, amount, or authorization invalidates consent without writing', async () => {
  await withWorker({
    async fetchAuthorizedDummyCancellationFacts() { return facts; },
    async executeAuthorizedDummyCancellation() { assert.fail('Changed payment must not mutate'); },
    async reconcileAuthorizedDummyCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    for (const changed of [
      { id: 'another-payment', state: 'Authorized' as const, amountMinor: 2500 },
      { id: 'payment-1', state: 'Authorized' as const, amountMinor: 2499 },
      null,
    ]) {
      let reads = 0;
      const worker = await Worker.create({ connection: env.nativeConnection,
        taskQueue: `payment-change-${crypto.randomUUID()}`,
        workflowsPath: fileURLToPath(new URL('../src/authorized-dummy-cancellation-workflow.ts', import.meta.url)),
        activities: {
          async fetchAuthorizedDummyCancellationFacts() { return ++reads === 1 ? facts : { ...facts, payment: changed }; },
          async executeAuthorizedDummyCancellation() { assert.fail('Changed payment must not mutate'); },
        },
      });
      await worker.runUntil(async () => {
        const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow, {
          taskQueue: worker.options.taskQueue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request],
        });
        const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
        assert.ok(state.preview);
        await handle.signal(confirmAuthorizedDummyCancellation, { previewId: state.preview.previewId, accepted: true });
        assert.equal((await handle.result()).stage, 'PREVIEW_INVALIDATED');
      });
    }
  });
});

async function withWorker(
  activities: AuthorizedDummyCancellationActivities,
  run: (env: TestWorkflowEnvironment, queue: string) => Promise<void>,
): Promise<void> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const queue = `authorized-dummy-cancellation-test-${crypto.randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: queue,
    workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
    activities, maxCachedWorkflows: 0 });
  const workerRun = worker.run();
  try { await run(env, queue); }
  finally { await worker.shutdown(); await workerRun; await env.teardown(); }
}

async function waitForStage(handle: WorkflowHandle<typeof authorizedDummyCancellationWorkflow>, stage: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const state = await handle.query(getAuthorizedDummyCancellationState);
    if (state.stage === stage) return state;
    await delay(20);
  }
  assert.fail(`Workflow did not reach ${stage}`);
}

test('cancellation requires exact preview consent and refreshes facts before one mutation', async () => {
  let reads = 0; let executions = 0; let executedPreviewId: string | undefined;
  await withWorker({
    async fetchAuthorizedDummyCancellationFacts() { reads++; return facts; },
    async executeAuthorizedDummyCancellation(input) { executions++; executedPreviewId = input.intent.previewId;
      assert.equal(input.intent.paymentId, 'payment-1');
      assert.equal(input.intent.policyVersion, 'AUTHORIZED_DUMMY_V1');
      return { status: 'SUCCEEDED', operationId: 'operation-1' }; },
    async reconcileAuthorizedDummyCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    assert.deepEqual(await handle.query(getAuthorizedDummyCancellationAccess), request.access);
    assert.equal(state.preview.orderReference, facts.orderReference);
    assert.equal(state.preview.total.amountMinor, 2500);
    assert.deepEqual(state.preview.payment, { id: 'payment-1', state: 'Authorized', amountMinor: 2500 });
    assert.equal(Date.parse(state.preview.validUntil) - Date.parse(state.preview.createdAt), 900000);
    await handle.signal(confirmAuthorizedDummyCancellation, { previewId: 'wrong-preview', accepted: true });
    assert.equal((await handle.query(getAuthorizedDummyCancellationState)).stage, 'AWAITING_CUSTOMER_CONFIRMATION');
    await handle.signal(confirmAuthorizedDummyCancellation, { previewId: state.preview.previewId, accepted: true });
    const result = await handle.result();
    assert.equal(result.stage, 'BOTH_CANCELLED');
    assert.deepEqual(await handle.query(getAuthorizedDummyCancellationState), result);
    assert.equal(reads, 2);
    assert.equal(executions, 1);
    assert.equal(executedPreviewId, state.preview.previewId);
  });
});

test('changed provider facts invalidate consent without mutation', async () => {
  let reads = 0; let executions = 0;
  await withWorker({
    async fetchAuthorizedDummyCancellationFacts() { return ++reads === 1 ? facts : { ...facts, providerFactsDigest: 'b'.repeat(64) }; },
    async executeAuthorizedDummyCancellation() { executions++; assert.fail('Stale preview must not mutate'); },
    async reconcileAuthorizedDummyCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    await handle.signal(confirmAuthorizedDummyCancellation, { previewId: state.preview.previewId, accepted: true });
    const result = await handle.result();
    assert.equal(result.stage, 'PREVIEW_INVALIDATED');
    assert.deepEqual(await handle.query(getAuthorizedDummyCancellationState), result);
    assert.equal(executions, 0);
  });
});

test('uncertain execution reconciles without a second mutation', async () => {
  let executions = 0; let reconciliations = 0;
  await withWorker({
    async fetchAuthorizedDummyCancellationFacts() { return facts; },
    async executeAuthorizedDummyCancellation() { executions++; throw new Error('lost response'); },
    async reconcileAuthorizedDummyCancellation() { reconciliations++; return { status: 'SUCCEEDED', operationId: 'operation-1' }; },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    await handle.signal(confirmAuthorizedDummyCancellation, { previewId: state.preview.previewId, accepted: true });
    const result = await handle.result();
    assert.equal(result.stage, 'BOTH_CANCELLED');
    assert.deepEqual(await handle.query(getAuthorizedDummyCancellationState), result);
    assert.equal(executions, 1);
    assert.ok(reconciliations >= 1);
  });
});

test('ineligible facts never create a preview', async () => {
  await withWorker({
    async fetchAuthorizedDummyCancellationFacts() { return { ...facts, eligible: false }; },
    async executeAuthorizedDummyCancellation() { assert.fail('Ineligible order must not mutate'); },
    async reconcileAuthorizedDummyCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await handle.result();
    assert.equal(state.stage, 'NOT_ELIGIBLE');
    assert.equal(state.preview, undefined);
    assert.deepEqual(await handle.query(getAuthorizedDummyCancellationState), state);
  });
});

test('early terminal paths publish their final query state after completion', async () => {
  let reads = 0;
  await withWorker({
    async fetchAuthorizedDummyCancellationFacts() { reads++; throw new Error('facts unavailable'); },
    async executeAuthorizedDummyCancellation() { assert.fail('No mutation expected'); },
    async reconcileAuthorizedDummyCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const invalidPolicy = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`,
        args: [{ ...request, policyVersion: 'UNSUPPORTED_POLICY' } as unknown as AuthorizedDummyCancellationRequest] });
    const invalidPolicyResult = await invalidPolicy.result();
    assert.deepEqual(await invalidPolicy.query(getAuthorizedDummyCancellationState), invalidPolicyResult);
    assert.equal(reads, 0);

    const unavailable = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const unavailableResult = await unavailable.result();
    assert.deepEqual(await unavailable.query(getAuthorizedDummyCancellationState), unavailableResult);
    assert.equal(unavailableResult.stage, 'FACTS_UNAVAILABLE');
    assert.equal(reads, 3);
  });
});

test('declined and expired previews never call the cancellation mutation', async () => {
  let executions = 0;
  const activities: AuthorizedDummyCancellationActivities = {
    async fetchAuthorizedDummyCancellationFacts() { return facts; },
    async executeAuthorizedDummyCancellation() { executions++; assert.fail('Consent was not accepted'); },
    async reconcileAuthorizedDummyCancellation() { assert.fail('No reconciliation expected'); },
  };
  await withWorker(activities, async (env, queue) => {
    const declined = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const declinedState = await waitForStage(declined, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(declinedState.preview);
    await declined.signal(confirmAuthorizedDummyCancellation, { previewId: declinedState.preview.previewId, accepted: false });
    const declinedResult = await declined.result();
    assert.equal(declinedResult.stage, 'CUSTOMER_DECLINED');
    assert.deepEqual(await declined.query(getAuthorizedDummyCancellationState), declinedResult);

    const expired = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const expiredState = await waitForStage(expired, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(expiredState.preview);
    await env.sleep(15 * 60_000);
    const expiredResult = await expired.result();
    assert.equal(expiredResult.stage, 'PREVIEW_EXPIRED');
    assert.deepEqual(await expired.query(getAuthorizedDummyCancellationState), expiredResult);
    assert.equal(executions, 0);
  });
});

test('NOT_FOUND reconciliation never re-executes and completed history replays', async () => {
  let executions = 0; let reconciliations = 0;
  const workflowsPath = fileURLToPath(new URL('../src/workflows.ts', import.meta.url));
  await withWorker({
    async fetchAuthorizedDummyCancellationFacts() { return facts; },
    async executeAuthorizedDummyCancellation() { executions++; return { status: 'PENDING_RECONCILIATION', operationId: 'operation-1' }; },
    async reconcileAuthorizedDummyCancellation() { return ++reconciliations === 1
      ? { status: 'NOT_FOUND' } : { status: 'SUCCEEDED', operationId: 'operation-1' }; },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    await handle.signal(confirmAuthorizedDummyCancellation, { previewId: state.preview.previewId, accepted: true });
    const result = await handle.result();
    assert.equal(result.stage, 'BOTH_CANCELLED');
    assert.deepEqual(await handle.query(getAuthorizedDummyCancellationState), result);
    assert.equal(executions, 1);
    assert.equal(reconciliations, 2);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
  });
});

test('continuation recovery only reads the original payment-bound operation even after preview expires', async () => {
  const preview = {
    previewId: 'preview-before-restart', createdAt: '2020-01-01T00:00:00.000Z',
    validUntil: '2020-01-01T00:15:00.000Z', orderId: facts.orderId,
    orderReference: facts.orderReference, placedAt: facts.placedAt!, total: facts.total,
    lines: facts.lines, payment: facts.payment!, policyVersion: facts.policyVersion,
    providerFactsDigest: facts.providerFactsDigest,
  };
  const intent = { orderId: facts.orderId, orderReference: facts.orderReference,
    paymentId: 'payment-1', previewId: preview.previewId, previewExpiresAt: preview.validUntil,
    policyVersion: facts.policyVersion, providerFactsDigest: facts.providerFactsDigest,
    idempotencyKey: 'authorized-dummy-cancel:preview-before-restart' };
  let reads = 0;
  await withWorker({
    async fetchAuthorizedDummyCancellationFacts() { assert.fail('Recovery must not create new facts or consent'); },
    async executeAuthorizedDummyCancellation() { assert.fail('Recovery must never write again'); },
    async reconcileAuthorizedDummyCancellation(input) {
      assert.deepEqual(input.intent, intent);
      return ++reads === 1 ? { status: 'NOT_FOUND' } : { status: 'SUCCEEDED', operationId: 'operation-1' };
    },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow, {
      taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`,
      args: [{ ...request, recovery: { preview, intent } }],
    });
    const result = await handle.result();
    assert.equal(result.stage, 'BOTH_CANCELLED');
    assert.deepEqual(result.preview, preview);
    assert.equal(reads, 2);
  });
});

test('a restarted Worker resumes reconciliation without repeating the provider write', async () => {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const queue = `authorized-dummy-restart-${crypto.randomUUID()}`;
  let writes = 0;
  let restarted = false;
  const activities: AuthorizedDummyCancellationActivities = {
    async fetchAuthorizedDummyCancellationFacts() { return facts; },
    async executeAuthorizedDummyCancellation() { writes++; return { status: 'PENDING_RECONCILIATION' }; },
    async reconcileAuthorizedDummyCancellation() { return restarted
      ? { status: 'SUCCEEDED', operationId: 'operation-after-restart' } : { status: 'NOT_FOUND' }; },
  };
  const options = { connection: env.nativeConnection, taskQueue: queue, activities,
    // Avoid test-server sticky-queue stalls; the replacement still replays durable history.
    workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)), maxCachedWorkflows: 0 };
  const worker = await Worker.create(options);
  const workerRun = worker.run();
  let firstStopped = false;
  try {
    const handle = await env.workflowClient.start(authorizedDummyCancellationWorkflow, {
      taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request],
    });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    await handle.signal(confirmAuthorizedDummyCancellation, { previewId: state.preview.previewId, accepted: true });
    await waitForStage(handle, 'PENDING_RECONCILIATION');
    await worker.shutdown();
    await workerRun;
    firstStopped = true;
    restarted = true;
    const replacement = await Worker.create(options);
    await replacement.runUntil(async () => {
      const result = await handle.result();
      assert.equal(result.stage, 'BOTH_CANCELLED');
      assert.equal(result.operationId, 'operation-after-restart');
      assert.equal(result.preview?.previewId, state.preview!.previewId);
      assert.equal(writes, 1);
    });
  } finally {
    if (!firstStopped) { await worker.shutdown(); await workerRun; }
    await env.teardown();
  }
});

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import {
  confirmZeroTotalCancellation,
  getZeroTotalCancellationState,
  zeroTotalCancellationWorkflow,
  type ZeroTotalCancellationRequest,
} from '../src/zero-total-cancellation-workflow.js';
import type {
  ZeroTotalCancellationActivities,
  ZeroTotalCancellationFacts,
} from '../src/zero-total-cancellation-activities.js';

const request: ZeroTotalCancellationRequest = {
  orderReference: 'ORDER-001', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1',
  access: { tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
    requestId: 'request-1', traceId: 'trace-1' },
};
const facts: ZeroTotalCancellationFacts = {
  orderId: 'order-1', orderReference: 'ORDER-001', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1',
  providerFactsDigest: 'a'.repeat(64), eligible: true, placedAt: '2026-10-02T07:59:28.263Z',
  total: { amountMinor: 0, currency: 'USD' },
  lines: [{ id: 'line-1', quantity: 1, orderPlacedQuantity: 1 }],
};

async function withWorker(
  activities: ZeroTotalCancellationActivities,
  run: (env: TestWorkflowEnvironment, queue: string) => Promise<void>,
): Promise<void> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const queue = `zero-total-cancellation-test-${crypto.randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: queue,
    workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
    activities, maxCachedWorkflows: 0 });
  const workerRun = worker.run();
  try { await run(env, queue); }
  finally { await worker.shutdown(); await workerRun; await env.teardown(); }
}

async function waitForStage(handle: WorkflowHandle<typeof zeroTotalCancellationWorkflow>, stage: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const state = await handle.query(getZeroTotalCancellationState);
    if (state.stage === stage) return state;
    await delay(20);
  }
  assert.fail(`Workflow did not reach ${stage}`);
}

test('cancellation requires exact preview consent and refreshes facts before one mutation', async () => {
  let reads = 0; let executions = 0; let executedPreviewId: string | undefined;
  await withWorker({
    async fetchZeroTotalCancellationFacts() { reads++; return facts; },
    async executeZeroTotalCancellation(input) { executions++; executedPreviewId = input.intent.previewId;
      return { status: 'SUCCEEDED', operationId: 'operation-1' }; },
    async reconcileZeroTotalCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    assert.equal(state.preview.orderReference, facts.orderReference);
    assert.equal(state.preview.total.amountMinor, 0);
    await handle.signal(confirmZeroTotalCancellation, { previewId: 'wrong-preview', accepted: true });
    assert.equal((await handle.query(getZeroTotalCancellationState)).stage, 'AWAITING_CUSTOMER_CONFIRMATION');
    await handle.signal(confirmZeroTotalCancellation, { previewId: state.preview.previewId, accepted: true });
    const result = await handle.result();
    assert.equal(result.stage, 'ORDER_CANCELLED');
    assert.deepEqual(await handle.query(getZeroTotalCancellationState), result);
    assert.equal(reads, 2);
    assert.equal(executions, 1);
    assert.equal(executedPreviewId, state.preview.previewId);
  });
});

test('changed provider facts invalidate consent without mutation', async () => {
  let reads = 0; let executions = 0;
  await withWorker({
    async fetchZeroTotalCancellationFacts() { return ++reads === 1 ? facts : { ...facts, providerFactsDigest: 'b'.repeat(64) }; },
    async executeZeroTotalCancellation() { executions++; assert.fail('Stale preview must not mutate'); },
    async reconcileZeroTotalCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    await handle.signal(confirmZeroTotalCancellation, { previewId: state.preview.previewId, accepted: true });
    const result = await handle.result();
    assert.equal(result.stage, 'PREVIEW_INVALIDATED');
    assert.deepEqual(await handle.query(getZeroTotalCancellationState), result);
    assert.equal(executions, 0);
  });
});

test('a display-name-only change does not alter authorization after exact preview consent', async () => {
  let reads = 0; let executions = 0;
  await withWorker({
    async fetchZeroTotalCancellationFacts() {
      reads++;
      return { ...facts, lines: [{ ...facts.lines[0]!, displayName: reads === 1 ? 'Free fixture' : 'Renamed fixture' }] };
    },
    async executeZeroTotalCancellation() { executions++; return { status: 'SUCCEEDED', operationId: 'operation-name-change' }; },
    async reconcileZeroTotalCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.equal((state.preview?.lines[0] as { displayName?: string }).displayName, 'Free fixture');
    await handle.signal(confirmZeroTotalCancellation, { previewId: state.preview!.previewId, accepted: true });
    assert.equal((await handle.result()).stage, 'ORDER_CANCELLED');
    assert.equal(reads, 2);
    assert.equal(executions, 1);
  });
});

test('uncertain execution reconciles without a second mutation', async () => {
  let executions = 0; let reconciliations = 0;
  await withWorker({
    async fetchZeroTotalCancellationFacts() { return facts; },
    async executeZeroTotalCancellation() { executions++; throw new Error('lost response'); },
    async reconcileZeroTotalCancellation() { reconciliations++; return { status: 'SUCCEEDED', operationId: 'operation-1' }; },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    await handle.signal(confirmZeroTotalCancellation, { previewId: state.preview.previewId, accepted: true });
    const result = await handle.result();
    assert.equal(result.stage, 'ORDER_CANCELLED');
    assert.deepEqual(await handle.query(getZeroTotalCancellationState), result);
    assert.equal(executions, 1);
    assert.ok(reconciliations >= 1);
  });
});

test('ineligible facts never create a preview', async () => {
  await withWorker({
    async fetchZeroTotalCancellationFacts() { return { ...facts, eligible: false }; },
    async executeZeroTotalCancellation() { assert.fail('Ineligible order must not mutate'); },
    async reconcileZeroTotalCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await handle.result();
    assert.equal(state.stage, 'NOT_ELIGIBLE');
    assert.equal(state.preview, undefined);
    assert.deepEqual(await handle.query(getZeroTotalCancellationState), state);
  });
});

test('early terminal paths publish their final query state after completion', async () => {
  let reads = 0;
  await withWorker({
    async fetchZeroTotalCancellationFacts() { reads++; throw new Error('facts unavailable'); },
    async executeZeroTotalCancellation() { assert.fail('No mutation expected'); },
    async reconcileZeroTotalCancellation() { assert.fail('No reconciliation expected'); },
  }, async (env, queue) => {
    const invalidPolicy = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`,
        args: [{ ...request, policyVersion: 'UNSUPPORTED_POLICY' } as unknown as ZeroTotalCancellationRequest] });
    const invalidPolicyResult = await invalidPolicy.result();
    assert.deepEqual(await invalidPolicy.query(getZeroTotalCancellationState), invalidPolicyResult);
    assert.equal(reads, 0);

    const unavailable = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const unavailableResult = await unavailable.result();
    assert.deepEqual(await unavailable.query(getZeroTotalCancellationState), unavailableResult);
    assert.equal(unavailableResult.stage, 'FACTS_UNAVAILABLE');
    assert.equal(reads, 3);
  });
});

test('declined and expired previews never call the cancellation mutation', async () => {
  let executions = 0;
  const activities: ZeroTotalCancellationActivities = {
    async fetchZeroTotalCancellationFacts() { return facts; },
    async executeZeroTotalCancellation() { executions++; assert.fail('Consent was not accepted'); },
    async reconcileZeroTotalCancellation() { assert.fail('No reconciliation expected'); },
  };
  await withWorker(activities, async (env, queue) => {
    const declined = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const declinedState = await waitForStage(declined, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(declinedState.preview);
    await declined.signal(confirmZeroTotalCancellation, { previewId: declinedState.preview.previewId, accepted: false });
    const declinedResult = await declined.result();
    assert.equal(declinedResult.stage, 'CUSTOMER_DECLINED');
    assert.deepEqual(await declined.query(getZeroTotalCancellationState), declinedResult);

    const expired = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const expiredState = await waitForStage(expired, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(expiredState.preview);
    await env.sleep(15 * 60_000);
    const expiredResult = await expired.result();
    assert.equal(expiredResult.stage, 'PREVIEW_EXPIRED');
    assert.deepEqual(await expired.query(getZeroTotalCancellationState), expiredResult);
    assert.equal(executions, 0);
  });
});

test('NOT_FOUND reconciliation never re-executes and completed history replays', async () => {
  let executions = 0; let reconciliations = 0;
  const workflowsPath = fileURLToPath(new URL('../src/workflows.ts', import.meta.url));
  await withWorker({
    async fetchZeroTotalCancellationFacts() { return facts; },
    async executeZeroTotalCancellation() { executions++; return { status: 'PENDING_RECONCILIATION', operationId: 'operation-1' }; },
    async reconcileZeroTotalCancellation() { return ++reconciliations === 1
      ? { status: 'NOT_FOUND' } : { status: 'SUCCEEDED', operationId: 'operation-1' }; },
  }, async (env, queue) => {
    const handle = await env.workflowClient.start(zeroTotalCancellationWorkflow,
      { taskQueue: queue, workflowId: `cancel-${crypto.randomUUID()}`, args: [request] });
    const state = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok(state.preview);
    await handle.signal(confirmZeroTotalCancellation, { previewId: state.preview.previewId, accepted: true });
    const result = await handle.result();
    assert.equal(result.stage, 'ORDER_CANCELLED');
    assert.deepEqual(await handle.query(getZeroTotalCancellationState), result);
    assert.equal(executions, 1);
    assert.equal(reconciliations, 2);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
  });
});

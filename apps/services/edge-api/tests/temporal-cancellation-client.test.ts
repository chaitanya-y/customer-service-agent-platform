import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WorkflowExecutionAlreadyStartedError, type WorkflowClient } from '@temporalio/client';

import {
  CancellationPreviewUnavailableError,
  CancellationWorkflowNotFoundError,
  createTemporalCancellationClient,
} from '../src/temporal-cancellation-client.js';

const access = {
  tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
  requestId: 'request-1', traceId: 'trace-1',
};
const input = {
  workflowId: 'zero-cancel-opaque-id', orderReference: 'TESTORDER12345678',
  policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1' as const, access,
};
const ready = {
  stage: 'AWAITING_CUSTOMER_CONFIRMATION',
  preview: {
    previewId: 'preview-1', orderId: 'order-9', orderReference: input.orderReference,
    policyVersion: input.policyVersion, providerFactsDigest: 'a'.repeat(64),
    validUntil: '2026-10-02T12:00:00.000Z',
    total: { amountMinor: 0, currency: 'USD' },
    lines: [{ id: 'line-1', quantity: 1, orderPlacedQuantity: 1 }],
  },
};

test('cancellation start uses duplicate rejection and never accepts a different owner or digest', async () => {
  let savedMemo: Record<string, unknown> | undefined;
  const client = createTemporalCancellationClient({
    client: {
      async start(name: string, options: { workflowId: string; workflowIdReusePolicy: string;
        workflowIdConflictPolicy: string; memo: Record<string, unknown>; args: unknown[] }) {
        assert.equal(name, 'zeroTotalCancellationWorkflow');
        assert.equal(options.workflowId, input.workflowId);
        assert.equal(options.workflowIdReusePolicy, 'REJECT_DUPLICATE');
        assert.equal(options.workflowIdConflictPolicy, 'FAIL');
        assert.deepEqual(options.args, [{ orderReference: input.orderReference,
          policyVersion: input.policyVersion, access }]);
        savedMemo = options.memo;
        throw new WorkflowExecutionAlreadyStartedError('existing', input.workflowId, name);
      },
      getHandle() {
        return {
          async describe() { return { memo: savedMemo }; },
          async query(name: string) { assert.equal(name, 'zero-total-cancellation.access'); return access; },
        };
      },
    } as unknown as WorkflowClient,
    taskQueue: 'test-queue',
  });
  assert.deepEqual(await client.startCancellationWorkflow(input), { workflowId: input.workflowId });
  assert.deepEqual(Object.keys(savedMemo ?? {}), ['zeroTotalCancellationStartDigest']);
  assert.equal(JSON.stringify(savedMemo).includes(input.orderReference), false);

  const changed = createTemporalCancellationClient({
    client: {
      async start() { throw new WorkflowExecutionAlreadyStartedError('existing', input.workflowId, 'zeroTotalCancellationWorkflow'); },
      getHandle() { return { async describe() { return { memo: { zeroTotalCancellationStartDigest: 'different' } }; },
        async query() { return access; } }; },
    } as unknown as WorkflowClient, taskQueue: 'test-queue',
  });
  await assert.rejects(changed.startCancellationWorkflow(input));

  const foreign = createTemporalCancellationClient({
    client: {
      async start() { throw new WorkflowExecutionAlreadyStartedError('existing', input.workflowId, 'zeroTotalCancellationWorkflow'); },
      getHandle() { return { async describe() { return { memo: savedMemo }; },
        async query() { return { ...access, subjectCustomerId: 'other-customer' }; } }; },
    } as unknown as WorkflowClient, taskQueue: 'test-queue',
  });
  await assert.rejects(foreign.startCancellationWorkflow(input), CancellationWorkflowNotFoundError);
});

test('customer state and confirmation require exact owner and current preview', async () => {
  const calls: string[] = [];
  const signals: unknown[][] = [];
  let state = ready;
  let owner = access;
  const client = createTemporalCancellationClient({
    client: {
      getHandle() {
        return {
          async query(name: string) {
            calls.push(name);
            return name === 'zero-total-cancellation.access' ? owner : state;
          },
          async signal(...args: unknown[]) { signals.push(args); },
        };
      },
    } as unknown as WorkflowClient, taskQueue: 'test-queue',
  });
  owner = { ...access, subjectCustomerId: 'other-customer' };
  await assert.rejects(client.getCancellationWorkflow({ workflowId: input.workflowId, access }), CancellationWorkflowNotFoundError);
  await assert.rejects(client.confirmCancellationWorkflow({ workflowId: input.workflowId, access, previewId: 'preview-1', accepted: true }), CancellationWorkflowNotFoundError);
  assert.equal(signals.length, 0);

  owner = access;
  assert.deepEqual(await client.getCancellationWorkflow({ workflowId: input.workflowId, access }), ready);
  await assert.rejects(client.confirmCancellationWorkflow({ workflowId: input.workflowId, access, previewId: 'stale', accepted: true }), CancellationPreviewUnavailableError);
  state = { ...ready, stage: 'ORDER_CANCELLED' };
  await assert.rejects(client.confirmCancellationWorkflow({ workflowId: input.workflowId, access, previewId: 'preview-1', accepted: true }), CancellationPreviewUnavailableError);
  assert.equal(signals.length, 0);

  state = ready;
  await client.confirmCancellationWorkflow({ workflowId: input.workflowId, access, previewId: 'preview-1', accepted: true });
  assert.deepEqual(signals, [['zero-total-cancellation.confirmation', { previewId: 'preview-1', accepted: true }]]);
  assert.ok(calls.includes('zero-total-cancellation.state'));
});

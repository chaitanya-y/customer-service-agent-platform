import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';

import { buildApp } from '../src/app.js';
import type { CommerceOrder, CommerceProvider } from '../src/commerce.js';
import { InMemoryRefundExecutionRepository } from '../src/refund-execution-repository.js';
import { createHmacWorkflowAccessAssertionVerifier, WORKFLOW_ACCESS_ASSERTION_HEADER, type RefundExecutionIntent } from '../src/workflow-access.js';
import { verifyTestContextAssertion } from './trusted-context-fixture.js';

test('refund execution is Worker-authorized and idempotent', async (context) => {
  let executions = 0;
  const provider: CommerceProvider = {
    async getOrderByReference() {
      return { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 10_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: [] }], fulfillments: [] };
    },
    async getOrderById(orderId) {
      assert.equal(orderId, '3');
      return { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 10_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: [] }], fulfillments: [] };
    },
    async executeRefund(input) {
      assert.deepEqual(input, { orderId: '3', paymentId: 'payment-1', amount: { amountMinor: 5_000, currency: 'USD' }, reason: 'DAMAGED' });
      executions += 1; return { status: 'SUCCEEDED', providerRefundId: 'refund-1' };
    },
  };
  const app = buildApp({ commerceProvider: provider, verifyContextAssertion: verifyTestContextAssertion, async verifyWorkflowRefundExecutionAssertion(value) { assert.equal(value, 'worker-write-assertion'); return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', refundExecution: authorizedExecution }; } });
  context.after(() => app.close());
  const request = { method: 'POST' as const, url: '/internal/v1/refunds', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'worker-write-assertion' }, payload: { orderId: '3', reasonCode: 'DAMAGED', amount: { amountMinor: 5_000, currency: 'USD' }, selection: { scope: 'FULL_ORDER', itemIds: [] }, previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1' } };
  const first = await app.inject(request);
  const second = await app.inject(request);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { status: 'SUCCEEDED', providerRefundId: 'refund-1' });
  assert.deepEqual(second.json(), first.json());
  assert.equal(executions, 1);
});

test('real signed execution assertions cannot change the amount or key or reserve the preview twice', async (context) => {
  let executions = 0;
  const secret = 'test-only-bound-refund-execution-secret-at-least-32-bytes';
  const now = new Date('2026-10-02T12:00:00Z');
  async function assertion(refundExecution: RefundExecutionIntent) {
    return new SignJWT({ accessVersion: '1', workflow: { workflowId: 'workflow-1' }, tenant: { tenantId: 'tenant-local', environmentId: 'local' }, subject: { customerId: 'customer-42' }, purpose: 'refund_execute', request: { requestId: 'request-1', traceId: 'trace-1' }, refundExecution })
      .setProtectedHeader({ alg: 'HS256', typ: 'cso-workflow+jwt' }).setIssuer('workers').setAudience('integration-gateway')
      .setIssuedAt(Math.floor(now.getTime() / 1_000)).setExpirationTime(Math.floor(now.getTime() / 1_000) + 60).sign(new TextEncoder().encode(secret));
  }
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference() { throw new Error('not used'); },
      async getOrderById() {
        return { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 10_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: [] }], fulfillments: [] };
      },
      async executeRefund() { executions += 1; return { status: 'SUCCEEDED', providerRefundId: 'refund-1' }; },
    },
    verifyContextAssertion: verifyTestContextAssertion,
    verifyWorkflowRefundExecutionAssertion: createHmacWorkflowAccessAssertionVerifier({ secret, expectedIssuer: 'workers', expectedAudience: 'integration-gateway', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local', expectedPurpose: 'refund_execute', now: () => now }),
  });
  context.after(() => app.close());
  const signed = await assertion(authorizedExecution);
  const request = { method: 'POST' as const, url: '/internal/v1/refunds', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: signed }, payload: authorizedExecution };
  const first = await app.inject(request);
  assert.deepEqual(first.json(), { status: 'SUCCEEDED', providerRefundId: 'refund-1' });
  for (const mutation of [{ amount: { amountMinor: 7_000, currency: 'USD' } }, { idempotencyKey: 'another-key' }]) {
    assert.equal((await app.inject({ ...request, payload: { ...authorizedExecution, ...mutation } })).statusCode, 401);
  }
  const altered = { ...authorizedExecution, idempotencyKey: 'another-key' };
  assert.equal((await app.inject({ ...request, headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: await assertion(altered) }, payload: altered })).statusCode, 409);
  // Each altered body is independently valid and signed, but is not the
  // historical intent associated with this exact workflow/preview/key.
  for (const changed of [
    { ...authorizedExecution, reasonCode: 'OTHER' },
    { ...authorizedExecution, selection: { scope: 'SELECTED_ITEMS' as const, itemIds: ['line-1'] } },
  ]) {
    const replay = await app.inject({ ...request, headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: await assertion(changed) }, payload: changed });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, 'refund_execution_conflict');
  }
  assert.deepEqual((await app.inject(request)).json(), first.json());
  assert.equal(executions, 1);
});

test('an exact retry returns its durable outcome after provider balance is exhausted', async (context) => {
  let executions = 0;
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference() { throw new Error('not used'); },
      async getOrderById() {
        return { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 5_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 5_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: executions ? [{ id: 'refund-1', status: 'Settled', amount: { amountMinor: 5_000, currency: 'USD' }, lineIds: [] }] : [] }], fulfillments: [] };
      },
      async executeRefund() { executions += 1; return { status: 'SUCCEEDED', providerRefundId: 'refund-1' }; },
    },
    verifyContextAssertion: verifyTestContextAssertion,
    async verifyWorkflowRefundExecutionAssertion() {
      return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', refundExecution: authorizedExecution };
    },
  });
  context.after(() => app.close());
  const request = { method: 'POST' as const, url: '/internal/v1/refunds', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'synthetic-bound-assertion' }, payload: authorizedExecution };
  assert.deepEqual((await app.inject(request)).json(), { status: 'SUCCEEDED', providerRefundId: 'refund-1' });
  assert.deepEqual((await app.inject(request)).json(), { status: 'SUCCEEDED', providerRefundId: 'refund-1' });
  assert.equal(executions, 1);
});

const authorizedExecution: RefundExecutionIntent = { orderId: '3', reasonCode: 'DAMAGED', amount: { amountMinor: 5_000, currency: 'USD' }, selection: { scope: 'FULL_ORDER', itemIds: [] }, previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1' };

test('refund execution rejects changes to the exact signed execution intent before provider access', async (context) => {
  let orderReads = 0;
  let executions = 0;
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference() { throw new Error('not used'); },
      async getOrderById() { orderReads += 1; return undefined; },
      async executeRefund() { executions += 1; return { status: 'SUCCEEDED' }; },
    },
    verifyContextAssertion: verifyTestContextAssertion,
    async verifyWorkflowRefundExecutionAssertion() {
      return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', refundExecution: authorizedExecution };
    },
  });
  context.after(() => app.close());
  for (const mutation of [
    { amount: { amountMinor: 7_000, currency: 'USD' } },
    { idempotencyKey: 'another-key' },
    { orderId: 'other-order' },
    { previewId: 'other-preview' },
    { reasonCode: 'OTHER' },
    { selection: { scope: 'SELECTED_ITEMS', itemIds: ['item-1'] } },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/internal/v1/refunds', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'synthetic-bound-assertion' }, payload: { ...authorizedExecution, ...mutation } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'workflow_unauthorized');
  }
  assert.equal(orderReads, 0);
  assert.equal(executions, 0);
});

for (const selection of [
  { scope: 'SELECTED_ITEMS', itemIds: [] },
  { scope: 'SELECTED_ITEMS', itemIds: ['line-1', 'line-1'] },
  { scope: 'FULL_ORDER', itemIds: ['line-1'] },
]) {
  test(`refund execution rejects malformed selection ${JSON.stringify(selection)} before provider access`, async (context) => {
    let orderReads = 0;
    let executions = 0;
    const app = buildApp({
      commerceProvider: {
        async getOrderByReference() { throw new Error('not used'); },
        async getOrderById() { orderReads += 1; return undefined; },
        async executeRefund() { executions += 1; return { status: 'SUCCEEDED' }; },
      },
      verifyContextAssertion: verifyTestContextAssertion,
      async verifyWorkflowRefundExecutionAssertion() { throw new Error('invalid requests must not reach authorization'); },
    });
    context.after(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/internal/v1/refunds', payload: { ...authorizedExecution, selection } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_refund_execution_request');
    assert.equal(orderReads, 0);
    assert.equal(executions, 0);
  });
}

const selectedOrder: CommerceOrder = {
  source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false,
  placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' },
  total: { amountMinor: 10_000, currency: 'USD' },
  items: ['line-1', 'line-2'].map((id) => ({ id, sku: id, name: 'Item', quantity: 1,
    unitPrice: { amountMinor: 5_000, currency: 'USD' }, lineTotal: { amountMinor: 5_000, currency: 'USD' } })),
  payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' },
    method: 'card', transactionReference: null, refunds: [] }], fulfillments: [],
};

test('two distinct selected-item workflows reading the same facts cannot both dispatch', async (context) => {
  let reads = 0;
  let executions = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
  const intents: RefundExecutionIntent[] = ['1', '2'].map((id) => ({ ...authorizedExecution,
    selection: { scope: 'SELECTED_ITEMS', itemIds: ['line-1'] }, previewId: `preview-${id}`, idempotencyKey: `refund:workflow-${id}:preview-${id}` }));
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference() { throw new Error('not used'); },
      async getOrderById() { reads += 1; if (reads === 2) releaseReads(); if (reads <= 2) await bothRead; return structuredClone(selectedOrder); },
      async executeRefund() { executions += 1; return { status: 'SUCCEEDED', providerRefundId: 'refund-1' }; },
    },
    verifyContextAssertion: verifyTestContextAssertion,
    async verifyWorkflowRefundExecutionAssertion(value) {
      const index = value === 'workflow-1' ? 0 : 1;
      return { contextId: `workflow-${index + 1}`, tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
        routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', refundExecution: intents[index]! };
    },
  });
  context.after(() => app.close());
  const responses = await Promise.all(intents.map((intent, index) => app.inject({ method: 'POST', url: '/internal/v1/refunds',
    headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: `workflow-${index + 1}` }, payload: intent })));
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal(executions, 1);
});

test('eligibility is rechecked after the durable order claim rather than using the earlier snapshot', async (context) => {
  let reads = 0;
  let executions = 0;
  const intent: RefundExecutionIntent = { ...authorizedExecution, selection: { scope: 'SELECTED_ITEMS', itemIds: ['line-1'] } };
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference() { throw new Error('not used'); },
      async getOrderById() {
        reads += 1;
        return reads === 1 ? structuredClone(selectedOrder) : { ...selectedOrder, payments: [{ ...selectedOrder.payments[0]!,
          refunds: [{ id: 'external-refund', status: 'Settled', amount: { amountMinor: 5_000, currency: 'USD' }, lineIds: [] }] }] };
      },
      async executeRefund() { executions += 1; return { status: 'SUCCEEDED' }; },
    }, verifyContextAssertion: verifyTestContextAssertion,
    async verifyWorkflowRefundExecutionAssertion() {
      return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
        routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', refundExecution: intent };
    },
  });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/internal/v1/refunds',
    headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'synthetic-bound-assertion' }, payload: intent });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'refund_no_longer_eligible');
  assert.equal(reads, 2);
  assert.equal(executions, 0);
});

for (const failure of ['provider-outcome-unknown', 'claimed-read-unavailable', 'reserved-before-dispatch'] as const) {
  test(`an unresolved order claim after ${failure} cannot dispatch another workflow or replay blindly`, async (context) => {
    const repository = new InMemoryRefundExecutionRepository();
    let reads = 0;
    let executions = 0;
    if (failure === 'reserved-before-dispatch') await repository.reserve({ tenantId: 'tenant-local', environmentId: 'local',
      workflowId: 'workflow-1', previewId: authorizedExecution.previewId, idempotencyKey: authorizedExecution.idempotencyKey,
      orderId: '3', amountMinor: 5_000, currency: 'USD', selection: authorizedExecution.selection, reasonCode: authorizedExecution.reasonCode, occurredAt: '2026-10-02T12:00:00Z' });
    const otherIntent: RefundExecutionIntent = { ...authorizedExecution, previewId: 'preview-2', idempotencyKey: 'refund:workflow-2:preview-2' };
    const app = buildApp({
      refundExecutionRepository: repository,
      commerceProvider: {
        async getOrderByReference() { throw new Error('not used'); },
        async getOrderById() { reads += 1; if (failure === 'claimed-read-unavailable' && reads === 2) throw new Error('synthetic read timeout'); return structuredClone(selectedOrder); },
        async executeRefund() { executions += 1; throw new Error('synthetic provider response lost'); },
      }, verifyContextAssertion: verifyTestContextAssertion,
      async verifyWorkflowRefundExecutionAssertion(value) {
        return { contextId: value === 'workflow-2' ? 'workflow-2' : 'workflow-1', tenantId: 'tenant-local', environmentId: 'local',
          subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1',
          refundExecution: value === 'workflow-2' ? otherIntent : authorizedExecution };
      },
    });
    context.after(() => app.close());
    const request = { method: 'POST' as const, url: '/internal/v1/refunds',
      headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'workflow-1' }, payload: authorizedExecution };
    assert.deepEqual((await app.inject(request)).json(), { status: 'PENDING_RECONCILIATION' });
    assert.deepEqual((await app.inject(request)).json(), { status: 'PENDING_RECONCILIATION' });
    const other = await app.inject({ ...request, headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'workflow-2' }, payload: otherIntent });
    assert.equal(other.statusCode, 409);
    assert.equal(other.json().error.code, 'refund_execution_conflict');
    assert.equal(executions, failure === 'provider-outcome-unknown' ? 1 : 0);
  });
}

for (const lineIds of [[], ['unknown-line'], ['line-2', 'unknown-line']]) {
  test(`new selected-item execution blocks ambiguous prior attribution ${JSON.stringify(lineIds)}`, async (context) => {
    let executions = 0;
    const intent: RefundExecutionIntent = { ...authorizedExecution, selection: { scope: 'SELECTED_ITEMS', itemIds: ['line-1'] } };
    const app = buildApp({
      commerceProvider: {
        async getOrderByReference() { throw new Error('not used'); },
        async getOrderById() {
          return { ...selectedOrder, payments: [{ ...selectedOrder.payments[0], refunds: [{
            id: 'prior-refund', status: 'Settled', amount: { amountMinor: 5_000, currency: 'USD' }, lineIds,
          }] }] };
        },
        async executeRefund() { executions += 1; return { status: 'SUCCEEDED' }; },
      },
      verifyContextAssertion: verifyTestContextAssertion,
      async verifyWorkflowRefundExecutionAssertion() {
        return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
          routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', refundExecution: intent };
      },
    });
    context.after(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/internal/v1/refunds',
      headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'synthetic-bound-assertion' }, payload: intent });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'refund_no_longer_eligible');
    assert.equal(executions, 0);
  });
}

for (const [name, payment] of [
  ['mismatched payment currency', { ...selectedOrder.payments[0], amount: { amountMinor: 10_000, currency: 'EUR' } }],
  ['negative prior refund', { ...selectedOrder.payments[0], refunds: [{
    id: 'invalid-prior-refund', status: 'Settled', amount: { amountMinor: -5_000, currency: 'USD' }, lineIds: [],
  }] }],
] as const) {
  test(`refund execution makes no provider call for ${name}`, async (context) => {
    let executions = 0;
    const app = buildApp({
      commerceProvider: {
        async getOrderByReference() { throw new Error('not used'); },
        async getOrderById() { return { ...selectedOrder, payments: [payment] }; },
        async executeRefund() { executions += 1; return { status: 'SUCCEEDED' }; },
      },
      verifyContextAssertion: verifyTestContextAssertion,
      async verifyWorkflowRefundExecutionAssertion() {
        return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42',
          routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1', refundExecution: authorizedExecution };
      },
    });
    context.after(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/internal/v1/refunds',
      headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'synthetic-bound-assertion' }, payload: authorizedExecution });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'refund_no_longer_eligible');
    assert.equal(executions, 0);
  });
}

test('signed distinct selected-item execution blocks after an amount-only refund while exact replay stays unchanged', async (context) => {
  let executions = 0;
  const secret = 'test-only-selected-refund-execution-secret-at-least-32-bytes';
  const now = new Date('2026-10-02T12:00:00Z');
  async function assertion(workflowId: string, refundExecution: RefundExecutionIntent) {
    return new SignJWT({ accessVersion: '1', workflow: { workflowId }, tenant: { tenantId: 'tenant-local', environmentId: 'local' },
      subject: { customerId: 'customer-42' }, purpose: 'refund_execute', request: { requestId: 'request-1', traceId: 'trace-1' }, refundExecution })
      .setProtectedHeader({ alg: 'HS256', typ: 'cso-workflow+jwt' }).setIssuer('workers').setAudience('integration-gateway')
      .setIssuedAt(Math.floor(now.getTime() / 1_000)).setExpirationTime(Math.floor(now.getTime() / 1_000) + 60)
      .sign(new TextEncoder().encode(secret));
  }
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference() { throw new Error('not used'); },
      async getOrderById() {
        return { ...selectedOrder, payments: [{ ...selectedOrder.payments[0], refunds: executions ? [{
          id: 'refund-1', status: 'Settled', amount: { amountMinor: 5_000, currency: 'USD' }, lineIds: [],
        }] : [] }] };
      },
      async executeRefund(input) {
        assert.deepEqual(input, { orderId: '3', paymentId: 'payment-1', amount: { amountMinor: 5_000, currency: 'USD' }, reason: 'DAMAGED' });
        executions += 1; return { status: 'SUCCEEDED', providerRefundId: 'refund-1' };
      },
    },
    verifyContextAssertion: verifyTestContextAssertion,
    verifyWorkflowRefundExecutionAssertion: createHmacWorkflowAccessAssertionVerifier({ secret, expectedIssuer: 'workers',
      expectedAudience: 'integration-gateway', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
      expectedPurpose: 'refund_execute', now: () => now }),
  });
  context.after(() => app.close());
  const firstIntent: RefundExecutionIntent = { ...authorizedExecution, selection: { scope: 'SELECTED_ITEMS', itemIds: ['line-1'] } };
  const firstRequest = { method: 'POST' as const, url: '/internal/v1/refunds',
    headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: await assertion('workflow-1', firstIntent) }, payload: firstIntent };
  const first = await app.inject(firstRequest);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { status: 'SUCCEEDED', providerRefundId: 'refund-1' });
  const replay = await app.inject(firstRequest);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());
  const secondIntent: RefundExecutionIntent = { ...firstIntent, selection: { scope: 'SELECTED_ITEMS', itemIds: ['line-2'] },
    previewId: 'preview-2', idempotencyKey: 'refund:workflow-2:preview-2' };
  const second = await app.inject({ method: 'POST', url: '/internal/v1/refunds',
    headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: await assertion('workflow-2', secondIntent) }, payload: secondIntent });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, 'refund_execution_conflict');
  assert.equal(executions, 1);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildApp } from '../src/app.js';

const conversationId = '019c321e-8650-7000-8000-000000000001';
const identity = {
  principalId: 'customer-2', customerId: 'customer-2',
  tenantId: 'tenant-local', environmentId: 'local',
};
const report = {
  report_id: 'delivery-report-1', status: 'RECEIVED' as const,
  category: 'DAMAGED' as const, order_reference: 'ORDER1234',
  created_at: '2026-10-02T12:00:00.000Z',
  updated_at: '2026-10-02T12:00:00.000Z',
};

function baseOptions() {
  return {
    verifyCustomerIdentity: async () => identity,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signDeliveryReportAssertion: async () => 'delivery-report-assertion',
    getConversation: async () => ({ statusCode: 200, body: { data: {
      conversationId, status: 'OPEN', controlMode: 'AI', messages: [],
    } } }),
    intakeRefund: async () => { throw new Error('refund intake must not run'); },
    startRefundWorkflow: async () => { throw new Error('refund workflow must not run'); },
    deliveryReportClient: {
      verifyOwnedOrder: async () => 'owned' as const,
      createReport: async () => ({ kind: 'created' as const, report }),
      replayReport: async () => ({ kind: 'found' as const, report }),
      listReports: async () => ({ kind: 'found' as const, history: { delivery_issue_reports: [report], has_more: false } }),
      getReport: async () => ({ kind: 'found' as const, report }),
    },
  };
}

test('unauthenticated delivery report cannot reveal whether an order exists', async (context) => {
  const app = buildApp({
    ...baseOptions(),
    verifyCustomerIdentity: async () => { throw new Error('unauthorized'); },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports`,
    headers: { 'idempotency-key': 'delivery-1' },
    payload: { order_reference: 'ORDER1234', category: 'DAMAGED' },
  });
  assert.equal(response.statusCode, 401);
});

test('customer list requires authentication and rejects query or body before service access', async (context) => {
  let listCalls = 0;
  const app = buildApp({ ...baseOptions(),
    verifyCustomerIdentity: async (token) => { if (token !== 'valid') throw new Error('unauthorized'); return identity; },
    deliveryReportClient: { ...baseOptions().deliveryReportClient,
      listReports: async () => { listCalls += 1; return { kind: 'found' as const,
        history: { delivery_issue_reports: [report], has_more: false } }; } },
  });
  context.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/v1/delivery-issue-reports' })).statusCode, 401);
  for (const input of [
    { method: 'GET' as const, url: '/v1/delivery-issue-reports?customerId=other', headers: { authorization: 'Bearer valid' } },
    { method: 'GET' as const, url: '/v1/delivery-issue-reports', headers: { authorization: 'Bearer valid', 'content-length': '2' }, payload: '{}' },
  ]) {
    const response = await app.inject(input);
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  assert.equal(listCalls, 0);
});

test('customer list signs owner-only assertion and never accesses Gateway, model, or writes', async (context) => {
  const events: string[] = [];
  const history = { delivery_issue_reports: [report], has_more: false };
  const app = buildApp({ ...baseOptions(),
    signContextAssertion: async () => { throw new Error('Gateway must not run'); },
    signDeliveryReportAssertion: async (input) => {
      events.push('sign');
      assert.deepEqual(input, { purpose: 'delivery_issue_report_list', identity, requestId: input.requestId });
      return 'list-assertion';
    },
    deliveryReportClient: { ...baseOptions().deliveryReportClient,
      verifyOwnedOrder: async () => { throw new Error('Gateway must not run'); },
      createReport: async () => { throw new Error('create must not run'); },
      replayReport: async () => { throw new Error('replay must not run'); },
      listReports: async (assertion) => { events.push('list'); assert.equal(assertion, 'list-assertion');
        return { kind: 'found' as const, history }; },
    },
  });
  context.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/delivery-issue-reports',
    headers: { authorization: 'Bearer token' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json(), history);
  assert.deepEqual(events, ['sign', 'list']);
});

test('closed owned conversation replays exact scoped key without Gateway or create calls', async (context) => {
  const events: string[] = [];
  const expectedScopedKey = createHash('sha256').update(JSON.stringify([
    'delivery-report-create-v1', identity.tenantId, identity.environmentId,
    identity.customerId, conversationId, 'delivery-retry-1',
  ])).digest('hex');
  const app = buildApp({
    ...baseOptions(),
    getConversation: async () => { events.push('conversation'); return { statusCode: 200,
      body: { data: { conversationId, status: 'CLOSED' } } }; },
    signContextAssertion: async () => { throw new Error('Gateway must not run'); },
    signDeliveryReportAssertion: async (input) => {
      events.push('sign');
      assert.deepEqual(input, {
        purpose: 'delivery_issue_report_replay', identity, conversationId,
        orderReference: 'ORDER1234', category: 'DAMAGED',
        idempotencyKey: expectedScopedKey, requestId: input.requestId,
      });
      return 'replay-assertion';
    },
    deliveryReportClient: {
      ...baseOptions().deliveryReportClient,
      verifyOwnedOrder: async () => { throw new Error('Gateway must not run'); },
      createReport: async () => { throw new Error('create must not run'); },
      replayReport: async (input) => {
        events.push('replay');
        assert.deepEqual(input.body, { order_reference: 'ORDER1234', category: 'DAMAGED' });
        assert.equal(input.idempotencyKey, expectedScopedKey);
        assert.equal(input.assertion, 'replay-assertion');
        return { kind: 'found' as const, report: { ...report, status: 'ACKNOWLEDGED' as const } };
      },
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports/replay`,
    headers: { authorization: 'Bearer token', 'idempotency-key': 'delivery-retry-1' },
    payload: { order_reference: 'ORDER1234', category: 'DAMAGED' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.json().delivery_issue_report.status, 'ACKNOWLEDGED');
  assert.deepEqual(events, ['conversation', 'sign', 'replay']);
});

test('replay masks missing conversation and never consults Human Operations', async (context) => {
  let replayCalls = 0;
  const app = buildApp({ ...baseOptions(),
    getConversation: async () => ({ statusCode: 404, body: {} }),
    deliveryReportClient: { ...baseOptions().deliveryReportClient,
      replayReport: async () => { replayCalls += 1; return { kind: 'found' as const, report }; } },
  });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST',
    url: `/v1/conversations/${conversationId}/delivery-issue-reports/replay`,
    headers: { authorization: 'Bearer token', 'idempotency-key': 'delivery-retry-1' },
    payload: { order_reference: 'ORDER1234', category: 'DAMAGED' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(replayCalls, 0);
});

test('replay rejects malformed request and distinguishes missing, conflict and unavailable receipts', async (context) => {
  let result: { kind: 'not_found' | 'conflict' | 'unavailable' } = { kind: 'not_found' };
  const app = buildApp({ ...baseOptions(), deliveryReportClient: {
    ...baseOptions().deliveryReportClient, replayReport: async () => result,
  } });
  context.after(() => app.close());
  const request = (payload: unknown, headers = { authorization: 'Bearer token', 'idempotency-key': 'delivery-retry-1' }) => app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports/replay`, headers, payload,
  });
  assert.equal((await request({ order_reference: 'ORDER1234', category: 'DAMAGED', extra: true })).statusCode, 400);
  assert.equal((await request({ order_reference: 'ORDER1234', category: 'DAMAGED' },
    { authorization: 'Bearer token', 'idempotency-key': 'bad' })).statusCode, 400);
  for (const [kind, status] of [['not_found', 404], ['conflict', 409], ['unavailable', 503]] as const) {
    result = { kind };
    const response = await request({ order_reference: 'ORDER1234', category: 'DAMAGED' });
    assert.equal(response.statusCode, status);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
});

test('owned delivery issue creates only a safe durable report, not a refund', async (context) => {
  const events: string[] = [];
  const app = buildApp({
    ...baseOptions(),
    getConversation: async () => { events.push('conversation'); return {
      statusCode: 200, body: { data: { conversationId, status: 'OPEN', controlMode: 'AI', messages: [] } },
    }; },
    deliveryReportClient: {
      verifyOwnedOrder: async (reference, assertion) => {
        events.push('ownership'); assert.equal(reference, 'ORDER1234');
        assert.equal(assertion, 'gateway-context'); return 'owned' as const;
      },
      createReport: async (input) => {
        events.push('create');
        assert.deepEqual(input.body, { order_reference: 'ORDER1234', category: 'DAMAGED' });
        assert.equal(input.assertion, 'delivery-report-assertion');
        assert.ok(input.idempotencyKey.length >= 8);
        return { kind: 'created' as const, report };
      },
      getReport: async () => ({ kind: 'found' as const, report }),
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports`,
    headers: { authorization: 'Bearer token', 'idempotency-key': 'delivery-1' },
    payload: { order_reference: 'ORDER1234', category: 'DAMAGED' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json(), { delivery_issue_report: report });
  assert.deepEqual(events, ['conversation', 'ownership', 'create']);
});

test('missing or foreign order cannot create a delivery report', async (context) => {
  let createCalls = 0;
  const app = buildApp({
    ...baseOptions(),
    deliveryReportClient: {
      verifyOwnedOrder: async () => 'not_found' as const,
      createReport: async () => { createCalls += 1; return { kind: 'created' as const, report }; },
      getReport: async () => ({ kind: 'found' as const, report }),
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports`,
    headers: { authorization: 'Bearer token', 'idempotency-key': 'delivery-2' },
    payload: { order_reference: 'ORDER1234', category: 'DAMAGED' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(createCalls, 0);
});

test('uncertain create does not claim that the report was received', async (context) => {
  const app = buildApp({
    ...baseOptions(),
    deliveryReportClient: {
      verifyOwnedOrder: async () => 'owned' as const,
      createReport: async () => ({ kind: 'unconfirmed' as const }),
      getReport: async () => ({ kind: 'unavailable' as const }),
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports`,
    headers: { authorization: 'Bearer token', 'idempotency-key': 'delivery-3' },
    payload: { order_reference: 'ORDER1234', category: 'DAMAGED' },
  });
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error.message, /not confirmed/i);
});

test('conversation service failure does not falsely describe an unattempted create', async (context) => {
  let createCalls = 0;
  const app = buildApp({
    ...baseOptions(),
    getConversation: async () => { throw new Error('conversation service down'); },
    deliveryReportClient: {
      verifyOwnedOrder: async () => 'owned' as const,
      createReport: async () => { createCalls += 1; return { kind: 'created' as const, report }; },
      getReport: async () => ({ kind: 'found' as const, report }),
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports`,
    headers: { authorization: 'Bearer token', 'idempotency-key': 'delivery-4' },
    payload: { order_reference: 'ORDER1234', category: 'DAMAGED' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'delivery_report_unavailable');
  assert.equal(createCalls, 0);
});

test('foreign conversation cannot be used to create a delivery report', async (context) => {
  let ownershipCalls = 0;
  const app = buildApp({
    ...baseOptions(),
    getConversation: async () => ({ statusCode: 404, body: {} }),
    deliveryReportClient: {
      verifyOwnedOrder: async () => { ownershipCalls += 1; return 'owned' as const; },
      createReport: async () => ({ kind: 'created' as const, report }),
      getReport: async () => ({ kind: 'found' as const, report }),
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports`,
    headers: { authorization: 'Bearer token', 'idempotency-key': 'delivery-5' },
    payload: { order_reference: 'ORDER1234', category: 'DAMAGED' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(ownershipCalls, 0);
});

test('accepts the Gateway contract order-reference characters throughout delivery create', async (context) => {
  const reference = 'ORDER.REF_1:WEST';
  const app = buildApp({
    ...baseOptions(),
    deliveryReportClient: {
      verifyOwnedOrder: async (given) => given === reference ? 'owned' as const : 'not_found' as const,
      createReport: async (input) => ({ kind: 'created' as const, report: {
        ...report, order_reference: input.body.order_reference,
      } }),
      getReport: async () => ({ kind: 'found' as const, report }),
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/delivery-issue-reports`,
    headers: { authorization: 'Bearer token', 'idempotency-key': 'delivery-broad-ref' },
    payload: { order_reference: reference, category: 'DELAYED' },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().delivery_issue_report.order_reference, reference);
});

test('customer can read an owned delivery report without staff data', async (context) => {
  const app = buildApp(baseOptions());
  context.after(() => app.close());
  const response = await app.inject({
    method: 'GET', url: '/v1/delivery-issue-reports/delivery-report-1',
    headers: { authorization: 'Bearer token' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json(), { delivery_issue_report: report });
});

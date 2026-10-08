import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';

const conversationId = '019c321e-8650-7000-8000-000000000001';
const identity = {
  principalId: 'customer-42', customerId: 'customer-42',
  tenantId: 'tenant-local', environmentId: 'local',
};
const customerMessage = { data: {
  conversationId, messageId: '019c321e-8650-7000-8000-000000000002',
  sequenceNumber: 1, status: 'ACCEPTED',
} };
const queued = { data: {
  conversationId, status: 'OPEN', controlMode: 'QUEUED', controlVersion: 2,
  handoffSessionId: '019c321e-8650-7000-8000-000000000003', messages: [{
    messageId: customerMessage.data.messageId, sequenceNumber: 1,
    senderKind: 'END_CUSTOMER', text: 'I need a person',
    createdAt: '2026-10-02T00:00:00.000Z',
  }],
} };

function baseOptions() {
  return {
    verifyCustomerIdentity: async () => identity,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    intakeRefund: async () => { throw new Error('refund must not run'); },
    intakeSupport: async () => { throw new Error('model must not run'); },
    getConversation: async () => ({ statusCode: 200, body: queued }),
    acceptCustomerMessage: async () => ({ statusCode: 202, body: customerMessage }),
    appendAssistantMessage: async () => { throw new Error('assistant must not commit'); },
  };
}

test('disabled handoff does not queue a customer when no staffed support path is configured', async (context) => {
  const app = buildApp(baseOptions());
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/handoff`,
    headers: { authorization: 'Bearer customer-token', 'idempotency-key': 'handoff-disabled-1' },
    payload: { expected_control_version: 1 },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'handoff_unavailable');
});

test('explicit human handoff is authenticated and idempotent without a model or refund', async (context) => {
  const requests: unknown[] = [];
  const app = buildApp({
    ...baseOptions(),
    verifyCustomerIdentity: async (token) => {
      if (!token) throw new Error('unauthorized');
      return identity;
    },
    requestHumanHandoff: async (input: unknown) => {
      requests.push(input);
      return { statusCode: 200, body: { data: {
        conversationId, status: 'OPEN', controlMode: 'QUEUED', controlVersion: 2,
        handoffSessionId: queued.data.handoffSessionId,
      } } };
    },
  });
  context.after(() => app.close());
  const payload = { expected_control_version: 1 };
  const unauthorized = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/handoff`,
    headers: { 'idempotency-key': 'handoff-1' }, payload,
  });
  assert.equal(unauthorized.statusCode, 401);
  const accepted = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/handoff`,
    headers: { authorization: 'Bearer customer-token', 'idempotency-key': 'handoff-1' }, payload,
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers['cache-control'], 'private, no-store');
  assert.deepEqual(accepted.json(), {
    conversation_id: conversationId, status: 'OPEN', control_mode: 'QUEUED',
    control_version: 2, handoff_session_id: queued.data.handoffSessionId,
  });
  assert.equal(requests.length, 1);
  const request = requests[0] as Record<string, unknown>;
  assert.equal(request.conversationId, conversationId);
  assert.equal(request.contextAssertion, 'conversation-context');
  assert.equal(request.expectedControlVersion, 1);
  assert.match(String(request.idempotencyKey), /^cso-[a-f0-9]{64}$/);
});

test('customer messages persist in queued mode without invoking the model', async (context) => {
  let accepted = 0;
  const app = buildApp({
    ...baseOptions(),
    acceptCustomerMessage: async () => { accepted += 1; return { statusCode: 202, body: {
      data: { ...customerMessage.data, controlMode: 'QUEUED', controlVersion: 2 },
    } }; },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/messages`,
    headers: { authorization: 'Bearer customer-token', 'idempotency-key': 'customer-queued-1' },
    payload: { client_message_id: 'customer-queued-1', content: { type: 'text', text: 'I need a person' } },
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(accepted, 1);
  assert.equal(response.json().control_mode, 'QUEUED');
  assert.equal(response.json().assistant_message, undefined);
  assert.equal(response.json().refund_workflow, undefined);
});

test('an in-flight assistant denied after handoff cannot start a refund workflow', async (context) => {
  let reads = 0;
  let workflowStarts = 0;
  const app = buildApp({
    ...baseOptions(),
    getRefundStart: async () => ({ statusCode: 404, body: { error: { code: 'REFUND_START_NOT_FOUND' } } }),
    getConversation: async () => {
      reads += 1;
      return { statusCode: 200, body: reads === 1 ? { data: {
        ...queued.data, controlMode: 'AI', controlVersion: 1,
        messages: [{ ...queued.data.messages[0], text: 'I need a refund' }],
      } } : queued };
    },
    intakeSupport: async () => ({ statusCode: 200, body: {
      journey: 'refund', status: 'refund_proposal_ready',
      customer_message: 'I need a refund', order_reference: 'ORDER-1',
      customer_answer: { message: 'Please review the refund proposal.' },
      refund_proposal: {
        proposalId: 'proposal-1', journeyType: 'REFUND', missingFields: [],
        intent: { orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'FULL_ORDER',
          itemIds: [], requestedAmount: { amountMinor: 100, currency: 'USD' } },
      },
    } }),
    appendAssistantMessage: async () => ({ statusCode: 409, body: { error: { code: 'conversation_control_changed' } } }),
    startRefundWorkflow: async () => { workflowStarts += 1; return { workflowId: 'refund-proposal-1' }; },
    linkRefundWorkflow: async () => { throw new Error('must not link refund'); },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/messages`,
    headers: { authorization: 'Bearer customer-token', 'idempotency-key': 'customer-race-1' },
    payload: { client_message_id: 'customer-race-1', content: { type: 'text', text: 'I need a refund' } },
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().control_mode, 'QUEUED');
  assert.equal(response.json().assistant_message, undefined);
  assert.equal(workflowStarts, 0);
});

test('ready refund start is reserved with the assistant commit before Temporal starts', async (context) => {
  const events: string[] = [];
  const app = buildApp({
    ...baseOptions(),
    getRefundStart: async () => ({ statusCode: 404, body: { error: { code: 'REFUND_START_NOT_FOUND' } } }),
    getConversation: async () => ({ statusCode: 200, body: { data: {
      ...queued.data, controlMode: 'AI', controlVersion: 1,
      messages: [{ ...queued.data.messages[0], text: 'Please refund my damaged order ORDER-1.' }],
    } } }),
    intakeSupport: async () => ({ statusCode: 200, body: {
      journey: 'refund', status: 'refund_proposal_ready',
      customer_message: 'Please refund my damaged order ORDER-1.', order_reference: 'ORDER-1',
      customer_answer: { message: 'Please review the refund proposal.' },
      refund_proposal: {
        proposalId: 'proposal-1', journeyType: 'REFUND', missingFields: [],
        intent: { orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'FULL_ORDER',
          itemIds: [], requestedAmount: { amountMinor: 100, currency: 'USD' } },
      },
    } }),
    appendAssistantMessage: async (input) => {
      events.push('reserve');
      assert.equal(input.expectedControlVersion, 1);
      assert.equal(input.refundWorkflowId, 'refund-proposal-1');
      return { statusCode: 202, body: { data: {
        conversationId, messageId: 'assistant-1', sequenceNumber: 2, status: 'ACCEPTED',
        refundStart: { workflowId: 'refund-proposal-1', status: 'PENDING', startInput: input.refundStartInput },
      } } };
    },
    startRefundWorkflow: async (input) => {
      events.push('start');
      assert.equal(input.workflowId, 'refund-proposal-1');
      return { workflowId: input.workflowId };
    },
    linkRefundWorkflow: async (input) => {
      events.push('link');
      assert.equal(input.workflowId, 'refund-proposal-1');
      return { statusCode: 200, body: { data: { workflowId: input.workflowId } } };
    },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/messages`,
    headers: { authorization: 'Bearer customer-token', 'idempotency-key': 'customer-refund-1' },
    payload: { client_message_id: 'customer-refund-1',
      content: { type: 'text', text: 'Please refund my damaged order ORDER-1.' } },
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(events, ['reserve', 'start', 'link']);
  assert.equal(response.json().refund_workflow.workflow_id, 'refund-proposal-1');
});

test('a retry after handoff starts only the encrypted reservation intent and never reruns the agent', async (context) => {
  const events: string[] = [];
  const storedInput = {
    workflowId: 'refund-original', proposal: { proposalId: 'original', journeyType: 'REFUND' as const,
      intent: { orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'FULL_ORDER' as const,
        itemIds: [], requestedAmount: { amountMinor: 100, currency: 'USD' } } },
    policyVersion: 'refund-policy-v1', access: { tenantId: 'tenant-local', environmentId: 'local',
      subjectCustomerId: 'customer-42', requestId: 'original-request', traceId: 'original-trace' },
  };
  const app = buildApp({
    ...baseOptions(),
    now: () => new Date('2026-10-02T12:30:00.000Z'),
    getRefundStart: async () => { events.push('lookup'); return { statusCode: 200, body: { data: {
      workflowId: storedInput.workflowId, status: 'PENDING', assistantMessageId: 'assistant-original', startInput: storedInput,
      createdAt: '2026-10-02T12:00:00.000Z',
    } } }; },
    startRefundWorkflow: async (input) => { events.push('start'); assert.deepEqual(input, storedInput); return { workflowId: input.workflowId }; },
    linkRefundWorkflow: async (input) => { events.push('link'); assert.equal(input.messageId, 'assistant-original'); return { statusCode: 200, body: { data: { workflowId: input.workflowId } } }; },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/messages`,
    headers: { authorization: 'Bearer customer-token', 'idempotency-key': 'retry-1' },
    payload: { client_message_id: 'original-client-message', content: { type: 'text', text: 'I need a refund' } },
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(events, ['lookup', 'start', 'link']);
  assert.equal(response.json().refund_workflow.workflow_id, 'refund-original');
});

test('a reservation older than the safe Temporal retention margin is not restarted', async (context) => {
  let starts = 0;
  const app = buildApp({ ...baseOptions(), now: () => new Date('2026-10-02T12:00:00.000Z'),
    getRefundStart: async () => ({ statusCode: 200, body: { data: {
      workflowId: 'refund-old', status: 'PENDING', assistantMessageId: 'assistant-old',
      createdAt: '2026-10-02T10:00:00.000Z', startInput: {
        workflowId: 'refund-old', proposal: { proposalId: 'old', journeyType: 'REFUND', intent: {
          orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'FULL_ORDER', itemIds: [],
          requestedAmount: { amountMinor: 100, currency: 'USD' },
        } }, policyVersion: 'v1', access: { tenantId: 'tenant-local', environmentId: 'local',
          subjectCustomerId: 'customer-42', requestId: 'r1', traceId: 't1' },
      },
    } } }),
    startRefundWorkflow: async () => { starts += 1; return { workflowId: 'refund-old' }; },
    linkRefundWorkflow: async () => { throw new Error('must not link'); },
  });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/messages`,
    headers: { authorization: 'Bearer customer-token', 'idempotency-key': 'old-retry' },
    payload: { client_message_id: 'old-client', content: { type: 'text', text: 'I need a refund' } } });
  assert.equal(response.statusCode, 502);
  assert.equal(starts, 0);
});

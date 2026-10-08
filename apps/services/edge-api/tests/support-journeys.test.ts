import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';

const conversationId = '019c321e-8650-7000-8000-000000000001';
const identity = {
  principalId: 'customer-42',
  tenantId: 'tenant-local',
  environmentId: 'local',
  customerId: 'customer-42',
};

test('chat checks customer authentication before revealing support-service configuration', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => { throw new Error('invalid token'); },
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    intakeRefund: async () => { throw new Error('must not call refund'); },
    getConversation: async () => { throw new Error('must not load conversation'); },
    acceptCustomerMessage: async () => { throw new Error('must not accept message'); },
    appendAssistantMessage: async () => { throw new Error('must not append message'); },
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    getRefundStart: async () => ({ statusCode: 404, body: { error: { code: 'REFUND_START_NOT_FOUND' } } }),
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/messages`,
    headers: { 'idempotency-key': 'unauthorized-turn-1' },
    payload: {
      client_message_id: 'unauthorized-client-1',
      content: { type: 'text', text: 'Where is my order?' },
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'customer_unauthorized');
});

test('shared chat persists a read-only status answer without calling refund intake or Temporal', async (context) => {
  let legacyRefundCalls = 0;
  let workflowStarts = 0;
  let workflowLinks = 0;
  const appended: string[] = [];
  const app = buildApp({
    verifyCustomerIdentity: async () => identity,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    intakeRefund: async () => {
      legacyRefundCalls += 1;
      throw new Error('Legacy refund intake must not be called for chat');
    },
    intakeSupport: async (request, assertions) => {
      assert.equal(request.customer_message, 'Where is my order ORDER-123?');
      assert.deepEqual(assertions, {
        agentRuntime: 'agent-context',
        integrationGateway: 'gateway-context',
        knowledgeRag: 'rag-context',
      });
      return {
        statusCode: 200,
        body: {
          journey: 'order_status',
          status: 'answer_ready',
          customer_answer: { message: 'Order ORDER-123 is being prepared.' },
        },
      };
    },
    acceptCustomerMessage: async () => ({
      statusCode: 202,
      body: { data: { conversationId, messageId: 'customer-1', sequenceNumber: 1, status: 'ACCEPTED' } },
    }),
    getConversation: async () => ({
      statusCode: 200,
      body: { data: {
        conversationId,
        status: 'OPEN',
        controlMode: 'AI',
        messages: [{
          messageId: 'customer-1',
          sequenceNumber: 1,
          senderKind: 'END_CUSTOMER',
          text: 'Where is my order ORDER-123?',
          createdAt: '2026-10-01T00:00:00.000Z',
        }],
      } },
    }),
    appendAssistantMessage: async (input) => {
      appended.push(input.text);
      return {
        statusCode: 202,
        body: { data: { conversationId, messageId: 'assistant-1', sequenceNumber: 2, status: 'ACCEPTED' } },
      };
    },
    startRefundWorkflow: async () => {
      workflowStarts += 1;
      return { workflowId: 'must-not-start' };
    },
    linkRefundWorkflow: async () => {
      workflowLinks += 1;
      return { statusCode: 202, body: {} };
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'status-turn-1',
    },
    payload: {
      client_message_id: 'customer-client-1',
      content: { type: 'text', text: 'Where is my order ORDER-123?' },
    },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(appended, ['Order ORDER-123 is being prepared.']);
  assert.equal(legacyRefundCalls, 0);
  assert.equal(workflowStarts, 0);
  assert.equal(workflowLinks, 0);
  assert.equal(response.json().refund_workflow, undefined);
});

test('shared chat acknowledges cancellation without starting any workflow until the customer opens review', async (context) => {
  let refundStarts = 0;
  let cancellationStarts = 0;
  const app = buildApp({
    verifyCustomerIdentity: async () => identity,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    intakeRefund: async () => { throw new Error('refund must not run'); },
    intakeSupport: async () => ({ statusCode: 200, body: { journey: 'cancellation',
      status: 'cancellation_request_ready', order_reference: 'ORDER-123',
      customer_answer: { message: 'I can check whether order ORDER-123 can be cancelled. You will review the details before anything changes.' } } }),
    getConversation: async () => ({ statusCode: 200, body: { data: { conversationId,
      status: 'OPEN', controlMode: 'AI', messages: [{ messageId: 'customer-1', sequenceNumber: 1,
        senderKind: 'END_CUSTOMER', text: 'Please cancel order ORDER-123', createdAt: '2026-10-01T00:00:00.000Z' }] } } }),
    acceptCustomerMessage: async () => ({ statusCode: 202,
      body: { data: { conversationId, messageId: 'customer-1', sequenceNumber: 1, status: 'ACCEPTED' } } }),
    appendAssistantMessage: async (input) => { assert.equal(input.refundStartInput, undefined);
      assert.equal(input.refundWorkflowId, undefined);
      return { statusCode: 202, body: { data: { conversationId, messageId: 'assistant-1',
        sequenceNumber: 2, status: 'ACCEPTED' } } }; },
    startRefundWorkflow: async () => { refundStarts += 1; throw new Error('not allowed'); },
    startCancellationWorkflow: async ({ workflowId }) => { cancellationStarts += 1; return { workflowId }; },
  });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/messages`,
    headers: { authorization: 'Bearer customer-access-token', 'idempotency-key': 'cancel-turn-1' },
    payload: { client_message_id: 'cancel-client-1', content: { type: 'text', text: 'Please cancel order ORDER-123' } } });
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(response.json().cancellation_request, { order_reference: 'ORDER-123' });
  assert.equal(response.json().refund_workflow, undefined);
  assert.equal(refundStarts, 0);
  assert.equal(cancellationStarts, 0);
});

test('one shared chat isolates status, policy, payment, total, recent orders, clarification, and refund across turns', async (context) => {
  const customerTurns = [
    'Where is order ORDER-123?',
    'What is the return policy?',
    'I need help with something else.',
    'Please refund order ORDER-123 because the item arrived damaged.',
    'Which items are in order ORDER-123?',
    'Where is order ORDER-123 now?',
    'Was payment for order ORDER-123 recorded?',
    'What is the total for order ORDER-123?',
    'What are my recent orders?',
  ];
  const agentBodies = [
    { journey: 'order_status', status: 'answer_ready', customer_answer: { message: 'Order ORDER-123 is being prepared.' } },
    { journey: 'product_policy', status: 'answer_ready', customer_answer: { message: 'Returns are accepted within 30 days. (Source: Returns policy.)' } },
    { journey: 'clarify', status: 'clarification_required', customer_answer: { message: 'Would you like help with an order or a product?' } },
    {
      journey: 'refund',
      status: 'refund_proposal_ready',
      customer_message: customerTurns[3],
      order_reference: 'ORDER-123',
      customer_answer: { message: 'Please review your refund request.' },
      refund_proposal: {
        proposalId: 'proposal-123',
        journeyType: 'REFUND',
        missingFields: [],
        intent: {
          orderId: 'order-internal-123',
          reasonCode: 'DAMAGED',
          scope: 'FULL_ORDER',
          itemIds: [],
          requestedAmount: { amountMinor: 12_500, currency: 'USD' },
        },
      },
    },
    { journey: 'order_items', status: 'answer_ready', customer_answer: { message: 'Order ORDER-123 contains Laptop (quantity 2).' } },
    { journey: 'order_status', status: 'answer_ready', customer_answer: { message: 'Order ORDER-123 is being prepared.' } },
    { journey: 'payment_status', status: 'answer_ready', customer_answer: { message: 'Payment for order ORDER-123 is recorded as settled.' } },
    { journey: 'order_total', status: 'answer_ready', customer_answer: { message: 'The total for order ORDER-123 is $125.00, including tax.' } },
    { journey: 'recent_orders', status: 'answer_ready', customer_answer: { message: 'Recent placed-order references: ORDER-123.' } },
  ];
  const transcript: Array<Record<string, unknown>> = [];
  const acceptedAnswers: string[] = [];
  const observedTurns: string[] = [];
  const signedContexts: Array<{ requestId: string; traceId: string; channelId: string }> = [];
  let workflowStarts = 0;
  let workflowLinks = 0;
  let legacyRefundCalls = 0;
  const app = buildApp({
    verifyCustomerIdentity: async () => identity,
    signContextAssertion: async (input) => {
      signedContexts.push(input);
      return 'gateway-context';
    },
    signAgentRuntimeContextAssertion: async (input) => {
      signedContexts.push(input);
      return 'agent-context';
    },
    signKnowledgeRagContextAssertion: async (input) => {
      signedContexts.push(input);
      return 'rag-context';
    },
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    getRefundStart: async () => ({ statusCode: 404, body: { error: { code: 'REFUND_START_NOT_FOUND' } } }),
    intakeRefund: async () => {
      legacyRefundCalls += 1;
      throw new Error('Shared chat must not call legacy refund intake');
    },
    intakeSupport: async (input, assertions) => {
      observedTurns.push(input.customer_message);
      assert.equal(input.conversation_messages.at(-1)?.text, input.customer_message);
      assert.deepEqual(assertions, {
        agentRuntime: 'agent-context',
        integrationGateway: 'gateway-context',
        knowledgeRag: 'rag-context',
      });
      return { statusCode: 200, body: agentBodies[observedTurns.length - 1] };
    },
    acceptCustomerMessage: async (input) => {
      const sequenceNumber = transcript.length + 1;
      const messageId = `customer-${sequenceNumber}`;
      transcript.push({
        messageId, sequenceNumber, senderKind: 'END_CUSTOMER', text: input.text,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
      return { statusCode: 202, body: { data: { conversationId, messageId, sequenceNumber, status: 'ACCEPTED' } } };
    },
    getConversation: async () => ({
      statusCode: 200,
      body: { data: { conversationId, status: 'OPEN', controlMode: 'AI', messages: transcript } },
    }),
    appendAssistantMessage: async (input) => {
      acceptedAnswers.push(input.text);
      const sequenceNumber = transcript.length + 1;
      const messageId = `assistant-${sequenceNumber}`;
      transcript.push({
        messageId, sequenceNumber, senderKind: 'AI_AGENT', text: input.text,
        createdAt: '2026-10-01T00:00:01.000Z',
      });
      return { statusCode: 202, body: { data: { conversationId, messageId, sequenceNumber, status: 'ACCEPTED',
        ...(input.refundStartInput ? { refundStart: { workflowId: input.refundStartInput.workflowId,
          status: 'PENDING', startInput: input.refundStartInput } } : {}),
      } } };
    },
    startRefundWorkflow: async (input) => {
      workflowStarts += 1;
      assert.equal(input.proposal.intent.reasonCode, 'DAMAGED');
      return { workflowId: input.workflowId };
    },
    linkRefundWorkflow: async () => {
      workflowLinks += 1;
      return { statusCode: 202, body: {} };
    },
  });
  context.after(() => app.close());

  for (const [index, text] of customerTurns.entries()) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer customer-access-token', 'idempotency-key': `turn-${index + 1}` },
      payload: { client_message_id: `client-${index + 1}`, content: { type: 'text', text } },
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().assistant_message.content.text, acceptedAnswers[index]);
    assert.equal(workflowStarts, index >= 3 ? 1 : 0);
    assert.equal(workflowLinks, index >= 3 ? 1 : 0);
    assert.equal(response.json().refund_workflow?.workflow_id, index === 3 ? 'refund-proposal-123' : undefined);
    const contextsForTurn = signedContexts.slice(index * 3, (index + 1) * 3);
    assert.equal(contextsForTurn.length, 3);
    assert.equal(new Set(contextsForTurn.map((input) => input.requestId)).size, 1);
    assert.equal(new Set(contextsForTurn.map((input) => input.traceId)).size, 1);
    assert.deepEqual(contextsForTurn.map((input) => input.channelId), ['web', 'web', 'web']);
  }
  assert.deepEqual(observedTurns, customerTurns);
  assert.equal(legacyRefundCalls, 0);
});

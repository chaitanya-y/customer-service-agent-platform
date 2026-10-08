import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAgentRuntimeClient } from '../src/agent-runtime-client.js';
import { buildApp } from '../src/app.js';
import {
  AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
  CONTEXT_ASSERTION_HEADER,
  KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
} from '../src/context-assertion.js';

const conversationId = '019c321e-8650-7000-8000-000000000001';
const question = 'Is Cloud Hoodie Blue / Small in stock?';
const answer = 'The catalog lists Blue / Small as in stock. Availability can change; this does not reserve an item.';

test('named-variant stock chat crosses the support intake boundary without a refund workflow', async (context) => {
  const requests: unknown[] = [];
  const appended: string[] = [];
  let refundStarts = 0;
  const agent = createAgentRuntimeClient({
    baseUrl: 'http://agent-runtime.test:8000',
    fetchImpl: async (input, init) => {
      assert.equal(input.toString(), 'http://agent-runtime.test:8000/support/intake');
      assert.equal(init?.method, 'POST');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER), 'agent-context');
      assert.equal(headers.get(CONTEXT_ASSERTION_HEADER), 'gateway-context');
      assert.equal(headers.get(KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER), 'rag-context');
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        journey: 'product_policy',
        status: 'answer_ready',
        customer_answer: { message: answer },
      });
    },
  });
  const app = buildApp({
    verifyCustomerIdentity: async () => ({
      principalId: 'customer-42', tenantId: 'tenant-local', environmentId: 'local', customerId: 'customer-42',
    }),
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    intakeRefund: async () => { throw new Error('legacy refund intake must not run'); },
    intakeSupport: agent.intakeSupport,
    acceptCustomerMessage: async () => ({
      statusCode: 202,
      body: { data: { conversationId, messageId: 'customer-1', sequenceNumber: 1, status: 'ACCEPTED' } },
    }),
    getConversation: async () => ({
      statusCode: 200,
      body: { data: {
        conversationId, status: 'OPEN', controlMode: 'AI',
        messages: [{ messageId: 'customer-1', sequenceNumber: 1, senderKind: 'END_CUSTOMER',
          text: question, createdAt: '2026-10-02T00:00:00.000Z' }],
      } },
    }),
    appendAssistantMessage: async (input) => {
      assert.equal(input.refundStartInput, undefined);
      assert.equal(input.refundWorkflowId, undefined);
      appended.push(input.text);
      return { statusCode: 202, body: { data: {
        conversationId, messageId: 'assistant-1', sequenceNumber: 2, status: 'ACCEPTED',
      } } };
    },
    startRefundWorkflow: async () => {
      refundStarts += 1;
      throw new Error('stock question must not start a refund');
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/messages`,
    headers: { authorization: 'Bearer customer-access-token', 'idempotency-key': 'stock-turn-1' },
    payload: { client_message_id: 'stock-client-1', content: { type: 'text', text: question } },
  });

  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(requests, [{
    customer_message: question,
    conversation_messages: [{ sequence_number: 1, text: question }],
  }]);
  assert.deepEqual(appended, [answer]);
  assert.equal(refundStarts, 0);
  assert.equal(response.json().refund_workflow, undefined);
});

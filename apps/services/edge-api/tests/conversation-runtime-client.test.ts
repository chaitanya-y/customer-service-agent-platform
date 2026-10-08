import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  ConversationRuntimeUnavailableError,
  createConversationRuntimeClient,
} from '../src/conversation-runtime-client.js';
import {
  CONTEXT_ASSERTION_HEADER,
  SERVICE_ASSERTION_HEADER,
} from '../src/context-assertion.js';

const CONVERSATION_ID = '019c321e-8650-7000-8000-000000000001';

test('rejects cross-origin redirects for every customer and service conversation operation', async (t) => {
  let redirectedRequests = 0;
  const capture = createServer((_request, response) => {
    redirectedRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(307, { location: `http://127.0.0.1:${capturePort}/capture` });
    response.end();
  });
  t.after(() => {
    capture.closeAllConnections();
    upstream.closeAllConnections();
    capture.close();
    upstream.close();
  });
  capture.listen(0, '127.0.0.1');
  await once(capture, 'listening');
  const captureAddress = capture.address();
  assert.ok(captureAddress && typeof captureAddress !== 'string');
  const capturePort = captureAddress.port;
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  const client = createConversationRuntimeClient({ baseUrl: `http://127.0.0.1:${upstreamAddress.port}` });
  const customer = { conversationId: CONVERSATION_ID, contextAssertion: 'synthetic-context' };
  const service = { conversationId: CONVERSATION_ID, serviceAssertion: 'synthetic-service' };
  const operations = [
    () => client.createConversation({ contextAssertion: customer.contextAssertion, idempotencyKey: 'synthetic' }),
    () => client.getConversation(customer),
    () => client.requestHumanHandoff({ ...customer, idempotencyKey: 'synthetic', expectedControlVersion: 1 }),
    () => client.acceptCustomerMessage({ ...customer, idempotencyKey: 'synthetic', clientMessageId: 'synthetic', text: 'synthetic private message' }),
    () => client.appendAssistantMessage({ ...service, idempotencyKey: 'synthetic', clientMessageId: 'synthetic', text: 'synthetic private message' }),
    () => client.getRefundStart({ ...service, assistantClientMessageId: 'synthetic' }),
    () => client.linkRefundWorkflow({ ...service, idempotencyKey: 'synthetic', messageId: 'synthetic', workflowId: 'synthetic' }),
  ];
  for (const operation of operations) {
    await assert.rejects(operation(), ConversationRuntimeUnavailableError);
  }
  assert.equal(upstreamRequests, 7);
  assert.equal(redirectedRequests, 0);
});

test('sends the expected Conversation Runtime request shapes', async () => {
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  const client = createConversationRuntimeClient({
    baseUrl: 'http://conversation-runtime:3004',
    fetchImpl: async (input, init) => {
      requests.push({ input: input.toString(), init });
      return Response.json({
        data: {
          conversationId: CONVERSATION_ID,
          messageId: 'message-1',
          sequenceNumber: 1,
          status: 'ACCEPTED',
        },
      }, { status: 202 });
    },
  });

  await client.createConversation({
    contextAssertion: 'customer-context',
    idempotencyKey: 'create-key',
  });
  await client.getConversation({
    conversationId: CONVERSATION_ID,
    contextAssertion: 'customer-context',
  });
  await client.acceptCustomerMessage({
    conversationId: CONVERSATION_ID,
    contextAssertion: 'customer-context',
    idempotencyKey: 'customer-message-key',
    clientMessageId: 'client-message-1',
    text: 'I need help with my order.',
  });
  await client.appendAssistantMessage({
    conversationId: CONVERSATION_ID,
    serviceAssertion: 'edge-service-assertion',
    idempotencyKey: 'assistant-message-key',
    clientMessageId: 'assistant-message-1',
    text: 'I can help with that.',
  });
  await client.requestHumanHandoff({
    conversationId: CONVERSATION_ID,
    contextAssertion: 'customer-context',
    idempotencyKey: 'handoff-key',
    expectedControlVersion: 3,
  });

  assert.equal(requests.length, 5);
  assert.equal(
    requests[0]?.input,
    'http://conversation-runtime:3004/v1/conversations',
  );
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.equal(
    new Headers(requests[0]?.init?.headers).get(CONTEXT_ASSERTION_HEADER),
    'customer-context',
  );
  assert.equal(
    new Headers(requests[0]?.init?.headers).get('idempotency-key'),
    'create-key',
  );
  assert.equal(requests[0]?.init?.body, JSON.stringify({ channel: 'web' }));
  assert.ok(requests[0]?.init?.signal);
  assert.equal(
    requests[1]?.input,
    `http://conversation-runtime:3004/v1/conversations/${CONVERSATION_ID}`,
  );
  assert.equal(requests[1]?.init?.method, 'GET');
  assert.equal(
    new Headers(requests[1]?.init?.headers).get(CONTEXT_ASSERTION_HEADER),
    'customer-context',
  );
  assert.equal(
    new Headers(requests[2]?.init?.headers).get(CONTEXT_ASSERTION_HEADER),
    'customer-context',
  );
  assert.equal(
    requests[2]?.init?.body,
    JSON.stringify({
      clientMessageId: 'client-message-1',
      content: { type: 'text', text: 'I need help with my order.' },
    }),
  );
  assert.equal(
    new Headers(requests[3]?.init?.headers).get(SERVICE_ASSERTION_HEADER),
    'edge-service-assertion',
  );
  assert.equal(
    new Headers(requests[3]?.init?.headers).get(CONTEXT_ASSERTION_HEADER),
    null,
  );
  assert.equal(
    requests[3]?.init?.body,
    JSON.stringify({
      client_message_id: 'assistant-message-1',
      content: { type: 'text', text: 'I can help with that.' },
    }),
  );
  assert.equal(requests[4]?.input, `http://conversation-runtime:3004/v1/conversations/${CONVERSATION_ID}/handoff`);
  assert.equal(requests[4]?.init?.method, 'POST');
  assert.equal(new Headers(requests[4]?.init?.headers).get(CONTEXT_ASSERTION_HEADER), 'customer-context');
  assert.equal(requests[4]?.init?.body, JSON.stringify({ expectedControlVersion: 3 }));
});

test('maps Conversation Runtime transport failures to a stable client error', async () => {
  const client = createConversationRuntimeClient({
    baseUrl: 'http://conversation-runtime:3004',
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });

  await assert.rejects(
    () =>
      client.createConversation({
        contextAssertion: 'customer-context',
        idempotencyKey: 'create-key',
      }),
    ConversationRuntimeUnavailableError,
  );
});

test('looks up a reserved refund using a signed internal request and no redirect forwarding', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = createConversationRuntimeClient({
    baseUrl: 'http://conversation-runtime:3004',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ data: { workflowId: 'refund-1', status: 'PENDING' } });
    },
  });
  const result = await client.getRefundStart({
    conversationId: CONVERSATION_ID, assistantClientMessageId: 'assistant-client-1', serviceAssertion: 'service-assertion',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(requests[0]?.url, `http://conversation-runtime:3004/v1/internal/conversations/${CONVERSATION_ID}/refund-starts/by-assistant-client/assistant-client-1`);
  assert.equal(requests[0]?.init?.redirect, 'error');
  assert.equal(new Headers(requests[0]?.init?.headers).get(SERVICE_ASSERTION_HEADER), 'service-assertion');
});

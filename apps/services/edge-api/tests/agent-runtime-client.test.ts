import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  AgentRuntimeUnavailableError,
  createAgentRuntimeClient,
} from '../src/agent-runtime-client.js';
import {
  AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
  CONTEXT_ASSERTION_HEADER,
  KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
} from '../src/context-assertion.js';

test('rejects cross-origin redirects without forwarding intake assertions or messages', async (t) => {
  let redirectedRequests = 0;
  const capture = createServer((_request, response) => {
    redirectedRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  const upstreamPaths: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamPaths.push(request.url ?? '');
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
  const client = createAgentRuntimeClient({ baseUrl: `http://127.0.0.1:${upstreamAddress.port}` });
  for (const intake of [client.intakeRefund, client.intakeSupport]) {
    await assert.rejects(intake({ customer_message: 'synthetic private message' }, {
      agentRuntime: 'synthetic-agent-assertion',
      integrationGateway: 'synthetic-gateway-assertion',
      knowledgeRag: 'synthetic-knowledge-assertion',
    }), AgentRuntimeUnavailableError);
  }
  assert.deepEqual(upstreamPaths, ['/refunds/intake', '/support/intake']);
  assert.equal(redirectedRequests, 0);
});

test('forwards the refund request and audience-specific context assertions', async () => {
  const client = createAgentRuntimeClient({
    baseUrl: 'http://agent-runtime:8000',
    fetchImpl: async (input, init) => {
      assert.equal(input.toString(), 'http://agent-runtime:8000/refunds/intake');
      assert.equal(init?.method, 'POST');
      assert.equal(
        new Headers(init?.headers).get(CONTEXT_ASSERTION_HEADER),
        'gateway-context',
      );
      assert.equal(
        new Headers(init?.headers).get(
          AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
        ),
        'agent-runtime-context',
      );
      assert.equal(
        new Headers(init?.headers).get(
          KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
        ),
        'knowledge-rag-context',
      );
      assert.equal(
        init?.body,
        JSON.stringify({
          customer_message: 'Please refund my order.',
          order_reference: 'ORDER-123',
          conversation_messages: [
            { sequence_number: 1, text: 'Please refund my order.' },
          ],
        }),
      );

      return Response.json({ status: 'order_context_loaded' }, { status: 200 });
    },
  });

  assert.deepEqual(
    await client.intakeRefund(
      {
        customer_message: 'Please refund my order.',
        order_reference: 'ORDER-123',
        conversation_messages: [
          { sequence_number: 1, text: 'Please refund my order.' },
        ],
      },
      {
        agentRuntime: 'agent-runtime-context',
        integrationGateway: 'gateway-context',
        knowledgeRag: 'knowledge-rag-context',
      },
    ),
    {
      statusCode: 200,
      body: { status: 'order_context_loaded' },
    },
  );
});

test('forwards shared support chat turns to support intake with the same signed assertions', async () => {
  const client = createAgentRuntimeClient({
    baseUrl: 'http://agent-runtime:8000',
    fetchImpl: async (input, init) => {
      assert.equal(input.toString(), 'http://agent-runtime:8000/support/intake');
      assert.equal(init?.method, 'POST');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER), 'agent-runtime-context');
      assert.equal(headers.get(CONTEXT_ASSERTION_HEADER), 'gateway-context');
      assert.equal(headers.get(KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER), 'knowledge-rag-context');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        customer_message: 'Where is my order?',
        order_reference: 'ORDER-123',
      });
      return Response.json({
        journey: 'order_status',
        status: 'answer_ready',
        customer_answer: { message: 'Your order is being prepared.' },
      });
    },
  });

  const result = await client.intakeSupport(
    { customer_message: 'Where is my order?', order_reference: 'ORDER-123' },
    {
      agentRuntime: 'agent-runtime-context',
      integrationGateway: 'gateway-context',
      knowledgeRag: 'knowledge-rag-context',
    },
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    journey: 'order_status',
    status: 'answer_ready',
    customer_answer: { message: 'Your order is being prepared.' },
  });
});

test('maps transport failures to a stable client error', async () => {
  const client = createAgentRuntimeClient({
    baseUrl: 'http://agent-runtime:8000',
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });

  await assert.rejects(
    () =>
      client.intakeRefund(
        { customer_message: 'Refund it.' },
        {
          agentRuntime: 'agent-runtime-context',
          integrationGateway: 'gateway-context',
          knowledgeRag: 'knowledge-rag-context',
        },
      ),
    AgentRuntimeUnavailableError,
  );
});

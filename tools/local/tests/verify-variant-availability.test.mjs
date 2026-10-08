import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSmokeArguments, runVariantAvailabilitySmoke } from '../verify-variant-availability.mjs';

const conversationId = '11111111-1111-4111-8111-111111111111';
const variant = 'Laptop 13 inch 8GB';
const answer = `The catalog lists ${variant} as in stock. Availability can change; this does not reserve an item.`;

function edgeFetch({ message = {}, transcript = {} } = {}) {
  const calls = [];
  const replies = [
    { status: 201, body: { conversation_id: conversationId, status: 'OPEN', control_mode: 'AI', control_version: 1 } },
    { status: 202, body: {
      conversation_id: conversationId,
      customer_message_id: 'customer-message-1',
      assistant_message: { message_id: 'assistant-message-1', content: { type: 'text', text: answer } },
      ...message,
    } },
    { status: 200, body: {
      conversation_id: conversationId, status: 'OPEN', control_mode: 'AI', control_version: 1,
      messages: [
        { message_id: 'customer-message-1', sender_kind: 'END_CUSTOMER', content: { type: 'text', text: `Is ${variant} in stock?` } },
        { message_id: 'assistant-message-1', sender_kind: 'ASSISTANT', content: { type: 'text', text: answer } },
      ],
      ...transcript,
    } },
  ];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const reply = replies.shift();
      assert.ok(reply, 'Only the three expected Edge requests are allowed');
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

test('requires explicit run mode and a safe exact variant', () => {
  assert.deepEqual(parseSmokeArguments(['--run', '--variant=Laptop 13 inch 8GB']), { variant });
  assert.throws(() => parseSmokeArguments(['--variant=Laptop 13 inch 8GB']), /--run/);
  assert.throws(() => parseSmokeArguments(['--run', '--variant=']), /variant/);
  assert.throws(() => parseSmokeArguments(['--run', '--variant=Laptop refund']), /variant/);
  assert.throws(() => parseSmokeArguments(['--run', '--variant=Never Laptop']), /variant/);
  assert.throws(() => parseSmokeArguments(['--run', '--variant=Order paid Laptop']), /variant/);
  assert.throws(() => parseSmokeArguments(['--run', '--variant=Laptop?']), /variant/);
});

test('asks one exact named-variant question through authenticated Edge and verifies a read-only transcript', async () => {
  const { fetchImpl, calls } = edgeFetch();
  const result = await runVariantAvailabilitySmoke({ variant, token: 'private-test-token', fetchImpl });

  assert.deepEqual(result, { status: 'PASSED', conversationId, variant, availability: 'IN_STOCK' });
  assert.deepEqual(calls.map(({ url, init }) => [new URL(url).origin, new URL(url).pathname, init.method]), [
    ['http://127.0.0.1:3000', '/v1/conversations', 'POST'],
    ['http://127.0.0.1:3000', `/v1/conversations/${conversationId}/messages`, 'POST'],
    ['http://127.0.0.1:3000', `/v1/conversations/${conversationId}`, 'GET'],
  ]);
  assert.ok(calls.every(({ init }) => init.headers.authorization === 'Bearer private-test-token'));
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  assert.deepEqual(JSON.parse(calls[1].init.body).content, { type: 'text', text: `Is ${variant} in stock?` });
  assert.ok(calls.filter(({ init }) => init.method === 'POST').every(({ init }) => init.headers['idempotency-key']));
});

test('rejects a reply that starts a refund workflow without reading further', async () => {
  const { fetchImpl, calls } = edgeFetch({ message: { refund_workflow: { workflow_id: 'workflow-1', status: 'started' } } });
  await assert.rejects(runVariantAvailabilitySmoke({ variant, token: 'private-test-token', fetchImpl }), /refund workflow/);
  assert.equal(calls.length, 2);
});

test('rejects a reply that does not describe the exact variant with bounded no-reservation wording', async () => {
  const { fetchImpl } = edgeFetch({ message: { assistant_message: {
    message_id: 'assistant-message-1',
    content: { type: 'text', text: 'The catalog lists Laptop 15 inch as in stock. We reserved one for you.' },
  } } });
  await assert.rejects(runVariantAvailabilitySmoke({ variant, token: 'private-test-token', fetchImpl }), /bounded availability/);
});

test('rejects a persisted transcript with a refund workflow link', async () => {
  const { fetchImpl } = edgeFetch({ transcript: { messages: [
    { message_id: 'customer-message-1', sender_kind: 'END_CUSTOMER', content: { type: 'text', text: `Is ${variant} in stock?` } },
    { message_id: 'assistant-message-1', sender_kind: 'ASSISTANT', content: { type: 'text', text: answer }, refund_workflow: { workflow_id: 'workflow-1', status: 'started' } },
  ] } });
  await assert.rejects(runVariantAvailabilitySmoke({ variant, token: 'private-test-token', fetchImpl }), /refund workflow/);
});

test('does not expose the token when Edge fails', async () => {
  const { fetchImpl } = edgeFetch();
  await assert.rejects(
    runVariantAvailabilitySmoke({ variant, token: 'private-test-token', fetchImpl: async (url, init) => {
      await fetchImpl(url, init);
      throw new Error('private-test-token');
    } }),
    error => { assert.doesNotMatch(error.message, /private-test-token/); return true; },
  );
});

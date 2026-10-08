import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runRecentOrdersChatSmoke } from '../verify-recent-orders-chat.mjs';

test('one recent-order chat turn stays read-only and persists its answer', async () => {
  const id = '019c321e-8650-7000-8000-000000000001';
  const answer = 'Recent placed-order references: ORDER-NEW, ORDER-OLD.';
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ path: new URL(url).pathname, options });
    const response = requests.length === 1
      ? { conversation_id: id, status: 'OPEN', control_mode: 'AI' }
      : requests.length === 2
        ? { conversation_id: id, assistant_message: { content: { text: answer } } }
        : { conversation_id: id, control_mode: 'AI', messages: [
          { sender_kind: 'END_CUSTOMER', content: { text: 'What are my recent orders?' } },
          { sender_kind: 'ASSISTANT', content: { text: answer } },
        ] };
    return { ok: true, status: requests.length === 1 ? 201 : requests.length === 2 ? 202 : 200,
      json: async () => response };
  };
  const result = await runRecentOrdersChatSmoke({ token: 'private-test-token', fetchImpl });
  assert.deepEqual(result, { status: 'PASSED', conversationId: id, answerKind: 'REFERENCES' });
  assert.deepEqual(requests.map(request => request.path), [
    '/v1/conversations', `/v1/conversations/${id}/messages`, `/v1/conversations/${id}`,
  ]);
  assert.equal(requests[1].options.headers.authorization, 'Bearer private-test-token');
  assert.equal(JSON.parse(requests[1].options.body).content.text, 'What are my recent orders?');
});

test('smoke rejects an action link even if the answer sounds safe', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: calls === 1 ? 201 : 202, json: async () => calls === 1
      ? { conversation_id: '019c321e-8650-7000-8000-000000000001', control_mode: 'AI' }
      : { conversation_id: '019c321e-8650-7000-8000-000000000001',
        assistant_message: { content: { text: 'I found no recent placed orders for this account.' } },
        refund_workflow: { workflow_id: 'bad' } } };
  };
  await assert.rejects(runRecentOrdersChatSmoke({ token: 'test', fetchImpl }), /commerce action/);
});

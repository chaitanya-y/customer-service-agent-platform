import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const edgeBase = 'http://127.0.0.1:3000';
const operationsBase = 'http://127.0.0.1:3003';
const customerToken = process.env.CSO_LOCAL_CUSTOMER_TOKEN;
const supportToken = process.env.CSO_LOCAL_SUPPORT_STAFF_TOKEN;

if (!customerToken || !supportToken) {
  throw new Error('Load local customer and support staff tokens before this backend-only check.');
}

async function request(base, path, auth, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: 'application/json',
      ...(auth === 'customer'
        ? { authorization: `Bearer ${customerToken}` }
        : { 'x-cso-support-staff-assertion': supportToken }),
      ...(body === undefined ? {} : {
        'content-type': 'application/json',
        'idempotency-key': `handoff-proof-${randomUUID()}`,
      }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || response.status >= 300) {
    throw new Error(`${method} ${path}: HTTP ${response.status} ${payload?.error?.code ?? 'unknown'}`);
  }
  return payload;
}

async function createConversation() {
  const result = await request(edgeBase, '/v1/conversations', 'customer', 'POST', {});
  assert.match(result.conversation_id, /^[0-9a-f-]{36}$/i);
  assert.equal(result.control_mode, 'AI');
  assert.equal(result.control_version, 1);
  return result.conversation_id;
}

async function handoff(conversationId) {
  const result = await request(edgeBase, `/v1/conversations/${conversationId}/handoff`, 'customer', 'POST', {
    expected_control_version: 1,
  });
  assert.equal(result.conversation_id, conversationId);
  assert.equal(result.control_mode, 'QUEUED');
  assert.equal(result.control_version, 2);
  assert.match(result.handoff_session_id, /^[0-9a-f-]{36}$/i);
  return result.handoff_session_id;
}

async function claim(conversationId, handoffSessionId) {
  const result = await request(operationsBase, `/v1/support-chats/${conversationId}/claim`, 'staff', 'POST', {
    handoffSessionId,
    expectedControlVersion: 2,
  });
  assert.equal(result.data.conversationId, conversationId);
  assert.equal(result.data.controlMode, 'HUMAN');
  assert.equal(result.data.controlVersion, 3);
}

const firstConversation = await createConversation();
const firstSession = await handoff(firstConversation);

const customerMessage = await request(edgeBase, `/v1/conversations/${firstConversation}/messages`, 'customer', 'POST', {
  client_message_id: `handoff-customer-${randomUUID()}`,
  content: { type: 'text', text: 'This is a local human handoff verification.' },
});
assert.equal(customerMessage.control_mode, 'QUEUED');
assert.equal(customerMessage.assistant_message, undefined);
assert.equal(customerMessage.refund_workflow, undefined);

const queue = await request(operationsBase, '/v1/support-chats', 'staff');
assert.ok(queue.data.items.some((item) => item.conversationId === firstConversation));
await claim(firstConversation, firstSession);

const replyText = 'A support specialist received this local test conversation.';
const staffReply = await request(operationsBase, `/v1/support-chats/${firstConversation}/messages`, 'staff', 'POST', {
  handoffSessionId: firstSession,
  expectedControlVersion: 3,
  clientMessageId: `handoff-staff-${randomUUID()}`,
  content: { type: 'text', text: replyText },
});
assert.equal(staffReply.data.control.controlMode, 'HUMAN');

const transcript = await request(edgeBase, `/v1/conversations/${firstConversation}`, 'customer');
assert.equal(transcript.control_mode, 'HUMAN');
assert.ok(transcript.messages.some((message) => message.sender_kind === 'WORKFORCE'
  && message.content.text === replyText));

const returned = await request(operationsBase, `/v1/support-chats/${firstConversation}/return-to-ai`, 'staff', 'POST', {
  handoffSessionId: firstSession,
  expectedControlVersion: 3,
});
assert.equal(returned.data.controlMode, 'AI');
assert.equal(returned.data.controlVersion, 4);

const secondConversation = await createConversation();
const secondSession = await handoff(secondConversation);
await claim(secondConversation, secondSession);
const closed = await request(operationsBase, `/v1/support-chats/${secondConversation}/close`, 'staff', 'POST', {
  handoffSessionId: secondSession,
  expectedControlVersion: 3,
});
assert.equal(closed.data.status, 'CLOSED');
const closedTranscript = await request(edgeBase, `/v1/conversations/${secondConversation}`, 'customer');
assert.equal(closedTranscript.status, 'CLOSED');

console.log(JSON.stringify({
  result: 'passed',
  mode: 'backend-only',
  firstConversation,
  secondConversation,
  checks: ['queue', 'customer-message-no-ai', 'claim', 'staff-reply', 'customer-transcript', 'return-to-ai', 'close'],
}));

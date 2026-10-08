#!/usr/bin/env node
/** One opt-in, model-free local Edge chat smoke; prints no token or answer. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE_BASE = 'http://127.0.0.1:3000';
const QUESTION = 'What are my recent orders?';
const SAFE_ANSWER = /^(?:I found no recent placed orders for this account\.|Recent placed-order references: [A-Za-z0-9][A-Za-z0-9._:-]*(?:, [A-Za-z0-9][A-Za-z0-9._:-]*){0,9}\.(?: More placed orders may exist beyond these ten\.)?)$/;

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}

export async function runRecentOrdersChatSmoke({ token, fetchImpl = fetch }) {
  requireCondition(typeof token === 'string' && token.length > 0, 'CSO_LOCAL_CUSTOMER_TOKEN is required.');
  async function request(path, method, body) {
    let response;
    try {
      response = await fetchImpl(new URL(path, EDGE_BASE), {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
        headers: {
          accept: 'application/json', authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : {
            'content-type': 'application/json', 'idempotency-key': `recent-orders-smoke-${randomUUID()}`,
          }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`Edge ${method} ${path} request failed.`);
    }
    requireCondition(response.ok && response.status < 300,
      `Edge ${method} ${path} returned HTTP ${response.status}.`);
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      throw new Error(`Edge ${method} ${path} returned invalid JSON.`);
    }
  }

  const created = await request('/v1/conversations', 'POST', {});
  const conversationId = created.body?.conversation_id;
  requireCondition(created.status === 201 && /^[0-9a-f-]{36}$/i.test(conversationId)
    && created.body?.control_mode === 'AI', 'Edge did not create an AI conversation.');

  const posted = await request(`/v1/conversations/${conversationId}/messages`, 'POST', {
    client_message_id: `recent-orders-smoke-${randomUUID()}`,
    content: { type: 'text', text: QUESTION },
  });
  const answer = posted.body?.assistant_message?.content?.text;
  requireCondition(posted.status === 202 && posted.body?.conversation_id === conversationId,
    'Edge did not accept the recent-order turn.');
  requireCondition(posted.body?.refund_workflow === undefined && posted.body?.cancellation_request === undefined,
    'A commerce action was unexpectedly offered.');
  requireCondition(typeof answer === 'string' && answer.length <= 2_000 && SAFE_ANSWER.test(answer),
    'Edge did not return a bounded recent-order answer.');

  const read = await request(`/v1/conversations/${conversationId}`, 'GET');
  const messages = read.body?.messages;
  requireCondition(read.status === 200 && read.body?.conversation_id === conversationId
    && read.body?.control_mode === 'AI' && Array.isArray(messages) && messages.length === 2,
  'Edge did not return a two-message AI transcript.');
  requireCondition(messages[0]?.sender_kind === 'END_CUSTOMER' && messages[0]?.content?.text === QUESTION
    && messages[1]?.sender_kind === 'ASSISTANT' && messages[1]?.content?.text === answer
    && messages.every(message => message.refund_workflow === undefined),
  'The persisted transcript did not match the read-only answer.');

  return { status: 'PASSED', conversationId, answerKind: answer.startsWith('Recent placed-order') ? 'REFERENCES' : 'EMPTY' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') {
    console.error('Usage: node tools/local/verify-recent-orders-chat.mjs --run');
    process.exitCode = 1;
  } else {
    try {
      requireCondition(Number(process.versions.node.split('.')[0]) === 24, 'Use Node.js 24.');
      console.log(JSON.stringify(await runRecentOrdersChatSmoke({ token: process.env.CSO_LOCAL_CUSTOMER_TOKEN })));
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Recent-order smoke failed.');
      process.exitCode = 1;
    }
  }
}

#!/usr/bin/env node
/**
 * Opt-in backend smoke for the deterministic named-variant stock route.
 * It persists one local chat; it never calls a model, Temporal, or commerce API.
 * Run only after the local stack is ready with Node 24 and an existing private
 * CSO_LOCAL_CUSTOMER_TOKEN in the process environment.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const edgeBase = 'http://127.0.0.1:3000';
const availabilityAnswer = /^The catalog lists (.{1,120}?) as (in stock|out of stock)\. Availability can change; this does not reserve an item\.$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseSmokeArguments(args) {
  const variantArguments = args.filter(argument => argument.startsWith('--variant='));
  requireCondition(args.length === 2 && args.includes('--run') && variantArguments.length === 1,
    'Use --run --variant="Exact product variant name".');
  const variant = variantArguments[0].slice('--variant='.length);
  // Keep this on the model-free stock branch even if a catalog happens to
  // contain words that the higher-priority action/status classifiers match.
  requireCondition(variant === variant.trim() && /^[A-Za-z0-9][A-Za-z0-9 /_-]{0,119}$/.test(variant)
    && !/\b(refund|return|exchange|cancel\w*|order|payment|policy|tracking|track|delivered|shipped|arrive|where|paid|no|never|dont)\b/i.test(variant),
  'Provide one exact, safe product variant name.');
  return { variant };
}

/** @param {{variant: string, token: string, fetchImpl?: typeof fetch}} input */
export async function runVariantAvailabilitySmoke({ variant, token, fetchImpl = fetch }) {
  // Validate again for library callers, not only CLI callers.
  parseSmokeArguments(['--run', `--variant=${variant}`]);
  requireCondition(typeof token === 'string' && token.length > 0, 'CSO_LOCAL_CUSTOMER_TOKEN is required.');

  async function edgeRequest(path, method, body) {
    let response;
    try {
      response = await fetchImpl(new URL(path, edgeBase), {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : {
            'content-type': 'application/json',
            'idempotency-key': `variant-availability-smoke-${randomUUID()}`,
          }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`Edge ${method} ${path} request failed.`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Edge ${method} ${path} returned invalid JSON.`);
    }
    requireCondition(response.ok && response.status < 300,
      `Edge ${method} ${path} returned HTTP ${response.status}.`);
    return { status: response.status, payload };
  }

  const created = await edgeRequest('/v1/conversations', 'POST', {});
  const conversationId = created.payload?.conversation_id;
  requireCondition(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)
    && created.payload?.status === 'OPEN' && created.payload?.control_mode === 'AI',
  'Edge did not create a fresh AI conversation.');

  const question = `Is ${variant} in stock?`;
  const posted = await edgeRequest(`/v1/conversations/${conversationId}/messages`, 'POST', {
    client_message_id: `variant-availability-smoke-${randomUUID()}`,
    content: { type: 'text', text: question },
  });
  requireCondition(posted.status === 202 && posted.payload?.conversation_id === conversationId,
    'Edge did not accept the named-variant chat turn.');
  requireCondition(posted.payload?.refund_workflow === undefined && posted.payload?.cancellation_request === undefined,
    'Edge unexpectedly returned a refund workflow or commerce action.');
  const assistant = posted.payload?.assistant_message;
  requireCondition(assistant?.content?.type === 'text' && typeof assistant.content.text === 'string',
    'Edge did not return a text answer.');
  const answer = assistant.content.text;
  const match = availabilityAnswer.exec(answer);
  requireCondition(answer.length <= 240 && match?.[1] === variant,
    'Edge did not return bounded availability for the exact variant with a no-reservation caveat.');

  const read = await edgeRequest(`/v1/conversations/${conversationId}`, 'GET');
  const transcript = read.payload;
  requireCondition(read.status === 200 && transcript?.conversation_id === conversationId
    && transcript?.control_mode === 'AI' && Array.isArray(transcript.messages)
    && transcript.messages.length === 2,
  'Edge did not return the fresh AI conversation transcript.');
  requireCondition(transcript.messages.every(message => message.refund_workflow === undefined),
    'A refund workflow link was persisted in the conversation.');
  const [customer, persistedAssistant] = transcript.messages;
  requireCondition(customer.sender_kind === 'END_CUSTOMER' && customer.content?.text === question
    && persistedAssistant.sender_kind === 'ASSISTANT' && persistedAssistant.content?.text === answer
    && persistedAssistant.message_id === assistant.message_id,
  'The persisted chat turn did not match the requested variant and answer.');

  return {
    status: 'PASSED', conversationId, variant,
    availability: match[2] === 'in stock' ? 'IN_STOCK' : 'OUT_OF_STOCK',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    console.log('Usage: node tools/local/verify-variant-availability.mjs --run --variant="Exact product variant name"');
  } else {
    try {
      requireCondition(Number(process.versions.node.split('.')[0]) === 24, 'Use Node.js 24 for this smoke check.');
      const { variant } = parseSmokeArguments(process.argv.slice(2));
      const result = await runVariantAvailabilitySmoke({ variant, token: process.env.CSO_LOCAL_CUSTOMER_TOKEN });
      console.log(JSON.stringify(result));
    } catch (error) {
      // Deliberately print no stack, HTTP response body, request headers, or token.
      console.error(error instanceof Error ? error.message : 'Variant availability smoke failed.');
      process.exitCode = 1;
    }
  }
}

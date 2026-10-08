import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createConversationService } from '../src/conversation-service.js';
import { createAesGcmMessageProtector, createAesGcmMessageUnprotector } from '../src/message-protection.js';
import { PostgresConversationRepository } from '../src/postgres-conversation-repository.js';
import { TEST_CONVERSATION_ID, TEST_SERVICE_CONTEXT } from './test-fixtures.js';

const startInput = { workflowId: 'refund-proposal-1', proposal: { proposalId: 'proposal-1', journeyType: 'REFUND',
  intent: { orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'FULL_ORDER', itemIds: [],
    requestedAmount: { amountMinor: 100, currency: 'USD' } } }, policyVersion: 'refund-policy-v1',
  access: { tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', requestId: 'request-1', traceId: 'trace-1' } };

test('a committed pending refund remains recoverable after human takeover without exposing a changed proposal', async () => {
  const calls: string[] = [];
  const pool = { async connect() { return { release() {}, async query(sql: string) {
    calls.push(sql);
    if (sql.includes('FROM conversation.conversations')) return { rowCount: 1, rows: [{ subject_customer_id: 'customer-42', control_mode: 'HUMAN', status: 'CLOSED' }] };
    if (sql.includes('FROM conversation.refund_start_reservations')) return { rowCount: 1, rows: [{
      workflow_id: startInput.workflowId, assistant_message_id: 'assistant-1', status: 'PENDING',
      created_at: new Date('2026-10-02T12:00:00.000Z'),
      start_input_ciphertext: Buffer.from('encrypted'), start_input_iv: Buffer.alloc(12),
      start_input_tag: Buffer.alloc(16), start_input_key_version: 'test-v1',
      start_input_sha256: createHash('sha256').update(JSON.stringify(startInput)).digest('hex'), start_input_length: JSON.stringify(startInput).length,
    }] };
    return { rowCount: 0, rows: [] };
  } }; } } as unknown as Pool;
  const repository = new PostgresConversationRepository(pool, () => JSON.stringify(startInput));
  const result = await repository.findRefundStart(TEST_SERVICE_CONTEXT, TEST_CONVERSATION_ID, 'assistant-client-1');
  assert.deepEqual(result, { workflowId: startInput.workflowId, assistantMessageId: 'assistant-1', status: 'PENDING', createdAt: '2026-10-02T12:00:00.000Z', startInput });
  assert.equal(calls.at(-1), 'COMMIT');
});

test('a second idempotency key cannot silently replay a changed refund proposal under the same assistant client ID', async () => {
  const key = Buffer.alloc(32, 7);
  const protect = createAesGcmMessageProtector({ key, keyVersion: 'test-v1' });
  const unprotect = createAesGcmMessageUnprotector({ key, keyVersion: 'test-v1' });
  const stored = protect(JSON.stringify(startInput));
  const text = 'I captured your request.';
  const protectedText = protect(text);
  const pool = { async connect() { return { release() {}, async query(sql: string) {
    if (sql.includes('SELECT subject_customer_id')) return { rowCount: 1, rows: [{ subject_customer_id: 'customer-42', control_mode: 'AI', control_version: '1' }] };
    if (sql.includes('FROM conversation.messages')) return { rowCount: 1, rows: [{ message_id: 'assistant-existing', sequence_number: '2', content_sha256: protectedText.plaintextSha256 }] };
    if (sql.includes('FROM conversation.refund_start_reservations')) return { rowCount: 1, rows: [{
      workflow_id: startInput.workflowId, assistant_message_id: 'assistant-existing', status: 'PENDING',
      created_at: new Date('2026-10-02T12:00:00.000Z'),
      start_input_ciphertext: stored.ciphertext, start_input_iv: stored.initializationVector,
      start_input_tag: stored.authenticationTag, start_input_key_version: stored.encryptionKeyVersion,
      start_input_sha256: stored.plaintextSha256, start_input_length: stored.plaintextByteLength,
    }] };
    return { rowCount: 0, rows: [] };
  } }; } } as unknown as Pool;
  const service = createConversationService({ repository: new PostgresConversationRepository(pool, unprotect), protectMessage: protect });
  await assert.rejects(service.appendAssistantMessage({
    context: TEST_SERVICE_CONTEXT, conversationId: TEST_CONVERSATION_ID,
    idempotencyKey: 'new-key', clientMessageId: 'same-assistant-client', text,
    refundWorkflowId: startInput.workflowId,
    refundStartInput: { ...startInput, proposal: { ...startInput.proposal,
      intent: { ...startInput.proposal.intent, requestedAmount: { amountMinor: 200, currency: 'USD' } } } },
  }));
});

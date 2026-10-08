import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PostgresConversationRepository } from '../src/postgres-conversation-repository.js';
import { createTestConversationService, FakeConversationRepository, TEST_PROTECTED_MESSAGE, TEST_SERVICE_CONTEXT, TEST_CONVERSATION_ID } from './test-fixtures.js';
import { createConversationService } from '../src/conversation-service.js';

function setup(mode: string, version: number) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { async connect() { return { release() {}, async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes('SELECT subject_customer_id')) return { rowCount: 1, rows: [{ subject_customer_id: 'customer-42', control_mode: mode, control_version: String(version) }] };
    if (sql.includes('RETURNING next_sequence_number')) return { rowCount: 1, rows: [{ sequence_number: '2' }] };
    return { rowCount: 0, rows: [] };
  } }; } } as unknown as Pool;
  const repository = new PostgresConversationRepository(pool, () => 'unused');
  return { calls, service: createConversationService({ repository, protectMessage: () => TEST_PROTECTED_MESSAGE }) };
}
const base = { context: TEST_SERVICE_CONTEXT, conversationId: TEST_CONVERSATION_ID, idempotencyKey: 'assistant-1', clientMessageId: 'turn-1', text: 'Response' };
const startInput = { workflowId: 'refund-1', proposal: { proposalId: '1', journeyType: 'REFUND' as const,
  intent: { orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'FULL_ORDER' as const, itemIds: [],
    requestedAmount: { amountMinor: 100, currency: 'USD' } } }, policyVersion: 'v1',
  access: { tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', requestId: 'r1', traceId: 't1' } };

test('assistant commits and refund reservations are fenced atomically by exact AI control epoch', async () => {
  for (const [mode, current, expected] of [['HUMAN', 3, 1], ['QUEUED', 2, 1], ['AI', 4, 1], ['AI', 4, undefined]] as const) {
    const { service, calls } = setup(mode, current);
    await assert.rejects(service.appendAssistantMessage({ ...base, ...(expected === undefined ? {} : { expectedControlVersion: expected }), refundWorkflowId: 'refund-1', refundStartInput: startInput }));
    assert.equal(calls.some((entry) => entry.sql.includes('INSERT INTO conversation.messages')), false);
    assert.equal(calls.some((entry) => entry.sql.includes('INSERT INTO conversation.refund_start_reservations')), false);
    assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
  }
});

test('an accepted ready refund message reserves its deterministic workflow in the same transaction', async () => {
  const { service, calls } = setup('AI', 4);
  const result = await service.appendAssistantMessage({ ...base, expectedControlVersion: 4, refundWorkflowId: 'refund-1', refundStartInput: startInput });
  assert.deepEqual(result.refundStart, { workflowId: 'refund-1', status: 'PENDING', startInput });
  const reservation = calls.find((entry) => entry.sql.includes('INSERT INTO conversation.refund_start_reservations'));
  assert.ok(reservation?.values.includes('refund-1')); assert.ok(reservation?.values.includes(4));
  assert.equal(calls.at(-1)?.sql, 'COMMIT');
});

test('legacy assistant append is compatible only with the untouched initial AI epoch', async () => {
  const { service } = setup('AI', 1);
  assert.equal((await service.appendAssistantMessage(base)).status, 'ACCEPTED');
});

test('service binds requested epoch and reservation identity into idempotency request hash', async () => {
  const repository = new FakeConversationRepository();
  const service = createTestConversationService(repository);
  await service.appendAssistantMessage({ ...base, expectedControlVersion: 1, refundWorkflowId: 'refund-1', refundStartInput: startInput });
  assert.equal(repository.assistantMessageRecord?.expectedControlVersion, 1);
  assert.equal(repository.assistantMessageRecord?.refundWorkflowId, 'refund-1');
});

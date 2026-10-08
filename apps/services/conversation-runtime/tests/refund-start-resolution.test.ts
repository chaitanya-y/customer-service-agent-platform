import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PostgresConversationRepository } from '../src/postgres-conversation-repository.js';
import { createConversationService } from '../src/conversation-service.js';
import { TEST_SERVICE_CONTEXT, TEST_CONVERSATION_ID, TEST_PROTECTED_MESSAGE } from './test-fixtures.js';

function setup(reservationStatus: string, customerId = 'customer-42') {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { async connect() { return { release() {}, async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes('FROM conversation.conversations')) return { rowCount: 1, rows: [{ subject_customer_id: customerId, control_mode: 'HUMAN', control_version: '3', status: 'CLOSED' }] };
    if (sql.includes('FROM conversation.refund_start_reservations')) return { rowCount: 1, rows: [{ workflow_id: 'refund-1', status: reservationStatus }] };
    return { rowCount: 0, rows: [] };
  } }; } } as unknown as Pool;
  return { calls, service: createConversationService({ repository: new PostgresConversationRepository(pool, () => 'unused'), protectMessage: () => TEST_PROTECTED_MESSAGE }) };
}
const input = { context: TEST_SERVICE_CONTEXT, conversationId: TEST_CONVERSATION_ID, workflowId: 'refund-1', idempotencyKey: 'resolve-1' };
test('an accepted refund start can resolve after human takeover or closure without gaining new action authority', async () => {
  const { calls, service } = setup('PENDING');
  assert.deepEqual(await service.resolveRefundStart({ ...input, status: 'STARTED' }), { workflowId: 'refund-1', status: 'STARTED' });
  assert.ok(calls.some((entry) => entry.sql.includes('UPDATE conversation.refund_start_reservations')));
  assert.ok(calls.some((entry) => entry.sql.includes('INSERT INTO events.idempotency_keys')));
  assert.equal(calls.at(-1)?.sql, 'COMMIT');
});
test('foreign customers and contradictory terminal reservation outcomes never update the ledger', async () => {
  for (const [status, customer] of [['ABORTED', 'customer-42'], ['PENDING', 'other']]) {
    const { calls, service } = setup(status, customer);
    await assert.rejects(service.resolveRefundStart({ ...input, status: 'STARTED' }));
    assert.equal(calls.some((entry) => entry.sql.includes('UPDATE conversation.refund_start_reservations')), false);
    assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
  }
});

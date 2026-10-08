import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PostgresHandoffService } from '../src/handoff-service.js';
import { TEST_CONTEXT, TEST_CONVERSATION_ID, TEST_PROTECTED_MESSAGE } from './test-fixtures.js';
import { canonicalHandoffBodyHash, type StaffAccessContext } from '../src/staff-assertion.js';

const session = '019c321e-8650-7000-8000-000000000002';
const queued = { conversation_id: TEST_CONVERSATION_ID, subject_customer_id: 'customer-42', status: 'OPEN', control_mode: 'QUEUED', control_version: '2', handoff_session_id: session, assigned_staff_id: null, queued_at: new Date('2026-10-02T12:00:00Z') };
function staff(purpose: string, body: unknown, overrides = {}): StaffAccessContext {
  const suffix = { handoff_claim: 'claim', handoff_reply: 'messages', handoff_return_to_ai: 'return-to-ai', handoff_close: 'close' }[purpose];
  return { tenantId: 'tenant-local', environmentId: 'local', staffId: 'staff-1', role: 'SUPPORT_AGENT', purpose, requestId: 'request-1', traceId: 'trace-1', routingEpoch: 1, iss: 'customer-service-os-human-operations', aud: 'conversation-runtime-handoff', iat: 1, exp: 2, httpMethod: 'POST', path: `/v1/internal/handoffs/${TEST_CONVERSATION_ID}/${suffix}`, conversationId: TEST_CONVERSATION_ID, handoffSessionId: session, expectedControlVersion: 2, idempotencyKey: 'staff-command-1', requestBodySha256: canonicalHandoffBodyHash(body), ...overrides } as StaffAccessContext;
}
function fakePool(row: unknown, calls: { sql: string; values: unknown[] }[], duplicate?: unknown) {
  return { async connect() { return { release() {}, async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes('FROM conversation.conversations')) return { rowCount: 1, rows: [row] };
    if (sql.includes('FROM events.idempotency_keys') && duplicate) return { rowCount: 1, rows: [duplicate] };
    if (sql.includes('RETURNING next_sequence_number')) return { rowCount: 1, rows: [{ sequence_number: '4' }] };
    return { rowCount: 0, rows: [] };
  } }; } } as unknown as Pool;
}

test('request handoff locks the owned conversation and commits control plus idempotency plus outbox together', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = { async connect() { return { release() {}, async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes('FROM conversation.conversations')) return { rowCount: 1, rows: [{ subject_customer_id: 'customer-42', status: 'OPEN', control_mode: 'AI', control_version: '1', handoff_session_id: null, assigned_staff_id: null, queued_at: null }] };
    return { rowCount: 0, rows: [] };
  } }; } } as unknown as Pool;
  const service = new PostgresHandoffService(pool, () => TEST_PROTECTED_MESSAGE, () => 'unused', () => '019c321e-8650-7000-8000-000000000002');
  const response = await service.request({ context: TEST_CONTEXT, conversationId: TEST_CONVERSATION_ID, idempotencyKey: 'handoff-1', expectedControlVersion: 1 });
  assert.equal(response.controlMode, 'QUEUED'); assert.equal(response.controlVersion, 2);
  assert.equal(calls[0]?.sql, 'BEGIN'); assert.equal(calls.at(-1)?.sql, 'COMMIT');
  const locked = calls.find((entry) => entry.sql.includes('FROM conversation.conversations'));
  assert.match(locked?.sql ?? '', /FOR UPDATE/);
  assert.deepEqual(locked?.values, ['tenant-local', 'local', TEST_CONVERSATION_ID]);
  assert.ok(calls.some((entry) => entry.sql.includes('INSERT INTO events.idempotency_keys')));
  assert.ok(calls.some((entry) => entry.sql.includes('INSERT INTO events.outbox')));
  assert.equal(JSON.stringify(response).includes('assignedStaffId'), false);
});

test('staff claim derives assignment only from verified actor and validates the exact signed command', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const body = { handoffSessionId: session, expectedControlVersion: 2 };
  const service = new PostgresHandoffService(fakePool(queued, calls), () => TEST_PROTECTED_MESSAGE, () => 'unused');
  const result = await service.command({ context: staff('handoff_claim', body), conversationId: TEST_CONVERSATION_ID, action: 'claim', body, idempotencyKey: 'staff-command-1' });
  assert.equal('controlMode' in result ? result.controlMode : undefined, 'HUMAN');
  const update = calls.find((entry) => entry.sql.includes('UPDATE conversation.conversations'));
  assert.equal(update?.values[7], 'staff-1');
  const before = calls.length;
  await assert.rejects(service.command({ context: staff('handoff_claim', body), conversationId: TEST_CONVERSATION_ID, action: 'close', body, idempotencyKey: 'staff-command-1' }));
  await assert.rejects(service.command({ context: staff('handoff_claim', body), conversationId: TEST_CONVERSATION_ID, action: 'claim', body: { ...body, expectedControlVersion: 3 }, idempotencyKey: 'staff-command-1' }));
  await assert.rejects(service.command({ context: staff('handoff_claim', body), conversationId: TEST_CONVERSATION_ID, action: 'claim', body, idempotencyKey: 'other-key' }));
  assert.equal(calls.length, before);
});

test('assigned staff reply shares ordered transcript and commits ciphertext, idempotency and outbox without plaintext', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const body = { handoffSessionId: session, expectedControlVersion: 3, clientMessageId: 'reply-1', content: { type: 'text' as const, text: 'private support reply' } };
  let protectedText = '';
  const service = new PostgresHandoffService(fakePool({ ...queued, control_mode: 'HUMAN', control_version: '3', assigned_staff_id: 'staff-1' }, calls), (text) => { protectedText = text; return TEST_PROTECTED_MESSAGE; }, () => 'unused');
  const result = await service.command({ context: staff('handoff_reply', body, { expectedControlVersion: 3 }), conversationId: TEST_CONVERSATION_ID, action: 'reply', body, idempotencyKey: 'staff-command-1' });
  assert.equal(protectedText, 'private support reply'); assert.ok('message' in result); assert.equal(result.message.sequenceNumber, 4);
  const message = calls.find((entry) => entry.sql.includes('INSERT INTO conversation.messages'));
  assert.ok(message?.values.includes('WORKFORCE')); assert.ok(message?.values.includes(session));
  assert.equal(calls.some((entry) => entry.values.includes('private support reply')), false);
  assert.equal(calls.at(-1)?.sql, 'COMMIT');
});

test('idempotent handoff retry returns exact stored outcome despite changed control epoch and rejects body reuse', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const expected = { conversationId: TEST_CONVERSATION_ID, status: 'OPEN', controlMode: 'QUEUED', controlVersion: 2, handoffSessionId: session };
  const duplicate = { canonical_request_hash: canonicalHandoffBodyHash({ expectedControlVersion: 1 }), result_json: expected };
  const service = new PostgresHandoffService(fakePool({ ...queued, control_mode: 'HUMAN', control_version: '3', assigned_staff_id: 'staff-1' }, calls, duplicate), () => TEST_PROTECTED_MESSAGE, () => 'unused');
  assert.deepEqual(await service.request({ context: TEST_CONTEXT, conversationId: TEST_CONVERSATION_ID, idempotencyKey: 'handoff-1', expectedControlVersion: 1 }), expected);
  assert.equal(calls.some((entry) => entry.sql.includes('UPDATE conversation.conversations')), false);
  await assert.rejects(service.request({ context: TEST_CONTEXT, conversationId: TEST_CONVERSATION_ID, idempotencyKey: 'handoff-1', expectedControlVersion: 2 }));
});

test('a lost close response replays its stored result after detail becomes unavailable', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const body = { handoffSessionId: session, expectedControlVersion: 3 };
  const completed = { conversationId: TEST_CONVERSATION_ID, status: 'CLOSED', controlMode: 'HUMAN', controlVersion: 4, handoffSessionId: session };
  const duplicate = { canonical_request_hash: canonicalHandoffBodyHash(body), result_json: completed };
  const closed = { ...queued, status: 'CLOSED', control_mode: 'HUMAN', control_version: '4', assigned_staff_id: 'staff-1' };
  const service = new PostgresHandoffService(fakePool(closed, calls, duplicate), () => TEST_PROTECTED_MESSAGE, () => 'unused');
  const readContext = staff('handoff_close', body, {
    purpose: 'handoff_read', httpMethod: 'GET', path: `/v1/internal/handoffs/${TEST_CONVERSATION_ID}`,
  });

  await assert.rejects(service.detail(readContext, TEST_CONVERSATION_ID));
  assert.deepEqual(await service.command({
    context: staff('handoff_close', body, { expectedControlVersion: 3 }),
    conversationId: TEST_CONVERSATION_ID, action: 'close', body, idempotencyKey: 'staff-command-1',
  }), completed);
  assert.equal(calls.some((entry) => entry.sql.includes('UPDATE conversation.conversations')), false);
  assert.equal(calls.some((entry) => entry.sql.includes('INSERT INTO events.outbox')), false);
});

test('a lost return-to-AI response replays after staff transcript access ends', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const body = { handoffSessionId: session, expectedControlVersion: 3 };
  const completed = { conversationId: TEST_CONVERSATION_ID, status: 'OPEN', controlMode: 'AI', controlVersion: 4 };
  const duplicate = { canonical_request_hash: canonicalHandoffBodyHash(body), result_json: completed };
  const returned = { ...queued, status: 'OPEN', control_mode: 'AI', control_version: '4', handoff_session_id: null, assigned_staff_id: null };
  const service = new PostgresHandoffService(fakePool(returned, calls, duplicate), () => TEST_PROTECTED_MESSAGE, () => 'unused');
  const readContext = staff('handoff_return_to_ai', body, {
    purpose: 'handoff_read', httpMethod: 'GET', path: `/v1/internal/handoffs/${TEST_CONVERSATION_ID}`,
  });

  await assert.rejects(service.detail(readContext, TEST_CONVERSATION_ID));
  assert.deepEqual(await service.command({
    context: staff('handoff_return_to_ai', body, { expectedControlVersion: 3 }),
    conversationId: TEST_CONVERSATION_ID, action: 'return_to_ai', body, idempotencyKey: 'staff-command-1',
  }), completed);
  assert.equal(calls.some((entry) => entry.sql.includes('UPDATE conversation.conversations')), false);
});

test('staff queue is bounded to queued and own-assigned chats with computed action flags', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const context = { tenantId: 'tenant-local', environmentId: 'local', staffId: 'staff-1', role: 'SUPPORT_AGENT', purpose: 'handoff_list', requestId: 'request-1', traceId: 'trace-1', routingEpoch: 1, httpMethod: 'GET', path: '/v1/internal/handoffs' } as StaffAccessContext;
  const service = new PostgresHandoffService(fakePool(queued, calls), () => TEST_PROTECTED_MESSAGE, () => 'unused');
  const response = await service.list(context, 50, 0);
  assert.equal(response.items[0]?.canClaim, true); assert.equal(response.items[0]?.canReply, false);
  assert.equal(response.items[0]?.queuedAt, '2026-10-02T12:00:00.000Z');
  const query = calls.find((entry) => entry.sql.includes('FROM conversation.conversations'));
  assert.match(query?.sql ?? '', /assigned_staff_id/); assert.ok(query?.values.includes('staff-1')); assert.ok(query?.values.includes(51));
  assert.equal(JSON.stringify(response).includes('subject_customer_id'), false);
});

test('detail masks a chat assigned to another staff member before decrypting any transcript', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const context = { tenantId: 'tenant-local', environmentId: 'local', staffId: 'staff-2', role: 'SUPPORT_AGENT', purpose: 'handoff_read', conversationId: TEST_CONVERSATION_ID, requestId: 'request-1', traceId: 'trace-1', routingEpoch: 1, httpMethod: 'GET', path: `/v1/internal/handoffs/${TEST_CONVERSATION_ID}` } as StaffAccessContext;
  const service = new PostgresHandoffService(fakePool({ ...queued, control_mode: 'HUMAN', control_version: '3', assigned_staff_id: 'staff-1' }, calls), () => TEST_PROTECTED_MESSAGE, () => { throw new Error('No decrypt allowed'); });
  await assert.rejects(service.detail(context, TEST_CONVERSATION_ID));
  assert.equal(calls.some((entry) => entry.sql.includes('FROM conversation.messages')), false);
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
});

test('detail decrypts ordered shared transcript and reports pending accepted refund starts', async () => {
  const context = { tenantId: 'tenant-local', environmentId: 'local', staffId: 'staff-1', role: 'SUPPORT_AGENT', purpose: 'handoff_read', conversationId: TEST_CONVERSATION_ID, requestId: 'request-1', traceId: 'trace-1', routingEpoch: 1, httpMethod: 'GET', path: `/v1/internal/handoffs/${TEST_CONVERSATION_ID}` } as StaffAccessContext;
  const pool = { async connect() { return { release() {}, async query(sql: string) {
    if (sql.includes('FROM conversation.conversations')) return { rowCount: 1, rows: [queued] };
    if (sql.includes('FROM conversation.messages')) return { rowCount: 1, rows: [{ message_id: 'message-1', sequence_number: '1', sender_kind: 'WORKFORCE', content_length: TEST_PROTECTED_MESSAGE.plaintextByteLength, content_sha256: TEST_PROTECTED_MESSAGE.plaintextSha256, created_at: new Date('2026-10-02T12:00:00Z'), refund_workflow_id: null, ciphertext: TEST_PROTECTED_MESSAGE.ciphertext, initialization_vector: TEST_PROTECTED_MESSAGE.initializationVector, authentication_tag: TEST_PROTECTED_MESSAGE.authenticationTag, encryption_key_version: TEST_PROTECTED_MESSAGE.encryptionKeyVersion }] };
    if (sql.includes('FROM conversation.refund_start_reservations')) return { rowCount: 1, rows: [{ workflow_id: 'refund-accepted' }] };
    return { rowCount: 0, rows: [] };
  } }; } } as unknown as Pool;
  const service = new PostgresHandoffService(pool, () => TEST_PROTECTED_MESSAGE, (protectedMessage) => { assert.deepEqual(protectedMessage, TEST_PROTECTED_MESSAGE); return 'Visible reply'; });
  const result = await service.detail(context, TEST_CONVERSATION_ID);
  assert.deepEqual(result.pendingRefundStarts, [{ workflowId: 'refund-accepted', status: 'PENDING' }]); assert.equal(result.workflowStartPending, true);
  assert.equal(result.messages[0]?.senderKind, 'WORKFORCE'); assert.equal(result.messages[0]?.text, 'Visible reply');
  assert.equal(JSON.stringify(result).includes('ciphertext'), false); assert.equal(JSON.stringify(result).includes('subject_customer_id'), false);
});

test('foreign customers and stale commands roll back without a control write', async () => {
  for (const fields of [{ subject_customer_id: 'other', control_version: '1' }, { subject_customer_id: 'customer-42', control_version: '2' }]) {
    const calls: string[] = [];
    const pool = { async connect() { return { release() {}, async query(sql: string) {
      calls.push(sql);
      if (sql.includes('FROM conversation.conversations')) return { rowCount: 1, rows: [{ ...fields, status: 'OPEN', control_mode: 'AI', handoff_session_id: null, assigned_staff_id: null, queued_at: null }] };
      return { rowCount: 0, rows: [] };
    } }; } } as unknown as Pool;
    const service = new PostgresHandoffService(pool, () => TEST_PROTECTED_MESSAGE, () => 'unused');
    await assert.rejects(service.request({ context: TEST_CONTEXT, conversationId: TEST_CONVERSATION_ID, idempotencyKey: 'handoff-1', expectedControlVersion: 1 }));
    assert.equal(calls.at(-1), 'ROLLBACK'); assert.equal(calls.some((sql) => sql.includes('UPDATE conversation.conversations')), false);
  }
});

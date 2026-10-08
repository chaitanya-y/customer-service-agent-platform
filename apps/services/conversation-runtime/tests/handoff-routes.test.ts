import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createTestConversationService, FakeConversationRepository, TEST_CONTEXT, TEST_CONVERSATION_ID } from './test-fixtures.js';
import { StaffAssertionError, type StaffAccessContext } from '../src/staff-assertion.js';

test('staff routes require a distinct assertion and exact bound method/path before service access', async (context) => {
  let calls = 0;
  const staff = { tenantId: 'tenant-local', environmentId: 'local', staffId: 'staff-1', role: 'SUPPORT_AGENT', purpose: 'handoff_list', requestId: 'request-1', traceId: 'trace-1', routingEpoch: 1, httpMethod: 'GET', path: '/v1/internal/handoffs' } as StaffAccessContext;
  const app = buildApp({ verifyContextAssertion: async () => TEST_CONTEXT, verifyServiceAssertion: async () => { throw new Error('No service access'); }, verifyStaffAssertion: async (assertion) => { if (assertion !== 'staff-token') throw new StaffAssertionError(); return staff; }, checkHealth: async () => {}, conversationService: createTestConversationService(new FakeConversationRepository()), handoffService: { async list() { calls += 1; return { items: [], hasMore: false }; } } as never });
  context.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/v1/internal/handoffs', headers: { 'x-cso-context-assertion': 'customer-token' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/internal/handoffs/${TEST_CONVERSATION_ID}`, headers: { 'x-cso-conversation-staff-assertion': 'staff-token' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/internal/handoffs?limit=101', headers: { 'x-cso-conversation-staff-assertion': 'staff-token' } })).statusCode, 400);
  const response = await app.inject({ method: 'GET', url: '/v1/internal/handoffs?limit=10&offset=0', headers: { 'x-cso-conversation-staff-assertion': 'staff-token' } });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json().data, { items: [], hasMore: false }); assert.equal(calls, 1);
});

test('customer handoff accepts only strict version commands and returns no staff identity', async (context) => {
  let calls = 0;
  const app = buildApp({ verifyContextAssertion: async () => TEST_CONTEXT, verifyServiceAssertion: async () => { throw new Error('No service access'); }, checkHealth: async () => {}, conversationService: createTestConversationService(new FakeConversationRepository()), handoffService: {
    async request(input: { context: typeof TEST_CONTEXT; conversationId: string; expectedControlVersion: number; idempotencyKey: string }) {
      calls += 1; assert.equal(input.context.subjectCustomerId, 'customer-42'); assert.equal(input.expectedControlVersion, 1);
      return { conversationId: TEST_CONVERSATION_ID, status: 'OPEN', controlMode: 'QUEUED', controlVersion: 2, handoffSessionId: '019c321e-8650-7000-8000-000000000002' };
    },
  } as never });
  context.after(() => app.close());
  for (const payload of [{}, { expectedControlVersion: 1, staffId: 'other' }, { expectedControlVersion: 0 }]) {
    assert.equal((await app.inject({ method: 'POST', url: `/v1/conversations/${TEST_CONVERSATION_ID}/handoff`, headers: { 'idempotency-key': 'handoff-1' }, payload })).statusCode, 400);
  }
  const response = await app.inject({ method: 'POST', url: `/v1/conversations/${TEST_CONVERSATION_ID}/handoff`, headers: { 'idempotency-key': 'handoff-1' }, payload: { expectedControlVersion: 1 } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().data.controlMode, 'QUEUED'); assert.equal(calls, 1);
  assert.equal(response.body.includes('staffId'), false);
});

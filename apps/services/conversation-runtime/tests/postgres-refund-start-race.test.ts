import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createConversationService } from '../src/conversation-service.js';
import { PostgresHandoffService } from '../src/handoff-service.js';
import { createAesGcmMessageProtector, createAesGcmMessageUnprotector } from '../src/message-protection.js';
import { PostgresConversationRepository } from '../src/postgres-conversation-repository.js';

const databaseUrl = process.env.CONVERSATION_TEST_DATABASE_URL;

test('PostgreSQL serializes handoff against assistant refund reservation and replays the exact encrypted start',
  { skip: databaseUrl ? false : 'CONVERSATION_TEST_DATABASE_URL is not set; apply migrations 004 and 005 to a disposable test DB first' },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    const key = Buffer.alloc(32, 8);
    const protect = createAesGcmMessageProtector({ key, keyVersion: 'refund-race-test-v1' });
    const unprotect = createAesGcmMessageUnprotector({ key, keyVersion: 'refund-race-test-v1' });
    const repository = new PostgresConversationRepository(pool, unprotect);
    const conversation = createConversationService({ repository, protectMessage: protect });
    const handoff = new PostgresHandoffService(pool, protect, unprotect);
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const context = { contextId: `context-${unique}`, tenantId: `tenant-${unique}`, environmentId: 'integration-test',
      subjectCustomerId: `customer-${unique}`, routingEpoch: 1, requestId: `request-${unique}`, traceId: `trace-${unique}` };
    const serviceContext = { tenantId: context.tenantId, environmentId: context.environmentId,
      subjectCustomerId: context.subjectCustomerId, routingEpoch: 1, requestId: `edge-${unique}`, traceId: `edge-trace-${unique}` };
    try {
      const created = await conversation.createConversation({ context, idempotencyKey: `create-${unique}`, channel: 'web' });
      const startInput = { workflowId: `refund-${unique}`, proposal: { proposalId: unique, journeyType: 'REFUND' as const,
        intent: { orderId: `order-${unique}`, reasonCode: 'DAMAGED', scope: 'FULL_ORDER' as const,
          itemIds: [], requestedAmount: { amountMinor: 100, currency: 'USD' } } }, policyVersion: 'refund-policy-v1',
        access: { tenantId: context.tenantId, environmentId: context.environmentId,
          subjectCustomerId: context.subjectCustomerId, requestId: context.requestId, traceId: context.traceId } };
      const assistant = { context: serviceContext, conversationId: created.conversationId,
        idempotencyKey: `assistant-${unique}`, clientMessageId: `assistant-client-${unique}`,
        text: 'Your request is captured.', expectedControlVersion: 1, refundWorkflowId: startInput.workflowId, refundStartInput: startInput };
      const [appendResult, handoffResult] = await Promise.allSettled([
        conversation.appendAssistantMessage(assistant),
        handoff.request({ context, conversationId: created.conversationId, expectedControlVersion: 1, idempotencyKey: `handoff-${unique}` }),
      ]);
      assert.equal(handoffResult.status, 'fulfilled');
      if (appendResult.status === 'fulfilled') {
        assert.equal(appendResult.value.refundStart?.status, 'PENDING');
        const recovered = await conversation.findRefundStart({ context: serviceContext,
          conversationId: created.conversationId, assistantClientMessageId: assistant.clientMessageId });
        assert.deepEqual(recovered?.startInput, startInput);
        const replay = await conversation.appendAssistantMessage(assistant);
        assert.equal(replay.messageId, appendResult.value.messageId);
        assert.deepEqual(replay.refundStart?.startInput, startInput);
      } else {
        const missing = await conversation.findRefundStart({ context: serviceContext,
          conversationId: created.conversationId, assistantClientMessageId: assistant.clientMessageId });
        assert.equal(missing, undefined);
      }
    } finally {
      await pool.end();
    }
  });

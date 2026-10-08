import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createConversationService,
  MessageTooLargeError,
} from '../src/conversation-service.js';
import {
  createTestConversationService,
  FakeConversationRepository,
  TEST_CONTEXT,
  TEST_CONVERSATION_ID,
  TEST_MESSAGE_ID,
  TEST_PROTECTED_MESSAGE,
  TEST_SERVICE_CONTEXT,
} from './test-fixtures.js';

test('creates a conversation under trusted tenant and customer scope', async () => {
  const repository = new FakeConversationRepository();
  const service = createTestConversationService(repository);

  const result = await service.createConversation({
    context: TEST_CONTEXT,
    idempotencyKey: 'create-1',
    channel: 'web',
  });

  assert.deepEqual(result, {
    conversationId: TEST_CONVERSATION_ID,
    status: 'OPEN',
    controlMode: 'AI',
    controlVersion: 1,
  });
  assert.equal(repository.createRecord?.context, TEST_CONTEXT);
  assert.match(repository.createRecord?.canonicalRequestHash ?? '', /^[a-f0-9]{64}$/);
});

test('prepares an encrypted message record for atomic persistence', async () => {
  const repository = new FakeConversationRepository();
  const service = createTestConversationService(repository);

  const result = await service.acceptMessage({
    context: TEST_CONTEXT,
    conversationId: TEST_CONVERSATION_ID,
    idempotencyKey: 'message-1',
    clientMessageId: 'browser-message-1',
    text: 'Please refund me.',
  });

  assert.deepEqual(result, {
    conversationId: TEST_CONVERSATION_ID,
    messageId: TEST_MESSAGE_ID,
    sequenceNumber: 1,
    status: 'ACCEPTED',
  });
  assert.equal(repository.messageRecord?.context, TEST_CONTEXT);
  assert.equal(
    repository.messageRecord?.protectedMessage,
    TEST_PROTECTED_MESSAGE,
  );
  assert.match(repository.messageRecord?.canonicalRequestHash ?? '', /^[a-f0-9]{64}$/);
});

test('prepares an encrypted assistant record with its Edge service scope', async () => {
  const repository = new FakeConversationRepository();
  const service = createTestConversationService(repository);

  const result = await service.appendAssistantMessage({
    context: TEST_SERVICE_CONTEXT,
    conversationId: TEST_CONVERSATION_ID,
    idempotencyKey: 'assistant-message-1',
    clientMessageId: 'agent-turn-1',
    text: 'I can help with that.',
  });

  assert.deepEqual(result, {
    conversationId: TEST_CONVERSATION_ID,
    messageId: '019c321e-8650-7000-8000-000000000003',
    sequenceNumber: 2,
    status: 'ACCEPTED',
  });
  assert.equal(repository.assistantMessageRecord?.context, TEST_SERVICE_CONTEXT);
  assert.equal(
    repository.assistantMessageRecord?.protectedMessage,
    TEST_PROTECTED_MESSAGE,
  );
});

test('refund assistant commit encrypts and binds the exact Temporal start intent', async () => {
  const repository = new FakeConversationRepository();
  const protectedTexts: string[] = [];
  const service = createConversationService({
    repository,
    protectMessage: (text) => { protectedTexts.push(text); return TEST_PROTECTED_MESSAGE; },
    createId: () => TEST_MESSAGE_ID,
  });
  const startInput = {
    workflowId: 'refund-proposal-1', proposal: { proposalId: 'proposal-1', journeyType: 'REFUND' as const,
      intent: { orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'FULL_ORDER' as const,
        itemIds: [], requestedAmount: { amountMinor: 100, currency: 'USD' } } },
    policyVersion: 'refund-policy-v1', access: {
      tenantId: TEST_SERVICE_CONTEXT.tenantId, environmentId: TEST_SERVICE_CONTEXT.environmentId,
      subjectCustomerId: TEST_SERVICE_CONTEXT.subjectCustomerId,
      requestId: 'request-1', traceId: 'trace-1',
    },
  };
  await service.appendAssistantMessage({
    context: TEST_SERVICE_CONTEXT, conversationId: TEST_CONVERSATION_ID,
    idempotencyKey: 'assistant-refund-1', clientMessageId: 'assistant-client-1',
    text: 'I have captured your refund request.', refundWorkflowId: 'refund-proposal-1', refundStartInput: startInput,
  });
  assert.equal(protectedTexts[1], JSON.stringify(startInput));
  assert.equal(repository.assistantMessageRecord?.protectedRefundStartInput, TEST_PROTECTED_MESSAGE);
  assert.match(repository.assistantMessageRecord?.canonicalRequestHash ?? '', /^[a-f0-9]{64}$/);
  await assert.rejects(service.appendAssistantMessage({
    context: TEST_SERVICE_CONTEXT, conversationId: TEST_CONVERSATION_ID,
    idempotencyKey: 'assistant-refund-2', clientMessageId: 'assistant-client-2',
    text: 'Changed.', refundWorkflowId: 'refund-proposal-1',
    refundStartInput: { ...startInput, access: { ...startInput.access, subjectCustomerId: 'other' } },
  }));
});

test('prepares an idempotent workflow link scoped to the assistant message', async () => {
  const repository = new FakeConversationRepository();
  const service = createTestConversationService(repository);

  const result = await service.linkRefundWorkflow({
    context: TEST_SERVICE_CONTEXT,
    conversationId: TEST_CONVERSATION_ID,
    messageId: '019c321e-8650-7000-8000-000000000003',
    workflowId: 'refund-proposal-001',
    idempotencyKey: 'assistant-workflow-link-1',
  });

  assert.deepEqual(result, {
    status: 'linked',
    workflowId: 'refund-proposal-001',
  });
  assert.equal(repository.refundWorkflowLinkRecord?.context, TEST_SERVICE_CONTEXT);
  assert.equal(repository.refundWorkflowLinkRecord?.workflowId, 'refund-proposal-001');
  assert.match(
    repository.refundWorkflowLinkRecord?.canonicalRequestHash ?? '',
    /^[a-f0-9]{64}$/,
  );
});

test('returns the customer-safe transcript only through the trusted read path', async () => {
  const repository = new FakeConversationRepository();
  const service = createTestConversationService(repository);

  const transcript = await service.getConversation({
    context: TEST_CONTEXT,
    conversationId: TEST_CONVERSATION_ID,
  });

  assert.equal(transcript.conversationId, TEST_CONVERSATION_ID);
  assert.deepEqual(
    transcript.messages.map((message) => message.senderKind),
    ['END_CUSTOMER', 'ASSISTANT'],
  );
});

test('rejects a message larger than 32 KiB before persistence', async () => {
  const repository = new FakeConversationRepository();
  const service = createConversationService({
    repository,
    protectMessage: () => {
      throw new Error('Message should not be encrypted');
    },
  });

  await assert.rejects(
    () =>
      service.acceptMessage({
        context: TEST_CONTEXT,
        conversationId: TEST_CONVERSATION_ID,
        idempotencyKey: 'message-1',
        clientMessageId: 'browser-message-1',
        text: 'a'.repeat(32 * 1_024 + 1),
      }),
    MessageTooLargeError,
  );
  assert.equal(repository.messageRecord, undefined);
});

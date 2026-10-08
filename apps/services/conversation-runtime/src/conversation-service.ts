import { createHash } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';

import type { ProtectMessage, ProtectedMessage } from './message-protection.js';
import type { ConversationServiceAccessContext } from './service-assertion.js';
import type { ConversationAccessContext } from './trusted-context.js';

export type Conversation = {
  conversationId: string;
  status: 'OPEN' | 'CLOSED';
  controlMode: 'AI' | 'QUEUED' | 'HUMAN';
  controlVersion?: number;
  handoffSessionId?: string;
};

export type AcceptedMessage = {
  conversationId: string;
  messageId: string;
  sequenceNumber: number;
  status: 'ACCEPTED';
  controlMode?: 'AI' | 'QUEUED' | 'HUMAN';
  controlVersion?: number;
  refundStart?: RefundStartReservation;
};

export type RefundStartInput = {
  workflowId: string;
  orderReference?: string | undefined;
  proposal: {
    proposalId: string;
    journeyType: 'REFUND';
    intent: {
      orderId: string;
      reasonCode: string;
      scope: 'FULL_ORDER' | 'SELECTED_ITEMS';
      itemIds: string[];
      requestedAmount: { amountMinor: number; currency: string };
    };
  };
  policyVersion: string;
  access: {
    tenantId: string; environmentId: string; subjectCustomerId: string;
    requestId: string; traceId: string;
  };
};

export type RefundStartReservation = {
  workflowId: string;
  status: 'PENDING' | 'STARTED' | 'ABORTED';
  createdAt?: string;
  startInput?: RefundStartInput;
  assistantMessageId?: string;
};

export type ConversationTranscriptMessage = {
  messageId: string;
  sequenceNumber: number;
  senderKind: 'END_CUSTOMER' | 'ASSISTANT' | 'WORKFORCE';
  text: string;
  createdAt: string;
  refundWorkflowId?: string;
};

export type ConversationTranscript = Conversation & {
  messages: ConversationTranscriptMessage[];
};

export type OutboxEvent = {
  eventId: string;
  eventType:
    | 'conversation.message.received.v1'
    | 'conversation.assistant-message.committed.v1';
  occurredAt: Date;
  producer: 'conversation-runtime';
  tenantId: string;
  environmentId: string;
  aggregateType: 'conversation';
  aggregateId: string;
  aggregateSequence: number;
  routingEpoch: number;
  traceId: string;
  schemaVersion: 1;
  payload: {
    messageId: string;
  };
};

type CreateConversationRecord = {
  context: ConversationAccessContext;
  conversationId: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  channel: 'web';
  createdAt: Date;
};

type AcceptMessageRecord = {
  context: ConversationAccessContext;
  conversationId: string;
  messageId: string;
  payloadId: string;
  eventId: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  clientMessageId: string;
  protectedMessage: ProtectedMessage;
  occurredAt: Date;
};

type AppendAssistantMessageRecord = {
  context: ConversationServiceAccessContext;
  conversationId: string;
  messageId: string;
  payloadId: string;
  eventId: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  clientMessageId: string;
  protectedMessage: ProtectedMessage;
  occurredAt: Date;
  expectedControlVersion?: number;
  refundWorkflowId?: string;
  refundStartInput?: RefundStartInput;
  protectedRefundStartInput?: ProtectedMessage;
};

type LinkRefundWorkflowRecord = {
  context: ConversationServiceAccessContext;
  conversationId: string;
  messageId: string;
  workflowId: string;
  eventId: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  occurredAt: Date;
};

export type CreateConversationPersistenceResult = {
  status: 'created' | 'duplicate';
  conversationId: string;
  currentState?: Omit<Conversation, 'conversationId'>;
};

export type AcceptMessagePersistenceResult = {
  status: 'accepted' | 'duplicate';
  messageId: string;
  sequenceNumber: number;
  controlMode?: 'AI' | 'QUEUED' | 'HUMAN';
  controlVersion?: number;
  refundStart?: RefundStartReservation;
};

export type RefundWorkflowLinkPersistenceResult = {
  status: 'linked' | 'duplicate';
  workflowId: string;
};
type RefundStartResolutionRecord = {
  context: ConversationServiceAccessContext; conversationId: string; workflowId: string;
  status: 'STARTED' | 'ABORTED'; idempotencyKey: string; canonicalRequestHash: string; occurredAt: Date;
};

export interface ConversationRepository {
  createConversation(
    record: CreateConversationRecord,
  ): Promise<CreateConversationPersistenceResult>;
  acceptMessage(
    record: AcceptMessageRecord,
  ): Promise<AcceptMessagePersistenceResult>;
  appendAssistantMessage(
    record: AppendAssistantMessageRecord,
  ): Promise<AcceptMessagePersistenceResult>;
  linkRefundWorkflow(
    record: LinkRefundWorkflowRecord,
  ): Promise<RefundWorkflowLinkPersistenceResult>;
  resolveRefundStart(record: RefundStartResolutionRecord): Promise<{ workflowId: string; status: 'STARTED' | 'ABORTED' }>;
  findRefundStart(context: ConversationServiceAccessContext, conversationId: string, assistantClientMessageId: string): Promise<RefundStartReservation | undefined>;
  readConversation(
    context: ConversationAccessContext,
    conversationId: string,
  ): Promise<ConversationTranscript>;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used for a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class ConversationUnavailableError extends Error {
  constructor() {
    super('The conversation is unavailable');
    this.name = 'ConversationUnavailableError';
  }
}

export class MessageTooLargeError extends Error {
  constructor() {
    super('Message text must not exceed 32 KiB');
    this.name = 'MessageTooLargeError';
  }
}

type ConversationServiceOptions = {
  repository: ConversationRepository;
  protectMessage: ProtectMessage;
  createId?: () => string;
  now?: () => Date;
};

export type ConversationService = ReturnType<typeof createConversationService>;

export function createConversationService({
  repository,
  protectMessage,
  createId = uuidv7,
  now = () => new Date(),
}: ConversationServiceOptions) {
  return {
    async createConversation(input: {
      context: ConversationAccessContext;
      idempotencyKey: string;
      channel: 'web';
    }): Promise<Conversation> {
      const createdAt = now();
      const result = await repository.createConversation({
        ...input,
        conversationId: createId(),
        canonicalRequestHash: hashCanonicalRequest({
          channel: input.channel,
          subjectCustomerId: input.context.subjectCustomerId,
        }),
        createdAt,
      });

      return {
        conversationId: result.conversationId,
        status: 'OPEN',
        controlMode: 'AI',
        controlVersion: 1,
        ...(result.currentState ?? {}),
      };
    },

    async acceptMessage(input: {
      context: ConversationAccessContext;
      conversationId: string;
      idempotencyKey: string;
      clientMessageId: string;
      text: string;
    }): Promise<AcceptedMessage> {
      if (Buffer.byteLength(input.text, 'utf8') > 32 * 1_024) {
        throw new MessageTooLargeError();
      }

      const occurredAt = now();
      const result = await repository.acceptMessage({
        context: input.context,
        conversationId: input.conversationId,
        messageId: createId(),
        payloadId: createId(),
        eventId: createId(),
        idempotencyKey: input.idempotencyKey,
        canonicalRequestHash: hashCanonicalRequest({
          clientMessageId: input.clientMessageId,
          text: input.text,
        }),
        clientMessageId: input.clientMessageId,
        protectedMessage: protectMessage(input.text),
        occurredAt,
      });

      return {
        conversationId: input.conversationId,
        messageId: result.messageId,
        sequenceNumber: result.sequenceNumber,
        status: 'ACCEPTED',
        ...(result.controlMode === undefined ? {} : { controlMode: result.controlMode }),
        ...(result.controlVersion === undefined ? {} : { controlVersion: result.controlVersion }),
      };
    },

    async appendAssistantMessage(input: {
      context: ConversationServiceAccessContext;
      conversationId: string;
      idempotencyKey: string;
      clientMessageId: string;
      text: string;
      expectedControlVersion?: number;
      refundWorkflowId?: string;
      refundStartInput?: RefundStartInput;
    }): Promise<AcceptedMessage> {
      if (Buffer.byteLength(input.text, 'utf8') > 32 * 1_024) {
        throw new MessageTooLargeError();
      }
      if ((input.refundWorkflowId === undefined) !== (input.refundStartInput === undefined)) {
        throw new IdempotencyConflictError();
      }
      if (input.refundStartInput && (
        input.refundStartInput.workflowId !== input.refundWorkflowId ||
        input.refundStartInput.access.tenantId !== input.context.tenantId ||
        input.refundStartInput.access.environmentId !== input.context.environmentId ||
        input.refundStartInput.access.subjectCustomerId !== input.context.subjectCustomerId
      )) throw new IdempotencyConflictError();

      const occurredAt = now();
      const serializedStartInput = input.refundStartInput === undefined ? undefined : JSON.stringify(input.refundStartInput);
      const result = await repository.appendAssistantMessage({
        context: input.context,
        conversationId: input.conversationId,
        messageId: createId(),
        payloadId: createId(),
        eventId: createId(),
        idempotencyKey: input.idempotencyKey,
        canonicalRequestHash: hashCanonicalRequest({
          clientMessageId: input.clientMessageId,
          text: input.text,
          ...(input.expectedControlVersion === undefined ? {} : { expectedControlVersion: String(input.expectedControlVersion) }),
          ...(input.refundWorkflowId === undefined ? {} : { refundWorkflowId: input.refundWorkflowId }),
          ...(serializedStartInput === undefined ? {} : { refundStartInput: serializedStartInput }),
        }),
        clientMessageId: input.clientMessageId,
        protectedMessage: protectMessage(input.text),
        occurredAt,
        ...(input.expectedControlVersion === undefined ? {} : { expectedControlVersion: input.expectedControlVersion }),
        ...(input.refundWorkflowId === undefined ? {} : { refundWorkflowId: input.refundWorkflowId }),
        ...(input.refundStartInput === undefined ? {} : { refundStartInput: input.refundStartInput }),
        ...(serializedStartInput === undefined ? {} : { protectedRefundStartInput: protectMessage(serializedStartInput) }),
      });

      return {
        conversationId: input.conversationId,
        messageId: result.messageId,
        sequenceNumber: result.sequenceNumber,
        status: 'ACCEPTED',
        ...(result.controlMode === undefined ? {} : { controlMode: result.controlMode }),
        ...(result.controlVersion === undefined ? {} : { controlVersion: result.controlVersion }),
        ...(result.refundStart === undefined ? {} : { refundStart: result.refundStart }),
      };
    },

    async linkRefundWorkflow(input: {
      context: ConversationServiceAccessContext;
      conversationId: string;
      messageId: string;
      workflowId: string;
      idempotencyKey: string;
    }): Promise<RefundWorkflowLinkPersistenceResult> {
      const occurredAt = now();
      return repository.linkRefundWorkflow({
        ...input,
        eventId: createId(),
        canonicalRequestHash: hashCanonicalRequest({
          messageId: input.messageId,
          workflowId: input.workflowId,
        }),
        occurredAt,
      });
    },

    async getConversation(input: {
      context: ConversationAccessContext;
      conversationId: string;
    }): Promise<ConversationTranscript> {
      return repository.readConversation(input.context, input.conversationId);
    },
    async resolveRefundStart(input: { context: ConversationServiceAccessContext; conversationId: string; workflowId: string; status: 'STARTED' | 'ABORTED'; idempotencyKey: string }) {
      return repository.resolveRefundStart({ ...input, canonicalRequestHash: hashCanonicalRequest({ workflowId: input.workflowId, status: input.status }), occurredAt: now() });
    },
    async findRefundStart(input: { context: ConversationServiceAccessContext; conversationId: string; assistantClientMessageId: string }) {
      return repository.findRefundStart(input.context, input.conversationId, input.assistantClientMessageId);
    },
  };
}

function hashCanonicalRequest(value: Record<string, string>): string {
  const canonicalValue = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );

  return createHash('sha256')
    .update(JSON.stringify(canonicalValue))
    .digest('hex');
}

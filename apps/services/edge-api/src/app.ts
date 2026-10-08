import { createHash, randomUUID } from 'node:crypto';

import Fastify, { LogController, type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RequestInstrumentation } from '@cso/observability-node';

import type {
  AgentRuntimeResponse,
  IntakeRefund,
  IntakeSupport,
  RefundIntakeRequest,
} from './agent-runtime-client.js';
import {
  getReadyRefundProposal,
  parseSupportResponse,
  type ReadyRefundProposal,
} from './support-response.js';
import type {
  AcceptCustomerMessage,
  AppendAssistantMessage,
  CreateConversation,
  GetConversation,
  GetRefundStart,
  LinkRefundWorkflow,
  RequestHumanHandoff,
} from './conversation-runtime-client.js';
import type {
  SignContextAssertion,
  SignServiceAssertion,
} from './context-assertion.js';
import { parseAuthenticatedCustomer, type VerifyCustomerIdentity } from './customer-identity.js';
import {
  RefundPreviewUnavailableError,
  RefundWorkflowNotFoundError,
  type ConfirmRefundWorkflow,
  type GetRefundWorkflow,
  type RefundWorkflowView,
  type StartRefundWorkflow,
} from './temporal-refund-client.js';
import {
  createRefundJourneyUpdateEvent,
  formatSseEvent,
  refundJourneyFingerprint,
  toRefundJourneyView,
} from './refund-journey-view.js';
import { buildCustomerConversationContext } from './customer-conversation-context.js';
import type { RefundEvidenceClient, RefundEvidenceSummary } from './refund-evidence-client.js';
import { isEvidenceWaitStage, registerRefundEvidenceRoutes } from './refund-evidence-routes.js';
import {
  resolveOrderReference,
  resolveOrderReferenceFromCustomerMessages,
} from './order-reference.js';
import { instrumentHttpServer } from './observability.js';
import { registerDeliveryIssueRoutes } from './delivery-issue-routes.js';
import type { DeliveryReportClient } from './delivery-report-client.js';
import type { SignDeliveryReportAssertion } from './delivery-report-assertion.js';
import { registerSavedAddressStatusRoutes } from './saved-address-status-routes.js';
import type { SavedAddressStatusClient } from './saved-address-status-client.js';
import { registerRecentOrderReferencesRoutes } from './recent-order-references-routes.js';
import type { RecentOrderReferencesClient } from './recent-order-references-client.js';
import { registerHumanHandoffRoutes } from './human-handoff-routes.js';
import { registerCancellationRoutes } from './cancellation-routes.js';
import type {
  StartCancellationWorkflow, GetCancellationWorkflow, ConfirmCancellationWorkflow,
} from './temporal-cancellation-client.js';

const refundIntakeRequestSchema = z
  .object({
    customer_message: z.string().trim().min(1).max(2_000),
    order_reference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
// Local Temporal retains executions for 24 hours. Keep automatic recovery well
// inside that window; other namespaces must meet this rollout precondition.
const MAX_REFUND_START_RECOVERY_AGE_MS = 60 * 60 * 1_000;

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const conversationIdSchema = z.uuid();
const conversationParamsSchema = z
  .object({ conversationId: conversationIdSchema })
  .strict();
const createConversationRequestSchema = z.object({}).strict();
const chatMessageRequestSchema = z
  .object({
    client_message_id: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    content: z
      .object({
        type: z.literal('text'),
        text: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    order_reference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const conversationDataSchema = z
  .object({
    conversationId: conversationIdSchema,
    status: z.enum(['OPEN', 'CLOSED']),
    controlMode: z.enum(['AI', 'QUEUED', 'HUMAN']),
    controlVersion: z.number().int().positive().optional(),
    handoffSessionId: conversationIdSchema.optional(),
  })
  .passthrough();
const conversationRuntimeResponseSchema = z
  .object({ data: conversationDataSchema })
  .passthrough();
const conversationTranscriptResponseSchema = z
  .object({
    data: conversationDataSchema.extend({
      messages: z.array(
        z
          .object({
            messageId: z.string().min(1).max(160),
            sequenceNumber: z.number().int().positive(),
            senderKind: z.string().min(1).max(80),
            text: z.string().min(1).max(32_768),
            createdAt: z.string().min(1).max(80),
            refundWorkflowId: z.string().min(1).max(200).optional(),
          })
          .strict(),
      ),
    }),
  })
  .passthrough();
const refundStartInputSchema = z.object({
  workflowId: z.string().min(1).max(200), orderReference: z.string().min(1).max(100).optional(),
  proposal: z.object({ proposalId: z.string().min(1).max(200), journeyType: z.literal('REFUND'),
    intent: z.object({ orderId: z.string().min(1).max(200), reasonCode: z.string().min(1).max(200),
      scope: z.enum(['FULL_ORDER', 'SELECTED_ITEMS']), itemIds: z.array(z.string().min(1).max(200)).max(100),
      requestedAmount: z.object({ amountMinor: z.number().int().positive(), currency: z.string().min(1).max(10) }).strict(),
    }).strict(),
  }).strict(), policyVersion: z.string().min(1).max(200),
  access: z.object({ tenantId: z.string().min(1).max(160), environmentId: z.string().min(1).max(160),
    subjectCustomerId: z.string().min(1).max(160), requestId: z.string().min(1).max(160), traceId: z.string().min(1).max(160) }).strict(),
}).strict();
const refundStartReservationSchema = z.object({
  workflowId: z.string().min(1).max(200), status: z.enum(['PENDING', 'STARTED', 'ABORTED']),
  assistantMessageId: z.string().min(1).max(160).optional(), startInput: refundStartInputSchema.optional(),
  createdAt: z.iso.datetime().optional(),
}).strict();
const acceptedMessageResponseSchema = z
  .object({
    data: z
      .object({
        conversationId: conversationIdSchema,
        messageId: z.string().min(1).max(160),
        sequenceNumber: z.number().int().positive(),
        status: z.literal('ACCEPTED'),
        controlMode: z.enum(['AI', 'QUEUED', 'HUMAN']).optional(),
        controlVersion: z.number().int().positive().optional(),
        refundStart: refundStartReservationSchema.optional(),
      })
      .strict(),
  })
  .passthrough();
const agentRuntimeFailureResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('intent_extraction_unavailable'),
      error_code: z.literal('intent_extraction_unavailable'),
    })
    .passthrough(),
  z
    .object({
      status: z.literal('order_lookup_unavailable'),
      error_code: z.string().trim().min(1).max(160),
    })
    .passthrough(),
]);

const readyRefundProposalSchema = z.object({
  proposalId: z.string().min(1),
  journeyType: z.literal('REFUND'),
  missingFields: z.array(z.string()).length(0),
  intent: z.object({
    orderId: z.string().min(1),
    reasonCode: z.string().min(1),
    scope: z.enum(['FULL_ORDER', 'SELECTED_ITEMS']),
    itemIds: z.array(z.string()),
    requestedAmount: z.object({
      amountMinor: z.number().int().positive(),
      currency: z.string().min(1),
    }).strict(),
  }).strict(),
}).passthrough();

const readyAgentResponseSchema = z.object({
  status: z.literal('refund_proposal_ready'),
  refund_proposal: readyRefundProposalSchema,
}).passthrough();
const workflowParamsSchema = z.object({ workflowId: z.string().min(1).max(200) }).strict();
const confirmationSchema = z.object({ preview_id: z.string().min(1).max(200), accepted: z.boolean() }).strict();

type BuildAppOptions = {
  verifyCustomerIdentity: VerifyCustomerIdentity;
  signContextAssertion: SignContextAssertion;
  signAgentRuntimeContextAssertion: SignContextAssertion;
  signKnowledgeRagContextAssertion: SignContextAssertion;
  intakeRefund: IntakeRefund;
  intakeSupport?: IntakeSupport;
  signConversationRuntimeContextAssertion?: SignContextAssertion;
  signEdgeServiceAssertion?: SignServiceAssertion;
  signDeliveryReportAssertion?: SignDeliveryReportAssertion;
  createConversation?: CreateConversation;
  getConversation?: GetConversation;
  getRefundStart?: GetRefundStart;
  acceptCustomerMessage?: AcceptCustomerMessage;
  appendAssistantMessage?: AppendAssistantMessage;
  linkRefundWorkflow?: LinkRefundWorkflow;
  requestHumanHandoff?: RequestHumanHandoff;
  startRefundWorkflow?: StartRefundWorkflow;
  getRefundWorkflow?: GetRefundWorkflow;
  confirmRefundWorkflow?: ConfirmRefundWorkflow;
  startCancellationWorkflow?: StartCancellationWorkflow;
  getCancellationWorkflow?: GetCancellationWorkflow;
  confirmCancellationWorkflow?: ConfirmCancellationWorkflow;
  refundEvidenceClient?: RefundEvidenceClient;
  deliveryReportClient?: DeliveryReportClient;
  savedAddressStatusClient?: SavedAddressStatusClient;
  recentOrderReferencesClient?: RecentOrderReferencesClient;
  refundPolicyVersion?: string;
  createCorrelationId?: () => string;
  now?: () => Date;
  refundJourneyPollIntervalMilliseconds?: number;
  logger?: boolean;
  telemetry?: RequestInstrumentation;
};

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization || authorization.length > 8_200) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1];
}

function sendAgentResponse(
  reply: FastifyReply,
  response: AgentRuntimeResponse,
) {
  if (response.statusCode >= 500) {
    return reply.code(502).send({
      error: {
        code: 'agent_runtime_unavailable',
        message: 'Agent Runtime request failed',
      },
    });
  }

  return reply.code(response.statusCode).send(response.body);
}

function sendAgentUnavailable(reply: FastifyReply) {
  return reply.code(502).send({
    error: {
      code: 'agent_runtime_unavailable',
      message: 'Agent Runtime request failed',
    },
  });
}

function sendRefundIntentUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: 'refund_intent_unavailable',
      message:
        'We could not understand your refund request right now. Please try again.',
    },
  });
}

function sendOrderLookupUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: 'order_lookup_unavailable',
      message: 'We could not retrieve your order right now. Please try again.',
    },
  });
}

function sendConversationRuntimeFailure(
  reply: FastifyReply,
  statusCode: number,
) {
  if (statusCode === 404) {
    return reply.code(404).send({
      error: {
        code: 'conversation_not_found',
        message: 'Conversation was not found',
      },
    });
  }

  if (statusCode === 409) {
    return reply.code(409).send({
      error: {
        code: 'idempotency_conflict',
        message: 'Conversation request conflicts with a previous request',
      },
    });
  }

  return reply.code(502).send({
    error: {
      code: 'conversation_runtime_unavailable',
      message: 'Conversation service is temporarily unavailable',
    },
  });
}

function sendConversationRuntimeUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: 'conversation_runtime_unavailable',
      message: 'Conversation service is temporarily unavailable',
    },
  });
}

function readIdempotencyKey(value: string | string[] | undefined) {
  return idempotencyKeySchema.safeParse(value);
}

function createScopedIdempotencyKey(
  scope: string,
  ...values: readonly string[]
) {
  const identity = [scope, ...values].join('\0');
  return `cso-${createHash('sha256').update(identity).digest('hex')}`;
}

function buildWorkflowStartInput({
  response,
  orderReference,
  refundPolicyVersion,
  identity,
  requestId,
  traceId,
}: {
  response: { refund_proposal: ReadyRefundProposal };
  orderReference: string | undefined;
  refundPolicyVersion: string;
  identity: Awaited<ReturnType<VerifyCustomerIdentity>>;
  requestId: string;
  traceId: string;
}): Parameters<StartRefundWorkflow>[0] {
  return {
    workflowId: `refund-${response.refund_proposal.proposalId}`,
    ...(orderReference === undefined ? {} : { orderReference }),
    proposal: {
      proposalId: response.refund_proposal.proposalId,
      journeyType: 'REFUND',
      intent: {
        orderId: response.refund_proposal.intent.orderId,
        reasonCode: response.refund_proposal.intent.reasonCode,
        scope: response.refund_proposal.intent.scope,
        itemIds: response.refund_proposal.intent.itemIds,
        requestedAmount: response.refund_proposal.intent.requestedAmount,
      },
    },
    policyVersion: refundPolicyVersion,
    access: {
      tenantId: identity.tenantId,
      environmentId: identity.environmentId,
      subjectCustomerId: identity.customerId,
      requestId,
      traceId,
    },
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            err: () => ({
              type: 'application_error',
              message: 'application error',
              stack: '',
            }),
            req: () => ({}),
            res: () => ({}),
          },
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    forceCloseConnections: true,
  });
  instrumentHttpServer(app, options.telemetry);
  const createCorrelationId = options.createCorrelationId ?? randomUUID;
  const refundPolicyVersion = options.refundPolicyVersion ?? 'refund-policy-v1';
  const now = options.now ?? (() => new Date());
  const refundJourneyPollIntervalMilliseconds =
    options.refundJourneyPollIntervalMilliseconds ?? 5_000;

  app.get('/health', async () => ({
    service: 'edge-api',
    status: 'ok',
  }));

  async function verifyRequestIdentity(authorization: string | undefined) {
    return parseAuthenticatedCustomer(
      await options.verifyCustomerIdentity(extractBearerToken(authorization)),
    );
  }

  registerCancellationRoutes(app, {
    verifyRequestIdentity,
    createCorrelationId,
    ...(options.startCancellationWorkflow ? { startCancellationWorkflow: options.startCancellationWorkflow } : {}),
    ...(options.getCancellationWorkflow ? { getCancellationWorkflow: options.getCancellationWorkflow } : {}),
    ...(options.confirmCancellationWorkflow ? { confirmCancellationWorkflow: options.confirmCancellationWorkflow } : {}),
  });

  registerRefundEvidenceRoutes(app, {
    verifyRequestIdentity, createCorrelationId,
    ...(options.getRefundWorkflow ? { getRefundWorkflow: options.getRefundWorkflow } : {}),
    ...(options.refundEvidenceClient ? { evidenceClient: options.refundEvidenceClient } : {}),
  });
  registerDeliveryIssueRoutes(app, {
    verifyRequestIdentity,
    createCorrelationId,
    signGatewayContext: options.signContextAssertion,
    ...(options.signConversationRuntimeContextAssertion ? { signConversationContext: options.signConversationRuntimeContextAssertion } : {}),
    ...(options.signDeliveryReportAssertion ? { signDeliveryReportAssertion: options.signDeliveryReportAssertion } : {}),
    ...(options.getConversation ? { getConversation: options.getConversation } : {}),
    ...(options.deliveryReportClient ? { deliveryReportClient: options.deliveryReportClient } : {}),
  });
  registerSavedAddressStatusRoutes(app, {
    verifyRequestIdentity,
    createCorrelationId,
    signGatewayContext: options.signContextAssertion,
    ...(options.savedAddressStatusClient ? { savedAddressStatusClient: options.savedAddressStatusClient } : {}),
  });
  registerRecentOrderReferencesRoutes(app, {
    verifyRequestIdentity,
    createCorrelationId,
    signGatewayContext: options.signContextAssertion,
    ...(options.recentOrderReferencesClient ? { recentOrderReferencesClient: options.recentOrderReferencesClient } : {}),
  });
  registerHumanHandoffRoutes(app, {
    verifyRequestIdentity,
    createCorrelationId,
    ...(options.signConversationRuntimeContextAssertion ? { signConversationContext: options.signConversationRuntimeContextAssertion } : {}),
    ...(options.requestHumanHandoff ? { requestHumanHandoff: options.requestHumanHandoff } : {}),
  });

  app.post('/v1/conversations', async (request, reply) => {
    const body = createConversationRequestSchema.safeParse(request.body ?? {});
    const idempotencyKey = readIdempotencyKey(
      request.headers['idempotency-key'],
    );

    if (!body.success || !idempotencyKey.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_conversation_request',
          message: 'Conversation request is invalid',
        },
      });
    }

    if (
      !options.createConversation ||
      !options.signConversationRuntimeContextAssertion
    ) {
      return sendConversationRuntimeUnavailable(reply);
    }

    let identity: Awaited<ReturnType<VerifyCustomerIdentity>>;
    try {
      identity = await verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({
        error: {
          code: 'customer_unauthorized',
          message: 'Customer authentication is required',
        },
      });
    }

    const requestId = createCorrelationId();
    const traceId = createCorrelationId();
    let contextAssertion: string;
    try {
      contextAssertion = await options.signConversationRuntimeContextAssertion({
        identity,
        requestId,
        traceId,
        channelId: 'web',
      });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Conversation context signing failed');
      return reply.code(500).send({
        error: {
          code: 'internal_error',
          message: 'Request could not be authorized',
        },
      });
    }

    try {
      const response = await options.createConversation({
        contextAssertion,
        idempotencyKey: createScopedIdempotencyKey(
          'conversation-create-v1',
          identity.tenantId,
          identity.environmentId,
          identity.customerId,
          idempotencyKey.data,
        ),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return sendConversationRuntimeFailure(reply, response.statusCode);
      }

      const created = conversationRuntimeResponseSchema.safeParse(response.body);
      if (!created.success) {
        request.log.error({ requestId }, 'Conversation Runtime returned an invalid create response');
        return sendConversationRuntimeFailure(reply, 500);
      }

      return reply.code(response.statusCode).send({
        conversation_id: created.data.data.conversationId,
        status: created.data.data.status,
        control_mode: created.data.data.controlMode,
        ...(created.data.data.controlVersion === undefined ? {} : { control_version: created.data.data.controlVersion }),
        ...(created.data.data.handoffSessionId === undefined ? {} : { handoff_session_id: created.data.data.handoffSessionId }),
      });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Conversation creation failed');
      return sendConversationRuntimeFailure(reply, 500);
    }
  });

  app.get('/v1/conversations/:conversationId', async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_conversation_id',
          message: 'Conversation ID is invalid',
        },
      });
    }

    if (
      !options.getConversation ||
      !options.signConversationRuntimeContextAssertion
    ) {
      return sendConversationRuntimeUnavailable(reply);
    }

    let identity;
    try {
      identity = await verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({
        error: {
          code: 'customer_unauthorized',
          message: 'Customer authentication is required',
        },
      });
    }

    const requestId = createCorrelationId();
    const traceId = createCorrelationId();
    let contextAssertion: string;
    try {
      contextAssertion = await options.signConversationRuntimeContextAssertion({
        identity,
        requestId,
        traceId,
        channelId: 'web',
      });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Conversation context signing failed');
      return reply.code(500).send({
        error: {
          code: 'internal_error',
          message: 'Request could not be authorized',
        },
      });
    }

    try {
      const response = await options.getConversation({
        conversationId: params.data.conversationId,
        contextAssertion,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return sendConversationRuntimeFailure(reply, response.statusCode);
      }

      const transcript = conversationTranscriptResponseSchema.safeParse(
        response.body,
      );
      if (!transcript.success) {
        request.log.error({ requestId }, 'Conversation Runtime returned an invalid transcript response');
        return sendConversationRuntimeFailure(reply, 500);
      }

      if (transcript.data.data.conversationId !== params.data.conversationId) {
        request.log.error({ requestId }, 'Conversation Runtime returned a mismatched conversation');
        return sendConversationRuntimeFailure(reply, 500);
      }

      return reply.code(response.statusCode).send({
        conversation_id: transcript.data.data.conversationId,
        status: transcript.data.data.status,
        control_mode: transcript.data.data.controlMode,
        control_version: transcript.data.data.controlVersion ?? 1,
        ...(transcript.data.data.handoffSessionId ? { handoff_session_id: transcript.data.data.handoffSessionId } : {}),
        messages: transcript.data.data.messages.map((message) => ({
          message_id: message.messageId,
          sequence_number: message.sequenceNumber,
          sender_kind: message.senderKind,
          content: { type: 'text', text: message.text },
          created_at: message.createdAt,
          ...(message.refundWorkflowId === undefined
            ? {}
            : {
                refund_workflow: {
                  workflow_id: message.refundWorkflowId,
                  status: 'started' as const,
                },
              }),
        })),
      });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Conversation query failed');
      return sendConversationRuntimeFailure(reply, 500);
    }
  });

  app.post('/v1/conversations/:conversationId/messages', async (
    request,
    reply,
  ) => {
    const params = conversationParamsSchema.safeParse(request.params);
    const body = chatMessageRequestSchema.safeParse(request.body);
    const idempotencyKey = readIdempotencyKey(
      request.headers['idempotency-key'],
    );

    if (!params.success || !body.success || !idempotencyKey.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_conversation_message',
          message: 'Conversation message is invalid',
        },
      });
    }

    if (
      !options.getConversation ||
      !options.acceptCustomerMessage ||
      !options.appendAssistantMessage ||
      !options.signConversationRuntimeContextAssertion ||
      !options.signEdgeServiceAssertion
    ) {
      return sendConversationRuntimeUnavailable(reply);
    }

    let identity: Awaited<ReturnType<VerifyCustomerIdentity>>;
    try {
      identity = await verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({
        error: {
          code: 'customer_unauthorized',
          message: 'Customer authentication is required',
        },
      });
    }

    if (!options.intakeSupport) {
      return sendAgentUnavailable(reply);
    }

    const requestId = createCorrelationId();
    const traceId = createCorrelationId();
    const conversationId = params.data.conversationId;
    const customerMessageText = body.data.content.text;
    const customerMessageIdempotencyKey = createScopedIdempotencyKey(
      'conversation-customer-message-v1',
      identity.tenantId,
      identity.environmentId,
      identity.customerId,
      conversationId,
      idempotencyKey.data,
    );

    let conversationContextAssertion: string;
    try {
      conversationContextAssertion =
        await options.signConversationRuntimeContextAssertion({
          identity,
          requestId,
          traceId,
          channelId: 'web',
        });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Conversation context signing failed');
      return reply.code(500).send({
        error: {
          code: 'internal_error',
          message: 'Request could not be authorized',
        },
      });
    }

    let customerMessage;
    try {
      const response = await options.acceptCustomerMessage({
        conversationId,
        contextAssertion: conversationContextAssertion,
        idempotencyKey: customerMessageIdempotencyKey,
        clientMessageId: body.data.client_message_id,
        text: customerMessageText,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return sendConversationRuntimeFailure(reply, response.statusCode);
      }

      const accepted = acceptedMessageResponseSchema.safeParse(response.body);
      if (!accepted.success || accepted.data.data.conversationId !== conversationId) {
        request.log.error({ requestId }, 'Conversation Runtime returned an invalid customer message response');
        return sendConversationRuntimeFailure(reply, 500);
      }
      customerMessage = accepted.data.data;
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Customer message persistence failed');
      return sendConversationRuntimeFailure(reply, 500);
    }

    const assistantClientMessageId = createScopedIdempotencyKey(
      'conversation-assistant-client-message-v1', conversationId, body.data.client_message_id,
    );
    let serviceAssertion: string;
    try {
      serviceAssertion = await options.signEdgeServiceAssertion({ identity, requestId, traceId });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Assistant service assertion signing failed');
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Request could not be authorized' } });
    }

    async function finishReservedStart(reservation: z.infer<typeof refundStartReservationSchema>, requireFresh = false) {
      if (reservation.status === 'ABORTED' || !reservation.assistantMessageId) throw new Error('Refund reservation cannot be started');
      if (reservation.status === 'STARTED') return { workflow_id: reservation.workflowId, status: 'started' as const };
      if (requireFresh) {
        const age = reservation.createdAt === undefined ? Number.NaN : now().getTime() - Date.parse(reservation.createdAt);
        if (!Number.isFinite(age) || age < 0 || age > MAX_REFUND_START_RECOVERY_AGE_MS) {
          throw new Error('Refund reservation requires manual reconciliation');
        }
      }
      const storedInput = reservation.startInput;
      if (!storedInput || storedInput.workflowId !== reservation.workflowId ||
          storedInput.access.tenantId !== identity.tenantId ||
          storedInput.access.environmentId !== identity.environmentId ||
          storedInput.access.subjectCustomerId !== identity.customerId ||
          !options.startRefundWorkflow || !options.linkRefundWorkflow) {
        throw new Error('Refund reservation cannot be safely recovered');
      }
      const { orderReference, ...requiredInput } = storedInput;
      const startInput = orderReference === undefined ? requiredInput : { ...requiredInput, orderReference };
      const workflow = await options.startRefundWorkflow(startInput);
      if (workflow.workflowId !== reservation.workflowId) throw new Error('Temporal returned a mismatched refund workflow');
      const reference = await options.linkRefundWorkflow({
        conversationId, messageId: reservation.assistantMessageId, workflowId: workflow.workflowId, serviceAssertion,
        idempotencyKey: createScopedIdempotencyKey('conversation-refund-workflow-reference-v1',
          identity.tenantId, identity.environmentId, identity.customerId,
          conversationId, reservation.assistantMessageId, workflow.workflowId),
      });
      if (reference.statusCode < 200 || reference.statusCode >= 300) throw new Error('Refund reservation link failed');
      return { workflow_id: workflow.workflowId, status: 'started' as const };
    }

    if (options.getRefundStart) {
      try {
        const lookup = await options.getRefundStart({ conversationId, assistantClientMessageId, serviceAssertion });
        if (lookup.statusCode !== 404) {
          if (lookup.statusCode < 200 || lookup.statusCode >= 300) return sendConversationRuntimeFailure(reply, lookup.statusCode);
          const parsed = z.object({ data: refundStartReservationSchema }).passthrough().safeParse(lookup.body);
          if (!parsed.success) return sendConversationRuntimeFailure(reply, 500);
          const refundWorkflow = await finishReservedStart(parsed.data.data, true);
          return reply.code(202).send({
            conversation_id: conversationId, customer_message_id: customerMessage.messageId,
            refund_workflow: refundWorkflow,
          });
        }
      } catch (error) {
        request.log.error({ err: error, requestId }, 'Reserved refund start recovery failed');
        return reply.code(502).send({ error: { code: 'workflow_unavailable', message: 'Refund workflow is temporarily unavailable' } });
      }
    }

    let customerConversationContext;
    let customerControlVersion = 1;
    try {
      const response = await options.getConversation({
        conversationId,
        contextAssertion: conversationContextAssertion,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return sendConversationRuntimeFailure(reply, response.statusCode);
      }

      const transcript = conversationTranscriptResponseSchema.safeParse(
        response.body,
      );
      if (
        !transcript.success ||
        transcript.data.data.conversationId !== conversationId
      ) {
        request.log.error(
          { requestId },
          'Conversation Runtime returned an invalid customer conversation context',
        );
        return sendConversationRuntimeFailure(reply, 500);
      }

      customerControlVersion = transcript.data.data.controlVersion ?? 1;
      if (transcript.data.data.controlMode !== 'AI') {
        return reply.code(202).send({
          conversation_id: conversationId,
          customer_message_id: customerMessage.messageId,
          control_mode: transcript.data.data.controlMode,
          control_version: customerControlVersion,
        });
      }

      customerConversationContext = buildCustomerConversationContext({
        messages: transcript.data.data.messages,
        acceptedCustomerMessage: {
          messageId: customerMessage.messageId,
          text: customerMessageText,
        },
      });
    } catch (error) {
      request.log.error(
        { err: error, requestId },
        'Customer conversation context loading failed',
      );
      return sendConversationRuntimeFailure(reply, 500);
    }

    let agentRuntimeContextAssertion: string;
    let integrationGatewayContextAssertion: string;
    let knowledgeRagContextAssertion: string;
    try {
      const assertionInput = {
        identity,
        requestId,
        traceId,
        channelId: 'web',
      };
      [
        integrationGatewayContextAssertion,
        agentRuntimeContextAssertion,
        knowledgeRagContextAssertion,
      ] = await Promise.all([
        options.signContextAssertion(assertionInput),
        options.signAgentRuntimeContextAssertion(assertionInput),
        options.signKnowledgeRagContextAssertion(assertionInput),
      ]);
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Agent context signing failed');
      return sendAgentUnavailable(reply);
    }

    let agentResponse: AgentRuntimeResponse;
    const orderReference = resolveOrderReferenceFromCustomerMessages({
      customerMessages: customerConversationContext,
      explicitOrderReference: body.data.order_reference,
    });
    try {
      agentResponse = await options.intakeSupport(
        {
          customer_message: customerMessageText,
          conversation_messages: customerConversationContext,
          ...(orderReference === undefined
            ? {}
            : { order_reference: orderReference }),
        },
        {
          agentRuntime: agentRuntimeContextAssertion,
          integrationGateway: integrationGatewayContextAssertion,
          knowledgeRag: knowledgeRagContextAssertion,
        },
      );
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Agent Runtime request failed after customer message acceptance');
      return sendAgentUnavailable(reply);
    }

    if (
      agentResponse.statusCode < 200 ||
      agentResponse.statusCode >= 300
    ) {
      return sendAgentUnavailable(reply);
    }

    const agentFailure = agentRuntimeFailureResponseSchema.safeParse(
      agentResponse.body,
    );
    if (agentFailure.success) {
      request.log.warn(
        { requestId, agentStatus: agentFailure.data.status },
        'Agent Runtime could not continue the refund request',
      );
      return agentFailure.data.status === 'intent_extraction_unavailable'
        ? sendRefundIntentUnavailable(reply)
        : sendOrderLookupUnavailable(reply);
    }

    let supportResponse;
    try {
      supportResponse = parseSupportResponse(agentResponse.body);
    } catch {
      request.log.error({ requestId }, 'Agent Runtime returned an unsafe chat response');
      return sendAgentUnavailable(reply);
    }

    if (supportResponse.journey === 'cancellation' &&
        supportResponse.status === 'cancellation_request_ready' &&
        (orderReference === undefined ||
          supportResponse.order_reference.toUpperCase() !== orderReference.toUpperCase())) {
      request.log.error({ requestId }, 'Agent Runtime cancellation reference did not match customer context');
      return sendAgentUnavailable(reply);
    }

    const readyProposal = getReadyRefundProposal(supportResponse);
    if (readyProposal && (!options.getRefundStart || !options.startRefundWorkflow || !options.linkRefundWorkflow)) {
      return reply.code(503).send({
        error: { code: 'workflow_unavailable', message: 'Refund workflow is unavailable' },
      });
    }
    const readyWorkflowStart = readyProposal
      ? buildWorkflowStartInput({
          response: { refund_proposal: readyProposal },
          orderReference, refundPolicyVersion, identity, requestId, traceId,
        })
      : undefined;

    let assistantMessage;
    try {
      const response = await options.appendAssistantMessage({
        conversationId,
        serviceAssertion,
        idempotencyKey: createScopedIdempotencyKey(
          'conversation-assistant-message-v1',
          identity.tenantId,
          identity.environmentId,
          identity.customerId,
          conversationId,
          idempotencyKey.data,
        ),
        clientMessageId: assistantClientMessageId,
        text: supportResponse.customer_answer.message,
        expectedControlVersion: customerControlVersion,
        ...(readyWorkflowStart ? { refundWorkflowId: readyWorkflowStart.workflowId } : {}),
        ...(readyWorkflowStart ? { refundStartInput: readyWorkflowStart } : {}),
      });
      if (response.statusCode === 409) {
        const latest = await options.getConversation({ conversationId, contextAssertion: conversationContextAssertion });
        const current = latest.statusCode === 200
          ? conversationTranscriptResponseSchema.safeParse(latest.body)
          : undefined;
        if (current?.success && current.data.data.conversationId === conversationId &&
            current.data.data.controlMode !== 'AI') {
          return reply.code(202).send({
            conversation_id: conversationId,
            customer_message_id: customerMessage.messageId,
            control_mode: current.data.data.controlMode,
            control_version: current.data.data.controlVersion ?? 1,
          });
        }
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return sendConversationRuntimeFailure(reply, response.statusCode);
      }

      const accepted = acceptedMessageResponseSchema.safeParse(response.body);
      if (!accepted.success || accepted.data.data.conversationId !== conversationId) {
        request.log.error({ requestId }, 'Conversation Runtime returned an invalid assistant message response');
        return sendConversationRuntimeFailure(reply, 500);
      }
      assistantMessage = accepted.data.data;
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Assistant message persistence failed');
      return sendConversationRuntimeFailure(reply, 500);
    }

    let refundWorkflow: { workflow_id: string; status: 'started' } | undefined;
    if (readyWorkflowStart && options.startRefundWorkflow && options.linkRefundWorkflow) {
      try {
        const reservation = assistantMessage.refundStart;
        if (!reservation || reservation.workflowId !== readyWorkflowStart.workflowId) throw new Error('Assistant refund reservation is missing or changed');
        refundWorkflow = await finishReservedStart({ ...reservation, assistantMessageId: assistantMessage.messageId });
      } catch (error) {
        request.log.error({ err: error, requestId }, 'Refund workflow start failed');
        return reply.code(502).send({
          error: {
            code: 'workflow_unavailable',
            message: 'Refund workflow is temporarily unavailable',
          },
        });
      }
    }

    return reply.code(202).send({
      conversation_id: conversationId,
      customer_message_id: customerMessage.messageId,
      assistant_message: {
        message_id: assistantMessage.messageId,
        content: {
          type: 'text',
          text: supportResponse.customer_answer.message,
        },
      },
      ...(refundWorkflow === undefined ? {} : { refund_workflow: refundWorkflow }),
      ...(supportResponse.journey === 'cancellation' &&
        supportResponse.status === 'cancellation_request_ready'
        ? { cancellation_request: { order_reference: supportResponse.order_reference.toUpperCase() } }
        : {}),
    });
  });

  async function loadOwnedRefundWorkflow(
    workflowId: string,
    authorization: string | undefined,
  ): Promise<
    | Readonly<{ workflow: RefundWorkflowView; evidence?: RefundEvidenceSummary }>
    | Readonly<{ error: 'customer_unauthorized' | 'refund_workflow_not_found' | 'workflow_unavailable' | 'evidence_unavailable' }>
  > {
    if (!options.getRefundWorkflow) {
      return { error: 'workflow_unavailable' };
    }

    let identity;
    try {
      identity = await verifyRequestIdentity(authorization);
    } catch {
      return { error: 'customer_unauthorized' };
    }

    try {
      const workflow = await options.getRefundWorkflow({
        workflowId,
        access: {
          tenantId: identity.tenantId,
          environmentId: identity.environmentId,
          subjectCustomerId: identity.customerId,
          requestId: createCorrelationId(),
          traceId: createCorrelationId(),
        },
      });
      let evidence: RefundEvidenceSummary | undefined;
      if (options.refundEvidenceClient) {
        try {
          evidence = await options.refundEvidenceClient.getSummary({
            workflowId, identity, requestId: createCorrelationId(), traceId: createCorrelationId(),
          });
        } catch {
          // Legacy / non-photo journeys must not depend on a new evidence
          // service rollout. Active evidence gates fail closed instead.
          if (isEvidenceWaitStage(workflow.stage)) return { error: 'evidence_unavailable' };
        }
      }
      if (isEvidenceWaitStage(workflow.stage) && !evidence) return { error: 'evidence_unavailable' };
      return { workflow, ...(evidence === undefined ? {} : { evidence }) };
    } catch (error) {
      if (error instanceof RefundWorkflowNotFoundError) {
        return { error: 'refund_workflow_not_found' };
      }
      return { error: 'workflow_unavailable' };
    }
  }

  function sendRefundJourneyLoadFailure(
    reply: FastifyReply,
    error: 'customer_unauthorized' | 'refund_workflow_not_found' | 'workflow_unavailable' | 'evidence_unavailable',
  ) {
    switch (error) {
      case 'customer_unauthorized':
        return reply.code(401).send({
          error: {
            code: 'customer_unauthorized',
            message: 'Customer authentication is required',
          },
        });
      case 'refund_workflow_not_found':
        return reply.code(404).send({
          error: {
            code: 'refund_workflow_not_found',
            message: 'Refund workflow was not found',
          },
        });
      case 'workflow_unavailable':
        return reply.code(502).send({
          error: {
            code: 'workflow_unavailable',
            message: 'Refund workflow is temporarily unavailable',
          },
        });
      case 'evidence_unavailable':
        return reply.code(503).send({ error: { code: 'evidence_unavailable', message: 'Photo evidence is temporarily unavailable. Please try again.' } });
    }
  }

  app.get('/v1/refunds/:workflowId/journey', async (request, reply) => {
    const params = workflowParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: { code: 'invalid_workflow_id', message: 'Workflow ID is invalid' },
      });
    }

    const result = await loadOwnedRefundWorkflow(
      params.data.workflowId,
      request.headers.authorization,
    );
    if ('error' in result) {
      return sendRefundJourneyLoadFailure(reply, result.error);
    }

    return reply.header('cache-control', 'private, no-store').send(toRefundJourneyView(params.data.workflowId, result.workflow, result.evidence));
  });

  app.get('/v1/refunds/:workflowId/events', async (request, reply) => {
    const params = workflowParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: { code: 'invalid_workflow_id', message: 'Workflow ID is invalid' },
      });
    }

    const workflowId = params.data.workflowId;
    const initial = await loadOwnedRefundWorkflow(
      workflowId,
      request.headers.authorization,
    );
    if ('error' in initial) {
      return sendRefundJourneyLoadFailure(reply, initial.error);
    }

    let fingerprint = refundJourneyFingerprint(workflowId, initial.workflow, initial.evidence);
    let eventSequence = 0;
    const writeUpdate = () => {
      eventSequence += 1;
      reply.raw.write(formatSseEvent(createRefundJourneyUpdateEvent(
        workflowId,
        `${workflowId}:${eventSequence}`,
        now().toISOString(),
      )));
    };

    reply.hijack();
    reply.raw.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`retry: ${refundJourneyPollIntervalMilliseconds}\n\n`);
    writeUpdate();

    let refreshing = false;
    let closed = false;
    const interval = setInterval(async () => {
      if (refreshing || closed) return;
      refreshing = true;
      try {
        const next = await loadOwnedRefundWorkflow(workflowId, request.headers.authorization);
        if ('error' in next) return;
        const nextFingerprint = refundJourneyFingerprint(workflowId, next.workflow, next.evidence);
        if (!closed && nextFingerprint !== fingerprint) {
          fingerprint = nextFingerprint;
          writeUpdate();
        }
      } catch {
        // Keep the prior safe view on an unavailable poll; a later poll retries.
      } finally { refreshing = false; }
    }, refundJourneyPollIntervalMilliseconds);

    request.raw.once('close', () => {
      closed = true;
      clearInterval(interval);
    });
  });

  app.get('/v1/refunds/:workflowId', async (request, reply) => {
    const params = workflowParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'invalid_workflow_id', message: 'Workflow ID is invalid' } });
    if (!options.getRefundWorkflow) return reply.code(503).send({ error: { code: 'workflow_unavailable', message: 'Refund workflow is unavailable' } });
    let identity;
    try {
      identity = await verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } });
    }

    try {
      const workflow = await options.getRefundWorkflow({ workflowId: params.data.workflowId, access: { tenantId: identity.tenantId, environmentId: identity.environmentId, subjectCustomerId: identity.customerId, requestId: createCorrelationId(), traceId: createCorrelationId() } });
      return reply.send({ workflow_id: params.data.workflowId, ...workflow });
    } catch (error) {
      if (error instanceof RefundWorkflowNotFoundError) return reply.code(404).send({ error: { code: 'refund_workflow_not_found', message: 'Refund workflow was not found' } });
      request.log.error({ err: error }, 'Refund workflow status query failed');
      return reply.code(502).send({ error: { code: 'workflow_unavailable', message: 'Refund workflow is temporarily unavailable' } });
    }
  });

  app.post('/v1/refunds/:workflowId/confirmation', async (request, reply) => {
    const params = workflowParamsSchema.safeParse(request.params);
    const body = confirmationSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: 'invalid_refund_confirmation', message: 'Refund confirmation is invalid' } });
    if (!options.confirmRefundWorkflow) return reply.code(503).send({ error: { code: 'workflow_unavailable', message: 'Refund workflow is unavailable' } });
    let identity;
    try {
      identity = await verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } });
    }

    try {
      await options.confirmRefundWorkflow({ workflowId: params.data.workflowId, previewId: body.data.preview_id, accepted: body.data.accepted, access: { tenantId: identity.tenantId, environmentId: identity.environmentId, subjectCustomerId: identity.customerId, requestId: createCorrelationId(), traceId: createCorrelationId() } });
      return reply.code(202).send({ workflow_id: params.data.workflowId, status: 'confirmation_received' });
    } catch (error) {
      if (error instanceof RefundPreviewUnavailableError) return reply.code(409).send({ error: { code: 'refund_preview_unavailable', message: error.message } });
      if (error instanceof RefundWorkflowNotFoundError) return reply.code(404).send({ error: { code: 'refund_workflow_not_found', message: 'Refund workflow was not found' } });
      request.log.error({ err: error }, 'Refund workflow confirmation failed');
      return reply.code(502).send({ error: { code: 'workflow_unavailable', message: 'Refund workflow is temporarily unavailable' } });
    }
  });

  app.post('/v1/refunds/intake', async (request, reply) => {
    const parsedRequest = refundIntakeRequestSchema.safeParse(request.body);

    if (!parsedRequest.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_refund_request',
          message: 'Refund request is invalid',
        },
      });
    }

    let identity;

    try {
      identity = await verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({
        error: {
          code: 'customer_unauthorized',
          message: 'Customer authentication is required',
        },
      });
    }

    const requestId = createCorrelationId();
    const traceId = createCorrelationId();
    let integrationGatewayContextAssertion;
    let agentRuntimeContextAssertion;
    let knowledgeRagContextAssertion;

    try {
      const assertionInput = {
        identity,
        requestId,
        traceId,
        channelId: 'web',
      };

      [
        integrationGatewayContextAssertion,
        agentRuntimeContextAssertion,
        knowledgeRagContextAssertion,
      ] = await Promise.all([
        options.signContextAssertion(assertionInput),
        options.signAgentRuntimeContextAssertion(assertionInput),
        options.signKnowledgeRagContextAssertion(assertionInput),
      ]);
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Context signing failed');

      return reply.code(500).send({
        error: {
          code: 'internal_error',
          message: 'Request could not be authorized',
        },
      });
    }

    try {
      const orderReference = resolveOrderReference({
        customerMessage: parsedRequest.data.customer_message,
        explicitOrderReference: parsedRequest.data.order_reference,
      });
      const refundRequest: RefundIntakeRequest = {
        customer_message: parsedRequest.data.customer_message,
        ...(orderReference === undefined
          ? {}
          : { order_reference: orderReference }),
      };
      const agentResponse = await options.intakeRefund(
        refundRequest,
        {
          agentRuntime: agentRuntimeContextAssertion,
          integrationGateway: integrationGatewayContextAssertion,
          knowledgeRag: knowledgeRagContextAssertion,
        },
      );

      if (agentResponse.statusCode < 200 || agentResponse.statusCode >= 300) {
        return sendAgentResponse(reply, agentResponse);
      }

      const readyResponse = readyAgentResponseSchema.safeParse(agentResponse.body);
      if (!readyResponse.success) {
        return reply.code(agentResponse.statusCode).send(agentResponse.body);
      }
      if (!options.startRefundWorkflow) {
        throw new Error('WORKFLOW_STARTER_NOT_CONFIGURED');
      }

      const workflow = await options.startRefundWorkflow(
        buildWorkflowStartInput({
          response: readyResponse.data,
          orderReference,
          refundPolicyVersion,
          identity,
          requestId,
          traceId,
        }),
      );

      return reply.code(agentResponse.statusCode).send({
        ...readyResponse.data,
        refund_workflow: {
          workflow_id: workflow.workflowId,
          status: 'started',
        },
      });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Agent Runtime request failed');

      return reply.code(502).send({
        error: {
          code: 'agent_runtime_unavailable',
          message: 'Agent Runtime request failed',
        },
      });
    }
  });

  return app;
}

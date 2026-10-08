import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
} from 'fastify';
import { z } from 'zod';
import type { RequestInstrumentation } from '@cso/observability-node';

import {
  ConversationUnavailableError,
  IdempotencyConflictError,
  MessageTooLargeError,
  type ConversationService,
} from './conversation-service.js';
import {
  CONTEXT_ASSERTION_HEADER,
  ContextAssertionError,
  type VerifyContextAssertion,
} from './trusted-context.js';
import {
  SERVICE_ASSERTION_HEADER,
  ServiceAssertionError,
  type VerifyServiceAssertion,
} from './service-assertion.js';
import { instrumentHttpServer } from './observability.js';
import { registerHandoffRoutes } from './handoff-routes.js';
import type { PostgresHandoffService } from './handoff-service.js';
import { StaffAssertionError, type VerifyStaffAssertion } from './staff-assertion.js';
import { HandoffConflictError } from './handoff-state.js';

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const createConversationSchema = z
  .object({
    channel: z.literal('web').default('web'),
  })
  .strict();
const acceptMessageSchema = z
  .object({
    clientMessageId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    content: z
      .object({
        type: z.literal('text'),
        text: z.string().trim().min(1).max(32_768),
      })
      .strict(),
  })
  .strict();
const appendAssistantMessageSchema = z
  .object({
    expected_control_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1).optional(),
    refund_workflow_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
    refund_start_input: z.object({
      workflowId: z.string().min(1).max(200),
      orderReference: z.string().min(1).max(100).optional(),
      proposal: z.object({
        proposalId: z.string().min(1).max(200), journeyType: z.literal('REFUND'),
        intent: z.object({
          orderId: z.string().min(1).max(200), reasonCode: z.string().min(1).max(200),
          scope: z.enum(['FULL_ORDER', 'SELECTED_ITEMS']), itemIds: z.array(z.string().min(1).max(200)).max(100),
          requestedAmount: z.object({ amountMinor: z.number().int().positive(), currency: z.string().min(1).max(10) }).strict(),
        }).strict(),
      }).strict(),
      policyVersion: z.string().min(1).max(200),
      access: z.object({
        tenantId: z.string().min(1).max(160), environmentId: z.string().min(1).max(160),
        subjectCustomerId: z.string().min(1).max(160), requestId: z.string().min(1).max(160), traceId: z.string().min(1).max(160),
      }).strict(),
    }).strict().optional(),
    client_message_id: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    content: z
      .object({
        type: z.literal('text'),
        text: z.string().trim().min(1).max(32_768),
      })
      .strict(),
  })
  .strict().refine((value) => (value.refund_workflow_id === undefined) === (value.refund_start_input === undefined));
const linkRefundWorkflowSchema = z
  .object({
    workflow_id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();
const conversationParametersSchema = z.object({
  conversationId: z.uuid(),
});
const assistantMessageParametersSchema = conversationParametersSchema.extend({
  messageId: z.uuid(),
});

type BuildAppOptions = {
  verifyContextAssertion: VerifyContextAssertion;
  verifyServiceAssertion: VerifyServiceAssertion;
  conversationService: ConversationService;
  checkHealth: () => Promise<void>;
  logger?: boolean;
  telemetry?: RequestInstrumentation;
  handoffService?: PostgresHandoffService;
  verifyStaffAssertion?: VerifyStaffAssertion;
};

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  instrumentHttpServer(app, options.telemetry);
  registerHandoffRoutes(app, options.handoffService, options.verifyContextAssertion, options.verifyStaffAssertion);

  app.get('/health', async (_request, reply) => {
    try {
      await options.checkHealth();
      return { service: 'conversation-runtime', status: 'ok' };
    } catch {
      return reply.code(503).send({
        service: 'conversation-runtime',
        status: 'unavailable',
      });
    }
  });

  app.post('/v1/conversations', async (request, reply) => {
    const body = createConversationSchema.safeParse(request.body ?? {});
    const idempotencyKey = idempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );

    if (!body.success || !idempotencyKey.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_CONVERSATION_REQUEST',
          message: 'Conversation request is invalid',
          retryable: false,
        },
      });
    }

    try {
      const context = await options.verifyContextAssertion(
        readContextAssertion(request.headers[CONTEXT_ASSERTION_HEADER]),
      );
      const conversation = await options.conversationService.createConversation({
        context,
        idempotencyKey: idempotencyKey.data,
        channel: body.data.channel,
      });

      return reply.code(201).send({
        data: conversation,
        meta: {
          requestId: context.requestId,
          apiVersion: '2026-08-05',
        },
      });
    } catch (error) {
      return sendStableError(reply, error, request.log);
    }
  });

  app.get('/v1/conversations/:conversationId', async (request, reply) => {
    const parameters = conversationParametersSchema.safeParse(request.params);

    if (!parameters.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_CONVERSATION_REQUEST',
          message: 'Conversation request is invalid',
          retryable: false,
        },
      });
    }

    try {
      const context = await options.verifyContextAssertion(
        readContextAssertion(request.headers[CONTEXT_ASSERTION_HEADER]),
      );
      const conversation = await options.conversationService.getConversation({
        context,
        conversationId: parameters.data.conversationId,
      });

      return {
        data: conversation,
        meta: {
          requestId: context.requestId,
          apiVersion: '2026-08-05',
        },
      };
    } catch (error) {
      return sendStableError(reply, error, request.log);
    }
  });

  app.post('/v1/conversations/:conversationId/messages', async (
    request,
    reply,
  ) => {
    const parameters = conversationParametersSchema.safeParse(request.params);
    const body = acceptMessageSchema.safeParse(request.body);
    const idempotencyKey = idempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );

    if (!parameters.success || !body.success || !idempotencyKey.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_MESSAGE_REQUEST',
          message: 'Message request is invalid',
          retryable: false,
        },
      });
    }

    try {
      const context = await options.verifyContextAssertion(
        readContextAssertion(request.headers[CONTEXT_ASSERTION_HEADER]),
      );
      const accepted = await options.conversationService.acceptMessage({
        context,
        conversationId: parameters.data.conversationId,
        idempotencyKey: idempotencyKey.data,
        clientMessageId: body.data.clientMessageId,
        text: body.data.content.text,
      });

      return reply.code(202).send({
        data: accepted,
        meta: {
          requestId: context.requestId,
          apiVersion: '2026-08-05',
        },
      });
    } catch (error) {
      return sendStableError(reply, error, request.log);
    }
  });

  app.post('/v1/internal/conversations/:conversationId/assistant-messages', async (
    request,
    reply,
  ) => {
    const parameters = conversationParametersSchema.safeParse(request.params);
    const body = appendAssistantMessageSchema.safeParse(request.body);
    const idempotencyKey = idempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );

    if (!parameters.success || !body.success || !idempotencyKey.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_ASSISTANT_MESSAGE_REQUEST',
          message: 'Assistant message request is invalid',
          retryable: false,
        },
      });
    }

    try {
      const context = await options.verifyServiceAssertion(
        readContextAssertion(request.headers[SERVICE_ASSERTION_HEADER]),
      );
      const accepted = await options.conversationService.appendAssistantMessage({
        context,
        conversationId: parameters.data.conversationId,
        idempotencyKey: idempotencyKey.data,
        clientMessageId: body.data.client_message_id,
        text: body.data.content.text,
        ...(body.data.expected_control_version === undefined ? {} : { expectedControlVersion: body.data.expected_control_version }),
        ...(body.data.refund_workflow_id === undefined ? {} : { refundWorkflowId: body.data.refund_workflow_id }),
        ...(body.data.refund_start_input === undefined ? {} : { refundStartInput: body.data.refund_start_input }),
      });

      return reply.code(202).send({
        data: accepted,
        meta: {
          requestId: context.requestId,
          apiVersion: '2026-08-05',
        },
      });
    } catch (error) {
      return sendStableError(reply, error, request.log);
    }
  });

  app.post('/v1/internal/conversations/:conversationId/messages/:messageId/refund-workflow', async (
    request,
    reply,
  ) => {
    const parameters = assistantMessageParametersSchema.safeParse(request.params);
    const body = linkRefundWorkflowSchema.safeParse(request.body);
    const idempotencyKey = idempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );

    if (!parameters.success || !body.success || !idempotencyKey.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REFUND_WORKFLOW_REFERENCE',
          message: 'Refund workflow reference is invalid',
          retryable: false,
        },
      });
    }

    try {
      const context = await options.verifyServiceAssertion(
        readContextAssertion(request.headers[SERVICE_ASSERTION_HEADER]),
      );
      const linked = await options.conversationService.linkRefundWorkflow({
        context,
        conversationId: parameters.data.conversationId,
        messageId: parameters.data.messageId,
        workflowId: body.data.workflow_id,
        idempotencyKey: idempotencyKey.data,
      });

      return reply.code(202).send({
        data: {
          conversationId: parameters.data.conversationId,
          messageId: parameters.data.messageId,
          workflowId: linked.workflowId,
          status: 'LINKED',
        },
        meta: {
          requestId: context.requestId,
          apiVersion: '2026-08-05',
        },
      });
    } catch (error) {
      return sendStableError(reply, error, request.log);
    }
  });

  app.post('/v1/internal/conversations/:conversationId/refund-starts/:workflowId/resolve', async (request, reply) => {
    const params = conversationParametersSchema.extend({ workflowId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).safeParse(request.params);
    const body = z.object({ status: z.enum(['STARTED', 'ABORTED']) }).strict().safeParse(request.body);
    const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!params.success || !body.success || !key.success) return reply.code(400).send({ error: { code: 'INVALID_REFUND_START_RESOLUTION', message: 'Refund start resolution is invalid', retryable: false } });
    try {
      const context = await options.verifyServiceAssertion(readContextAssertion(request.headers[SERVICE_ASSERTION_HEADER]));
      const result = await options.conversationService.resolveRefundStart({ context, conversationId: params.data.conversationId, workflowId: params.data.workflowId, status: body.data.status, idempotencyKey: key.data });
      return { data: result, meta: { requestId: context.requestId, apiVersion: '2026-08-05' } };
    } catch (error) { return sendStableError(reply, error, request.log); }
  });

  app.get('/v1/internal/conversations/:conversationId/refund-starts/by-assistant-client/:assistantClientMessageId', async (request, reply) => {
    const params = conversationParametersSchema.extend({ assistantClientMessageId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_REFUND_START_LOOKUP', message: 'Refund start lookup is invalid', retryable: false } });
    try {
      const context = await options.verifyServiceAssertion(readContextAssertion(request.headers[SERVICE_ASSERTION_HEADER]));
      const reservation = await options.conversationService.findRefundStart({
        context, conversationId: params.data.conversationId, assistantClientMessageId: params.data.assistantClientMessageId,
      });
      if (!reservation) return reply.code(404).send({ error: { code: 'REFUND_START_NOT_FOUND', message: 'Refund start was not found', retryable: false } });
      return { data: reservation, meta: { requestId: context.requestId, apiVersion: '2026-08-05' } };
    } catch (error) { return sendStableError(reply, error, request.log); }
  });

  return app;
}

function readContextAssertion(value: string | string[] | undefined) {
  return typeof value === 'string' ? value : undefined;
}

export function sendStableError(
  reply: FastifyReply,
  error: unknown,
  logger: Pick<FastifyBaseLogger, 'error'>,
) {
  if (error instanceof StaffAssertionError) return reply.code(401).send({ error: { code: 'STAFF_UNAUTHORIZED', message: 'Trusted staff assertion is required', retryable: false } });
  if (error instanceof HandoffConflictError) return reply.code(409).send({ error: { code: 'CONVERSATION_CONTROL_CHANGED', message: 'Conversation control changed; refresh before continuing', retryable: false } });
  if (error instanceof ContextAssertionError) {
    return reply.code(401).send({
      error: {
        code: 'CONTEXT_UNAUTHORIZED',
        message: 'Trusted context is required',
        retryable: false,
      },
    });
  }

  if (error instanceof ServiceAssertionError) {
    return reply.code(401).send({
      error: {
        code: 'SERVICE_UNAUTHORIZED',
        message: 'Trusted service assertion is required',
        retryable: false,
      },
    });
  }

  if (error instanceof IdempotencyConflictError) {
    return reply.code(409).send({
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The idempotency key was already used for another request',
        retryable: false,
      },
    });
  }

  if (error instanceof ConversationUnavailableError) {
    return reply.code(404).send({
      error: {
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation was not found',
        retryable: false,
      },
    });
  }

  if (error instanceof MessageTooLargeError) {
    return reply.code(400).send({
      error: {
        code: 'MESSAGE_TOO_LARGE',
        message: 'Message exceeds the supported size',
        retryable: false,
      },
    });
  }

  logger.error('conversation.request.failed');
  return reply.code(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Conversation request could not be completed',
      retryable: true,
    },
  });
}

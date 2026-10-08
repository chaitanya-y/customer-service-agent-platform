import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AuthenticatedCustomer } from './customer-identity.js';
import {
  CancellationPreviewUnavailableError,
  CancellationWorkflowNotFoundError,
  type StartCancellationWorkflow,
  type GetCancellationWorkflow,
  type ConfirmCancellationWorkflow,
} from './temporal-cancellation-client.js';

const orderReference = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/);
const workflowId = z.string().regex(/^cancel-[a-f0-9]{64}$/);
const startBody = z.object({ order_reference: orderReference }).strict();
const confirmationBody = z.object({ preview_id: z.string().min(1).max(200), accepted: z.boolean() }).strict();
const paramsSchema = z.object({ workflowId }).strict();
const previewSchema = z.object({
  previewId: z.string().min(1).max(200), createdAt: z.iso.datetime(), validUntil: z.iso.datetime(),
  orderId: z.string().min(1).max(200), orderReference: orderReference, placedAt: z.iso.datetime(),
  total: z.object({ amountMinor: z.literal(0), currency: z.string().min(1).max(10) }).strict(),
  lines: z.array(z.object({ id: z.string().min(1).max(200), quantity: z.number().int().nonnegative(),
    orderPlacedQuantity: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(300)
      .refine(value => !/\p{C}/u.test(value) && /[\p{L}\p{N}]/u.test(value)).optional() }).strict()).min(1).max(100),
  policyVersion: z.literal('NO_PAYMENT_ZERO_TOTAL_V1'), providerFactsDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const stateSchema = z.object({
  stage: z.enum(['EVALUATING', 'FACTS_UNAVAILABLE', 'NOT_ELIGIBLE', 'AWAITING_CUSTOMER_CONFIRMATION',
    'PREVIEW_EXPIRED', 'CUSTOMER_DECLINED', 'PREVIEW_INVALIDATED', 'CANCELLATION_REQUESTED',
    'PENDING_RECONCILIATION', 'ORDER_CANCELLED', 'CANCELLATION_FAILED']),
  preview: previewSchema.optional(),
}).passthrough();

type CancellationRoutesOptions = Readonly<{
  verifyRequestIdentity: (authorization: string | undefined) => Promise<AuthenticatedCustomer>;
  createCorrelationId: () => string;
  startCancellationWorkflow?: StartCancellationWorkflow;
  getCancellationWorkflow?: GetCancellationWorkflow;
  confirmCancellationWorkflow?: ConfirmCancellationWorkflow;
}>;

function accessFor(identity: AuthenticatedCustomer, requestId: string, traceId: string) {
  return { tenantId: identity.tenantId, environmentId: identity.environmentId,
    subjectCustomerId: identity.customerId, requestId, traceId };
}

function workflowIdFor(identity: AuthenticatedCustomer, reference: string): string {
  const digest = createHash('sha256').update(JSON.stringify([
    'zero-total-cancellation-v1', identity.tenantId, identity.environmentId, identity.customerId, reference,
  ])).digest('hex');
  return `cancel-${digest}`;
}

function noCache(reply: { header: (name: string, value: string) => unknown }) {
  reply.header('Cache-Control', 'private, no-store');
}

function projectSafeState(state: unknown) {
  const parsed = stateSchema.parse(state);
  const output: Record<string, unknown> = { stage: parsed.stage };
  if (parsed.stage === 'AWAITING_CUSTOMER_CONFIRMATION' && parsed.preview) {
    output.preview = {
      preview_id: parsed.preview.previewId,
      order_reference: parsed.preview.orderReference,
      placed_at: parsed.preview.placedAt,
      valid_until: parsed.preview.validUntil,
      total: { amount_minor: 0, currency: parsed.preview.total.currency },
      lines: parsed.preview.lines.map((line) => ({ item_id: line.id, quantity: line.orderPlacedQuantity,
        ...(line.displayName === undefined ? {} : { display_name: line.displayName }) })),
    };
  }
  return output;
}

export function registerCancellationRoutes(app: FastifyInstance, options: CancellationRoutesOptions): void {
  app.post('/v1/cancellations', async (request, reply) => {
    noCache(reply);
    const body = startBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'invalid_cancellation_request', message: 'A valid order reference is required' } });
    let identity: AuthenticatedCustomer;
    try { identity = await options.verifyRequestIdentity(request.headers.authorization); }
    catch { return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } }); }
    if (!options.startCancellationWorkflow) return reply.code(503).send({ error: { code: 'cancellation_unavailable', message: 'Cancellation is unavailable' } });
    const reference = body.data.order_reference.toUpperCase();
    const requestedWorkflowId = workflowIdFor(identity, reference);
    try {
      const started = await options.startCancellationWorkflow({ workflowId: requestedWorkflowId, orderReference: reference,
        policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', access: accessFor(identity, options.createCorrelationId(), options.createCorrelationId()) });
      if (started.workflowId !== requestedWorkflowId) throw new Error('Cancellation workflow identity mismatch');
      return reply.code(202).send({ workflow_id: requestedWorkflowId });
    } catch (error) {
      request.log.error({ err: error }, 'Cancellation workflow start failed');
      return reply.code(503).send({ error: { code: 'cancellation_unavailable', message: 'Cancellation is temporarily unavailable' } });
    }
  });

  app.get('/v1/cancellations/:workflowId', async (request, reply) => {
    noCache(reply);
    const params = paramsSchema.safeParse(request.params);
    if (!params.success || Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0) {
      return reply.code(400).send({ error: { code: 'invalid_cancellation_request', message: 'Invalid cancellation request' } });
    }
    let identity: AuthenticatedCustomer;
    try { identity = await options.verifyRequestIdentity(request.headers.authorization); }
    catch { return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } }); }
    if (!options.getCancellationWorkflow) return reply.code(503).send({ error: { code: 'cancellation_unavailable', message: 'Cancellation is unavailable' } });
    try {
      const state = await options.getCancellationWorkflow({ workflowId: params.data.workflowId,
        access: accessFor(identity, options.createCorrelationId(), options.createCorrelationId()) });
      return reply.send(projectSafeState(state));
    } catch (error) {
      if (error instanceof CancellationWorkflowNotFoundError) return reply.code(404).send({ error: { code: 'cancellation_not_found', message: 'Cancellation request was not found' } });
      request.log.error({ err: error }, 'Cancellation state query failed');
      return reply.code(503).send({ error: { code: 'cancellation_unavailable', message: 'Cancellation is temporarily unavailable' } });
    }
  });

  app.post('/v1/cancellations/:workflowId/confirmation', async (request, reply) => {
    noCache(reply);
    const params = paramsSchema.safeParse(request.params);
    const body = confirmationBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: 'invalid_cancellation_confirmation', message: 'A valid preview decision is required' } });
    let identity: AuthenticatedCustomer;
    try { identity = await options.verifyRequestIdentity(request.headers.authorization); }
    catch { return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } }); }
    if (!options.confirmCancellationWorkflow) return reply.code(503).send({ error: { code: 'cancellation_unavailable', message: 'Cancellation is unavailable' } });
    try {
      await options.confirmCancellationWorkflow({ workflowId: params.data.workflowId,
        access: accessFor(identity, options.createCorrelationId(), options.createCorrelationId()),
        previewId: body.data.preview_id, accepted: body.data.accepted });
      return reply.code(202).send({ status: 'confirmation_received' });
    } catch (error) {
      if (error instanceof CancellationWorkflowNotFoundError) return reply.code(404).send({ error: { code: 'cancellation_not_found', message: 'Cancellation request was not found' } });
      if (error instanceof CancellationPreviewUnavailableError) return reply.code(409).send({ error: { code: 'cancellation_preview_unavailable', message: 'This preview is no longer available' } });
      request.log.error({ err: error }, 'Cancellation confirmation failed');
      return reply.code(503).send({ error: { code: 'cancellation_unavailable', message: 'Cancellation is temporarily unavailable' } });
    }
  });
}

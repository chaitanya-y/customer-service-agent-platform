import type { FastifyInstance } from 'fastify';

import type { CommerceOrder, CommerceProvider } from './commerce.js';
import {
  AUTHORIZED_DUMMY_CANCELLATION_EXECUTE_PATH, AUTHORIZED_DUMMY_CANCELLATION_FACTS_PATH,
  AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION, AUTHORIZED_DUMMY_CANCELLATION_RECONCILE_PATH,
  authorizedDummyCancellationFactsRequestSchema, authorizedDummyCancellationIntentSchema,
  type AuthorizedDummyCancellationIntent,
} from './authorized-dummy-cancellation-contract.js';
import type {
  ZeroTotalCancellationExecution, ZeroTotalCancellationRepository, ZeroTotalCancellationReservation,
} from './zero-total-cancellation-repository.js';
import type { AuthorizedDummyCancellationProvider } from './vendure-authorized-dummy-cancellation-client.js';
import { CONTEXT_ASSERTION_HEADER, type OrderAccessContext, type VerifyContextAssertion } from './trusted-context.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER, type VerifyWorkflowAccessAssertion, type WorkflowAccessContext } from './workflow-access.js';

type Options = {
  commerceProvider: CommerceProvider;
  cancellationProvider: AuthorizedDummyCancellationProvider;
  repository: ZeroTotalCancellationRepository;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  verifyCustomerContext: VerifyContextAssertion;
  verifyWorkflowFacts?: VerifyWorkflowAccessAssertion;
  verifyWorkflowExecute?: VerifyWorkflowAccessAssertion;
  verifyWorkflowReconcile?: VerifyWorkflowAccessAssertion;
  now?: () => Date;
};

function inScope(access: OrderAccessContext, options: Options): boolean {
  return access.tenantId === options.expectedTenantId && access.environmentId === options.expectedEnvironmentId;
}
function owned(order: CommerceOrder | null, access: OrderAccessContext, reference?: string): order is CommerceOrder {
  return !!order && order.customer?.id === access.subjectCustomerId
    && (reference === undefined || order.reference === reference);
}
function sameIntent(left: AuthorizedDummyCancellationIntent | undefined, right: AuthorizedDummyCancellationIntent): boolean {
  return !!left && left.orderId === right.orderId && left.orderReference === right.orderReference
    && left.paymentId === right.paymentId && left.previewId === right.previewId
    && left.previewExpiresAt === right.previewExpiresAt && left.policyVersion === right.policyVersion
    && left.providerFactsDigest === right.providerFactsDigest && left.idempotencyKey === right.idempotencyKey;
}
function reservation(access: WorkflowAccessContext, intent: AuthorizedDummyCancellationIntent): ZeroTotalCancellationReservation {
  return { tenantId: access.tenantId, environmentId: access.environmentId, workflowId: access.contextId,
    customerId: access.subjectCustomerId, ...intent };
}

export function registerAuthorizedDummyCancellationRoutes(app: FastifyInstance, options: Options): void {
  const now = options.now ?? (() => new Date());

  async function workerAccess(assertion: unknown, verifier: VerifyWorkflowAccessAssertion | undefined): Promise<WorkflowAccessContext | null> {
    if (typeof assertion !== 'string' || !verifier) return null;
    try {
      const access = await verifier(assertion);
      return inScope(access, options) && access.workflowType === 'AUTHORIZED_DUMMY_CANCELLATION' ? access : null;
    } catch { return null; }
  }

  async function authoritativeOutcome(execution: ZeroTotalCancellationExecution, input: ZeroTotalCancellationReservation) {
    const marker = await options.cancellationProvider.getMarker(execution.operationId);
    if (marker?.status === 'SUCCEEDED' && marker.operationId === execution.operationId
      && marker.tenantId === input.tenantId && marker.environmentId === input.environmentId
      && marker.customerId === input.customerId && marker.orderId === input.orderId
      && marker.orderReference === input.orderReference && marker.paymentId === input.paymentId
      && marker.factsDigest === input.providerFactsDigest && marker.workflowId === input.workflowId
      && marker.previewId === input.previewId && marker.previewExpiresAt === input.previewExpiresAt
      && marker.policyVersion === input.policyVersion && marker.idempotencyKey === input.idempotencyKey) {
      const order = await options.commerceProvider.getOrderById(input.orderId);
      if (order && order.reference === input.orderReference && order.customer?.id === input.customerId
        && order.status === 'Cancelled' && order.active === false && order.placedAt !== null
        && order.payments.length === 1 && order.payments[0]?.id === input.paymentId
        && order.payments[0].status === 'Cancelled' && order.payments[0].refunds.length === 0
        && order.fulfillments.length === 0 && order.items.length > 0
        && order.items.every(item => item.quantity === 0)) {
        await options.repository.recordStatus(execution.operationId, 'SUCCEEDED');
        return { status: 'SUCCEEDED' as const, operationId: execution.operationId };
      }
    }
    await options.repository.recordStatus(execution.operationId, 'PENDING_RECONCILIATION');
    return { status: 'PENDING_RECONCILIATION' as const, operationId: execution.operationId };
  }

  app.post(AUTHORIZED_DUMMY_CANCELLATION_FACTS_PATH, async (request, reply) => {
    const parsed = authorizedDummyCancellationFactsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_authorized_dummy_cancellation_facts_request' } });
    const customerAssertion = request.headers[CONTEXT_ASSERTION_HEADER];
    const workflowAssertion = request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER];
    if (typeof customerAssertion === 'string' && typeof workflowAssertion === 'string') {
      return reply.code(401).send({ error: { code: 'cancellation_facts_unauthorized' } });
    }
    let access: OrderAccessContext | null = null;
    if (typeof workflowAssertion === 'string') access = await workerAccess(workflowAssertion, options.verifyWorkflowFacts);
    else try { access = await options.verifyCustomerContext(typeof customerAssertion === 'string' ? customerAssertion : undefined); }
    catch { /* fail closed */ }
    if (!access || !inScope(access, options)) return reply.code(401).send({ error: { code: 'cancellation_facts_unauthorized' } });
    try {
      const order = await options.commerceProvider.getOrderByReference(parsed.data.orderReference);
      if (!owned(order, access)) return reply.code(404).send({ error: { code: 'order_not_found' } });
      const facts = await options.cancellationProvider.getFacts(order.source.orderId);
      if (!facts || facts.orderId !== order.source.orderId || facts.orderReference !== order.reference
        || facts.customerId !== access.subjectCustomerId) return reply.code(404).send({ error: { code: 'order_not_found' } });
      if (facts.eligible && (!facts.payment || facts.payment.state !== 'Authorized')) {
        throw new Error('Eligible cancellation facts missing authorized payment');
      }
      return { orderId: facts.orderId, orderReference: facts.orderReference,
        policyVersion: AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION, providerFactsDigest: facts.digest,
        eligible: facts.eligible, placedAt: facts.placedAt,
        total: { amountMinor: facts.totalWithTax, currency: facts.currencyCode },
        lines: facts.lines,
        payment: facts.payment ? { id: facts.payment.id, state: facts.payment.state,
          amountMinor: facts.payment.amount } : null };
    } catch (error) {
      request.log.error({ err: error }, 'Authorized dummy cancellation facts lookup failed');
      return reply.code(502).send({ error: { code: 'commerce_provider_unavailable' } });
    }
  });

  app.post(AUTHORIZED_DUMMY_CANCELLATION_EXECUTE_PATH, async (request, reply) => {
    const parsed = authorizedDummyCancellationIntentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_authorized_dummy_cancellation_request' } });
    const access = await workerAccess(request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER], options.verifyWorkflowExecute);
    if (!access || !sameIntent(access.authorizedDummyCancellation, parsed.data)
      || typeof request.headers[CONTEXT_ASSERTION_HEADER] === 'string') {
      return reply.code(401).send({ error: { code: 'workflow_unauthorized' } });
    }
    if (Date.parse(parsed.data.previewExpiresAt) <= now().getTime()) {
      return reply.code(409).send({ error: { code: 'cancellation_preview_expired' } });
    }
    let order: CommerceOrder | null;
    try { order = await options.commerceProvider.getOrderById(parsed.data.orderId); }
    catch { return reply.code(502).send({ error: { code: 'commerce_provider_unavailable' } }); }
    if (!owned(order, access, parsed.data.orderReference)) return reply.code(404).send({ error: { code: 'order_not_found' } });
    const input = reservation(access, parsed.data);
    const held = await options.repository.reserve(input);
    if (held.kind === 'conflict') return reply.code(409).send({ error: { code: 'cancellation_execution_conflict' } });
    const execution: ZeroTotalCancellationExecution = held.kind === 'reserved'
      ? { operationId: held.operationId, status: 'IN_PROGRESS' } : held.execution;
    if (execution.status === 'FAILED') return { status: 'FAILED', operationId: execution.operationId };
    if (held.kind !== 'reserved') return authoritativeOutcome(execution, input);
    try {
      const facts = await options.cancellationProvider.getFacts(parsed.data.orderId);
      if (!facts || facts.customerId !== access.subjectCustomerId || facts.orderReference !== parsed.data.orderReference
        || facts.orderId !== parsed.data.orderId) {
        await options.repository.recordStatus(execution.operationId, 'FAILED');
        return reply.code(404).send({ error: { code: 'order_not_found' } });
      }
      if (!facts.eligible || facts.digest !== parsed.data.providerFactsDigest
        || facts.payment?.id !== parsed.data.paymentId || facts.payment.state !== 'Authorized') {
        await options.repository.recordStatus(execution.operationId, 'FAILED');
        return reply.code(409).send({ error: { code: 'cancellation_no_longer_eligible' } });
      }
    } catch (error) {
      request.log.error({ err: error }, 'Authorized dummy cancellation preflight uncertain');
      await options.repository.recordStatus(execution.operationId, 'PENDING_RECONCILIATION');
      return { status: 'PENDING_RECONCILIATION', operationId: execution.operationId };
    }
    try {
      await options.cancellationProvider.cancel({ operationId: execution.operationId,
        tenantId: input.tenantId, environmentId: input.environmentId, customerId: input.customerId,
        orderId: input.orderId, orderReference: input.orderReference, paymentId: parsed.data.paymentId,
        expectedFactsDigest: input.providerFactsDigest, workflowId: input.workflowId,
        previewId: input.previewId, previewExpiresAt: input.previewExpiresAt,
        policyVersion: input.policyVersion, idempotencyKey: input.idempotencyKey });
    } catch (error) { request.log.warn({ err: error }, 'Authorized dummy provider outcome uncertain'); }
    try { return await authoritativeOutcome(execution, input); }
    catch (error) {
      request.log.error({ err: error }, 'Authorized dummy cancellation reconciliation deferred');
      await options.repository.recordStatus(execution.operationId, 'PENDING_RECONCILIATION');
      return { status: 'PENDING_RECONCILIATION', operationId: execution.operationId };
    }
  });

  app.post(AUTHORIZED_DUMMY_CANCELLATION_RECONCILE_PATH, async (request, reply) => {
    const parsed = authorizedDummyCancellationIntentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_authorized_dummy_cancellation_reconciliation_request' } });
    const access = await workerAccess(request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER], options.verifyWorkflowReconcile);
    if (!access || !sameIntent(access.authorizedDummyCancellation, parsed.data)
      || typeof request.headers[CONTEXT_ASSERTION_HEADER] === 'string') {
      return reply.code(401).send({ error: { code: 'workflow_unauthorized' } });
    }
    let order: CommerceOrder | null;
    try { order = await options.commerceProvider.getOrderById(parsed.data.orderId); }
    catch { return reply.code(502).send({ error: { code: 'commerce_provider_unavailable' } }); }
    if (!owned(order, access, parsed.data.orderReference)) return reply.code(404).send({ error: { code: 'order_not_found' } });
    const input = reservation(access, parsed.data);
    const execution = await options.repository.findExact(input);
    if (!execution) return { status: 'NOT_FOUND' };
    if (execution.status === 'FAILED') return { status: 'FAILED', operationId: execution.operationId };
    try { return await authoritativeOutcome(execution, input); }
    catch (error) {
      request.log.error({ err: error }, 'Authorized dummy cancellation reconciliation deferred');
      return { status: 'PENDING_RECONCILIATION', operationId: execution.operationId };
    }
  });
}

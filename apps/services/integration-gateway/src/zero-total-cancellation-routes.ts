import type { FastifyInstance } from 'fastify';

import type { CommerceOrder, CommerceProvider } from './commerce.js';
import { ZERO_TOTAL_CANCELLATION_EXECUTE_PATH, ZERO_TOTAL_CANCELLATION_FACTS_PATH, ZERO_TOTAL_CANCELLATION_POLICY_VERSION, ZERO_TOTAL_CANCELLATION_RECONCILE_PATH, zeroTotalCancellationFactsRequestSchema, zeroTotalCancellationIntentSchema, type ZeroTotalCancellationIntent } from './zero-total-cancellation-contract.js';
import type { ZeroTotalCancellationExecution, ZeroTotalCancellationRepository, ZeroTotalCancellationReservation } from './zero-total-cancellation-repository.js';
import type { ZeroTotalCancellationProvider } from './vendure-zero-total-cancellation-client.js';
import { CONTEXT_ASSERTION_HEADER, type OrderAccessContext, type VerifyContextAssertion } from './trusted-context.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER, type VerifyWorkflowAccessAssertion, type WorkflowAccessContext } from './workflow-access.js';

type Options = {
  commerceProvider: CommerceProvider;
  cancellationProvider: ZeroTotalCancellationProvider;
  repository: ZeroTotalCancellationRepository;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  verifyCustomerContext: VerifyContextAssertion;
  verifyWorkflowFacts?: VerifyWorkflowAccessAssertion | undefined;
  verifyWorkflowExecute?: VerifyWorkflowAccessAssertion | undefined;
  verifyWorkflowReconcile?: VerifyWorkflowAccessAssertion | undefined;
  now?: () => Date;
};

function sameIntent(left: ZeroTotalCancellationIntent | undefined, right: ZeroTotalCancellationIntent): boolean {
  return !!left && left.orderId === right.orderId && left.orderReference === right.orderReference
    && left.previewId === right.previewId && left.previewExpiresAt === right.previewExpiresAt
    && left.policyVersion === right.policyVersion && left.providerFactsDigest === right.providerFactsDigest
    && left.idempotencyKey === right.idempotencyKey;
}
function inScope(access: OrderAccessContext, options: Options): boolean {
  return access.tenantId === options.expectedTenantId && access.environmentId === options.expectedEnvironmentId;
}
function owned(order: CommerceOrder | null, access: OrderAccessContext, reference?: string): order is CommerceOrder {
  return !!order && order.customer?.id === access.subjectCustomerId && (reference === undefined || order.reference === reference);
}
function reservation(access: WorkflowAccessContext, intent: ZeroTotalCancellationIntent): ZeroTotalCancellationReservation {
  return { tenantId: access.tenantId, environmentId: access.environmentId, workflowId: access.contextId, customerId: access.subjectCustomerId, ...intent };
}

function namedCancellationLines(lines: readonly Readonly<{ id: string; quantity: number; orderPlacedQuantity: number }>[], order: CommerceOrder) {
  return lines.map(line => {
    const matches = order.items.filter(item => item.id === line.id);
    if (matches.length !== 1) throw new Error('CANCELLATION_ITEM_LABEL_UNAVAILABLE');
    const displayName = matches[0]!.name.trim();
    if (displayName.length === 0 || displayName.length > 300
      || /\p{C}/u.test(displayName) || !/[\p{L}\p{N}]/u.test(displayName)) {
      throw new Error('CANCELLATION_ITEM_LABEL_UNAVAILABLE');
    }
    return { ...line, displayName };
  });
}

export function registerZeroTotalCancellationRoutes(app: FastifyInstance, options: Options): void {
  const now = options.now ?? (() => new Date());

  async function workerAccess(assertion: unknown, verifier: VerifyWorkflowAccessAssertion | undefined): Promise<WorkflowAccessContext | null> {
    if (typeof assertion !== 'string' || !verifier) return null;
    try {
      const access = await verifier(assertion);
      return inScope(access, options) && access.workflowType === 'ZERO_TOTAL_CANCELLATION' ? access : null;
    } catch { return null; }
  }

  async function authoritativeOutcome(execution: ZeroTotalCancellationExecution, input: ZeroTotalCancellationReservation) {
    const marker = await options.cancellationProvider.getMarker(execution.operationId);
    if (marker?.status === 'SUCCEEDED' && marker.operationId === execution.operationId
      && marker.tenantId === input.tenantId && marker.environmentId === input.environmentId
      && marker.customerId === input.customerId && marker.orderId === input.orderId
      && marker.orderReference === input.orderReference && marker.factsDigest === input.providerFactsDigest
      && marker.workflowId === input.workflowId && marker.previewId === input.previewId
      && marker.previewExpiresAt === input.previewExpiresAt && marker.policyVersion === input.policyVersion
      && marker.idempotencyKey === input.idempotencyKey) {
      const order = await options.commerceProvider.getOrderById(input.orderId);
      if (order && order.reference === input.orderReference && order.customer?.id === input.customerId
        && order.status === 'Cancelled' && order.active === false && order.placedAt !== null) {
        await options.repository.recordStatus(execution.operationId, 'SUCCEEDED');
        return { status: 'SUCCEEDED' as const, operationId: execution.operationId };
      }
    }
    await options.repository.recordStatus(execution.operationId, 'PENDING_RECONCILIATION');
    return { status: 'PENDING_RECONCILIATION' as const, operationId: execution.operationId };
  }

  app.post(ZERO_TOTAL_CANCELLATION_FACTS_PATH, async (request, reply) => {
    const parsed = zeroTotalCancellationFactsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_zero_total_cancellation_facts_request' } });
    const customerAssertion = request.headers[CONTEXT_ASSERTION_HEADER];
    const workflowAssertion = request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER];
    if (typeof customerAssertion === 'string' && typeof workflowAssertion === 'string') return reply.code(401).send({ error: { code: 'cancellation_facts_unauthorized' } });
    let access: OrderAccessContext | null = null;
    if (typeof workflowAssertion === 'string') access = await workerAccess(workflowAssertion, options.verifyWorkflowFacts);
    else try { access = await options.verifyCustomerContext(typeof customerAssertion === 'string' ? customerAssertion : undefined); } catch { /* fail closed */ }
    if (!access || !inScope(access, options)) return reply.code(401).send({ error: { code: 'cancellation_facts_unauthorized' } });
    try {
      const order = await options.commerceProvider.getOrderByReference(parsed.data.orderReference);
      if (!owned(order, access)) return reply.code(404).send({ error: { code: 'order_not_found' } });
      const facts = await options.cancellationProvider.getFacts(order.source.orderId);
      if (!facts || facts.orderId !== order.source.orderId || facts.orderReference !== order.reference || facts.customerId !== access.subjectCustomerId) return reply.code(404).send({ error: { code: 'order_not_found' } });
      return { orderId: facts.orderId, orderReference: facts.orderReference, policyVersion: ZERO_TOTAL_CANCELLATION_POLICY_VERSION, providerFactsDigest: facts.digest, eligible: facts.eligible, placedAt: facts.placedAt, total: { amountMinor: facts.totalWithTax, currency: facts.currencyCode }, lines: namedCancellationLines(facts.lines, order) };
    } catch (error) { request.log.error({ err: error }, 'Zero-total cancellation facts lookup failed'); return reply.code(502).send({ error: { code: 'commerce_provider_unavailable' } }); }
  });

  app.post(ZERO_TOTAL_CANCELLATION_EXECUTE_PATH, async (request, reply) => {
    const parsed = zeroTotalCancellationIntentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_zero_total_cancellation_request' } });
    const access = await workerAccess(request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER], options.verifyWorkflowExecute);
    if (!access || !sameIntent(access.zeroTotalCancellation, parsed.data) || typeof request.headers[CONTEXT_ASSERTION_HEADER] === 'string') return reply.code(401).send({ error: { code: 'workflow_unauthorized' } });
    if (Date.parse(parsed.data.previewExpiresAt) <= now().getTime()) return reply.code(409).send({ error: { code: 'cancellation_preview_expired' } });
    let order: CommerceOrder | null;
    try { order = await options.commerceProvider.getOrderById(parsed.data.orderId); }
    catch { return reply.code(502).send({ error: { code: 'commerce_provider_unavailable' } }); }
    if (!owned(order, access, parsed.data.orderReference)) return reply.code(404).send({ error: { code: 'order_not_found' } });
    const input = reservation(access, parsed.data);
    const held = await options.repository.reserve(input);
    if (held.kind === 'conflict') return reply.code(409).send({ error: { code: 'cancellation_execution_conflict' } });
    const execution: ZeroTotalCancellationExecution = held.kind === 'reserved' ? { operationId: held.operationId, status: 'IN_PROGRESS' } : held.execution;
    if (execution.status === 'FAILED') return { status: 'FAILED', operationId: execution.operationId };
    if (execution.status === 'SUCCEEDED') return authoritativeOutcome(execution, input);
    // An existing reservation may already have reached Vendure even when the
    // response was lost. Only the first reservation may attempt the write;
    // every replay must inspect the marker and final provider state instead.
    if (held.kind !== 'reserved') return authoritativeOutcome(execution, input);
    if (held.kind === 'reserved') {
      try {
        const facts = await options.cancellationProvider.getFacts(parsed.data.orderId);
        if (!facts || facts.customerId !== access.subjectCustomerId || facts.orderReference !== parsed.data.orderReference || facts.orderId !== parsed.data.orderId) {
          await options.repository.recordStatus(execution.operationId, 'FAILED');
          return reply.code(404).send({ error: { code: 'order_not_found' } });
        }
        if (!facts.eligible || facts.digest !== parsed.data.providerFactsDigest) {
          await options.repository.recordStatus(execution.operationId, 'FAILED');
          return reply.code(409).send({ error: { code: 'cancellation_no_longer_eligible' } });
        }
      } catch (error) { request.log.error({ err: error }, 'Cancellation preflight uncertain'); await options.repository.recordStatus(execution.operationId, 'PENDING_RECONCILIATION'); return { status: 'PENDING_RECONCILIATION', operationId: execution.operationId }; }
    }
    try { await options.cancellationProvider.cancel({ operationId: execution.operationId, tenantId: input.tenantId, environmentId: input.environmentId, customerId: input.customerId, orderId: input.orderId, orderReference: input.orderReference, expectedFactsDigest: input.providerFactsDigest, workflowId: input.workflowId, previewId: input.previewId, previewExpiresAt: input.previewExpiresAt, policyVersion: input.policyVersion, idempotencyKey: input.idempotencyKey }); }
    catch (error) { request.log.warn({ err: error }, 'Cancellation provider outcome uncertain'); }
    try { return await authoritativeOutcome(execution, input); }
    catch (error) { request.log.error({ err: error }, 'Cancellation reconciliation deferred'); await options.repository.recordStatus(execution.operationId, 'PENDING_RECONCILIATION'); return { status: 'PENDING_RECONCILIATION', operationId: execution.operationId }; }
  });

  app.post(ZERO_TOTAL_CANCELLATION_RECONCILE_PATH, async (request, reply) => {
    const parsed = zeroTotalCancellationIntentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_zero_total_cancellation_reconciliation_request' } });
    const access = await workerAccess(request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER], options.verifyWorkflowReconcile);
    if (!access || !sameIntent(access.zeroTotalCancellation, parsed.data) || typeof request.headers[CONTEXT_ASSERTION_HEADER] === 'string') return reply.code(401).send({ error: { code: 'workflow_unauthorized' } });
    let order: CommerceOrder | null;
    try { order = await options.commerceProvider.getOrderById(parsed.data.orderId); }
    catch { return reply.code(502).send({ error: { code: 'commerce_provider_unavailable' } }); }
    if (!owned(order, access, parsed.data.orderReference)) return reply.code(404).send({ error: { code: 'order_not_found' } });
    const input = reservation(access, parsed.data);
    const execution = await options.repository.findExact(input);
    if (!execution) return { status: 'NOT_FOUND' };
    if (execution.status === 'FAILED') return { status: 'FAILED', operationId: execution.operationId };
    try { return await authoritativeOutcome(execution, input); }
    catch (error) { request.log.error({ err: error }, 'Cancellation reconciliation deferred'); return { status: 'PENDING_RECONCILIATION', operationId: execution.operationId }; }
  });
}

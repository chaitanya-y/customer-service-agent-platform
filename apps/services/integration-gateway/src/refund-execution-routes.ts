import type { FastifyInstance } from 'fastify';

import type { CommerceProvider } from './commerce.js';
import { toRefundContext } from './refund-context.js';
import type { RefundExecutionRepository } from './refund-execution-repository.js';
import { refundExecutionIntentSchema, WORKFLOW_ACCESS_ASSERTION_HEADER, type RefundExecutionIntent, type VerifyWorkflowAccessAssertion } from './workflow-access.js';

type ExecutionResult = { status: 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION'; providerRefundId?: string };

export function registerRefundExecutionRoutes(app: FastifyInstance, commerceProvider: CommerceProvider, repository: RefundExecutionRepository, verify?: VerifyWorkflowAccessAssertion): void {
  app.post('/internal/v1/refunds', async (request, reply) => {
    const parsed = refundExecutionIntentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_refund_execution_request' } });
    let access;
    try {
      access = await verify?.(typeof request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER] === 'string' ? request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER] : undefined);
      if (!verify) throw new Error('missing verifier');
    } catch { return reply.code(401).send({ error: { code: 'workflow_unauthorized' } }); }
    if (!access?.refundExecution || !sameExecutionIntent(access.refundExecution, parsed.data)) return reply.code(401).send({ error: { code: 'workflow_unauthorized' } });
    if (!commerceProvider.executeRefund) return reply.code(501).send({ error: { code: 'refund_execution_not_configured' } });
    const order = await commerceProvider.getOrderById(parsed.data.orderId);
    if (!order || order.source.orderId !== parsed.data.orderId || order.customer?.id !== access?.subjectCustomerId) return reply.code(404).send({ error: { code: 'order_not_found' } });
    const reservation = await repository.reserve({ tenantId: access.tenantId, environmentId: access.environmentId, idempotencyKey: parsed.data.idempotencyKey, workflowId: access.contextId, previewId: parsed.data.previewId, orderId: parsed.data.orderId, amountMinor: parsed.data.amount.amountMinor, currency: parsed.data.amount.currency, selection: parsed.data.selection, reasonCode: parsed.data.reasonCode, occurredAt: new Date().toISOString() });
    if (reservation.kind === 'conflict') return reply.code(409).send({ error: { code: 'refund_execution_conflict' } });
    if (reservation.kind === 'existing') {
      if (reservation.execution.status === 'SUCCEEDED') return succeededResponse(reservation.execution.providerRefundId);
      if (reservation.execution.status === 'FAILED') return { status: 'FAILED' } satisfies ExecutionResult;
      if (reservation.execution.status === 'SUBMITTED') return submittedResponse(reservation.execution.providerRefundId);
      return { status: 'PENDING_RECONCILIATION' } satisfies ExecutionResult;
    }
    try {
      // The first read proves ownership only. Eligibility must be observed
      // after the order claim commits, never from a pre-reservation snapshot.
      const claimedOrder = await commerceProvider.getOrderById(parsed.data.orderId);
      if (!claimedOrder || claimedOrder.source.orderId !== parsed.data.orderId || claimedOrder.customer?.id !== access.subjectCustomerId) {
        await repository.recordOutcome(reservation.executionId, 'FAILED');
        return reply.code(404).send({ error: { code: 'order_not_found' } });
      }
      const currentContext = toRefundContext(claimedOrder, parsed.data.selection, { observationId: 'refund-execution-check', observedAt: new Date().toISOString() });
      const payment = claimedOrder.payments.find((candidate) => candidate.status.toUpperCase() === 'SETTLED');
      if (!payment || !currentContext.facts.transactionRefundable || !currentContext.facts.itemSelectionValid || currentContext.facts.refundableAmount.currency !== parsed.data.amount.currency || parsed.data.amount.amountMinor > currentContext.facts.refundableAmount.amountMinor) {
        await repository.recordOutcome(reservation.executionId, 'FAILED');
        return reply.code(409).send({ error: { code: 'refund_no_longer_eligible' } });
      }
      const result = await commerceProvider.executeRefund({ orderId: claimedOrder.source.orderId, paymentId: payment.id, amount: parsed.data.amount, reason: parsed.data.reasonCode });
      const response: ExecutionResult = result.status === 'SUBMITTED'
        ? result.providerRefundId === undefined
          ? { status: 'SUBMITTED' }
          : { status: 'SUBMITTED', providerRefundId: result.providerRefundId }
        : result.status === 'SUCCEEDED'
        ? result.providerRefundId === undefined
          ? { status: 'SUCCEEDED' }
          : { status: 'SUCCEEDED', providerRefundId: result.providerRefundId }
        : { status: 'FAILED' };
      await repository.recordOutcome(reservation.executionId, response.status, response.providerRefundId);
      return response;
    } catch (error) {
      request.log.error({ err: error }, 'Refund provider outcome is unknown; reconciliation required');
      await repository.recordOutcome(reservation.executionId, 'PENDING_RECONCILIATION');
      return { status: 'PENDING_RECONCILIATION' } satisfies ExecutionResult;
    }
  });
}

function sameExecutionIntent(authorized: RefundExecutionIntent, requested: RefundExecutionIntent): boolean {
  return authorized.orderId === requested.orderId && authorized.reasonCode === requested.reasonCode
    && authorized.previewId === requested.previewId && authorized.idempotencyKey === requested.idempotencyKey
    && authorized.amount.amountMinor === requested.amount.amountMinor && authorized.amount.currency === requested.amount.currency
    && authorized.selection.scope === requested.selection.scope
    && authorized.selection.itemIds.length === requested.selection.itemIds.length
    && authorized.selection.itemIds.every((itemId, index) => itemId === requested.selection.itemIds[index]);
}

function succeededResponse(providerRefundId: string | undefined): ExecutionResult { return providerRefundId === undefined ? { status: 'SUCCEEDED' } : { status: 'SUCCEEDED', providerRefundId }; }
function submittedResponse(providerRefundId: string | undefined): ExecutionResult { return providerRefundId === undefined ? { status: 'SUBMITTED' } : { status: 'SUBMITTED', providerRefundId }; }

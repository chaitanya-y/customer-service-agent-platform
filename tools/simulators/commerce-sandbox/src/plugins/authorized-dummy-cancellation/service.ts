import { createHash } from 'node:crypto';
import { dummyPaymentHandler, isGraphQlErrorResult, Order, OrderService, PaymentMethodService, RequestContext, TransactionalConnection } from '@vendure/core';
import type { GuardedCancellationInput } from '../zero-total-cancellation/service';
import { authorizedDummyFactsDigest, isEligibleAuthorizedDummyCancellation, type AuthorizedDummyCancellationFacts } from './facts';
export type GuardedAuthorizedDummyCancellationInput = GuardedCancellationInput & { paymentId: string };
export type AuthorizedDummyCancellationMarker = Omit<GuardedAuthorizedDummyCancellationInput, 'expectedFactsDigest'> & { factsDigest: string; status: string };
const markerSelect = `SELECT operation_id AS operationId, order_id AS orderId, tenant_id AS tenantId,
    environment_id AS environmentId, customer_id AS customerId, order_reference AS orderReference,
    facts_digest AS factsDigest, workflow_id AS workflowId, preview_id AS previewId,
    preview_expires_at AS previewExpiresAt, policy_version AS policyVersion, idempotency_key AS idempotencyKey,
    payment_id AS paymentId, status FROM cso_zero_total_cancellation_marker`;

export class AuthorizedDummyCancellationService {
    constructor(private readonly connection: TransactionalConnection, private readonly orderService: OrderService, private readonly paymentMethods: PaymentMethodService) {}
    async getFacts(ctx: RequestContext, orderId: string): Promise<(AuthorizedDummyCancellationFacts & { digest: string; eligible: boolean }) | null> {
        const order = await this.connection.getRepository(ctx, Order).findOne({ where: { id: orderId },
            relations: ['customer', 'channels', 'lines', 'payments', 'payments.refunds', 'fulfillments'] });
        if (!order || !Array.isArray(order.channels) || !order.channels.some(channel => String(channel.id) === String(ctx.channelId))
            || !Array.isArray(order.lines) || !Array.isArray(order.payments) || !Array.isArray(order.fulfillments)
            || order.payments.some(payment => !Array.isArray(payment.refunds))) return null;
        let payment: AuthorizedDummyCancellationFacts['payment'] = null;
        if (order.payments.length === 1) {
            const current = order.payments[0];
            // A payment's method is a merchant code, never proof of its installed handler.
            const found = await this.paymentMethods.findAll(ctx, { filter: { code: { eq: current.method } }, take: 2 });
            if (found.totalItems === 1 && found.items[0]?.enabled) {
                try {
                    const resolved = await this.paymentMethods.getMethodAndOperations(ctx, current.method);
                    if (resolved.handler === dummyPaymentHandler && resolved.paymentMethod.handler.code === dummyPaymentHandler.code
                        && String(resolved.paymentMethod.id) === String(found.items[0].id)) {
                        const args = [...resolved.paymentMethod.handler.args].sort((a, b) => a.name.localeCompare(b.name)).map(arg => [arg.name, arg.value]);
                        payment = { id: String(current.id), state: current.state, amount: current.amount, method: current.method,
                            handlerCode: resolved.handler.code, paymentMethodId: String(resolved.paymentMethod.id),
                            handlerArgsDigest: createHash('sha256').update(JSON.stringify(args)).digest('hex') };
                    }
                } catch { /* Unresolvable or disabled method is ineligible; never invoke it. */ }
            }
        }
        const facts: AuthorizedDummyCancellationFacts = {
            orderId: String(order.id), orderReference: order.code, customerId: order.customerId == null ? null : String(order.customerId),
            channelIds: order.channels.map(channel => String(channel.id)), orderType: order.type, state: order.state, active: order.active,
            placedAt: order.orderPlacedAt ? new Date(order.orderPlacedAt).toISOString() : null, currencyCode: order.currencyCode,
            totalWithTax: order.totalWithTax, lines: order.lines.map(line => ({ id: String(line.id), quantity: line.quantity, orderPlacedQuantity: line.orderPlacedQuantity })),
            paymentCount: order.payments.length, payment, refundCount: order.payments.reduce((n, p) => n + p.refunds.length, 0), fulfillmentCount: order.fulfillments.length,
        };
        return { ...facts, digest: authorizedDummyFactsDigest(facts), eligible: isEligibleAuthorizedDummyCancellation(facts) };
    }

    async cancel(ctx: RequestContext, input: GuardedAuthorizedDummyCancellationInput): Promise<{ status: 'SUCCEEDED'; operationId: string; paymentId: string }> {
        input = { ...input, orderId: String(input.orderId), customerId: String(input.customerId), paymentId: String(input.paymentId) };
        if (!input.operationId || !input.tenantId || !input.environmentId || !input.customerId || !input.orderId || !input.paymentId
            || !input.orderReference || !input.workflowId || !input.previewId || !input.idempotencyKey || input.policyVersion !== 'AUTHORIZED_DUMMY_V1'
            || !/^[a-f0-9]{64}$/.test(input.expectedFactsDigest) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.previewExpiresAt)
            || !Number.isFinite(Date.parse(input.previewExpiresAt))) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_INVALID_INPUT');
        return this.connection.withTransaction(ctx, async transactionCtx => {
            const repository = this.connection.getRepository(transactionCtx, Order);
            // Shared order-unique marker is the first write: SQLite writer lock precedes all trusted reads.
            await repository.query(`INSERT OR IGNORE INTO cso_zero_total_cancellation_marker
                (operation_id,order_id,tenant_id,environment_id,customer_id,order_reference,facts_digest,workflow_id,
                 preview_id,preview_expires_at,policy_version,idempotency_key,payment_id,status)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')`, [input.operationId,input.orderId,input.tenantId,input.environmentId,input.customerId,
                input.orderReference,input.expectedFactsDigest,input.workflowId,input.previewId,input.previewExpiresAt,input.policyVersion,input.idempotencyKey,input.paymentId]);
            const [marker] = await repository.query(`${markerSelect} WHERE order_id = ?`, [input.orderId]) as AuthorizedDummyCancellationMarker[];
            if (!marker) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_CONFLICT_MARKER_MISSING');
            for (const [field, expected] of Object.entries(input)) {
                const actual = field === 'expectedFactsDigest' ? marker.factsDigest : marker[field as keyof AuthorizedDummyCancellationMarker];
                if (actual !== expected) throw new Error(`AUTHORIZED_DUMMY_CANCELLATION_CONFLICT_${field.toUpperCase()}`);
            }
            const current = await this.getFacts(transactionCtx, input.orderId);
            if (!current || current.customerId !== input.customerId || current.orderReference !== input.orderReference) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_NOT_FOUND');
            const succeeded = { status: 'SUCCEEDED' as const, operationId: input.operationId, paymentId: input.paymentId };
            if (marker.status === 'SUCCEEDED') {
                if (!this.hasFinalStates(current, input.paymentId)) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_RECONCILIATION_REQUIRED');
                return succeeded;
            }
            if (marker.status !== 'PENDING') throw new Error('AUTHORIZED_DUMMY_CANCELLATION_CONFLICT_STATUS');
            if (Date.parse(input.previewExpiresAt) <= Date.now()) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_PREVIEW_EXPIRED');
            if (!current.eligible || current.digest !== input.expectedFactsDigest || current.payment?.id !== input.paymentId) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_INELIGIBLE');
            const cancelledPayment = await this.orderService.cancelPayment(transactionCtx, input.paymentId);
            if (isGraphQlErrorResult(cancelledPayment) || cancelledPayment.state !== 'Cancelled') throw new Error('AUTHORIZED_DUMMY_CANCELLATION_PAYMENT_REJECTED');
            const afterPayment = await this.getFacts(transactionCtx, input.orderId);
            if (!afterPayment || afterPayment.payment?.id !== input.paymentId || afterPayment.payment.state !== 'Cancelled'
                || afterPayment.paymentCount !== 1 || afterPayment.refundCount !== 0 || afterPayment.fulfillmentCount !== 0) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_PAYMENT_STATE_INVALID');
            const cancelledOrder = await this.orderService.cancelOrder(transactionCtx, { orderId: input.orderId, cancelShipping: true, reason: 'Customer-requested order and simulated authorization cancellation' });
            if (isGraphQlErrorResult(cancelledOrder)) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_ORDER_REJECTED');
            const final = await this.getFacts(transactionCtx, input.orderId);
            if (!final || !this.hasFinalStates(final, input.paymentId) || final.customerId !== current.customerId || final.orderReference !== current.orderReference
                || final.currencyCode !== current.currencyCode || final.lines.length !== current.lines.length
                || !final.lines.every(line => current.lines.some(before => before.id === line.id && before.orderPlacedQuantity === line.orderPlacedQuantity))
                || final.payment?.amount !== current.payment.amount || final.payment.method !== current.payment.method
                || final.payment.paymentMethodId !== current.payment.paymentMethodId || final.payment.handlerArgsDigest !== current.payment.handlerArgsDigest) throw new Error('AUTHORIZED_DUMMY_CANCELLATION_FINAL_STATE_INVALID');
            await repository.query(`UPDATE cso_zero_total_cancellation_marker SET status = 'SUCCEEDED' WHERE operation_id = ? AND status = 'PENDING'`, [input.operationId]);
            return succeeded;
        });
    }

    private hasFinalStates(facts: AuthorizedDummyCancellationFacts, paymentId: string): boolean {
        return facts.state === 'Cancelled' && !facts.active && facts.paymentCount === 1 && facts.payment?.id === paymentId
            && facts.payment.state === 'Cancelled' && facts.refundCount === 0 && facts.fulfillmentCount === 0
            && facts.lines.length > 0 && facts.lines.every(line => line.quantity === 0);
    }

    async getMarker(ctx: RequestContext, operationId: string): Promise<AuthorizedDummyCancellationMarker | null> {
        const [marker] = await this.connection.getRepository(ctx, Order).query(`${markerSelect} WHERE operation_id = ? AND policy_version = 'AUTHORIZED_DUMMY_V1'`, [operationId]) as AuthorizedDummyCancellationMarker[];
        if (!marker || !await this.getFacts(ctx, marker.orderId)) return null;
        return marker;
    }
}

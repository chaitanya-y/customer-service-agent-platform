import { isGraphQlErrorResult, Order, OrderService, RequestContext, TransactionalConnection } from '@vendure/core';

import { cancellationFactsDigest, isEligibleZeroTotalCancellation, type CancellationFacts } from './facts';

const POLICY_VERSION = 'NO_PAYMENT_ZERO_TOTAL_V1';

export type GuardedCancellationInput = Readonly<{
    operationId: string;
    tenantId: string;
    environmentId: string;
    customerId: string;
    orderId: string;
    orderReference: string;
    expectedFactsDigest: string;
    workflowId: string;
    previewId: string;
    previewExpiresAt: string;
    policyVersion: string;
    idempotencyKey: string;
}>;

type Marker = {
    operationId: string;
    orderId: string;
    tenantId: string;
    environmentId: string;
    customerId: string;
    orderReference: string;
    factsDigest: string;
    workflowId: string;
    previewId: string;
    previewExpiresAt: string;
    policyVersion: string;
    idempotencyKey: string;
    status: string;
};

function markerMismatch(marker: Marker, input: GuardedCancellationInput): string | null {
    const fields: readonly (readonly [string, unknown, unknown])[] = [
        ['operation_id', marker.operationId, input.operationId], ['order_id', marker.orderId, input.orderId],
        ['tenant_id', marker.tenantId, input.tenantId], ['environment_id', marker.environmentId, input.environmentId],
        ['customer_id', marker.customerId, input.customerId], ['order_reference', marker.orderReference, input.orderReference],
        ['facts_digest', marker.factsDigest, input.expectedFactsDigest], ['workflow_id', marker.workflowId, input.workflowId],
        ['preview_id', marker.previewId, input.previewId], ['preview_expires_at', marker.previewExpiresAt, input.previewExpiresAt],
        ['policy_version', marker.policyVersion, input.policyVersion], ['idempotency_key', marker.idempotencyKey, input.idempotencyKey],
    ];
    return fields.find(([, actual, expected]) => actual !== expected)?.[0] ?? null;
}

export class ZeroTotalCancellationService {
    constructor(private readonly connection: TransactionalConnection, private readonly orderService: OrderService) {}

    async getFacts(ctx: RequestContext, orderId: string): Promise<(CancellationFacts & { digest: string; eligible: boolean }) | null> {
        const order = await this.connection.getRepository(ctx, Order).findOne({
            where: { id: orderId },
            relations: ['customer', 'channels', 'lines', 'payments', 'payments.refunds', 'fulfillments'],
        });
        if (!order || !order.channels?.some(channel => String(channel.id) === String(ctx.channelId))
            || !Array.isArray(order.lines) || !Array.isArray(order.payments) || !Array.isArray(order.fulfillments)) return null;
        const facts: CancellationFacts = {
            orderId: String(order.id), orderReference: order.code,
            customerId: order.customerId == null ? null : String(order.customerId),
            channelIds: order.channels.map(channel => String(channel.id)),
            orderType: order.type,
            state: order.state, active: order.active,
            placedAt: order.orderPlacedAt ? new Date(order.orderPlacedAt).toISOString() : null,
            currencyCode: order.currencyCode, totalWithTax: order.totalWithTax,
            lines: order.lines.map(line => ({ id: String(line.id), quantity: line.quantity, orderPlacedQuantity: line.orderPlacedQuantity })),
            paymentCount: order.payments.length,
            refundCount: order.payments.reduce((count, payment) => count + (payment.refunds?.length ?? 0), 0),
            fulfillmentCount: order.fulfillments.length,
        };
        return { ...facts, digest: cancellationFactsDigest(facts), eligible: isEligibleZeroTotalCancellation(facts) };
    }

    async cancel(ctx: RequestContext, input: GuardedCancellationInput): Promise<{ status: 'SUCCEEDED'; operationId: string }> {
        // Vendure's GraphQL ID scalar may reach this resolver as a number even
        // when the request variable was a string. Normalize before the marker
        // write and every owner/digest comparison.
        input = { ...input, orderId: String(input.orderId), customerId: String(input.customerId) };
        if (!input.operationId || !input.tenantId || !input.environmentId || !input.customerId || !input.orderId
            || !input.orderReference || !input.workflowId || !input.previewId || !input.idempotencyKey
            || input.policyVersion !== POLICY_VERSION || !/^[a-f0-9]{64}$/.test(input.expectedFactsDigest)
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.previewExpiresAt)
            || !Number.isFinite(Date.parse(input.previewExpiresAt)) || Date.parse(input.previewExpiresAt) <= Date.now()) throw new Error('ZERO_TOTAL_CANCELLATION_INVALID_INPUT');
        return this.connection.withTransaction(ctx, async transactionCtx => {
            const repository = this.connection.getRepository(transactionCtx, Order);
            // The first write acquires SQLite's single-writer lock before the eligibility read.
            await repository.query(`INSERT OR IGNORE INTO cso_zero_total_cancellation_marker
                (operation_id, order_id, tenant_id, environment_id, customer_id, order_reference, facts_digest,
                 workflow_id, preview_id, preview_expires_at, policy_version, idempotency_key, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`, [input.operationId, input.orderId, input.tenantId, input.environmentId, input.customerId, input.orderReference, input.expectedFactsDigest,
                    input.workflowId, input.previewId, input.previewExpiresAt, input.policyVersion, input.idempotencyKey]);
            const markers = await repository.query(`SELECT operation_id AS operationId, order_id AS orderId,
                tenant_id AS tenantId, environment_id AS environmentId, customer_id AS customerId,
                order_reference AS orderReference, facts_digest AS factsDigest, workflow_id AS workflowId,
                preview_id AS previewId, preview_expires_at AS previewExpiresAt, policy_version AS policyVersion,
                idempotency_key AS idempotencyKey, status
                FROM cso_zero_total_cancellation_marker WHERE order_id = ?`, [input.orderId]) as Marker[];
            const marker = markers[0];
            // Establish channel and owner visibility before returning any
            // marker-dependent conflict detail, including on replay.
            const current = await this.getFacts(transactionCtx, input.orderId);
            if (!current || current.customerId !== input.customerId || current.orderReference !== input.orderReference) throw new Error('ZERO_TOTAL_CANCELLATION_NOT_FOUND');
            if (!marker) throw new Error('ZERO_TOTAL_CANCELLATION_CONFLICT_MARKER_MISSING');
            const mismatch = markerMismatch(marker, input);
            if (mismatch) throw new Error(`ZERO_TOTAL_CANCELLATION_CONFLICT_${mismatch.toUpperCase()}`);
            if (marker.status === 'SUCCEEDED') {
                if (current.state !== 'Cancelled' || current.active) throw new Error('ZERO_TOTAL_CANCELLATION_RECONCILIATION_REQUIRED');
                return { status: 'SUCCEEDED', operationId: input.operationId };
            }
            if (Date.parse(input.previewExpiresAt) <= Date.now()) throw new Error('ZERO_TOTAL_CANCELLATION_PREVIEW_EXPIRED');
            if (!current.eligible || current.digest !== input.expectedFactsDigest) throw new Error('ZERO_TOTAL_CANCELLATION_INELIGIBLE');
            const result = await this.orderService.cancelOrder(transactionCtx, { orderId: input.orderId, cancelShipping: true, reason: 'Customer-requested zero-total cancellation' });
            if (isGraphQlErrorResult(result)) throw new Error('ZERO_TOTAL_CANCELLATION_PROVIDER_REJECTED');
            const finalOrder = await this.connection.getRepository(transactionCtx, Order).findOne({ where: { id: input.orderId }, relations: ['channels'] });
            if (!finalOrder || finalOrder.state !== 'Cancelled' || finalOrder.active || !finalOrder.channels?.some(channel => String(channel.id) === String(transactionCtx.channelId))) throw new Error('ZERO_TOTAL_CANCELLATION_FINAL_STATE_INVALID');
            await repository.query(`UPDATE cso_zero_total_cancellation_marker SET status = 'SUCCEEDED' WHERE operation_id = ?`, [input.operationId]);
            return { status: 'SUCCEEDED', operationId: input.operationId };
        });
    }

    async getMarker(ctx: RequestContext, operationId: string, scope: Readonly<{
        orderId?: string | number | null;
        customerId?: string | number | null;
    }> = {}): Promise<Marker | null> {
        // This plugin and its migrations target local SQLite. A single joined
        // read avoids exposing a global marker before a separate visibility
        // check, and uses the caller's transaction-bound repository.
        const conditions = ['marker.operation_id = ?', 'scoped_channel.channelId = ?'];
        const parameters: unknown[] = [operationId, String(ctx.channelId)];
        if (scope.orderId != null) { conditions.push('marker.order_id = ?'); parameters.push(String(scope.orderId)); }
        if (scope.customerId != null) { conditions.push('marker.customer_id = ?'); parameters.push(String(scope.customerId)); }
        const rows = await this.connection.getRepository(ctx, Order).query(`SELECT marker.operation_id AS operationId, marker.order_id AS orderId,
            marker.tenant_id AS tenantId, marker.environment_id AS environmentId, marker.customer_id AS customerId,
            marker.order_reference AS orderReference, marker.facts_digest AS factsDigest, marker.workflow_id AS workflowId,
            marker.preview_id AS previewId, marker.preview_expires_at AS previewExpiresAt, marker.policy_version AS policyVersion,
            marker.idempotency_key AS idempotencyKey, marker.status AS status
            FROM cso_zero_total_cancellation_marker AS marker
            INNER JOIN "order" AS scoped_order ON CAST(scoped_order.id AS TEXT) = marker.order_id
                AND CAST(scoped_order.customerId AS TEXT) = marker.customer_id
                AND scoped_order.code = marker.order_reference
            INNER JOIN order_channels_channel AS scoped_channel ON scoped_channel.orderId = scoped_order.id
            WHERE ${conditions.join(' AND ')}`, parameters) as Marker[];
        return rows[0] ?? null;
    }
}

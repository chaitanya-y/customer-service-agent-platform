import { createHash } from 'node:crypto';

export const ZERO_TOTAL_CANCELLATION_POLICY_VERSION = 'NO_PAYMENT_ZERO_TOTAL_V1';

export type CancellationFacts = Readonly<{
    orderId: string;
    orderReference: string;
    customerId: string | null;
    channelIds: readonly string[];
    orderType: string;
    state: string;
    active: boolean;
    placedAt: string | null;
    currencyCode: string;
    totalWithTax: number;
    lines: readonly Readonly<{ id: string; quantity: number; orderPlacedQuantity: number }>[];
    paymentCount: number;
    refundCount: number;
    fulfillmentCount: number;
}>;

export function isEligibleZeroTotalCancellation(facts: CancellationFacts): boolean {
    return facts.orderType === 'Regular'
        && facts.state === 'PaymentSettled'
        && facts.active === false
        && facts.placedAt !== null
        && facts.customerId !== null
        && facts.channelIds.length > 0
        && facts.totalWithTax === 0
        && facts.paymentCount === 0
        && facts.refundCount === 0
        && facts.fulfillmentCount === 0
        && facts.lines.length > 0
        && facts.lines.every(line => line.quantity > 0 && line.orderPlacedQuantity > 0 && line.quantity === line.orderPlacedQuantity);
}

export function cancellationFactsDigest(facts: CancellationFacts): string {
    const canonical = [
        ZERO_TOTAL_CANCELLATION_POLICY_VERSION,
        facts.orderId, facts.orderReference, facts.customerId,
        [...facts.channelIds].sort(), facts.orderType, facts.state, facts.active, facts.placedAt,
        facts.currencyCode, facts.totalWithTax,
        [...facts.lines].sort((left, right) => left.id.localeCompare(right.id)).map(line => [line.id, line.quantity, line.orderPlacedQuantity]),
        facts.paymentCount, facts.refundCount, facts.fulfillmentCount,
    ];
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

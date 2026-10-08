import { createHash } from 'node:crypto';
import type { CancellationFacts } from '../zero-total-cancellation/facts';

export const AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION = 'AUTHORIZED_DUMMY_V1';
export type AuthorizedDummyPaymentFacts = Readonly<{
    id: string; state: string; amount: number; method: string; handlerCode: string;
    paymentMethodId: string; handlerArgsDigest: string;
}>;
export type AuthorizedDummyCancellationFacts = CancellationFacts & Readonly<{ payment: AuthorizedDummyPaymentFacts | null }>;

export function isEligibleAuthorizedDummyCancellation(facts: AuthorizedDummyCancellationFacts): boolean {
    const payment = facts.payment;
    return facts.orderType === 'Regular' && facts.state === 'PaymentAuthorized' && !facts.active
        && facts.placedAt !== null && facts.customerId !== null && facts.channelIds.length > 0
        && Number.isSafeInteger(facts.totalWithTax) && facts.totalWithTax > 0
        && facts.paymentCount === 1 && payment !== null && payment.state === 'Authorized'
        && payment.amount === facts.totalWithTax && !!payment.id && !!payment.method
        && payment.handlerCode === 'dummy-payment-handler' && !!payment.paymentMethodId
        && /^[a-f0-9]{64}$/.test(payment.handlerArgsDigest)
        && facts.refundCount === 0 && facts.fulfillmentCount === 0 && facts.lines.length > 0
        && facts.lines.every(line => Number.isSafeInteger(line.quantity) && line.quantity > 0 && line.quantity === line.orderPlacedQuantity);
}

export function authorizedDummyFactsDigest(facts: AuthorizedDummyCancellationFacts): string {
    const payment = facts.payment;
    const canonical = [AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION, facts.orderId, facts.orderReference, facts.customerId,
        [...facts.channelIds].sort(), facts.orderType, facts.state, facts.active, facts.placedAt, facts.currencyCode, facts.totalWithTax,
        [...facts.lines].sort((a, b) => a.id.localeCompare(b.id)).map(line => [line.id, line.quantity, line.orderPlacedQuantity]),
        facts.paymentCount, payment && [payment.id, payment.state, payment.amount, payment.method, payment.handlerCode, payment.paymentMethodId, payment.handlerArgsDigest],
        facts.refundCount, facts.fulfillmentCount];
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

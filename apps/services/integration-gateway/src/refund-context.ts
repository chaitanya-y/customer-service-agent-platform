import { createHash } from 'node:crypto';

import type { CommerceOrder, Money } from './commerce.js';

export type RefundSelection =
  | {
      scope: 'FULL_ORDER';
      itemIds: string[];
    }
  | {
      scope: 'SELECTED_ITEMS';
      itemIds: string[];
    };

type ObservationMetadata = {
  observationId: string;
  observedAt: string;
};

function money(amountMinor: number, currency: string): Money {
  return { amountMinor, currency };
}

function refundConsumesBalance(status: string): boolean {
  const normalizedStatus = status.toUpperCase();
  return normalizedStatus !== 'FAILED' && normalizedStatus !== 'CANCELLED';
}

function validMoney(value: Money, currency: string): boolean {
  return value.currency === currency &&
    Number.isSafeInteger(value.amountMinor) &&
    value.amountMinor >= 0;
}

export function toRefundContext(
  order: CommerceOrder,
  selection: RefundSelection,
  metadata: ObservationMetadata,
) {
  const settledPayments = order.payments.filter(
    (payment) => payment.status.toUpperCase() === 'SETTLED',
  );
  const payment = settledPayments.length === 1 ? settledPayments[0] : null;
  const priorRefunds = payment?.refunds.filter((refund) =>
    refundConsumesBalance(refund.status),
  ) ?? [];
  const consumedAmountMinor = priorRefunds.reduce(
    (total, refund) => total + refund.amount.amountMinor,
    0,
  );
  const paymentMoneyValid = payment !== null && payment !== undefined &&
    validMoney(order.total, order.total.currency) &&
    validMoney(payment.amount, order.total.currency) &&
    payment.refunds.every((refund) => validMoney(refund.amount, order.total.currency)) &&
    Number.isSafeInteger(consumedAmountMinor);
  const remainingPaymentAmountMinor = payment && paymentMoneyValid
    ? Math.max(payment.amount.amountMinor - consumedAmountMinor, 0)
    : 0;
  const selectedItems = selection.itemIds.map((itemId) =>
    order.items.find((item) => item.id === itemId),
  );
  const selectedItemTotalMinor = selectedItems.reduce(
    (total, item) => total + (item?.lineTotal.amountMinor ?? 0),
    0,
  );
  const orderItemIds = new Set(order.items.map((item) => item.id));
  const priorRefundAttributionUnknown = priorRefunds.some(
    (refund) =>
      refund.lineIds.length === 0 ||
      refund.lineIds.some((lineId) => !orderItemIds.has(lineId)),
  );
  const selectedItemWasRefunded = priorRefunds.some(
    (refund) =>
      refund.lineIds.some((lineId) => selection.itemIds.includes(lineId)),
  );
  const selectedMaximumMinor =
    selection.scope === 'FULL_ORDER'
      ? remainingPaymentAmountMinor
      : Math.min(selectedItemTotalMinor, remainingPaymentAmountMinor);
  const itemSelectionValid =
    (selection.scope === 'FULL_ORDER' && selection.itemIds.length === 0) ||
    (selection.scope === 'SELECTED_ITEMS' &&
      selection.itemIds.length > 0 &&
      new Set(selection.itemIds).size === selection.itemIds.length &&
      selectedItems.every((item) => item !== undefined &&
        validMoney(item.lineTotal, order.total.currency)) &&
      Number.isSafeInteger(selectedItemTotalMinor) &&
      selectedMaximumMinor > 0 &&
      !priorRefundAttributionUnknown &&
      !selectedItemWasRefunded);
  const facts = {
    source: {
      provider: order.source.provider,
      orderId: order.source.orderId,
    },
    selection,
    payment: payment
      ? {
          paymentId: payment.id,
          status: payment.status,
          amount: payment.amount,
          refunds: payment.refunds.map((refund) => ({
            refundId: refund.id,
            status: refund.status,
            amount: refund.amount,
            lineIds: refund.lineIds,
          })),
        }
      : null,
    facts: {
      customerVerified: true,
      transactionRefundable:
        !order.active && paymentMoneyValid && remainingPaymentAmountMinor > 0,
      itemSelectionValid,
      priorRefundCount: priorRefunds.length,
      refundableAmount: money(
        itemSelectionValid ? selectedMaximumMinor : 0,
        order.total.currency,
      ),
      refundDestination: 'ORIGINAL_PAYMENT_METHOD' as const,
    },
  };
  const factsDigest = createHash('sha256')
    .update(JSON.stringify(facts))
    .digest('hex');

  return {
    schemaVersion: '1' as const,
    observationId: metadata.observationId,
    observedAt: metadata.observedAt,
    source: {
      ...facts.source,
      factsVersion: `sha256:${factsDigest}`,
    },
    selection: facts.selection,
    facts: facts.facts,
  };
}

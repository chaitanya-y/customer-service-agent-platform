import type { GetOrderContext } from './get-order-context.js';

type OwnedOrder = NonNullable<Awaited<ReturnType<GetOrderContext>>>;
const currencies = new Set(['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'KWD']);

/** CommerceOrder.total is tax-inclusive, not a payment or refundable balance. */
export function toOrderTotal(order: OwnedOrder) {
  if (
    typeof order.reference !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(order.reference) ||
    !Number.isSafeInteger(order.total?.amountMinor) ||
    order.total.amountMinor < 0 ||
    !currencies.has(order.total.currency)
  ) {
    throw new Error('Invalid order total source');
  }
  return {
    schemaVersion: '1' as const,
    reference: order.reference,
    total: { amountMinor: order.total.amountMinor, currency: order.total.currency },
  };
}

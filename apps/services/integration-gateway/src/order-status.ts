import type { GetOrderContext } from './get-order-context.js';

type OwnedOrderContext = NonNullable<Awaited<ReturnType<GetOrderContext>>>;

export function toOrderStatus(order: OwnedOrderContext) {
  return {
    schemaVersion: '1' as const,
    reference: order.reference,
    status: order.status,
    fulfillments: order.fulfillments.map((fulfillment) => ({
      status: fulfillment.status,
      trackingCode: fulfillment.trackingCode,
    })),
  };
}

import type { GetOrderContext } from './get-order-context.js';

type OwnedOrderContext = NonNullable<Awaited<ReturnType<GetOrderContext>>>;

export function toOrderItems(order: OwnedOrderContext): {
  schemaVersion: '1';
  reference: string;
  items: Array<{ name: string; quantity: number }>;
} {
  if (
    // V1 describes current contents and cannot label historical quantities.
    // Fail closed until a versioned history projection is available.
    order.status === 'Cancelled' ||
    typeof order.reference !== 'string' ||
    order.reference.length < 1 ||
    order.reference.length > 100 ||
    !Array.isArray(order.items) ||
    order.items.length < 1 ||
    order.items.length > 20
  ) {
    throw new Error('Invalid order items source');
  }

  const items = order.items.map((item) => {
    const quantity = item?.quantity;
    if (
      typeof item?.name !== 'string' ||
      item.name.length > 300 ||
      !/\S/u.test(item.name) ||
      !Number.isInteger(quantity) ||
      quantity === undefined ||
      quantity < 1 ||
      quantity > 10000
    ) {
      throw new Error('Invalid order items source');
    }
    return { name: item.name, quantity };
  });

  return { schemaVersion: '1', reference: order.reference, items };
}

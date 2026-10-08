import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommerceOrder } from '../src/commerce.js';
import { toOrderContext } from '../src/order-context.js';
import { toOrderItems } from '../src/order-items.js';

const item: CommerceOrder['items'][number] = {
  id: 'private-line-id', sku: 'private-sku', name: 'Laptop 13 inch 8GB',
  quantity: 1, unitPrice: { amountMinor: 10000, currency: 'USD' },
  lineTotal: { amountMinor: 10000, currency: 'USD' },
};
const order: CommerceOrder = {
  source: { provider: 'vendure', orderId: 'private-order-id' },
  reference: 'ORDER-123', status: 'Delivered', active: false,
  placedAt: '2026-01-01T00:00:00Z',
  customer: { id: 'customer-42', name: 'Private Customer', email: 'private@example.com' },
  total: { amountMinor: 10000, currency: 'USD' },
  items: [item], payments: [], fulfillments: [],
};

function ownedOrder(overrides: Partial<CommerceOrder> = {}) {
  return toOrderContext({ ...order, ...overrides }, {
    observationId: 'private-observation-id', observedAt: '2026-01-01T00:00:00Z',
  });
}

test('projects only owned order reference and item names and quantities', () => {
  assert.deepEqual(toOrderItems(ownedOrder()), {
    schemaVersion: '1', reference: 'ORDER-123',
    items: [{ name: 'Laptop 13 inch 8GB', quantity: 1 }],
  });
});

test('rejects empty and oversized item arrays without partial projection', () => {
  for (const items of [[], Array.from({ length: 21 }, () => item)]) {
    assert.throws(() => toOrderItems(ownedOrder({ items })));
  }
  assert.equal(toOrderItems(ownedOrder({ items: Array.from({ length: 20 }, () => item) })).items.length, 20);
});

test('rejects blank or oversized names and invalid quantities', () => {
  for (const badItem of [
    { ...item, name: ' \t ' },
    { ...item, name: 'x'.repeat(301) },
    { ...item, quantity: 0 },
    { ...item, quantity: 10001 },
    { ...item, quantity: 1.5 },
    { ...item, quantity: Number.NaN },
  ]) {
    assert.throws(() => toOrderItems(ownedOrder({ items: [item, badItem] })));
  }
});

test('rejects invalid provider reference', () => {
  for (const reference of ['', 'x'.repeat(101)]) {
    assert.throws(() => toOrderItems(ownedOrder({ reference })));
  }
});

test('rejects cancelled history rather than relabeling it as current contents', () => {
  const cancelledItem = { ...item, quantity: 0, orderedQuantity: 2 };
  assert.throws(() => toOrderItems(ownedOrder({ status: 'Cancelled', items: [cancelledItem] })));
  assert.throws(() => toOrderItems(ownedOrder({ items: [cancelledItem] })));
  assert.throws(() => toOrderItems(ownedOrder({ status: 'Cancelled', items: [{ ...item, quantity: 0 }] })));
  for (const orderedQuantity of [0, -1, 1.5, 10001]) {
    assert.throws(() => toOrderItems(ownedOrder({ status: 'Cancelled', items: [{ ...cancelledItem, orderedQuantity }] })));
  }
  assert.equal(toOrderItems(ownedOrder({ items: [{ ...item, orderedQuantity: 2 }] })).items[0].quantity, 1);
});

test('rejects a cancelled order even if the provider retains positive quantities', () => {
  assert.throws(() => toOrderItems(ownedOrder({ status: 'Cancelled' })));
});

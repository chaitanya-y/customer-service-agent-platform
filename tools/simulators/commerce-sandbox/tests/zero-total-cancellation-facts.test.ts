import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cancellationFactsDigest, isEligibleZeroTotalCancellation, type CancellationFacts } from '../src/plugins/zero-total-cancellation/facts';

const placed: CancellationFacts = {
  orderId: '9', orderReference: 'TEST-ORDER', customerId: '7', channelIds: ['1'],
  orderType: 'Regular', state: 'PaymentSettled', active: false, placedAt: '2026-10-02T07:59:28.263Z',
  currencyCode: 'USD', totalWithTax: 0,
  lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 1 }],
  paymentCount: 0, refundCount: 0, fulfillmentCount: 0,
};

test('only a genuinely placed, unfulfilled zero-total order with original lines is eligible', () => {
  assert.equal(isEligibleZeroTotalCancellation(placed), true);
  for (const changed of [
    { ...placed, active: true }, { ...placed, placedAt: null },
    { ...placed, totalWithTax: 1 }, { ...placed, paymentCount: 1 },
    { ...placed, refundCount: 1 }, { ...placed, fulfillmentCount: 1 },
    { ...placed, state: 'Delivered' }, { ...placed, lines: [] },
    { ...placed, orderType: 'Seller' },
    { ...placed, lines: [{ id: '8', quantity: 0, orderPlacedQuantity: 1 }] },
    { ...placed, lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 0 }] },
  ]) assert.equal(isEligibleZeroTotalCancellation(changed), false);
});

test('provider digest binds owner, channel, original quantities, and all cancellation facts', () => {
  const base = cancellationFactsDigest(placed);
  assert.match(base, /^[a-f0-9]{64}$/);
  for (const changed of [
    { ...placed, customerId: 'other' }, { ...placed, channelIds: ['2'] },
    { ...placed, orderId: 'other' }, { ...placed, orderReference: 'OTHER' },
    { ...placed, state: 'Shipped' }, { ...placed, active: true },
    { ...placed, orderType: 'Aggregate' },
    { ...placed, placedAt: '2026-10-02T08:00:00.000Z' },
    { ...placed, totalWithTax: 1 }, { ...placed, paymentCount: 1 },
    { ...placed, refundCount: 1 }, { ...placed, fulfillmentCount: 1 },
    { ...placed, lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 2 }] },
  ]) assert.notEqual(cancellationFactsDigest(changed), base);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommerceOrder } from '../src/commerce.js';
import { toRefundContext } from '../src/refund-context.js';

const order: CommerceOrder = {
  source: {
    provider: 'vendure',
    orderId: '3',
  },
  reference: 'ORDER-123',
  status: 'Delivered',
  active: false,
  placedAt: '2026-07-25T23:59:40.265Z',
  customer: {
    id: 'customer-42',
    name: 'Private Customer',
    email: 'private@example.com',
  },
  total: {
    amountMinor: 15_000,
    currency: 'USD',
  },
  items: [
    {
      id: 'line-1',
      sku: 'SKU-1',
      name: 'First item',
      quantity: 1,
      unitPrice: { amountMinor: 10_000, currency: 'USD' },
      lineTotal: { amountMinor: 10_000, currency: 'USD' },
    },
    {
      id: 'line-2',
      sku: 'SKU-2',
      name: 'Second item',
      quantity: 1,
      unitPrice: { amountMinor: 5_000, currency: 'USD' },
      lineTotal: { amountMinor: 5_000, currency: 'USD' },
    },
  ],
  payments: [
    {
      id: 'payment-1',
      status: 'Settled',
      amount: { amountMinor: 15_000, currency: 'USD' },
      method: 'standard-payment',
      transactionReference: 'secret-transaction-reference',
      refunds: [
        {
          id: 'refund-1',
          status: 'Settled',
          amount: { amountMinor: 5_000, currency: 'USD' },
          lineIds: ['line-2'],
        },
      ],
    },
  ],
  fulfillments: [],
};

const observation = {
  observationId: 'observation-1',
  observedAt: '2026-07-26T12:00:00.000Z',
};

test('refund context uses remaining settled-payment balance for a full order', () => {
  const refundContext = toRefundContext(
    order,
    { scope: 'FULL_ORDER', itemIds: [] },
    observation,
  );

  assert.equal(refundContext.facts.transactionRefundable, true);
  assert.equal(refundContext.facts.itemSelectionValid, true);
  assert.equal(refundContext.facts.priorRefundCount, 1);
  assert.deepEqual(refundContext.facts.refundableAmount, {
    amountMinor: 10_000,
    currency: 'USD',
  });
  assert.equal(refundContext.facts.refundDestination, 'ORIGINAL_PAYMENT_METHOD');
  assert.match(refundContext.source.factsVersion, /^sha256:[a-f0-9]{64}$/);

  const serializedContext = JSON.stringify(refundContext);
  assert.doesNotMatch(serializedContext, /secret-transaction-reference/);
  assert.doesNotMatch(serializedContext, /Private Customer/);
});

test('refund context fails closed for a selected item already in a refund', () => {
  const refundContext = toRefundContext(
    order,
    { scope: 'SELECTED_ITEMS', itemIds: ['line-2'] },
    observation,
  );

  assert.equal(refundContext.facts.itemSelectionValid, false);
  assert.equal(refundContext.facts.priorRefundCount, 1);
  assert.deepEqual(refundContext.facts.refundableAmount, {
    amountMinor: 0,
    currency: 'USD',
  });
});

test('a failed refund does not consume the refundable balance', () => {
  const failedRefundOrder: CommerceOrder = {
    ...order,
    payments: [
      {
        ...order.payments[0],
        refunds: [
          {
            id: 'refund-failed',
            status: 'Failed',
            amount: { amountMinor: 5_000, currency: 'USD' },
            lineIds: ['line-2'],
          },
        ],
      },
    ],
  };
  const refundContext = toRefundContext(
    failedRefundOrder,
    { scope: 'FULL_ORDER', itemIds: [] },
    observation,
  );

  assert.deepEqual(refundContext.facts.refundableAmount, {
    amountMinor: 15_000,
    currency: 'USD',
  });
  assert.equal(refundContext.facts.priorRefundCount, 0);
});

test('refund context does not relabel a mismatched payment or refund currency as the order currency', () => {
  const wrongPayment = toRefundContext({
    ...order,
    payments: [{ ...order.payments[0], amount: { amountMinor: 15_000, currency: 'EUR' } }],
  }, { scope: 'FULL_ORDER', itemIds: [] }, observation);
  assert.equal(wrongPayment.facts.transactionRefundable, false);
  assert.equal(wrongPayment.facts.refundableAmount.amountMinor, 0);

  const wrongRefund = toRefundContext({
    ...order,
    payments: [{ ...order.payments[0], refunds: [{
      ...order.payments[0].refunds[0], amount: { amountMinor: 5_000, currency: 'EUR' },
    }] }],
  }, { scope: 'FULL_ORDER', itemIds: [] }, observation);
  assert.equal(wrongRefund.facts.transactionRefundable, false);
  assert.equal(wrongRefund.facts.refundableAmount.amountMinor, 0);
});

test('refund context rejects malformed provider-neutral money and full-order item IDs', () => {
  const negativeRefund = toRefundContext({
    ...order,
    payments: [{ ...order.payments[0], refunds: [{
      ...order.payments[0].refunds[0], amount: { amountMinor: -5_000, currency: 'USD' },
    }] }],
  }, { scope: 'FULL_ORDER', itemIds: [] }, observation);
  assert.equal(negativeRefund.facts.transactionRefundable, false);
  assert.equal(negativeRefund.facts.refundableAmount.amountMinor, 0);

  const wrongSelection = toRefundContext(order, { scope: 'FULL_ORDER', itemIds: ['line-1'] }, observation);
  assert.equal(wrongSelection.facts.itemSelectionValid, false);
  assert.equal(wrongSelection.facts.refundableAmount.amountMinor, 0);
});

test('selected-item context requires line totals in the order currency', () => {
  const wrongLine = toRefundContext({
    ...order,
    items: [{ ...order.items[0], lineTotal: { amountMinor: 10_000, currency: 'EUR' } }, order.items[1]],
    payments: [{ ...order.payments[0], refunds: [] }],
  }, { scope: 'SELECTED_ITEMS', itemIds: ['line-1'] }, observation);
  assert.equal(wrongLine.facts.itemSelectionValid, false);
  assert.equal(wrongLine.facts.refundableAmount.amountMinor, 0);
});

for (const { name, itemIds, lineIds, status = 'Settled', valid, amountMinor, priorRefundCount = 1 } of [
  { name: 'empty selected items', itemIds: [], lineIds: ['line-2'], valid: false, amountMinor: 0 },
  { name: 'duplicate selected items', itemIds: ['line-1', 'line-1'], lineIds: ['line-2'], valid: false, amountMinor: 0 },
  { name: 'unknown selected item', itemIds: ['missing-line'], lineIds: ['line-2'], valid: false, amountMinor: 0 },
  { name: 'unattributed prior refund', itemIds: ['line-1'], lineIds: [], valid: false, amountMinor: 0 },
  { name: 'unknown prior refund line', itemIds: ['line-1'], lineIds: ['missing-line'], valid: false, amountMinor: 0 },
  { name: 'mixed known and unknown prior refund lines', itemIds: ['line-1'], lineIds: ['line-2', 'missing-line'], valid: false, amountMinor: 0 },
  { name: 'pending unattributed prior refund', itemIds: ['line-1'], lineIds: [], status: 'Pending', valid: false, amountMinor: 0 },
  { name: 'overlapping prior refund', itemIds: ['line-2'], lineIds: ['line-2'], valid: false, amountMinor: 0 },
  { name: 'known disjoint prior refund', itemIds: ['line-1'], lineIds: ['line-2'], valid: true, amountMinor: 10_000 },
  { name: 'failed unattributed prior refund', itemIds: ['line-1'], lineIds: [], status: 'Failed', valid: true, amountMinor: 10_000, priorRefundCount: 0 },
  { name: 'cancelled unknown prior refund line', itemIds: ['line-1'], lineIds: ['missing-line'], status: 'Cancelled', valid: true, amountMinor: 10_000, priorRefundCount: 0 },
  { name: 'failed overlapping prior refund', itemIds: ['line-1'], lineIds: ['line-1'], status: 'FAILED', valid: true, amountMinor: 10_000, priorRefundCount: 0 },
]) {
  test(`selected-item context handles ${name}`, () => {
    const historyOrder: CommerceOrder = {
      ...order,
      payments: [{ ...order.payments[0], refunds: [{ ...order.payments[0].refunds[0], lineIds, status }] }],
    };
    const result = toRefundContext(historyOrder, { scope: 'SELECTED_ITEMS', itemIds }, observation);
    assert.equal(result.facts.itemSelectionValid, valid);
    assert.deepEqual(result.facts.refundableAmount, { amountMinor, currency: 'USD' });
    assert.equal(result.facts.priorRefundCount, priorRefundCount);
  });
}

test('full-order context keeps remaining-balance logic after an unattributed prior refund', () => {
  const result = toRefundContext({
    ...order,
    payments: [{ ...order.payments[0], refunds: [{ ...order.payments[0].refunds[0], lineIds: [] }] }],
  }, { scope: 'FULL_ORDER', itemIds: [] }, observation);
  assert.equal(result.facts.itemSelectionValid, true);
  assert.equal(result.facts.transactionRefundable, true);
  assert.deepEqual(result.facts.refundableAmount, { amountMinor: 10_000, currency: 'USD' });
});

for (const { name, lineTotalMinor, paymentAmountMinor, valid, refundableMinor } of [
  { name: 'zero-priced selected line', lineTotalMinor: 0, paymentAmountMinor: 15_000, valid: false, refundableMinor: 0 },
  { name: 'exhausted payment balance', lineTotalMinor: 10_000, paymentAmountMinor: 5_000, valid: false, refundableMinor: 0 },
  { name: 'positive remaining selected maximum', lineTotalMinor: 10_000, paymentAmountMinor: 5_001, valid: true, refundableMinor: 1 },
]) {
  test(`selected-item context fails closed at zero maximum: ${name}`, () => {
    const result = toRefundContext({
      ...order,
      items: [{ ...order.items[0], lineTotal: { amountMinor: lineTotalMinor, currency: 'USD' } }, order.items[1]],
      payments: [{ ...order.payments[0], amount: { amountMinor: paymentAmountMinor, currency: 'USD' } }],
    }, { scope: 'SELECTED_ITEMS', itemIds: ['line-1'] }, observation);
    assert.equal(result.facts.itemSelectionValid, valid);
    assert.deepEqual(result.facts.refundableAmount, { amountMinor: refundableMinor, currency: 'USD' });
    assert.equal(result.facts.transactionRefundable, paymentAmountMinor > 5_000);
  });
}

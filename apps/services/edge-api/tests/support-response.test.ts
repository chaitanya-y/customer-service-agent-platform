import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getReadyRefundProposal, parseSupportResponse } from '../src/support-response.js';

const readyProposal = {
  proposalId: 'proposal-1',
  journeyType: 'REFUND',
  missingFields: [],
  intent: {
    orderId: 'order-1',
    reasonCode: 'DAMAGED',
    scope: 'FULL_ORDER',
    itemIds: [],
    requestedAmount: { amountMinor: 10000, currency: 'USD' },
  },
};

test('accepts a read-only order answer without refund workflow data', () => {
  const response = parseSupportResponse({
    journey: 'order_status',
    status: 'answer_ready',
    customer_answer: { message: 'Your order is being prepared.' },
  });

  assert.equal(response.customer_answer.message, 'Your order is being prepared.');
  assert.equal(getReadyRefundProposal(response), null);
});

test('accepts an owned-order items answer without creating a refund proposal', () => {
  const response = parseSupportResponse({
    journey: 'order_items',
    status: 'answer_ready',
    customer_answer: { message: 'Order ORDER-123 contains Laptop (quantity 2).' },
  });

  assert.equal(response.customer_answer.message, 'Order ORDER-123 contains Laptop (quantity 2).');
  assert.equal(getReadyRefundProposal(response), null);
});

test('recent-order references are accepted only as read-only text', () => {
  const response = parseSupportResponse({
    journey: 'recent_orders', status: 'answer_ready',
    customer_answer: { message: 'Recent placed-order references: ORDER-123.' },
  });
  assert.equal(response.journey, 'recent_orders');
  assert.equal(getReadyRefundProposal(response), null);
  assert.throws(() => parseSupportResponse({ ...response, refund_proposal: readyProposal }));
  assert.throws(() => parseSupportResponse({ ...response, orders: [{ reference: 'private' }] }));
  assert.throws(() => parseSupportResponse({ ...response, status: 'awaiting_order_reference' }));
});

test('accepts a payment-status answer without exposing payment or refund internals', () => {
  const response = parseSupportResponse({
    journey: 'payment_status',
    status: 'answer_ready',
    customer_answer: { message: 'Payment for order ORDER-123 is recorded as settled.' },
  });

  assert.equal(response.customer_answer.message, 'Payment for order ORDER-123 is recorded as settled.');
  assert.equal(getReadyRefundProposal(response), null);
  assert.throws(() => parseSupportResponse({
    ...response,
    transactionReference: 'private-transaction',
  }));
});

test('accepts an order-total answer only as read-only customer text', () => {
  const response = parseSupportResponse({
    journey: 'order_total',
    status: 'answer_ready',
    customer_answer: { message: 'The total for order ORDER-123 is $42.00, including tax.' },
  });

  assert.equal(response.journey, 'order_total');
  assert.equal(getReadyRefundProposal(response), null);
  assert.throws(() => parseSupportResponse({ ...response, amountPaidMinor: 4_200 }));
  assert.throws(() => parseSupportResponse({ ...response, refund_proposal: readyProposal }));
});

test('rejects a forged refund proposal on every read-only journey', () => {
  for (const [journey, status] of [
    ['order_status', 'answer_ready'],
    ['recent_orders', 'answer_ready'],
    ['order_items', 'answer_ready'],
    ['payment_status', 'answer_ready'],
    ['order_total', 'answer_ready'],
    ['product_policy', 'answer_ready'],
    ['clarify', 'clarification_required'],
  ] as const) {
    assert.throws(() => parseSupportResponse({
      journey,
      status,
      customer_answer: { message: 'A safe answer.' },
      refund_proposal: readyProposal,
    }));
  }
});

test('rejects extra order-item response fields and invalid journey status pairing', () => {
  const base = {
    journey: 'order_items',
    status: 'answer_ready',
    customer_answer: { message: 'Order ORDER-123 contains Laptop (quantity 2).' },
  };
  assert.throws(() => parseSupportResponse({ ...base, payments: [] }));
  assert.throws(() => parseSupportResponse({ ...base, status: 'awaiting_product' }));
});

test('only a refund-ready variant yields a workflow proposal', () => {
  const ready = parseSupportResponse({
    journey: 'refund',
    status: 'refund_proposal_ready',
    customer_message: 'Please refund my order.',
    order_reference: 'ORDER-123',
    customer_answer: { message: 'Please review your refund request.' },
    refund_proposal: readyProposal,
  });
  assert.deepEqual(getReadyRefundProposal(ready), readyProposal);

  const awaiting = parseSupportResponse({
    journey: 'refund',
    status: 'awaiting_refund_details',
    customer_message: 'Please refund my order.',
    order_reference: 'ORDER-123',
    customer_answer: { message: 'What happened to the item?' },
    refund_proposal: { ...readyProposal, missingFields: ['REFUND_REASON'] },
  });
  assert.equal(getReadyRefundProposal(awaiting), null);
});

test('rejects a ready refund without a valid proposal and invalid journey status pairing', () => {
  assert.throws(() => parseSupportResponse({
    journey: 'refund',
    status: 'refund_proposal_ready',
    customer_message: 'Please refund my order.',
    order_reference: 'ORDER-123',
    customer_answer: { message: 'Please review your refund request.' },
  }));
  assert.throws(() => parseSupportResponse({
    journey: 'product_policy',
    status: 'awaiting_order_reference',
    customer_answer: { message: 'Which product?' },
  }));
});

test('accepts cancellation intent only with its paired reference and no refund proposal', () => {
  const ready = parseSupportResponse({ journey: 'cancellation', status: 'cancellation_request_ready',
    order_reference: 'EJ4P5T4W2BKUH56Y', customer_answer: { message: 'Review the cancellation first.' } });
  assert.equal(ready.journey, 'cancellation');
  assert.equal(getReadyRefundProposal(ready), null);
  const awaiting = parseSupportResponse({ journey: 'cancellation', status: 'awaiting_order_reference',
    order_reference: null, customer_answer: { message: 'Please share your order reference.' } });
  assert.equal(awaiting.journey, 'cancellation');
  assert.throws(() => parseSupportResponse({ journey: 'cancellation', status: 'cancellation_request_ready',
    order_reference: null, customer_answer: { message: 'Review the cancellation first.' } }));
  assert.throws(() => parseSupportResponse({ journey: 'cancellation', status: 'awaiting_order_reference',
    order_reference: 'EJ4P5T4W2BKUH56Y', customer_answer: { message: 'Please share your order reference.' } }));
  assert.throws(() => parseSupportResponse({ journey: 'cancellation', status: 'cancellation_request_ready',
    order_reference: 'EJ4P5T4W2BKUH56Y', customer_answer: { message: 'Review the cancellation first.' },
    refund_proposal: readyProposal }));
});

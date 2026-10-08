import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommerceOrder } from '../src/commerce.js';
import { toPaymentStatus } from '../src/payment-status.js';

const amount = (amountMinor: number, currency = 'USD') => ({ amountMinor, currency });
const refund = (status: string, amountMinor: number, currency = 'USD', id = 'private-refund-id') => ({
  id, status, amount: amount(amountMinor, currency), lineIds: [],
});
const payment = (status: string, amountMinor: number, refunds: CommerceOrder['payments'][number]['refunds'] = [], currency = 'USD', id = 'private-payment-id'): CommerceOrder['payments'][number] => ({
  id, status, amount: amount(amountMinor, currency),
  method: 'private-method', transactionReference: 'private-transaction', refunds,
});
const order: CommerceOrder = {
  source: { provider: 'vendure', orderId: 'private-order-id' },
  reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null,
  customer: { id: 'customer-42', name: 'Private Customer', email: 'private@example.com' },
  total: amount(10000), items: [], payments: [], fulfillments: [],
};
const project = (payments: CommerceOrder['payments'], total = amount(10000)) =>
  toPaymentStatus({ ...order, total, payments });

test('projects exact safe fields for settled payment and no refunds', () => {
  assert.deepEqual(project([payment('Settled', 10000)]), {
    schemaVersion: '1', reference: 'ORDER-123', paymentStatus: 'PAID', refundStatus: 'NONE',
  });
});

test('distinguishes absent, authorized, declined, and partially settled payments', () => {
  assert.equal(project([]).paymentStatus, 'NOT_RECORDED');
  assert.equal(project([payment('Authorized', 10000)]).paymentStatus, 'AUTHORIZED');
  assert.equal(project([payment('Declined', 10000), payment('Declined', 10000, [], 'USD', 'payment-2')]).paymentStatus, 'DECLINED');
  assert.equal(project([payment('Settled', 4000), payment('Declined', 6000, [], 'USD', 'payment-2')]).paymentStatus, 'PARTIALLY_PAID');
  assert.equal(project([payment('Settled', 4000), payment('Settled', 6000, [], 'USD', 'payment-2')]).paymentStatus, 'PAID');
});

test('distinguishes pending, partial, mixed, full, and failed refunds', () => {
  assert.equal(project([payment('Settled', 10000, [refund('Pending', 1000)])]).refundStatus, 'PENDING');
  assert.equal(project([payment('Settled', 10000, [refund('Processing', 1000)])]).refundStatus, 'PENDING');
  assert.equal(project([payment('Settled', 10000, [refund('Submitted', 1000)])]).refundStatus, 'PENDING');
  assert.equal(project([payment('Settled', 10000, [refund('Settled', 4000)])]).refundStatus, 'PARTIALLY_REFUNDED');
  assert.equal(project([payment('Settled', 10000, [refund('Completed', 4000), refund('Pending', 3000, 'USD', 'refund-2')])]).refundStatus, 'PARTIALLY_REFUNDED_WITH_PENDING');
  assert.equal(project([payment('Settled', 4000, [refund('Settled', 4000)]), payment('Settled', 6000, [refund('Completed', 6000, 'USD', 'refund-2')], 'USD', 'payment-2')]).refundStatus, 'REFUNDED');
  assert.equal(project([payment('Settled', 10000, [refund('Failed', 1000), refund('Cancelled', 1000, 'USD', 'refund-2')])]).refundStatus, 'FAILED');
});

test('fails closed on unknown payment states and inconsistent payment amounts', () => {
  for (const payments of [
    [payment('Chargeback', 10000)],
    [payment('Settled', 11000)],
    [payment('Settled', 10000, [], 'EUR')],
    [payment('Settled', -1)],
    [payment('Settled', 1.5)],
  ]) assert.equal(project(payments).paymentStatus, 'UNCERTAIN');
  assert.equal(project([payment('Settled', 10000)], amount(0)).paymentStatus, 'UNCERTAIN');
});

test('fails closed on unknown, mismatched, or excessive refunds', () => {
  for (const refunds of [
    [refund('Mystery', 1000)],
    [refund('Settled', 1000, 'EUR')],
    [refund('Settled', 10001)],
    [refund('Settled', 9000), refund('Pending', 2000, 'USD', 'refund-2')],
    [refund('Settled', -1)],
  ]) assert.equal(project([payment('Settled', 10000, refunds)]).refundStatus, 'UNCERTAIN');
  assert.equal(project([payment('Authorized', 10000, [refund('Settled', 1000)])]).refundStatus, 'UNCERTAIN');
});

test('fails closed when provider payment or refund identifiers repeat', () => {
  const duplicatedPayment = project([payment('Settled', 5000), payment('Settled', 5000)]);
  assert.equal(duplicatedPayment.paymentStatus, 'UNCERTAIN');
  assert.equal(duplicatedPayment.refundStatus, 'UNCERTAIN');

  const duplicatedRefund = project([payment('Settled', 10000, [
    refund('Completed', 5000), refund('Completed', 5000),
  ])]);
  assert.equal(duplicatedRefund.paymentStatus, 'UNCERTAIN');
  assert.equal(duplicatedRefund.refundStatus, 'UNCERTAIN');

  const crossPaymentRefund = project([
    payment('Settled', 5000, [refund('Completed', 5000)]),
    payment('Settled', 5000, [refund('Completed', 5000)], 'USD', 'payment-2'),
  ]);
  assert.equal(crossPaymentRefund.refundStatus, 'UNCERTAIN');

  for (const malformed of [payment('Settled', 10000, [], 'USD', ''),
    payment('Settled', 10000, [refund('Pending', 500, 'USD', '')])]) {
    assert.equal(project([malformed]).paymentStatus, 'UNCERTAIN');
  }
});

test('rejects invalid provider reference rather than emitting a malformed contract', () => {
  for (const reference of ['', 'x'.repeat(101)]) {
    assert.throws(() => toPaymentStatus({ ...order, reference }));
  }
});

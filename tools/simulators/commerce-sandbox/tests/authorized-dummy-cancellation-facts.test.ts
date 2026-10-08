import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizedDummyFactsDigest, isEligibleAuthorizedDummyCancellation, type AuthorizedDummyCancellationFacts } from '../src/plugins/authorized-dummy-cancellation/facts';

const eligible: AuthorizedDummyCancellationFacts = {
  orderId: '9', orderReference: 'TEST', customerId: '7', channelIds: ['1'], orderType: 'Regular',
  state: 'PaymentAuthorized', active: false, placedAt: '2026-10-02T00:00:00.000Z', currencyCode: 'USD', totalWithTax: 1500,
  lines: [{ id: '8', quantity: 2, orderPlacedQuantity: 2 }], paymentCount: 1,
  payment: { id: '6', state: 'Authorized', amount: 1500, method: 'local', handlerCode: 'dummy-payment-handler', paymentMethodId: '5', handlerArgsDigest: 'a'.repeat(64) },
  refundCount: 0, fulfillmentCount: 0,
};

test('only positive unchanged unfulfilled authorized dummy orders qualify', () => {
  assert.equal(isEligibleAuthorizedDummyCancellation(eligible), true);
  for (const patch of [
    { totalWithTax: 0 }, { totalWithTax: -1 }, { totalWithTax: 1.5 }, { totalWithTax: Number.MAX_SAFE_INTEGER + 1 },
    { state: 'PaymentSettled' }, { active: true }, { placedAt: null }, { customerId: null }, { channelIds: [] },
    { orderType: 'Aggregate' }, { paymentCount: 2 }, { payment: null }, { refundCount: 1 }, { fulfillmentCount: 1 },
    { lines: [] }, { lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 2 }] },
    { lines: [{ id: '8', quantity: 1.5, orderPlacedQuantity: 1.5 }] },
  ]) assert.equal(isEligibleAuthorizedDummyCancellation({ ...eligible, ...patch }), false);
  for (const patch of [{ state: 'Settled' }, { amount: 1499 }, { handlerCode: 'real-psp' }, { paymentMethodId: '' }, { handlerArgsDigest: '' }]) {
    assert.equal(isEligibleAuthorizedDummyCancellation({ ...eligible, payment: { ...eligible.payment!, ...patch } }), false);
  }
});

test('digest binds payment identity and actual configured handler facts while ignoring relation ordering', () => {
  const digest = authorizedDummyFactsDigest(eligible);
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const patch of [{ id: 'other' }, { state: 'Settled' }, { amount: 2000 }, { method: 'other' }, { handlerCode: 'other' }, { paymentMethodId: 'other' }, { handlerArgsDigest: 'b'.repeat(64) }]) {
    assert.notEqual(authorizedDummyFactsDigest({ ...eligible, payment: { ...eligible.payment!, ...patch } }), digest);
  }
  assert.notEqual(authorizedDummyFactsDigest({ ...eligible, customerId: 'other' }), digest);
  assert.notEqual(authorizedDummyFactsDigest({ ...eligible, channelIds: ['2'] }), digest);
  assert.notEqual(authorizedDummyFactsDigest({ ...eligible, fulfillmentCount: 1 }), digest);
  const unordered = { ...eligible, channelIds: ['2', '1'], lines: [...eligible.lines, { id: '10', quantity: 1, orderPlacedQuantity: 1 }] };
  assert.equal(authorizedDummyFactsDigest(unordered), authorizedDummyFactsDigest({ ...unordered, channelIds: ['1', '2'], lines: [...unordered.lines].reverse() }));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authorizedDummyCancellationIntentSchema } from '../src/authorized-dummy-cancellation-contract.js';

const intent = {
  orderId: '9', orderReference: 'TEST-ORDER', paymentId: 'payment-1', previewId: 'preview-1',
  previewExpiresAt: '2099-10-02T12:05:00.000Z', policyVersion: 'AUTHORIZED_DUMMY_V1',
  providerFactsDigest: 'a'.repeat(64), idempotencyKey: 'cancel:workflow-1:preview-1',
};

test('authorized dummy cancellation intent binds a specific payment and policy', () => {
  assert.deepEqual(authorizedDummyCancellationIntentSchema.parse(intent), intent);
  for (const changed of [
    { paymentId: undefined }, { paymentId: '' }, { policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1' },
    { providerFactsDigest: 'not-a-digest' }, { previewExpiresAt: 'not-a-time' },
    { unexpected: 'extra' },
  ]) assert.equal(authorizedDummyCancellationIntentSchema.safeParse({ ...intent, ...changed }).success, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryZeroTotalCancellationRepository } from '../src/zero-total-cancellation-repository.js';

const input = { tenantId: 'tenant-local', environmentId: 'local', workflowId: 'workflow-1', customerId: '7', orderId: '9', orderReference: 'TEST', previewId: 'preview-1', previewExpiresAt: '2026-10-02T12:05:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', providerFactsDigest: 'a'.repeat(64), idempotencyKey: 'cancel:workflow-1:preview-1' };

test('cancellation ledger reserves one exact intent and rejects replays with changed preview, owner, or key', async () => {
  const repository = new InMemoryZeroTotalCancellationRepository();
  const first = await repository.reserve(input);
  assert.equal(first.kind, 'reserved');
  const exact = await repository.reserve(input);
  assert.equal(exact.kind, 'existing');
  assert.equal(exact.kind === 'existing' && first.kind === 'reserved' && exact.execution.operationId, first.kind === 'reserved' ? first.operationId : '');
  for (const changed of [{ idempotencyKey: 'other-key' }, { previewId: 'other-preview' }, { customerId: 'other' }, { orderId: 'other' }, { providerFactsDigest: 'b'.repeat(64) }]) {
    assert.equal((await repository.reserve({ ...input, ...changed })).kind, 'conflict');
  }
});

test('reconciliation lookup is exact-scoped and a succeeded operation cannot regress', async () => {
  const repository = new InMemoryZeroTotalCancellationRepository();
  const reservation = await repository.reserve(input);
  assert.equal(reservation.kind, 'reserved');
  if (reservation.kind !== 'reserved') return;
  assert.equal(await repository.findExact({ ...input, customerId: 'other' }), null);
  await repository.recordStatus(reservation.operationId, 'SUCCEEDED');
  await repository.recordStatus(reservation.operationId, 'PENDING_RECONCILIATION');
  assert.equal((await repository.findExact(input))?.status, 'SUCCEEDED');
});

test('authorized dummy reservation binds its exact payment and excludes another policy for that order', async () => {
  const repository = new InMemoryZeroTotalCancellationRepository();
  const authorized = { ...input, policyVersion: 'AUTHORIZED_DUMMY_V1', paymentId: 'payment-5' };
  assert.equal((await repository.reserve(authorized)).kind, 'reserved');
  assert.equal((await repository.reserve(authorized)).kind, 'existing');
  assert.equal((await repository.reserve({ ...authorized, paymentId: 'payment-6' })).kind, 'conflict');
  assert.equal(await repository.findExact({ ...authorized, paymentId: 'payment-6' }), null);
  assert.equal((await repository.reserve(input)).kind, 'conflict');
});

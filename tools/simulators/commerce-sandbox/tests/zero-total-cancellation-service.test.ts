import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ZeroTotalCancellationService } from '../src/plugins/zero-total-cancellation/service';

function setup(providerResult: 'cancelled' | 'error' | 'unchanged' = 'cancelled') {
  const order = {
    id: '9', code: 'TEST-ORDER', type: 'Regular', state: 'PaymentSettled', active: false,
    orderPlacedAt: new Date('2026-10-02T07:59:28.263Z'), customerId: '7',
    channels: [{ id: '1' }], currencyCode: 'USD', totalWithTax: 0,
    lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 1 }], payments: [], fulfillments: [],
  };
  let marker: Record<string, string> | undefined;
  let cancellations = 0;
  let transactions = 0;
  const repository = {
    async findOne() { return order; },
    async query(sql: string, args: unknown[]) {
      if (sql.includes('INSERT OR IGNORE')) {
        if (!marker) marker = { operationId: String(args[0]), orderId: String(args[1]), tenantId: String(args[2]), environmentId: String(args[3]), customerId: String(args[4]), orderReference: String(args[5]), factsDigest: String(args[6]), workflowId: String(args[7]), previewId: String(args[8]), previewExpiresAt: String(args[9]), policyVersion: String(args[10]), idempotencyKey: String(args[11]), status: 'PENDING' };
        return [];
      }
      if (sql.includes('SELECT')) return marker ? [marker] : [];
      if (sql.includes('UPDATE')) { if (marker) marker.status = 'SUCCEEDED'; return []; }
      throw new Error('Unexpected marker SQL');
    },
  };
  const connection = {
    async withTransaction(ctx: unknown, work: (ctx: unknown) => Promise<unknown>) {
      transactions += 1;
      const before = marker && { ...marker };
      try { return await work(ctx); } catch (error) { marker = before; throw error; }
    },
    getRepository() { return repository; },
  };
  const orderService = {
    async cancelOrder() {
      cancellations += 1;
      if (providerResult === 'error') return { errorCode: 'ORDER_STATE_TRANSITION_ERROR', message: 'rejected' };
      if (providerResult === 'cancelled') { order.state = 'Cancelled'; order.lines[0]!.quantity = 0; }
      return order;
    },
  };
  const service = new ZeroTotalCancellationService(connection as never, orderService as never);
  const ctx = { channelId: '1' } as never;
  const input = { operationId: 'op-1', tenantId: 'tenant-local', environmentId: 'local', customerId: '7', orderId: '9', orderReference: 'TEST-ORDER', workflowId: 'workflow-1', previewId: 'preview-1', previewExpiresAt: '2099-01-01T00:00:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', idempotencyKey: 'idempotency-1' };
  return { service, ctx, input, order, get cancellations() { return cancellations; }, get transactions() { return transactions; } };
}

test('guarded cancellation rechecks exact digest under a transaction and an exact replay never cancels twice', async () => {
  const fixture = setup();
  const facts = await fixture.service.getFacts(fixture.ctx, '9');
  assert.ok(facts);
  const first = await fixture.service.cancel(fixture.ctx, { ...fixture.input, expectedFactsDigest: facts.digest });
  assert.deepEqual(first, { status: 'SUCCEEDED', operationId: 'op-1' });
  const replay = await fixture.service.cancel(fixture.ctx, { ...fixture.input, expectedFactsDigest: facts.digest });
  assert.deepEqual(replay, first);
  assert.equal(fixture.cancellations, 1);
  assert.equal(fixture.transactions, 2);
});

test('GraphQL numeric ID scalars are canonicalized before marker and owner comparisons', async () => {
  const fixture = setup();
  const facts = await fixture.service.getFacts(fixture.ctx, '9');
  assert.ok(facts);
  const result = await fixture.service.cancel(fixture.ctx, {
    ...fixture.input,
    orderId: 9 as unknown as string,
    customerId: 7 as unknown as string,
    expectedFactsDigest: facts.digest,
  });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(fixture.cancellations, 1);
});

test('stale digest, wrong owner, or wrong channel cannot invoke Vendure cancellation', async () => {
  for (const change of [{ expectedFactsDigest: '0'.repeat(64) }, { customerId: 'other' }, { orderReference: 'OTHER' }, { previewExpiresAt: '2020-01-01T00:00:00.000Z' }]) {
    const fixture = setup();
    const facts = await fixture.service.getFacts(fixture.ctx, '9');
    assert.ok(facts);
    await assert.rejects(fixture.service.cancel(fixture.ctx, { ...fixture.input, expectedFactsDigest: facts.digest, ...change }));
    assert.equal(fixture.cancellations, 0);
  }
  const fixture = setup();
  assert.equal(await fixture.service.getFacts({ channelId: '2' } as never, '9'), null);
});

test('marker replay binds workflow, preview, expiry, policy and idempotency', async () => {
  for (const change of [{ workflowId: 'other' }, { previewId: 'other' }, { previewExpiresAt: '2099-01-02T00:00:00.000Z' }, { policyVersion: 'OTHER' }, { idempotencyKey: 'other' }]) {
    const fixture = setup();
    const facts = await fixture.service.getFacts(fixture.ctx, '9');
    assert.ok(facts);
    await fixture.service.cancel(fixture.ctx, { ...fixture.input, expectedFactsDigest: facts.digest });
    await assert.rejects(fixture.service.cancel(fixture.ctx, { ...fixture.input, expectedFactsDigest: facts.digest, ...change }));
    assert.equal(fixture.cancellations, 1);
  }
});

test('provider error result or absent final Cancelled state rolls back the operation marker', async () => {
  for (const mode of ['error', 'unchanged'] as const) {
    const fixture = setup(mode);
    const facts = await fixture.service.getFacts(fixture.ctx, '9');
    assert.ok(facts);
    await assert.rejects(fixture.service.cancel(fixture.ctx, { ...fixture.input, expectedFactsDigest: facts.digest }));
    assert.equal(await fixture.service.getMarker(fixture.ctx, 'op-1'), null);
  }
});

test('missing loaded payment or fulfillment relations cannot be interpreted as empty', async () => {
  const fixture = setup();
  (fixture.order as unknown as { payments: unknown }).payments = undefined;
  assert.equal(await fixture.service.getFacts(fixture.ctx, '9'), null);
  fixture.order.payments = [];
  (fixture.order as unknown as { fulfillments: unknown }).fulfillments = undefined;
  assert.equal(await fixture.service.getFacts(fixture.ctx, '9'), null);
});

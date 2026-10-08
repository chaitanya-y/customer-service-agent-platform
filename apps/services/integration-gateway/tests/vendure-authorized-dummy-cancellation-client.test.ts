import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVendureAuthorizedDummyCancellationClient } from '../src/vendure-authorized-dummy-cancellation-client.js';

const binding = { channelToken: 'synthetic-channel-token', expectedChannelCode: 'tenant-local-channel' };
const input = { operationId: 'op-1', tenantId: 'tenant-local', environmentId: 'local', customerId: '7',
  orderId: '9', orderReference: 'TEST', paymentId: 'payment-1', expectedFactsDigest: 'a'.repeat(64),
  workflowId: 'workflow-1', previewId: 'preview-1', previewExpiresAt: '2099-01-01T00:00:00.000Z',
  policyVersion: 'AUTHORIZED_DUMMY_V1', idempotencyKey: 'key-1' };

test('authorized dummy client reads exact payment facts and invokes only guarded provider mutation', async () => {
  const operations: string[] = [];
  const client = createVendureAuthorizedDummyCancellationClient({
    adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
    async fetcher(_url, init) {
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('vendure-api-key'), 'test-api-key');
      assert.equal(new Headers(init?.headers).get('vendure-token'), 'synthetic-channel-token');
      const body = JSON.parse(String(init?.body));
      operations.push(body.query);
      if (body.query.includes('authorizedDummyCancellationFacts')) return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, authorizedDummyCancellationFacts: {
        orderId: '9', orderReference: 'TEST', customerId: '7', channelIds: ['1'], orderType: 'Regular', state: 'PaymentAuthorized',
        active: false, placedAt: '2026-10-02T07:59:28.263Z', currencyCode: 'USD', totalWithTax: 12500,
        lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 1 }], paymentCount: 1,
        payment: { id: 'payment-1', state: 'Authorized', amount: 12500, method: 'standard', handlerCode: 'dummy-payment-handler',
          paymentMethodId: 'method-1', handlerArgsDigest: 'b'.repeat(64) }, refundCount: 0, fulfillmentCount: 0,
        digest: 'a'.repeat(64), eligible: true,
      } } });
      if (body.query.includes('guardedCancelAuthorizedDummyOrder')) return Response.json({ data: { guardedCancelAuthorizedDummyOrder: {
        status: 'SUCCEEDED', operationId: 'op-1', paymentId: 'payment-1',
      } } });
      if (!body.query.includes('authorizedDummyCancellationMarker')) return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' } } });
      return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, authorizedDummyCancellationMarker: { ...input, factsDigest: input.expectedFactsDigest,
        status: 'SUCCEEDED' } } });
    },
  });
  const facts = await client.getFacts('9');
  assert.equal(facts?.payment?.id, 'payment-1');
  assert.equal(facts?.eligible, true);
  assert.deepEqual(await client.cancel(input), { status: 'SUCCEEDED', operationId: 'op-1', paymentId: 'payment-1' });
  assert.equal((await client.getMarker('op-1'))?.paymentId, 'payment-1');
  assert.equal(operations.length, 4);
  assert.match(operations[1], /activeChannel\s*\{\s*code\s*\}/);
  assert.match(operations[2], /guardedCancelAuthorizedDummyOrder/);
  assert.equal(operations.some(operation => /\b(cancelOrder|cancelPayment)\s*\(/.test(operation)), false);
});

test('authorized dummy client rejects GraphQL errors and malformed payment facts', async () => {
  const denied = createVendureAuthorizedDummyCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
    async fetcher() { return Response.json({ errors: [{ message: 'denied' }] }); } });
  await assert.rejects(denied.getFacts('9'));
  await assert.rejects(denied.cancel(input));
});

for (const field of ['channelToken', 'expectedChannelCode'] as const) {
  for (const value of [undefined, '', '  ']) {
    test(`authorized-dummy client rejects ${field}=${JSON.stringify(value)} before a provider request`, () => {
      let requests = 0;
      const options = { adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
        [field]: value, async fetcher() { requests++; return Response.json({}); } };
      assert.throws(() => createVendureAuthorizedDummyCancellationClient(options as Parameters<typeof createVendureAuthorizedDummyCancellationClient>[0]), /CHANNEL_BINDING_REQUIRED/);
      assert.equal(requests, 0);
    });
  }
}

for (const activeChannel of [undefined, null, {}, { code: '' }, { code: 'other-channel' }]) {
  test(`authorized-dummy client fails closed on channel proof ${JSON.stringify(activeChannel)}`, async () => {
    let mutations = 0;
    const client = createVendureAuthorizedDummyCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
      async fetcher(_url, init) {
        const { query } = JSON.parse(String(init?.body));
        if (query.includes('guardedCancelAuthorizedDummyOrder')) mutations++;
        return Response.json({ data: { activeChannel, authorizedDummyCancellationFacts: null, authorizedDummyCancellationMarker: null,
          guardedCancelAuthorizedDummyOrder: { status: 'SUCCEEDED', operationId: input.operationId, paymentId: input.paymentId } } });
      } });
    await assert.rejects(client.getFacts('9'));
    await assert.rejects(client.getMarker('op-1'));
    await assert.rejects(client.cancel(input));
    assert.equal(mutations, 0);
  });
}

test('authorized-dummy client returns scoped null reads only when the expected channel is proved', async () => {
  const client = createVendureAuthorizedDummyCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
    async fetcher(_url, init) {
      assert.match(JSON.parse(String(init?.body)).query, /activeChannel\s*\{\s*code\s*\}/);
      return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, authorizedDummyCancellationFacts: null, authorizedDummyCancellationMarker: null } });
    } });
  assert.equal(await client.getFacts('9'), null);
  assert.equal(await client.getMarker('op-1'), null);
});

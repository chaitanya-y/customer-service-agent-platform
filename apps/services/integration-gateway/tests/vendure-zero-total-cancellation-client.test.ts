import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVendureZeroTotalCancellationClient } from '../src/vendure-zero-total-cancellation-client.js';

const binding = { channelToken: 'synthetic-channel-token', expectedChannelCode: 'tenant-local-channel' };
const input = { operationId: 'op-1', tenantId: 'tenant-local', environmentId: 'local', customerId: '7', orderId: '9', orderReference: 'TEST', expectedFactsDigest: 'a'.repeat(64), workflowId: 'workflow-1', previewId: 'preview-1', previewExpiresAt: '2099-01-01T00:00:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', idempotencyKey: 'key-1' };

test('Vendure cancellation client reads facts and sends only guarded mutation with API key', async () => {
  const operations: string[] = [];
  const client = createVendureZeroTotalCancellationClient({
    adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
    async fetcher(_url, init) {
      assert.equal(new Headers(init?.headers).get('vendure-api-key'), 'test-api-key');
      assert.equal(new Headers(init?.headers).get('vendure-token'), 'synthetic-channel-token');
      const body = JSON.parse(String(init?.body));
      operations.push(body.query);
      if (body.query.includes('zeroTotalCancellationFacts')) return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, zeroTotalCancellationFacts: { orderId: '9', orderReference: 'TEST', customerId: '7', channelIds: ['1'], orderType: 'Regular', state: 'PaymentSettled', active: false, placedAt: '2026-10-02T07:59:28.263Z', currencyCode: 'USD', totalWithTax: 0, lines: [{ id: '8', quantity: 1, orderPlacedQuantity: 1 }], paymentCount: 0, refundCount: 0, fulfillmentCount: 0, digest: 'a'.repeat(64), eligible: true } } });
      if (body.query.includes('guardedCancelZeroTotalOrder')) return Response.json({ data: { guardedCancelZeroTotalOrder: { status: 'SUCCEEDED', operationId: 'op-1' } } });
      if (!body.query.includes('zeroTotalCancellationMarker')) return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' } } });
      return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, zeroTotalCancellationMarker: { operationId: 'op-1', orderId: '9', tenantId: 'tenant-local', environmentId: 'local', customerId: '7', orderReference: 'TEST', factsDigest: 'a'.repeat(64), workflowId: 'workflow-1', previewId: 'preview-1', previewExpiresAt: '2099-01-01T00:00:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', idempotencyKey: 'key-1', status: 'SUCCEEDED' } } });
    },
  });
  const facts = await client.getFacts('9');
  assert.equal(facts?.customerId, '7');
  assert.equal(facts?.digest, 'a'.repeat(64));
  const result = await client.cancel({ operationId: 'op-1', tenantId: 'tenant-local', environmentId: 'local', customerId: '7', orderId: '9', orderReference: 'TEST', expectedFactsDigest: 'a'.repeat(64), workflowId: 'workflow-1', previewId: 'preview-1', previewExpiresAt: '2099-01-01T00:00:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', idempotencyKey: 'key-1' });
  assert.deepEqual(result, { status: 'SUCCEEDED', operationId: 'op-1' });
  assert.equal((await client.getMarker('op-1'))?.status, 'SUCCEEDED');
  assert.equal(operations.length, 5);
  assert.match(operations[1], /activeChannel\s*\{\s*code\s*\}/);
  assert.match(operations[2], /guardedCancelZeroTotalOrder/);
  assert.equal(operations.some(operation => /\bcancelOrder\s*\(/.test(operation)), false);
});

test('zero-total client does not expose a global marker whose order is absent from the bound channel', async () => {
  const reads: string[] = [];
  const client = createVendureZeroTotalCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
    async fetcher(_url, init) {
      const body = JSON.parse(String(init?.body));
      reads.push(body.query);
      if (body.query.includes('zeroTotalCancellationMarker')) return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
        zeroTotalCancellationMarker: { ...input, orderId: 'foreign-order', factsDigest: input.expectedFactsDigest, status: 'SUCCEEDED' } } });
      assert.deepEqual(body.variables, { orderId: 'foreign-order' });
      return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, zeroTotalCancellationFacts: null } });
    } });
  await assert.rejects(client.getMarker('op-1'), /MARKER_SCOPE_MISMATCH/);
  assert.equal(reads.length, 2);
});

test('zero-total client rejects a marker for a different operation before reading its order', async () => {
  let requests = 0;
  const client = createVendureZeroTotalCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
    async fetcher() {
      requests++;
      return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
        zeroTotalCancellationMarker: { ...input, operationId: 'different-operation', factsDigest: input.expectedFactsDigest, status: 'SUCCEEDED' } } });
    } });
  await assert.rejects(client.getMarker('op-1'), /OPERATION_MISMATCH/);
  assert.equal(requests, 1);
});

for (const mismatch of [{ orderId: 'other-order' }, { customerId: 'other-customer' }, { orderReference: 'OTHER' }]) {
  test(`zero-total marker scope rejects mismatched order identity ${JSON.stringify(mismatch)}`, async () => {
    const client = createVendureZeroTotalCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
      async fetcher(_url, init) {
        const { query } = JSON.parse(String(init?.body));
        if (query.includes('zeroTotalCancellationMarker')) return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' },
          zeroTotalCancellationMarker: { ...input, factsDigest: input.expectedFactsDigest, status: 'SUCCEEDED' } } });
        return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, zeroTotalCancellationFacts: {
          orderId: '9', orderReference: 'TEST', customerId: '7', channelIds: ['1'], orderType: 'Regular', state: 'Cancelled', active: false,
          placedAt: '2026-10-02T07:59:28.263Z', currencyCode: 'USD', totalWithTax: 0, lines: [], paymentCount: 0,
          refundCount: 0, fulfillmentCount: 0, digest: 'b'.repeat(64), eligible: false, ...mismatch,
        } } });
      } });
    await assert.rejects(client.getMarker('op-1'), /MARKER_SCOPE_MISMATCH/);
  });
}

test('Vendure cancellation client fails closed on GraphQL errors and malformed facts', async () => {
  const client = createVendureZeroTotalCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding, async fetcher() { return Response.json({ errors: [{ message: 'denied' }] }); } });
  await assert.rejects(client.getFacts('9'));
  await assert.rejects(client.cancel({ operationId: 'op-1', tenantId: 'tenant-local', environmentId: 'local', customerId: '7', orderId: '9', orderReference: 'TEST', expectedFactsDigest: 'a'.repeat(64), workflowId: 'workflow-1', previewId: 'preview-1', previewExpiresAt: '2099-01-01T00:00:00.000Z', policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', idempotencyKey: 'key-1' }));
});

for (const field of ['channelToken', 'expectedChannelCode'] as const) {
  for (const value of [undefined, '', '  ']) {
    test(`zero-total client rejects ${field}=${JSON.stringify(value)} before a provider request`, () => {
      let requests = 0;
      const options = { adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
        [field]: value, async fetcher() { requests++; return Response.json({}); } };
      assert.throws(() => createVendureZeroTotalCancellationClient(options as Parameters<typeof createVendureZeroTotalCancellationClient>[0]), /CHANNEL_BINDING_REQUIRED/);
      assert.equal(requests, 0);
    });
  }
}

for (const activeChannel of [undefined, null, {}, { code: '' }, { code: 'other-channel' }]) {
  test(`zero-total client fails closed on channel proof ${JSON.stringify(activeChannel)}`, async () => {
    let mutations = 0;
    const client = createVendureZeroTotalCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
      async fetcher(_url, init) {
        const { query } = JSON.parse(String(init?.body));
        if (query.includes('guardedCancelZeroTotalOrder')) mutations++;
        return Response.json({ data: { activeChannel, zeroTotalCancellationFacts: null, zeroTotalCancellationMarker: null,
          guardedCancelZeroTotalOrder: { status: 'SUCCEEDED', operationId: input.operationId } } });
      } });
    await assert.rejects(client.getFacts('9'));
    await assert.rejects(client.getMarker('op-1'));
    await assert.rejects(client.cancel(input));
    assert.equal(mutations, 0);
  });
}

test('zero-total client returns scoped null reads only when the expected channel is proved', async () => {
  const client = createVendureZeroTotalCancellationClient({ adminApiUrl: 'http://vendure.test/admin-api', apiKey: 'test-api-key', ...binding,
    async fetcher(_url, init) {
      assert.match(JSON.parse(String(init?.body)).query, /activeChannel\s*\{\s*code\s*\}/);
      return Response.json({ data: { activeChannel: { code: 'tenant-local-channel' }, zeroTotalCancellationFacts: null, zeroTotalCancellationMarker: null } });
    } });
  assert.equal(await client.getFacts('9'), null);
  assert.equal(await client.getMarker('op-1'), null);
});

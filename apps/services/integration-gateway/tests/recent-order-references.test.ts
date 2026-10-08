import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createTestContextAssertion, TEST_ACCESS_CONTEXT, TEST_CONTEXT_ASSERTION, verifyTestContextAssertion } from './trusted-context-fixture.js';

const result = { schemaVersion: '1', orders: [{ reference: 'ABC-42', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: false };
function createApp(context: { after: (callback: () => Promise<void>) => void }, lookup?: (identity: typeof TEST_ACCESS_CONTEXT) => Promise<unknown>) {
  const app = buildApp({ commerceProvider: { async getOrderByReference() { throw new Error('Unrelated lookup forbidden'); } }, verifyContextAssertion: verifyTestContextAssertion,
    ...(lookup ? { getRecentOrderReferences: lookup } : {}) });
  context.after(() => app.close());
  return app;
}
test('returns only recent references for verified identity with no caching', async (context) => {
  const response = await createApp(context, async (identity) => { assert.deepEqual(identity, TEST_ACCESS_CONTEXT); return result; }).inject({ method: 'GET', url: '/v1/account/recent-order-references', headers: { 'x-cso-context-assertion': TEST_CONTEXT_ASSERTION } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), result);
  assert.equal(response.headers['cache-control'], 'no-store');
});
test('rejects unauthorized context before reading any recent orders', async (context) => {
  let reads = 0;
  const app = createApp(context, async () => { reads++; return result; });
  for (const assertion of [undefined, 'invalid', createTestContextAssertion({ tenantId: 'other' }), createTestContextAssertion({ environmentId: 'other' }), createTestContextAssertion({ audience: 'agent-runtime' }), createTestContextAssertion({ actorPrincipalId: 'other' }), createTestContextAssertion({ expiresAt: 1 })]) {
    const response = await app.inject({ method: 'GET', url: '/v1/account/recent-order-references', headers: assertion ? { 'x-cso-context-assertion': assertion } : {} });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(reads, 0);
});
test('rejects all caller parameters and framed GET bodies before lookup', async (context) => {
  let reads = 0;
  const app = createApp(context, async () => { reads++; return result; });
  for (const query of ['customerId=other', 'channel=other', 'take=100', 'sort=ASC', 'unknown=1']) {
    const response = await app.inject({ method: 'GET', url: `/v1/account/recent-order-references?${query}`, headers: { 'x-cso-context-assertion': TEST_CONTEXT_ASSERTION } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const response = await app.inject({ method: 'GET', url: '/v1/account/recent-order-references', headers: { 'x-cso-context-assertion': TEST_CONTEXT_ASSERTION, 'content-type': 'application/json' }, payload: JSON.stringify({ customerId: 'other' }) });
  assert.equal(response.statusCode, 400);
  assert.equal(reads, 0);
});
test('unavailable or malformed lookups fail closed without private diagnostics', async (context) => {
  for (const lookup of [undefined, async () => { throw new Error('private provider detail'); }, async () => ({ ...result, customerId: 'private' }), async () => ({ ...result, orders: [{ ...result.orders[0], amount: 100 }] }), async () => ({ ...result, orders: [result.orders[0], result.orders[0]] }), async () => ({ ...result, hasMore: true }), async () => ({ ...result, orders: [{ reference: ' ', placedAt: 'not a date' }] })]) {
    const response = await createApp(context, lookup).inject({ method: 'GET', url: '/v1/account/recent-order-references', headers: { 'x-cso-context-assertion': TEST_CONTEXT_ASSERTION } });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: { code: 'recent_order_references_unavailable', message: 'Recent order references are unavailable' } });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

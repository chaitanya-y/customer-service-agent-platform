import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { createRecentOrderReferencesClient } from '../src/recent-order-references-client.js';

const result = { schemaVersion: '1' as const, orders: [{ reference: 'ORDER1234', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: false };
const identity = { principalId: 'customer-2', customerId: 'customer-2', tenantId: 'tenant-local', environmentId: 'local' };
function options() {
  return {
    verifyCustomerIdentity: async () => identity,
    signContextAssertion: async () => 'signed-self',
    signAgentRuntimeContextAssertion: async () => 'signed-agent',
    signKnowledgeRagContextAssertion: async () => 'signed-knowledge',
    intakeRefund: async () => { throw new Error('refund must not run'); },
    intakeSupport: async () => { throw new Error('model must not run'); },
    recentOrderReferencesClient: { getReferences: async () => result },
  };
}
test('recent references require authentication and reject all caller parameters', async (context) => {
  let calls = 0;
  const app = buildApp({ ...options(),
    verifyCustomerIdentity: async (auth) => { if (!auth) throw new Error('missing'); return identity; },
    recentOrderReferencesClient: { getReferences: async () => { calls++; return result; } },
  });
  context.after(() => app.close());
  const denied = await app.inject({ method: 'GET', url: '/v1/account/recent-order-references' });
  assert.equal(denied.statusCode, 401);
  assert.match(denied.headers['cache-control'] as string, /no-store/);
  for (const suffix of ['?customerId=other', '?sort=ASC', '?take=100', '?channel=other']) {
    const response = await app.inject({ method: 'GET', url: '/v1/account/recent-order-references' + suffix, headers: { authorization: 'Bearer customer' } });
    assert.equal(response.statusCode, 400);
  }
  const body = await app.inject({ method: 'GET', url: '/v1/account/recent-order-references', headers: { authorization: 'Bearer customer', 'content-type': 'application/json' }, payload: { customerId: 'other' } });
  assert.equal(body.statusCode, 400);
  assert.equal(calls, 0);
});
test('recent references sign verified self scope and expose only valid public data', async (context) => {
  const app = buildApp({ ...options(), signContextAssertion: async (input) => {
    assert.deepEqual(input.identity, identity);
    assert.equal(input.channelId, 'web');
    return 'signed-self';
  }, recentOrderReferencesClient: { getReferences: async (assertion) => {
    assert.equal(assertion, 'signed-self'); return result;
  } } });
  context.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/account/recent-order-references', headers: { authorization: 'Bearer customer' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), result);
  assert.match(response.headers['cache-control'] as string, /no-store/);
});
test('recent references fail closed on unsafe upstream projections', async (context) => {
  const app = buildApp({ ...options(), recentOrderReferencesClient: { getReferences: async () => ({ ...result, email: 'private@example.test' }) } });
  context.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/account/recent-order-references', headers: { authorization: 'Bearer customer' } });
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(response.body, /private/);
});
test('recent references client uses fixed path, signed assertion, timeout and no-store', async () => {
  const client = createRecentOrderReferencesClient({ baseUrl: 'http://127.0.0.1:3002', fetcher: async (input) => {
    const request = input as Request;
    assert.equal(request.url, 'http://127.0.0.1:3002/v1/account/recent-order-references');
    assert.equal(request.headers.get('x-cso-context-assertion'), 'signed-self');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.equal(request.cache, 'no-store');
    assert.ok(request.signal);
    return Response.json(result);
  } });
  assert.deepEqual(await client.getReferences('signed-self'), result);
});
test('recent references client rejects oversized, duplicate, invalid, private and uncertain responses', async () => {
  for (const value of [
    { ...result, address: 'private' }, { ...result, schemaVersion: '2' },
    { ...result, orders: [{ ...result.orders[0], customerId: 'private' }] },
    { ...result, orders: Array(11).fill(result.orders[0]) },
    { ...result, orders: [result.orders[0], result.orders[0]] },
    { ...result, orders: [{ reference: 'bad reference', placedAt: result.orders[0]!.placedAt }] },
    { ...result, orders: [{ reference: 'ORDER1234', placedAt: '2026-02-30T00:00:00.000Z' }] },
    { ...result, hasMore: true },
    { ...result, orders: [result.orders[0], { reference: 'ORDER5678', placedAt: '2026-10-02T12:00:00.000Z' }] },
  ]) {
    const client = createRecentOrderReferencesClient({ baseUrl: 'http://127.0.0.1:3002', fetcher: async () => Response.json(value) });
    assert.equal(await client.getReferences('signed-self'), 'unavailable');
  }
  for (const fetcher of [async () => new Response(null, { status: 307 }), async () => new Response('not JSON'), async () => { throw new Error('timeout'); }]) {
    assert.equal(await createRecentOrderReferencesClient({ baseUrl: 'http://127.0.0.1:3002', fetcher }).getReferences('signed-self'), 'unavailable');
  }
});

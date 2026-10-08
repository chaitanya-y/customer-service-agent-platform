import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const result = { schemaVersion: '1', orders: [{ reference: 'ORDER1234', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: false };
test('recent orders parser rejects unsafe or malformed public data', async () => {
  const { parseRecentOrderReferences } = await import('../components/recent-order-references-api.ts');
  assert.deepEqual(parseRecentOrderReferences(result), result);
  assert.deepEqual(parseRecentOrderReferences({ ...result, orders: [] }), { ...result, orders: [] });
  for (const value of [null, [], {}, { ...result, email: 'private' }, { ...result, hasMore: 'yes' }, { ...result, schemaVersion: '2' },
    { ...result, orders: Array(11).fill(result.orders[0]) }, { ...result, orders: [result.orders[0], result.orders[0]] },
    { ...result, orders: [{ ...result.orders[0], customerId: 'private' }] },
    { ...result, orders: [{ reference: 'bad reference', placedAt: result.orders[0].placedAt }] },
    { ...result, orders: [{ reference: 'ORDER1234', placedAt: '2026-02-30T00:00:00.000Z' }] },
    { ...result, hasMore: true },
    { ...result, orders: [result.orders[0], { reference: 'ORDER5678', placedAt: '2026-10-02T12:00:00.000Z' }] },
  ]) assert.throws(() => parseRecentOrderReferences(value), /not valid/i);
});
test('recent orders load is a no-store read with no conversation or caller identity', async () => {
  const { loadRecentOrderReferences } = await import('../components/recent-order-references-api.ts');
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/account/recent-order-references');
    assert.deepEqual(init, { method: 'GET', cache: 'no-store' });
    return Response.json(result);
  };
  assert.deepEqual(await loadRecentOrderReferences(), result);
});
test('recent orders load distinguishes auth and generic unavailable errors without leaking details', async () => {
  const { loadRecentOrderReferences } = await import('../components/recent-order-references-api.ts');
  for (const [status, value] of [[401, { secret: 'private' }], [503, { secret: 'private' }], [202, result], [200, { ...result, customerId: 'private' }]]) {
    globalThis.fetch = async () => Response.json(value, { status });
    await assert.rejects(loadRecentOrderReferences(), error => {
      assert.doesNotMatch(error.message, /private/);
      assert.match(error.message, status === 401 ? /sign in/i : /try again/i);
      return true;
    });
  }
  globalThis.fetch = async () => { throw new Error('network details'); };
  await assert.rejects(loadRecentOrderReferences(), /try again/i);
});

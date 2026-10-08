import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVendureRecentOrderReferencesLookup } from '../src/vendure-recent-order-references-client.js';
import { TEST_ACCESS_CONTEXT } from './trusted-context-fixture.js';

const options = { adminApiUrl: 'https://commerce.invalid/admin-api', apiKey: 'test-only-api-key', channelToken: 'test-only-channel', expectedChannelCode: 'acme', expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local' };
const order = { code: 'ABC-42', orderPlacedAt: '2026-10-01T12:00:00.000Z', active: false, customer: { id: 'customer-42' } };
function payload(items: unknown = [order]) { return { data: { activeChannel: { code: 'acme' }, customer: { id: 'customer-42', orders: { items } } } }; }
test('queries only the verified customer with placed-order filters, descending dates and eleven-row bound', async () => {
  let requests = 0;
  const lookup = createVendureRecentOrderReferencesLookup({ ...options, fetcher: async (url, init) => {
    requests++;
    assert.equal(url, options.adminApiUrl);
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('vendure-token'), options.channelToken); assert.equal(headers.get('vendure-api-key'), options.apiKey);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.variables, { customerId: 'customer-42', options: { take: 11, sort: { orderPlacedAt: 'DESC' }, filter: { active: { eq: false }, orderPlacedAt: { isNull: false } } } });
    assert.match(body.query, /customer\(id:\s*\$customerId\)/); assert.match(body.query, /orders\(options:\s*\$options\)/);
    assert.match(body.query, /customer\s*\{\s*id\s*\}/);
    assert.doesNotMatch(body.query, /mutation|email|address|payment|total|lines/i);
    return Response.json(payload());
  } });
  assert.deepEqual(await lookup(TEST_ACCESS_CONTEXT), { schemaVersion: '1', orders: [{ reference: 'ABC-42', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: false });
  assert.equal(requests, 1);
});
test('distinguishes empty and ten-row complete lists from eleven-row truncated lists', async () => {
  for (const length of [0, 10, 11]) {
    const items = Array.from({ length }, (_, index) => ({ ...order, code: `ABC-${index}`, orderPlacedAt: `2026-10-01T${String(22 - index).padStart(2, '0')}:00:00.000Z` }));
    const result = await createVendureRecentOrderReferencesLookup({ ...options, fetcher: async () => Response.json(payload(items)) })(TEST_ACCESS_CONTEXT);
    assert.deepEqual(result, { schemaVersion: '1', orders: items.slice(0, 10).map((item) => ({ reference: item.code, placedAt: item.orderPlacedAt })), hasMore: length === 11 });
  }
});
test('rejects invalid scope/channel configuration before any provider read', async () => {
  let reads = 0;
  const fetcher = async () => { reads++; return Response.json(payload()); };
  for (const context of [{ ...TEST_ACCESS_CONTEXT, tenantId: 'other' }, { ...TEST_ACCESS_CONTEXT, environmentId: 'other' }]) await assert.rejects(createVendureRecentOrderReferencesLookup({ ...options, fetcher })(context), { message: 'Recent order references are unavailable' });
  for (const binding of [{ channelToken: '' }, { expectedChannelCode: ' ' }, { expectedTenantId: '' }, { expectedEnvironmentId: '' }]) await assert.rejects(createVendureRecentOrderReferencesLookup({ ...options, ...binding, fetcher })(TEST_ACCESS_CONTEXT), { message: 'Recent order references are unavailable' });
  assert.equal(reads, 0);
});
test('fails closed on owners, channel, unplaced/cart records, duplicate references, chronology and private extras', async () => {
  const eleven = Array.from({ length: 11 }, (_, index) => ({ ...order, code: `ABC-${index}` }));
  for (const raw of [
    { data: { ...payload().data, activeChannel: { code: 'other' } } },
    { data: { ...payload().data, customer: { id: 'other', orders: { items: [] } } } },
    { data: { ...payload().data, customer: null } }, { ...payload(), errors: [{ message: 'private diagnostics' }] }, {}, { data: null },
    payload([{ ...order, customer: { id: 'other' } }]), payload([{ ...order, customer: null }]),
    payload([...eleven.slice(0, 10), { ...eleven[10], customer: { id: 'other' } }]),
    payload([{ ...order, active: true }]), payload([{ ...order, orderPlacedAt: null }]), payload([{ ...order, orderPlacedAt: '2026-02-30T00:00:00Z' }]),
    payload([{ ...order, code: ' ' }]), payload([{ ...order, code: 'x'.repeat(101) }]), payload([order, order]),
    payload([order, { ...order, code: 'ABC-43', orderPlacedAt: '2026-10-02T00:00:00Z' }]),
    payload([{ ...order, total: 100 }]), payload([...eleven, { ...order, code: 'ABC-12' }]), payload(null),
  ]) await assert.rejects(createVendureRecentOrderReferencesLookup({ ...options, fetcher: async () => Response.json(raw) })(TEST_ACCESS_CONTEXT), { message: 'Recent order references are unavailable' });
});
test('conceals provider/network errors and rejects redirects, timeout and invalid JSON', async () => {
  for (const fetcher of [async () => { throw new Error('private network details'); }, async () => { throw new DOMException('private timeout', 'TimeoutError'); }, async () => new Response('private details', { status: 500 }), async () => new Response('redirect', { status: 302 }), async () => new Response('not JSON')]) await assert.rejects(createVendureRecentOrderReferencesLookup({ ...options, fetcher })(TEST_ACCESS_CONTEXT), { message: 'Recent order references are unavailable' });
});

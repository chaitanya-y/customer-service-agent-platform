import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVendureSavedAddressStatusLookup } from '../src/vendure-saved-address-client.js';
import { TEST_ACCESS_CONTEXT } from './trusted-context-fixture.js';

const options = {
  adminApiUrl: 'https://commerce.invalid/admin-api', apiKey: 'test-only-api-key',
  channelToken: 'test-only-channel', expectedChannelCode: 'acme',
  expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local',
};
const address = { defaultShippingAddress: true, defaultBillingAddress: false };
function payload(addresses: unknown = [address, { defaultShippingAddress: false, defaultBillingAddress: false }]) {
  return { data: { activeChannel: { code: 'acme' }, customer: { id: 'customer-42', addresses } } };
}

test('reads a single channel-bound customer query requesting no personal address fields', async () => {
  let requests = 0;
  const lookup = createVendureSavedAddressStatusLookup({ ...options, fetcher: async (url, init) => {
    requests += 1;
    assert.equal(url, options.adminApiUrl);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('vendure-token'), 'test-only-channel');
    assert.equal(headers.get('vendure-api-key'), 'test-only-api-key');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.variables, { customerId: 'customer-42' });
    assert.match(body.query, /activeChannel\s*\{\s*code\s*\}/);
    assert.match(body.query, /customer\(id:\s*\$customerId\)/);
    assert.doesNotMatch(body.query, /mutation|email|firstName|lastName|street|postal|phone|fullName|company|city|province|country|orders/i);
    return Response.json(payload());
  } });
  assert.deepEqual(await lookup(TEST_ACCESS_CONTEXT), { schemaVersion: '1', savedAddressCount: 2, hasDefaultShippingAddress: true, hasDefaultBillingAddress: false });
  assert.equal(requests, 1);
});

test('supports no saved address, no defaults, and one address serving both defaults', async () => {
  for (const [addresses, expected] of [
    [[], { schemaVersion: '1', savedAddressCount: 0, hasDefaultShippingAddress: false, hasDefaultBillingAddress: false }],
    [[{ defaultShippingAddress: false, defaultBillingAddress: false }], { schemaVersion: '1', savedAddressCount: 1, hasDefaultShippingAddress: false, hasDefaultBillingAddress: false }],
    [[{ defaultShippingAddress: true, defaultBillingAddress: true }], { schemaVersion: '1', savedAddressCount: 1, hasDefaultShippingAddress: true, hasDefaultBillingAddress: true }],
  ]) {
    const lookup = createVendureSavedAddressStatusLookup({ ...options, fetcher: async () => Response.json(payload(addresses)) });
    assert.deepEqual(await lookup(TEST_ACCESS_CONTEXT), expected);
  }
});

test('rejects tenant and environment mismatch or missing channel binding without a provider call', async () => {
  let reads = 0;
  const fetcher = async () => { reads += 1; return Response.json(payload()); };
  for (const context of [{ ...TEST_ACCESS_CONTEXT, tenantId: 'other' }, { ...TEST_ACCESS_CONTEXT, environmentId: 'other' }]) {
    await assert.rejects(createVendureSavedAddressStatusLookup({ ...options, fetcher })(context), /Saved address status is unavailable/);
  }
  for (const binding of [{ channelToken: '' }, { expectedChannelCode: '' }, { channelToken: ' ' }, { expectedTenantId: '' }, { expectedEnvironmentId: '' }]) {
    await assert.rejects(async () => createVendureSavedAddressStatusLookup({ ...options, ...binding, fetcher })(TEST_ACCESS_CONTEXT), /Saved address status is unavailable/);
  }
  assert.equal(reads, 0);
});

test('fails closed on provider identity/channel mismatch, partial errors, malformed and excessive data', async () => {
  for (const raw of [
    { data: { ...payload().data, activeChannel: { code: 'other' } } },
    { data: { ...payload().data, customer: { id: 'other', addresses: [] } } },
    { data: { ...payload().data, customer: null } },
    { ...payload(), errors: [{ message: 'private provider error' }] },
    { data: null }, {}, payload(null), payload([{ defaultShippingAddress: null, defaultBillingAddress: false }]),
    payload([{ defaultShippingAddress: 'true', defaultBillingAddress: false }]),
    payload([{ defaultShippingAddress: false }]), payload([address, address]),
    payload([{ defaultShippingAddress: false, defaultBillingAddress: true }, { defaultShippingAddress: false, defaultBillingAddress: true }]),
    payload(Array.from({ length: 1001 }, () => ({ defaultShippingAddress: false, defaultBillingAddress: false }))),
    payload([{ ...address, streetLine1: 'private provider data' }]),
  ]) {
    await assert.rejects(createVendureSavedAddressStatusLookup({ ...options, fetcher: async () => Response.json(raw) })(TEST_ACCESS_CONTEXT), { message: 'Saved address status is unavailable' });
  }
});

test('does not expose network/provider error contents, malformed JSON, or follow redirects', async () => {
  for (const fetcher of [
    async () => { throw new Error('private network detail'); },
    async () => new Response('private error', { status: 500 }),
    async () => new Response('private error', { status: 302 }),
    async () => new Response('not JSON'),
  ]) await assert.rejects(createVendureSavedAddressStatusLookup({ ...options, fetcher })(TEST_ACCESS_CONTEXT), { message: 'Saved address status is unavailable' });
});

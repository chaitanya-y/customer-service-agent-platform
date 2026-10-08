import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import {
  createTestContextAssertion,
  TEST_ACCESS_CONTEXT,
  TEST_CONTEXT_ASSERTION,
  verifyTestContextAssertion,
} from './trusted-context-fixture.js';

const result = { schemaVersion: '1', savedAddressCount: 2, hasDefaultShippingAddress: true, hasDefaultBillingAddress: false };

function createApp(context: { after: (callback: () => Promise<void>) => void }, lookup?: (identity: typeof TEST_ACCESS_CONTEXT) => Promise<unknown>) {
  const app = buildApp({
    commerceProvider: { async getOrderByReference() { throw new Error('No order lookup allowed'); } },
    verifyContextAssertion: verifyTestContextAssertion,
    ...(lookup ? { getSavedAddressStatus: lookup } : {}),
  });
  context.after(() => app.close());
  return app;
}

test('returns only address status for the verified self identity without reading orders', async (context) => {
  const app = createApp(context, async (identity) => {
    assert.deepEqual(identity, TEST_ACCESS_CONTEXT);
    return result;
  });
  const response = await app.inject({ method: 'GET', url: '/v1/account/saved-address-status', headers: { 'x-cso-context-assertion': TEST_CONTEXT_ASSERTION } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), result);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('rejects missing, expired, other-audience, tenant, environment and non-self identity before lookup', async (context) => {
  let reads = 0;
  const app = createApp(context, async () => { reads += 1; return result; });
  for (const assertion of [undefined, 'invalid', createTestContextAssertion({ tenantId: 'another' }), createTestContextAssertion({ environmentId: 'another' }), createTestContextAssertion({ audience: 'agent-runtime' }), createTestContextAssertion({ actorPrincipalId: 'other' }), createTestContextAssertion({ expiresAt: 1 })]) {
    const response = await app.inject({ method: 'GET', url: '/v1/account/saved-address-status', headers: assertion ? { 'x-cso-context-assertion': assertion } : {} });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'context_unauthorized');
  }
  assert.equal(reads, 0);
});

test('rejects caller-supplied identity or any query rather than silently ignoring it', async (context) => {
  let reads = 0;
  const app = createApp(context, async () => { reads += 1; return result; });
  for (const query of ['customerId=customer-other', 'tenantId=other', 'addressId=1', 'unused=1']) {
    const response = await app.inject({ method: 'GET', url: `/v1/account/saved-address-status?${query}`, headers: { 'x-cso-context-assertion': TEST_CONTEXT_ASSERTION } });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(reads, 0);
});

test('unconfigured, failed and malformed lookups return a generic error without provider details', async (context) => {
  for (const lookup of [undefined, async () => { throw new Error('private address and credential'); }, async () => ({ ...result, streetLine1: 'private address' }), async () => ({ ...result, savedAddressCount: 0 }), async () => ({ ...result, savedAddressCount: -1 })]) {
    const response = await createApp(context, lookup).inject({ method: 'GET', url: '/v1/account/saved-address-status', headers: { 'x-cso-context-assertion': TEST_CONTEXT_ASSERTION } });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: { code: 'saved_address_status_unavailable', message: 'Saved address status is unavailable' } });
    assert.equal(response.body.includes('private'), false);
  }
});

test('rejects a GET request carrying a body before any lookup', async (context) => {
  let reads = 0;
  const app = createApp(context, async () => { reads += 1; return result; });
  const response = await app.inject({ method: 'GET', url: '/v1/account/saved-address-status', headers: { 'x-cso-context-assertion': TEST_CONTEXT_ASSERTION, 'content-type': 'application/json' }, payload: JSON.stringify({ customerId: 'other' }) });
  assert.equal(response.statusCode, 400);
  assert.equal(reads, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { createSavedAddressStatusClient } from '../src/saved-address-status-client.js';

const identity = {
  principalId: 'customer-2', customerId: 'customer-2',
  tenantId: 'tenant-local', environmentId: 'local',
};
const status = {
  schemaVersion: '1', savedAddressCount: 2,
  hasDefaultShippingAddress: true, hasDefaultBillingAddress: false,
};

function baseOptions() {
  return {
    verifyCustomerIdentity: async () => identity,
    signContextAssertion: async () => 'signed-gateway-context',
    signAgentRuntimeContextAssertion: async () => 'signed-agent-context',
    signKnowledgeRagContextAssertion: async () => 'signed-knowledge-context',
    intakeRefund: async () => { throw new Error('refund must not run'); },
    intakeSupport: async () => { throw new Error('model must not run'); },
    savedAddressStatusClient: { getStatus: async () => status },
  };
}

test('saved-address action requires customer authentication and never reaches provider', async (context) => {
  let calls = 0;
  const app = buildApp({
    ...baseOptions(),
    verifyCustomerIdentity: async () => { throw new Error('expired customer token'); },
    savedAddressStatusClient: { getStatus: async () => { calls += 1; return status; } },
  });
  context.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/account/saved-address-status' });
  assert.equal(response.statusCode, 401);
  assert.equal(calls, 0);
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('saved-address action sends only signed self context and returns the strict safe projection', async (context) => {
  const assertions: string[] = [];
  const app = buildApp({
    ...baseOptions(),
    savedAddressStatusClient: { getStatus: async (assertion: string) => {
      assertions.push(assertion); return status;
    } },
  });
  context.after(() => app.close());
  const response = await app.inject({
    method: 'GET', url: '/v1/account/saved-address-status',
    headers: { authorization: 'Bearer local-customer-token' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json(), status);
  assert.deepEqual(assertions, ['signed-gateway-context']);
});

test('saved-address action refuses caller-supplied customer identity and malformed upstream data', async (context) => {
  let calls = 0;
  const app = buildApp({
    ...baseOptions(),
    savedAddressStatusClient: { getStatus: async () => {
      calls += 1;
      return { ...status, streetLine: 'private address' } as unknown as typeof status;
    } },
  });
  context.after(() => app.close());
  const headers = { authorization: 'Bearer local-customer-token' };
  const rejected = await app.inject({ method: 'GET', url: '/v1/account/saved-address-status?customerId=other', headers });
  assert.equal(rejected.statusCode, 400);
  const bodyRejected = await app.inject({
    method: 'GET', url: '/v1/account/saved-address-status',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: { customerId: 'other' },
  });
  assert.equal(bodyRejected.statusCode, 400);
  assert.equal(calls, 0);
  const malformed = await app.inject({ method: 'GET', url: '/v1/account/saved-address-status', headers });
  assert.equal(malformed.statusCode, 503);
  assert.equal(malformed.body.includes('private address'), false);
});

test('saved-address Gateway client rejects redirects, malformed JSON and PII fields', async () => {
  const requests: Request[] = [];
  const client = createSavedAddressStatusClient({
    baseUrl: 'http://127.0.0.1:3002',
    fetcher: async (request) => {
      requests.push(request as Request);
      return Response.json(status);
    },
  });
  assert.deepEqual(await client.getStatus('signed-self'), status);
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.redirect, 'error');
  assert.equal(requests[0]?.headers.get('x-cso-context-assertion'), 'signed-self');
  assert.equal(requests[0]?.url, 'http://127.0.0.1:3002/v1/account/saved-address-status');

  const unsafe = createSavedAddressStatusClient({
    baseUrl: 'http://127.0.0.1:3002',
    fetcher: async () => Response.json({ ...status, email: 'private@example.test' }),
  });
  assert.equal(await unsafe.getStatus('signed-self'), 'unavailable');
  const redirected = createSavedAddressStatusClient({
    baseUrl: 'http://127.0.0.1:3002',
    fetcher: async () => new Response(null, { status: 307, headers: { location: 'https://other.example' } }),
  });
  assert.equal(await redirected.getStatus('signed-self'), 'unavailable');
});

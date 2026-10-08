import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';

import { createHumanAssertionVerifier } from '../src/human-access.js';

const secret = 'refund-staff-test-secret-with-at-least-thirty-two-bytes';
const now = new Date('2030-10-02T12:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);
const baseClaims = {
  staffId: 'refund-staff-1', tenantId: 'tenant-local', environmentId: 'local',
  role: 'REFUND_SUPERVISOR', iss: 'customer-service-os-human-operations',
  aud: 'human-operations', iat: nowSeconds, exp: nowSeconds + 60,
};

async function sign(changes: Record<string, unknown> = {}, options: {
  algorithm?: string; typ?: string; signingSecret?: string;
} = {}) {
  return new SignJWT({ ...baseClaims, ...changes })
    .setProtectedHeader({ alg: options.algorithm ?? 'HS256', typ: options.typ ?? 'cso-human+jwt' })
    .sign(new TextEncoder().encode(options.signingSecret ?? secret));
}

const verify = createHumanAssertionVerifier({
  secret, issuer: 'customer-service-os-human-operations', audience: 'human-operations',
  tenantId: 'tenant-local', environmentId: 'local', now: () => now,
});

test('refund staff verifier accepts the full thirty-day issued lifetime', async () => {
  const access = await verify(await sign({ exp: nowSeconds + 2_592_000 }));
  assert.deepEqual(access, { ...baseClaims, exp: nowSeconds + 2_592_000 });
});

test('refund staff verifier accepts a shorter valid approver token', async () => {
  const access = await verify(await sign({ role: 'REFUND_APPROVER', iat: nowSeconds - 100, exp: nowSeconds + 1 }));
  assert.equal(access.role, 'REFUND_APPROVER');
  assert.equal(access.staffId, 'refund-staff-1');
});

test('refund staff verifier accepts the sibling thirty-second issued-at clock skew boundary', async () => {
  const access = await verify(await sign({ iat: nowSeconds + 30, exp: nowSeconds + 90 }));
  assert.equal(access.iat, nowSeconds + 30);
});

test('refund staff verifier uses the injected clock for exact expiry', async () => {
  let current = new Date(now.getTime() + 59_000);
  const verifyAtCurrentTime = createHumanAssertionVerifier({
    secret, issuer: 'customer-service-os-human-operations', audience: 'human-operations',
    tenantId: 'tenant-local', environmentId: 'local', now: () => current,
  });
  const assertion = await sign();
  assert.equal((await verifyAtCurrentTime(assertion)).staffId, 'refund-staff-1');
  current = new Date(now.getTime() + 60_000);
  await assert.rejects(verifyAtCurrentTime(assertion), /^Error: HUMAN_UNAUTHORIZED$/);
});

for (const [name, changes] of [
  ['missing issued-at', { iat: undefined }],
  ['missing expiry', { exp: undefined }],
  ['missing both lifetime claims', { iat: undefined, exp: undefined }],
  ['expired token', { iat: nowSeconds - 100, exp: nowSeconds - 1 }],
  ['expiry at the current second', { iat: nowSeconds - 100, exp: nowSeconds }],
  ['expiry equal to issued-at', { iat: nowSeconds + 10, exp: nowSeconds + 10 }],
  ['expiry before issued-at', { iat: nowSeconds + 20, exp: nowSeconds + 10 }],
  ['issued-at beyond thirty-second clock skew', { iat: nowSeconds + 31, exp: nowSeconds + 90 }],
  ['issued lifetime one second over thirty days', { exp: nowSeconds + 2_592_001 }],
  ['overlong issued lifetime despite at most thirty days remaining', { iat: nowSeconds - 1, exp: nowSeconds + 2_592_000 }],
  ['negative issued-at', { iat: -1 }],
  ['zero expiry', { exp: 0 }],
  ['fractional issued-at', { iat: nowSeconds + 0.5 }],
  ['fractional expiry', { exp: nowSeconds + 60.5 }],
  ['string issued-at', { iat: String(nowSeconds) }],
  ['string expiry', { exp: String(nowSeconds + 60) }],
  ['null issued-at', { iat: null }],
  ['null expiry', { exp: null }],
] as const) {
  test(`refund staff verifier rejects ${name}`, async () => {
    await assert.rejects(verify(await sign(changes)), /^Error: HUMAN_UNAUTHORIZED$/);
  });
}

for (const [name, changes] of [
  ['wrong issuer', { iss: 'other-issuer' }],
  ['wrong audience', { aud: 'human-operations-support-staff' }],
  ['foreign tenant', { tenantId: 'other-tenant' }],
  ['foreign environment', { environmentId: 'other-environment' }],
  ['support role', { role: 'SUPPORT_AGENT' }],
  ['delivery role', { role: 'DELIVERY_AGENT' }],
  ['empty staff identity', { staffId: '' }],
  ['unexpected claim', { extra: 'untrusted' }],
] as const) {
  test(`refund staff verifier still rejects ${name} with a valid lifetime`, async () => {
    await assert.rejects(verify(await sign(changes)), /^Error: HUMAN_UNAUTHORIZED$/);
  });
}

test('refund staff verifier still rejects the wrong JWT type', async () => {
  await assert.rejects(verify(await sign({}, { typ: 'cso-delivery-staff+jwt' })), /^Error: HUMAN_UNAUTHORIZED$/);
});

test('refund staff verifier still rejects a non-HS256 algorithm', async () => {
  await assert.rejects(verify(await sign({}, { algorithm: 'HS384' })), /^Error: HUMAN_UNAUTHORIZED$/);
});

test('refund staff verifier still rejects a token signed with another secret', async () => {
  await assert.rejects(verify(await sign({}, { signingSecret: 'another-test-secret-with-at-least-thirty-two-bytes' })), /^Error: HUMAN_UNAUTHORIZED$/);
});

test('refund staff verifier still rejects absent or malformed tokens', async () => {
  for (const assertion of [undefined, '', 'not-a-jwt']) {
    await assert.rejects(verify(assertion), /^Error: HUMAN_UNAUTHORIZED$/);
  }
});

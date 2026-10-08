import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { canonicalHandoffBodyHash, createHmacStaffAssertionVerifier } from '../src/staff-assertion.js';

const secret = 'test-staff-assertion-key-with-at-least-32-bytes';
const now = new Date('2026-10-02T12:00:00Z');
const issuedAt = Math.floor(now.getTime() / 1000);
const conversationId = '019c321e-8650-7000-8000-000000000001';
const sessionId = '019c321e-8650-7000-8000-000000000002';
const common = { tenantId: 'tenant-local', environmentId: 'local', staffId: 'staff-1', role: 'SUPPORT_AGENT', purpose: 'handoff_claim', requestId: 'request-1', traceId: 'trace-1', routingEpoch: 1, httpMethod: 'POST', path: `/v1/internal/handoffs/${conversationId}/claim`, conversationId, handoffSessionId: sessionId, expectedControlVersion: 2, idempotencyKey: 'claim-1', requestBodySha256: 'a'.repeat(64) };
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ ...common, ...overrides }).setProtectedHeader({ alg: 'HS256', typ: 'cso-conversation-staff+jwt' }).setIssuer('customer-service-os-human-operations').setAudience('conversation-runtime-handoff').setIssuedAt(issuedAt).setExpirationTime(typeof overrides.exp === 'number' ? overrides.exp : issuedAt + 60).sign(new TextEncoder().encode(secret));
}
const verify = createHmacStaffAssertionVerifier({ secret, expectedTenantId: 'tenant-local', expectedEnvironmentId: 'local', now: () => now });

test('accepts only independently signed, operation-bound SUPPORT_AGENT assertions', async () => {
  const context = await verify(await token());
  assert.equal(context.staffId, 'staff-1');
  assert.equal(context.requestBodySha256, 'a'.repeat(64));
  for (const overrides of [{ role: 'REFUND_AGENT' }, { tenantId: 'other' }, { environmentId: 'other' }, { purpose: 'refund_execute' }, { exp: issuedAt }, { exp: issuedAt + 301 }, { expectedControlVersion: 0 }, { idempotencyKey: undefined }, { requestBodySha256: 'invalid' }, { path: '/other' }]) {
    await assert.rejects(verify(await token(overrides)));
  }
});

test('read assertions cannot carry mutation bindings or impersonate another route', async () => {
  const read = { ...common, purpose: 'handoff_read', httpMethod: 'GET', path: `/v1/internal/handoffs/${conversationId}`, handoffSessionId: undefined, expectedControlVersion: undefined, idempotencyKey: undefined, requestBodySha256: undefined };
  assert.equal((await verify(await token(read))).purpose, 'handoff_read');
  await assert.rejects(verify(await token({ ...read, idempotencyKey: 'bad' })));
  await assert.rejects(verify(await token({ ...read, path: '/v1/internal/handoffs' })));
});

test('canonical body binding sorts nested keys while preserving exact reply text', () => {
  assert.equal(canonicalHandoffBodyHash({ b: { z: 'text', a: 1 }, a: true }), canonicalHandoffBodyHash({ a: true, b: { a: 1, z: 'text' } }));
  assert.notEqual(canonicalHandoffBodyHash({ text: 'reply' }), canonicalHandoffBodyHash({ text: ' reply' }));
});

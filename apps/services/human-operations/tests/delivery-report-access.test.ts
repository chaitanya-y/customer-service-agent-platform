import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';

import { createDeliveryReportAssertionVerifier } from '../src/delivery-report-access.js';
import { createDeliveryStaffAssertionVerifier } from '../src/delivery-staff-access.js';
import { createHumanAssertionVerifier } from '../src/human-access.js';

const secret = 'a-long-delivery-test-secret-1234567890';
const now = new Date('2026-10-02T12:00:00.000Z');
const issuedAt = Math.floor(now.getTime() / 1000);
const body = { order_reference: 'ORDER1234', category: 'DAMAGED' } as const;
const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
const createClaims = {
  tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: 'customer-a',
  conversationId: 'conversation-a', orderReference: body.order_reference,
  category: body.category, idempotencyKey: 'request-key', requestId: 'request-a',
  bodySha256: digest, purpose: 'delivery_issue_report_create',
};
const readClaims = {
  tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: 'customer-a',
  reportId: 'delivery-one', requestId: 'request-a', purpose: 'delivery_issue_report_read',
};
const replayClaims = { ...createClaims, purpose: 'delivery_issue_report_replay' };
const listClaims = {
  tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: 'customer-a',
  requestId: 'request-list', purpose: 'delivery_issue_report_list',
};
async function sign(payload: Record<string, unknown>, audience: string, typ: string, lifetime = 60) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ })
    .setIssuer('edge').setAudience(audience).setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetime).sign(new TextEncoder().encode(secret));
}

test('delivery create verifier binds signed fields to strict request body and header key', async () => {
  const verify = createDeliveryReportAssertionVerifier({ secret, issuer: 'edge', tenantId: 'tenant-a', environmentId: 'local', now: () => now });
  const assertion = await sign(createClaims, 'human-operations-delivery-report', 'cso-delivery-report+jwt');
  assert.deepEqual(await verify(assertion, 'delivery_issue_report_create', { body, idempotencyKey: 'request-key' }), {
    tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: 'customer-a', conversationId: 'conversation-a',
    orderReference: 'ORDER1234', category: 'DAMAGED', idempotencyKey: 'request-key', requestId: 'request-a',
  });
  await assert.rejects(verify(assertion, 'delivery_issue_report_create', { body: { ...body, category: 'MISSING' }, idempotencyKey: 'request-key' }), /DELIVERY_REPORT_UNAUTHORIZED/);
  await assert.rejects(verify(assertion, 'delivery_issue_report_create', { body, idempotencyKey: 'different-key' }), /DELIVERY_REPORT_UNAUTHORIZED/);
  await assert.rejects(verify(assertion, 'delivery_issue_report_read', { reportId: 'delivery-one' }), /DELIVERY_REPORT_UNAUTHORIZED/);
});

test('delivery read verifier binds report ID and rejects create fields', async () => {
  const verify = createDeliveryReportAssertionVerifier({ secret, issuer: 'edge', tenantId: 'tenant-a', environmentId: 'local', now: () => now });
  const assertion = await sign(readClaims, 'human-operations-delivery-report', 'cso-delivery-report+jwt');
  assert.deepEqual(await verify(assertion, 'delivery_issue_report_read', { reportId: 'delivery-one' }), {
    tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: 'customer-a', reportId: 'delivery-one', requestId: 'request-a',
  });
  await assert.rejects(verify(assertion, 'delivery_issue_report_read', { reportId: 'delivery-two' }), /DELIVERY_REPORT_UNAUTHORIZED/);
  const polluted = await sign({ ...readClaims, orderReference: 'ORDER1234' }, 'human-operations-delivery-report', 'cso-delivery-report+jwt');
  await assert.rejects(verify(polluted, 'delivery_issue_report_read', { reportId: 'delivery-one' }), /DELIVERY_REPORT_UNAUTHORIZED/);
});

test('delivery replay verifier binds its distinct purpose, body digest, and original key', async () => {
  const verify = createDeliveryReportAssertionVerifier({ secret, issuer: 'edge', tenantId: 'tenant-a', environmentId: 'local', now: () => now });
  const assertion = await sign(replayClaims, 'human-operations-delivery-report', 'cso-delivery-report+jwt');
  assert.deepEqual(await verify(assertion, 'delivery_issue_report_replay', { body, idempotencyKey: 'request-key' }), {
    tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: 'customer-a', conversationId: 'conversation-a',
    orderReference: 'ORDER1234', category: 'DAMAGED', idempotencyKey: 'request-key', requestId: 'request-a',
  });
  await assert.rejects(verify(assertion, 'delivery_issue_report_create', { body, idempotencyKey: 'request-key' }), /DELIVERY_REPORT_UNAUTHORIZED/);
  await assert.rejects(verify(assertion, 'delivery_issue_report_replay', { body: { ...body, category: 'WRONG' }, idempotencyKey: 'request-key' }), /DELIVERY_REPORT_UNAUTHORIZED/);
  await assert.rejects(verify(assertion, 'delivery_issue_report_replay', { body, idempotencyKey: 'different-key' }), /DELIVERY_REPORT_UNAUTHORIZED/);
  await assert.rejects(verify(await sign(createClaims, 'human-operations-delivery-report', 'cso-delivery-report+jwt'),
    'delivery_issue_report_replay', { body, idempotencyKey: 'request-key' }), /DELIVERY_REPORT_UNAUTHORIZED/);
  await assert.rejects(verify(await sign({ ...replayClaims, bodySha256: '0'.repeat(64) }, 'human-operations-delivery-report', 'cso-delivery-report+jwt'),
    'delivery_issue_report_replay', { body, idempotencyKey: 'request-key' }), /DELIVERY_REPORT_UNAUTHORIZED/);
});

test('delivery list verifier accepts only customer-scoped list purpose without create or read fields', async () => {
  const verify = createDeliveryReportAssertionVerifier({ secret, issuer: 'edge', tenantId: 'tenant-a', environmentId: 'local', now: () => now });
  const assertion = await sign(listClaims, 'human-operations-delivery-report', 'cso-delivery-report+jwt');
  assert.deepEqual(await verify(assertion, 'delivery_issue_report_list'), {
    tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: 'customer-a', requestId: 'request-list',
  });
  await assert.rejects(verify(await sign({ ...listClaims, reportId: 'delivery-one' }, 'human-operations-delivery-report', 'cso-delivery-report+jwt'),
    'delivery_issue_report_list'), /DELIVERY_REPORT_UNAUTHORIZED/);
  await assert.rejects(verify(await sign(createClaims, 'human-operations-delivery-report', 'cso-delivery-report+jwt'),
    'delivery_issue_report_list'), /DELIVERY_REPORT_UNAUTHORIZED/);
  await assert.rejects(verify(assertion, 'delivery_issue_report_read', { reportId: 'delivery-one' }), /DELIVERY_REPORT_UNAUTHORIZED/);
});

test('delivery verifier rejects wrong issuer, audience, type, tenant, and excessive lifetime', async () => {
  const verify = createDeliveryReportAssertionVerifier({ secret, issuer: 'edge', tenantId: 'tenant-a', environmentId: 'local', now: () => now });
  for (const [payload, audience, typ, lifetime] of [
    [createClaims, 'human-operations', 'cso-delivery-report+jwt', 60],
    [createClaims, 'human-operations-delivery-report', 'cso-human+jwt', 60],
    [{ ...createClaims, tenantId: 'tenant-b' }, 'human-operations-delivery-report', 'cso-delivery-report+jwt', 60],
    [createClaims, 'human-operations-delivery-report', 'cso-delivery-report+jwt', 61],
  ] as const) {
    await assert.rejects(verify(await sign(payload, audience, typ, lifetime), 'delivery_issue_report_create', { body, idempotencyKey: 'request-key' }), /DELIVERY_REPORT_UNAUTHORIZED/);
  }
});

test('delivery staff roles have a separate audience and cannot enter refund routes', async () => {
  const staffAssertion = await sign({ staffId: 'staff-a', tenantId: 'tenant-a', environmentId: 'local', role: 'DELIVERY_AGENT' }, 'human-operations-delivery-staff', 'cso-delivery-staff+jwt', 300);
  const verify = createDeliveryStaffAssertionVerifier({ secret, issuer: 'edge', tenantId: 'tenant-a', environmentId: 'local', now: () => now });
  const access = await verify(staffAssertion);
  assert.equal(access.staffId, 'staff-a');
  assert.equal(access.role, 'DELIVERY_AGENT');
  const refundVerifier = createHumanAssertionVerifier({ secret, issuer: 'edge', audience: 'human-operations', tenantId: 'tenant-a', environmentId: 'local' });
  await assert.rejects(refundVerifier(staffAssertion), /HUMAN_UNAUTHORIZED/);
  await assert.rejects(verify(await sign({ staffId: 'staff-a', tenantId: 'tenant-a', environmentId: 'local', role: 'REFUND_SUPERVISOR' }, 'human-operations-delivery-staff', 'cso-delivery-staff+jwt')), /DELIVERY_STAFF_UNAUTHORIZED/);
});

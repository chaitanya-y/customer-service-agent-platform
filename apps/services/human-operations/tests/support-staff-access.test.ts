import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createSupportStaffAssertionVerifier } from '../src/support-staff-access.js';

const secret = 'support-test-secret-with-at-least-thirty-two-bytes';
const now = new Date('2026-10-02T12:00:00Z');
const nowSeconds = Math.floor(now.getTime()/1000);
async function token(changes: Record<string, unknown> = {}, audience = 'human-operations-support-staff', typ = 'cso-support-staff+jwt') {
  return new SignJWT({ staffId: 'support-1', tenantId: 'tenant-local', environmentId: 'local', role: 'SUPPORT_AGENT', iat: nowSeconds, exp: nowSeconds+60, ...changes })
    .setProtectedHeader({alg:'HS256',typ}).setIssuer('customer-service-os-human-operations').setAudience(audience).sign(new TextEncoder().encode(secret));
}
const verify = createSupportStaffAssertionVerifier({secret,issuer:'customer-service-os-human-operations',tenantId:'tenant-local',environmentId:'local',now:()=>now});
test('support login grants only support identity and rejects refund/delivery audience and role', async () => {
  assert.deepEqual(await verify(await token()), {staffId:'support-1',tenantId:'tenant-local',environmentId:'local',role:'SUPPORT_AGENT'});
  for(const bad of [await token({role:'REFUND_SUPERVISOR'}), await token({role:'DELIVERY_AGENT'}), await token({},'human-operations','cso-human+jwt'), await token({},'human-operations-delivery-staff','cso-delivery-staff+jwt')]) await assert.rejects(verify(bad),/SUPPORT_STAFF_UNAUTHORIZED/);
});
test('support login requires strict live bounded claims and matching tenant/environment', async () => {
  for(const changes of [{tenantId:'other'},{environmentId:'other'},{exp:nowSeconds},{iat:nowSeconds+31,exp:nowSeconds+90},{exp:nowSeconds+2592001},{exp:undefined},{staffId:'../staff'},{extra:'untrusted'}]) await assert.rejects(verify(await token(changes)),/SUPPORT_STAFF_UNAUTHORIZED/);
  await assert.rejects(verify(undefined),/SUPPORT_STAFF_UNAUTHORIZED/);
});

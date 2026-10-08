import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeJwt } from 'jose';
import { createSupportStaffAssertionVerifier } from '../src/support-staff-access.js';
import { createHumanAssertionVerifier } from '../src/human-access.js';
import { createDeliveryStaffAssertionVerifier } from '../src/delivery-staff-access.js';
const secret='local-support-test-login-secret-is-at-least-32-bytes';
const cwd=fileURLToPath(new URL('..',import.meta.url));
const env={HUMAN_ACCESS_HMAC_SECRET:secret,TENANT_ID:'tenant-local',ENVIRONMENT_ID:'local'};
test('support CLI issues independent support-only thirty-day login token', async()=>{
  const token=execFileSync(process.execPath,['--import','tsx','src/local-support-token-cli.ts'],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const claims=decodeJwt(token);
  assert.equal(claims.exp!-claims.iat!,2592000);
  assert.deepEqual(await createSupportStaffAssertionVerifier({secret,issuer:'customer-service-os-human-operations',tenantId:'tenant-local',environmentId:'local'})(token),
    {staffId:'local-support-agent',tenantId:'tenant-local',environmentId:'local',role:'SUPPORT_AGENT'});
  await assert.rejects(createHumanAssertionVerifier({secret,issuer:'customer-service-os-human-operations',audience:'human-operations',tenantId:'tenant-local',environmentId:'local'})(token));
  await assert.rejects(createDeliveryStaffAssertionVerifier({secret,issuer:'customer-service-os-human-operations',tenantId:'tenant-local',environmentId:'local'})(token));
});
test('support CLI rejects overlong TTL instead of granting extended login',()=>{
  assert.throws(()=>execFileSync(process.execPath,['--import','tsx','src/local-support-token-cli.ts'],{cwd,env:{...env,LOCAL_SUPPORT_STAFF_TTL_SECONDS:'2592001'},stdio:['ignore','pipe','pipe']}));
});

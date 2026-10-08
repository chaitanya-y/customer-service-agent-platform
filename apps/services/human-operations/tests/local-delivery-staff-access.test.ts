import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeJwt } from 'jose';

import { createDeliveryStaffAssertionVerifier } from '../src/delivery-staff-access.js';
import { createHumanAssertionVerifier } from '../src/human-access.js';

test('delivery CLI produces a staff-only token with a thirty-day local lifetime', async () => {
  const secret = 'a-local-human-access-secret-that-is-long-enough';
  const token = execFileSync(process.execPath, ['--import', 'tsx', 'src/local-delivery-token-cli.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { HUMAN_ACCESS_HMAC_SECRET: secret, TENANT_ID: 'tenant-local', ENVIRONMENT_ID: 'local' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const claims = decodeJwt(token);
  assert.equal(claims.exp! - claims.iat!, 2_592_000);
  const access = await createDeliveryStaffAssertionVerifier({ secret, issuer: 'customer-service-os-human-operations',
    tenantId: 'tenant-local', environmentId: 'local' })(token);
  assert.deepEqual(access, { staffId: 'local-delivery-agent', tenantId: 'tenant-local', environmentId: 'local', role: 'DELIVERY_AGENT' });
  await assert.rejects(createHumanAssertionVerifier({ secret, issuer: 'customer-service-os-human-operations',
    audience: 'human-operations', tenantId: 'tenant-local', environmentId: 'local' })(token), /HUMAN_UNAUTHORIZED/);
});

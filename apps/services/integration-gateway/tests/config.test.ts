import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';

test('loadConfig applies local server defaults', () => {
  const config = loadConfig({
    VENDURE_ADMIN_API_URL: 'http://localhost:3001/admin-api',
    VENDURE_API_KEY: 'test-api-key',
    VENDURE_CHANNEL_TOKEN: 'synthetic-channel-token',
    VENDURE_CHANNEL_CODE: 'tenant-local-channel',
    DATABASE_URL: 'postgresql://localhost/customer_service_os',
    TENANT_ID: 'tenant-local',
    ENVIRONMENT_ID: 'local',
    CONTEXT_ASSERTION_HMAC_SECRET:
      'test-only-context-secret-with-at-least-32-bytes',
    WORKFLOW_ACCESS_HMAC_SECRET:
      'test-only-workflow-secret-with-at-least-32-bytes',
  });

  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.PORT, 3002);
  assert.equal(config.VENDURE_SHOP_API_URL, undefined);
  assert.equal(config.VENDURE_CHANNEL_TOKEN, 'synthetic-channel-token');
  assert.equal(config.VENDURE_CHANNEL_CODE, 'tenant-local-channel');
});

for (const field of ['VENDURE_CHANNEL_TOKEN', 'VENDURE_CHANNEL_CODE']) {
  for (const value of [undefined, '', '   ']) {
    test(`loadConfig rejects missing or blank required channel binding ${field}=${JSON.stringify(value)}`, () => {
      assert.throws(() => loadConfig({
        VENDURE_ADMIN_API_URL: 'http://localhost:3001/admin-api', VENDURE_API_KEY: 'test-api-key',
        VENDURE_CHANNEL_TOKEN: 'synthetic-channel-token', VENDURE_CHANNEL_CODE: 'tenant-local-channel',
        DATABASE_URL: 'postgresql://localhost/customer_service_os', TENANT_ID: 'tenant-local', ENVIRONMENT_ID: 'local',
        CONTEXT_ASSERTION_HMAC_SECRET: 'test-only-context-secret-with-at-least-32-bytes',
        WORKFLOW_ACCESS_HMAC_SECRET: 'test-only-workflow-secret-with-at-least-32-bytes',
        [field]: value,
      }));
    });
  }
}

test('loadConfig retains an explicitly configured Shop API channel binding', () => {
  const config = loadConfig({
    VENDURE_ADMIN_API_URL: 'http://localhost:3001/admin-api',
    VENDURE_API_KEY: 'test-api-key',
    VENDURE_SHOP_API_URL: 'http://localhost:3001/shop-api',
    VENDURE_CHANNEL_TOKEN: 'tenant-local-channel',
    VENDURE_CHANNEL_CODE: 'tenant-local-channel',
    DATABASE_URL: 'postgresql://localhost/customer_service_os',
    TENANT_ID: 'tenant-local',
    ENVIRONMENT_ID: 'local',
    CONTEXT_ASSERTION_HMAC_SECRET:
      'test-only-context-secret-with-at-least-32-bytes',
    WORKFLOW_ACCESS_HMAC_SECRET:
      'test-only-workflow-secret-with-at-least-32-bytes',
  });

  assert.equal(config.VENDURE_SHOP_API_URL, 'http://localhost:3001/shop-api');
  assert.equal(config.VENDURE_CHANNEL_TOKEN, 'tenant-local-channel');
  assert.equal(config.VENDURE_CHANNEL_CODE, 'tenant-local-channel');
});

test('loadConfig rejects a whitespace-only expected channel code', () => {
  assert.throws(() => loadConfig({
    VENDURE_ADMIN_API_URL: 'http://localhost:3001/admin-api',
    VENDURE_API_KEY: 'test-api-key',
    VENDURE_CHANNEL_CODE: '   ',
    DATABASE_URL: 'postgresql://localhost/customer_service_os',
    TENANT_ID: 'tenant-local',
    ENVIRONMENT_ID: 'local',
    CONTEXT_ASSERTION_HMAC_SECRET: 'test-only-context-secret-with-at-least-32-bytes',
    WORKFLOW_ACCESS_HMAC_SECRET: 'test-only-workflow-secret-with-at-least-32-bytes',
  }));
});

test('loadConfig rejects an empty Vendure API key', () => {
  assert.throws(() =>
    loadConfig({
      VENDURE_ADMIN_API_URL: 'http://localhost:3001/admin-api',
      VENDURE_API_KEY: '',
      TENANT_ID: 'tenant-local',
      ENVIRONMENT_ID: 'local',
      CONTEXT_ASSERTION_HMAC_SECRET:
        'test-only-context-secret-with-at-least-32-bytes',
      WORKFLOW_ACCESS_HMAC_SECRET:
        'test-only-workflow-secret-with-at-least-32-bytes',
    }),
  );
});

test('loadConfig rejects a short context assertion secret', () => {
  assert.throws(() =>
    loadConfig({
      VENDURE_ADMIN_API_URL: 'http://localhost:3001/admin-api',
      VENDURE_API_KEY: 'test-api-key',
      TENANT_ID: 'tenant-local',
      ENVIRONMENT_ID: 'local',
      CONTEXT_ASSERTION_HMAC_SECRET: 'too-short',
      WORKFLOW_ACCESS_HMAC_SECRET:
        'test-only-workflow-secret-with-at-least-32-bytes',
    }),
  );
});

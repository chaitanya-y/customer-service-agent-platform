import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommerceProvider } from '../src/commerce.js';
import { verifyTestContextAssertion } from './trusted-context-fixture.js';

const commerceProvider: CommerceProvider = {
  async getOrderByReference() {
    return null;
  },
};

test('enabled gateway logging never records untrusted request URLs or query values', async () => {
  const entries: string[] = [];
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
    logger: true,
    loggerStream: { write: (entry) => { entries.push(entry); } },
  });
  try {
    app.log.info('safe gateway log marker');
    app.log.error({ err: new Error('synthetic-private-error') }, 'safe failure marker');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/account/recent-order-references?email=synthetic-private-address%40example.test',
    });
    assert.equal(response.statusCode, 401);
    const notFound = await app.inject({
      method: 'GET',
      url: '/missing-route?token=synthetic-private-token',
    });
    assert.equal(notFound.statusCode, 404);
  } finally {
    await app.close();
  }

  const logged = entries.join('');
  assert.match(logged, /safe gateway log marker/);
  assert.match(logged, /safe failure marker/);
  assert.doesNotMatch(logged, /synthetic-private-address|synthetic-private-token|synthetic-private-error|email=|token=|recent-order-references|missing-route/);
});

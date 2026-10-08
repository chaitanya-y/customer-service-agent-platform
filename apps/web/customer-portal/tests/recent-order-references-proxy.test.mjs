import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const originalFetch = globalThis.fetch;
const originalEnv = { nodeEnv: process.env.NODE_ENV, token: process.env.CSO_LOCAL_CUSTOMER_TOKEN };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [['NODE_ENV', originalEnv.nodeEnv], ['CSO_LOCAL_CUSTOMER_TOKEN', originalEnv.token]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function loadSource(path, dependencies = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => name in dependencies ? dependencies[name] : require(name), module, module.exports);
  return module.exports;
}
function route() {
  process.env.NODE_ENV = 'development';
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = 'test-only-server-token';
  const proxy = loadSource('../lib/refund-proxy.ts', { 'server-only': {},
    '@cso/auth': loadSource('../../../../packages/auth/src/index.ts'),
    './safe-edge-fetch': loadSource('../lib/safe-edge-fetch.ts'),
  });
  return loadSource('../app/api/account/recent-order-references/route.ts', {
    '../../../../lib/refund-proxy': proxy,
    '../../../../components/recent-order-references-api': loadSource('../components/recent-order-references-api.ts'),
  });
}
function request(suffix = '', session = true, headers = {}) {
  return new NextRequest('http://127.0.0.1:3100/api/account/recent-order-references' + suffix, {
    headers: { ...(session ? { cookie: 'cso_local_customer_session=active', authorization: 'Bearer untrusted-browser' } : {}), ...headers },
  });
}
const result = { schemaVersion: '1', orders: [{ reference: 'ORDER1234', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: false };
test('recent orders proxy requires session and rejects caller filters before upstream access', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(result); };
  const { GET } = route();
  assert.equal((await GET(request('', false))).status, 401);
  for (const suffix of ['?customerId=other', '?sort=ASC', '?take=50']) {
    const rejected = await GET(request(suffix));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await GET(request('', true, { 'content-length': '12' }))).status, 400);
  assert.equal(calls, 0);
});
test('recent orders proxy uses only server auth and validates safe response with no-store', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url.pathname, '/v1/account/recent-order-references');
    assert.equal(url.search, '');
    assert.equal(init.method, 'GET');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, 'Bearer test-only-server-token');
    assert.equal(init.headers.cookie, undefined);
    assert.ok(init.signal);
    return Response.json(result);
  };
  const response = await route().GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('recent orders proxy suppresses raw diagnostics and unsafe response fields', async () => {
  for (const [status, value, expected] of [[401, { error: { message: 'private details' } }, 401], [503, { secret: 'private' }, 503], [200, { ...result, address: 'private' }, 502], [202, result, 502]]) {
    globalThis.fetch = async () => Response.json(value, { status });
    const response = await route().GET(request());
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /private/);
  }
  globalThis.fetch = async () => new Response(null, { status: 307 });
  assert.equal((await route().GET(request())).status, 502);
});

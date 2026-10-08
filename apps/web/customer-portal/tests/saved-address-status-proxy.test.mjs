import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
const originalFetch = globalThis.fetch;
const originalEnv = { nodeEnv: process.env.NODE_ENV, token: process.env.CSO_LOCAL_CUSTOMER_TOKEN };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [["NODE_ENV", originalEnv.nodeEnv], ["CSO_LOCAL_CUSTOMER_TOKEN", originalEnv.token]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function loadSource(relativePath, dependencies = {}) {
  const file = fileURLToPath(new URL(relativePath, import.meta.url));
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(
    (specifier) => specifier in dependencies ? dependencies[specifier] : require(specifier),
    module, module.exports,
  );
  return module.exports;
}

function loadRoute() {
  const proxy = loadSource("../lib/refund-proxy.ts", {
    "server-only": {},
    "@cso/auth": loadSource("../../../../packages/auth/src/index.ts"),
    "./safe-edge-fetch": loadSource("../lib/safe-edge-fetch.ts"),
  });
  return loadSource("../app/api/account/saved-address-status/route.ts", {
    "../../../../lib/refund-proxy": proxy,
  });
}
function request(cookie = true) {
  return new NextRequest("http://127.0.0.1:3100/api/account/saved-address-status?customerId=other", {
    headers: cookie ? { cookie: "cso_local_customer_session=active", authorization: "Bearer browser-untrusted" } : {},
  });
}

test("saved-address proxy requires an active local session before upstream access", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  const { GET } = loadRoute();
  const denied = await GET(request(false));
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  assert.equal(denied.headers.get("cache-control"), "no-store");
});

test("saved-address proxy uses only server auth, fixed owner-scoped path, and no-store", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  const body = { schemaVersion: "1", savedAddressCount: 0,
    hasDefaultShippingAddress: false, hasDefaultBillingAddress: false };
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(body); };
  const response = await loadRoute().GET(request());
  assert.ok(response instanceof NextResponse);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v1/account/saved-address-status");
  assert.equal(calls[0].url.search, "");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-only-server-token");
  assert.equal(calls[0].init.headers.cookie, undefined);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify(body), /server-token/);
});

test("saved-address proxy refuses redirect and preserves upstream authorization failures", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  globalThis.fetch = async () => new Response(null, { status: 307, headers: { location: "https://other.example" } });
  assert.equal((await loadRoute().GET(request())).status, 502);
  globalThis.fetch = async () => Response.json({ error: { code: "customer_unauthorized" } }, { status: 401 });
  assert.equal((await loadRoute().GET(request())).status, 401);
});

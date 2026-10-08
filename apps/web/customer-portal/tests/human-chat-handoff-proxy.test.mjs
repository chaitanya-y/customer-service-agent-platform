import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { NextRequest } = require("next/server");
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
  return loadSource("../app/api/conversations/[conversationId]/handoff/route.ts", {
    "../../../../../lib/refund-proxy": proxy,
  });
}
const conversationId = "f38f8a3f-c1a2-4f53-94ac-bdb19d441674";
const key = "5b396ac4-a6f0-4259-990e-2846809522e9";
function request({ cookie = true, origin = "http://127.0.0.1:3100", idempotencyKey = key } = {}) {
  return new NextRequest(`http://127.0.0.1:3100/api/conversations/${conversationId}/handoff`, {
    method: "POST", body: JSON.stringify({ expected_control_version: 1 }),
    headers: { "content-type": "application/json", origin, "idempotency-key": idempotencyKey,
      ...(cookie ? { cookie: "cso_local_customer_session=active" } : {}) },
  });
}
const context = { params: Promise.resolve({ conversationId }) };

test("requires authenticated same-origin session and an idempotency key", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  const { POST } = loadRoute();
  assert.equal((await POST(request({ cookie: false }), context)).status, 401);
  assert.equal((await POST(request({ origin: "https://elsewhere.example" }), context)).status, 403);
  assert.equal((await POST(request({ idempotencyKey: "invalid" }), context)).status, 400);
  assert.equal(calls, 0);
});

test("uses only server auth and exact Edge handoff path, rejects redirects", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({
    conversation_id: conversationId, status: "OPEN", control_mode: "QUEUED", control_version: 2,
    handoff_session_id: "9279888d-c449-4fe9-b68d-a030401d84bb",
  }); };
  const { POST } = loadRoute();
  const response = await POST(request(), context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls[0].url.pathname, `/v1/conversations/${conversationId}/handoff`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-only-server-token");
  assert.equal(calls[0].init.headers["idempotency-key"], key);
  assert.deepEqual(JSON.parse(calls[0].init.body), { expected_control_version: 1 });
  globalThis.fetch = async () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } });
  assert.equal((await POST(request(), context)).status, 502);
});

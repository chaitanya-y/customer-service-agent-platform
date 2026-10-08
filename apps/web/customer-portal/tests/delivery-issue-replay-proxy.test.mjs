import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
function loadSource(path, dependencies = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name) => name in dependencies ? dependencies[name] : require(name), module, module.exports,
  );
  return module.exports;
}
function route() {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  const proxy = loadSource("../lib/refund-proxy.ts", { "server-only": {},
    "@cso/auth": loadSource("../../../../packages/auth/src/index.ts"),
    "./safe-edge-fetch": loadSource("../lib/safe-edge-fetch.ts"),
  });
  return loadSource("../app/api/conversations/[conversationId]/delivery-issue-reports/replay/route.ts", {
    "../../../../../../lib/refund-proxy": proxy,
    "../../../../../../components/delivery-issue-api": loadSource("../components/delivery-issue-api.ts"),
  });
}
const conversationId = "33333333-3333-4333-8333-333333333333";
const key = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ conversationId }) };
function request({ cookie = true, origin = "http://127.0.0.1:3100", body = { order_reference: "ORDER1234", category: "DAMAGED" },
  idempotencyKey = key, suffix = "" } = {}) {
  return new NextRequest(`http://127.0.0.1:3100/api/conversations/${conversationId}/delivery-issue-reports/replay${suffix}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, "idempotency-key": idempotencyKey,
      ...(cookie ? { cookie: "cso_local_customer_session=active", authorization: "Bearer browser-supplied" } : {}) },
  });
}

test("replay proxy requires session, same origin, strict body and original key", async () => {
  const { POST } = route();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  assert.equal((await POST(request({ cookie: false }), context)).status, 401);
  assert.equal((await POST(request({ origin: "https://elsewhere.example" }), context)).status, 403);
  assert.equal((await POST(request({ idempotencyKey: "bad" }), context)).status, 400);
  assert.equal((await POST(request({ body: { order_reference: "ORDER1234", category: "DAMAGED", extra: true } }), context)).status, 400);
  assert.equal((await POST(request({ body: { order_reference: "ORDER/1234", category: "DAMAGED" } }), context)).status, 400);
  assert.equal((await POST(request({ suffix: "?customerId=other" }), context)).status, 400);
  assert.equal(calls, 0);
});

test("replay proxy sends only server authorization, exact path/body/key and no-store", async () => {
  const { POST } = route();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ delivery_issue_report: { report_id: "report-1", status: "RECEIVED",
      category: "DAMAGED", order_reference: "ORDER1234", created_at: "2026-10-02T12:00:00.000Z",
      updated_at: "2026-10-02T12:00:00.000Z" } });
  };
  const response = await POST(request(), context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, `/v1/conversations/${conversationId}/delivery-issue-reports/replay`);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-only-server-token");
  assert.equal(calls[0].init.headers["idempotency-key"], key);
  assert.deepEqual(JSON.parse(calls[0].init.body), { order_reference: "ORDER1234", category: "DAMAGED" });
});

test("replay proxy refuses upstream redirects without forwarding credentials", async () => {
  const { POST } = route();
  globalThis.fetch = async () => new Response(null, { status: 307,
    headers: { location: "https://elsewhere.example" } });
  const response = await POST(request(), context);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("replay proxy projects only the customer receipt and rejects malformed success", async () => {
  const { POST } = route();
  globalThis.fetch = async () => Response.json({ private_customer_id: "other-customer", delivery_issue_report: {
    report_id: "report-1", status: "RECEIVED", category: "DAMAGED", order_reference: "ORDER1234",
    created_at: "2026-10-02T12:00:00.000Z", updated_at: "2026-10-02T12:00:00.000Z",
    internal_notes: "private staff note",
  } });
  const response = await POST(request(), context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { delivery_issue_report: {
    report_id: "report-1", status: "RECEIVED", category: "DAMAGED", order_reference: "ORDER1234",
    created_at: "2026-10-02T12:00:00.000Z", updated_at: "2026-10-02T12:00:00.000Z",
  } });
  globalThis.fetch = async () => Response.json({ delivery_issue_report: { internal_notes: "private" } });
  const malformed = await POST(request(), context);
  assert.equal(malformed.status, 502);
  assert.doesNotMatch(JSON.stringify(await malformed.json()), /private/);
});

test("replay proxy preserves only named missing-receipt status, never raw diagnostics", async () => {
  const { POST } = route();
  globalThis.fetch = async () => Response.json({ error: {
    code: "delivery_report_not_found", message: "private database id 123", sql: "SELECT secret",
  } }, { status: 404 });
  const missing = await POST(request(), context);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "delivery_report_not_found");
  globalThis.fetch = async () => Response.json({ error: { code: "other_owner", secret: "customer-7" } }, { status: 404 });
  const other = await POST(request(), context);
  assert.equal(other.status, 404);
  assert.notEqual((await other.json()).error.code, "delivery_report_not_found");
  globalThis.fetch = async () => Response.json({ error: { debug: "private stack trace" } }, { status: 500 });
  const failed = await POST(request(), context);
  assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /private|stack/);
});

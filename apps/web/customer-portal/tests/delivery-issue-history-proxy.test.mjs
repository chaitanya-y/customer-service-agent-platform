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
  return loadSource("../app/api/delivery-issue-reports/route.ts", {
    "../../../lib/refund-proxy": proxy,
    "../../../components/delivery-issue-api": loadSource("../components/delivery-issue-api.ts"),
  });
}
function request(suffix = "", session = true, headers = {}) {
  return new NextRequest("http://127.0.0.1:3100/api/delivery-issue-reports" + suffix, {
    headers: { ...(session ? { cookie: "cso_local_customer_session=active", authorization: "Bearer browser-supplied" } : {}), ...headers },
  });
}
const report = { report_id: "report-1", status: "RECEIVED", category: "DAMAGED", order_reference: "ORDER1234",
  created_at: "2026-10-02T12:00:00.000Z", updated_at: "2026-10-02T12:00:00.000Z" };

test("history proxy requires session and rejects client filters or body before upstream access", async () => {
  const { GET } = route();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  const unauthenticated = await GET(request("", false));
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("cache-control"), "private, no-store");
  assert.equal((await GET(request("?customerId=other"))).status, 400);
  assert.equal((await GET(request("", true, { "content-length": "2" }))).status, 400);
  assert.equal(calls, 0);
});

test("history proxy uses only server authorization and returns strict no-store safe envelope", async () => {
  const { GET } = route();
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({
    delivery_issue_reports: [report], has_more: false,
  }); };
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { delivery_issue_reports: [report], has_more: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v1/delivery-issue-reports");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-only-server-token");
  assert.equal(calls[0].init.cache, "no-store");
});

test("history proxy fails closed on private or malformed response and refuses redirects", async () => {
  const { GET } = route();
  for (const upstream of [
    Response.json({ delivery_issue_reports: [{ ...report, staff_note: "private" }], has_more: false }),
    Response.json({ delivery_issue_reports: [report], has_more: true }),
    new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }),
  ]) {
    globalThis.fetch = async () => upstream;
    const response = await GET(request());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.doesNotMatch(await response.text(), /private/);
  }
});

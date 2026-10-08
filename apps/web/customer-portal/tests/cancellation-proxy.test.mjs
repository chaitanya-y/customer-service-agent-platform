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

function loadSource(relativePath, dependencies = {}) {
  const source = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(
    (specifier) => specifier in dependencies ? dependencies[specifier] : require(specifier),
    module, module.exports,
  );
  return module.exports;
}

function routes() {
  const proxy = loadSource("../lib/refund-proxy.ts", {
    "server-only": {},
    "@cso/auth": loadSource("../../../../packages/auth/src/index.ts"),
    "./safe-edge-fetch": loadSource("../lib/safe-edge-fetch.ts"),
  });
  return {
    start: loadSource("../app/api/cancellations/route.ts", { "../../../lib/refund-proxy": proxy }),
    status: loadSource("../app/api/cancellations/[workflowId]/route.ts", { "../../../../lib/refund-proxy": proxy }),
    confirm: loadSource("../app/api/cancellations/[workflowId]/confirmation/route.ts", { "../../../../../lib/refund-proxy": proxy }),
  };
}

function request(path, options = {}) {
  return new NextRequest(`http://127.0.0.1:3100${path}`, {
    ...options,
    headers: {
      cookie: "cso_local_customer_session=active",
      origin: "http://127.0.0.1:3100",
      ...options.headers,
    },
  });
}

test("start proxies only the supplied order reference with server authentication", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ workflow_id: "cancel-abc" }, { status: 202 });
  };
  const response = await routes().start.POST(request("/api/cancellations", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer browser-untrusted" },
    body: JSON.stringify({ order_reference: "ORDER-12345" }),
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { workflow_id: "cancel-abc" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v1/cancellations");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-only-server-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { order_reference: "ORDER-12345" });
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("start and decision reject cross-origin and absent-session requests without an upstream call", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  const { start, confirm } = routes();
  const crossOrigin = request("/api/cancellations", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal((await start.POST(crossOrigin)).status, 403);
  const noSession = new NextRequest("http://127.0.0.1:3100/api/cancellations", { method: "POST", headers: { origin: "http://127.0.0.1:3100", "content-type": "application/json" }, body: "{}" });
  assert.equal((await start.POST(noSession)).status, 401);
  assert.equal((await confirm.POST(request("/api/cancellations/cancel-abc/confirmation", {
    method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}",
  }), { params: Promise.resolve({ workflowId: "cancel-abc" }) })).status, 403);
  assert.equal(calls, 0);
});

test("status and decision route to distinct Edge paths and preserve responses", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_CUSTOMER_TOKEN = "test-only-server-token";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return init.method === "GET"
      ? Response.json({ stage: "AWAITING_CUSTOMER_CONFIRMATION" })
      : Response.json({ status: "confirmation_received" }, { status: 202 });
  };
  const { status, confirm } = routes();
  const context = { params: Promise.resolve({ workflowId: "cancel-abc" }) };
  assert.equal((await status.GET(request("/api/cancellations/cancel-abc"), context)).status, 200);
  const response = await confirm.POST(request("/api/cancellations/cancel-abc/confirmation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ preview_id: "preview-1", accepted: true }),
  }), context);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "confirmation_received" });
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/v1/cancellations/cancel-abc", "/v1/cancellations/cancel-abc/confirmation"]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { preview_id: "preview-1", accepted: true });
});

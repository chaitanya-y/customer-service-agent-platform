import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { NextRequest } = require("next/server");
const oldFetch = globalThis.fetch;
const oldEnv = { NODE_ENV: process.env.NODE_ENV, CSO_LOCAL_DELIVERY_STAFF_TOKEN: process.env.CSO_LOCAL_DELIVERY_STAFF_TOKEN };
afterEach(() => {
  globalThis.fetch = oldFetch;
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function source(path, dependencies = {}) {
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)((id) => id in dependencies ? dependencies[id] : require(id), module, module.exports);
  return module.exports;
}

function proxy() {
  return source("../lib/delivery-operations-proxy.ts", {
    "server-only": {},
    "../components/delivery-report": source("../components/delivery-report.ts"),
    "./safe-staff-fetch": source("../lib/safe-staff-fetch.ts"),
  });
}

const report = { report_id: "report-1", status: "ACKNOWLEDGED", category: "DAMAGED", order_reference: "ORDER1234", version: 3,
  assigned_staff_id: "staff-a", created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-02T12:00:00Z",
  claimed_at: "2026-10-02T12:00:00Z", acknowledged_at: "2026-10-02T12:00:00Z" };
function request(method = "GET", { cookie = "cso_local_delivery_staff_session=active", origin = "http://127.0.0.1:3101",
  body = { expected_version: 3 }, key = "close-key-123" } = {}) {
  return new NextRequest("http://127.0.0.1:3101/api/delivery-issue-reports/report-1/close", {
    method,
    headers: { cookie, ...(method === "POST" ? { origin, "content-type": "application/json", "idempotency-key": key } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

test("close proxy forwards only exact staff command after session and origin checks", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_DELIVERY_STAFF_TOKEN = "server-held-delivery-test-token";
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ delivery_issue_report: { ...report, status: "REVIEW_CLOSED", version: 4 } }); };
  const api = proxy();
  assert.equal((await api.proxyDeliveryReport(request("POST", { cookie: "cso_local_human_session=active" }), "close", "report-1")).status, 401);
  assert.equal((await api.proxyDeliveryReport(request("POST", { origin: "https://attacker.example" }), "close", "report-1")).status, 403);
  assert.equal((await api.proxyDeliveryReport(request("POST", { body: { expected_version: 3, staff_id: "staff-b" } }), "close", "report-1")).status, 400);
  assert.equal(calls.length, 0);
  const result = await api.proxyDeliveryReport(request("POST"), "close", "report-1");
  assert.equal(result.status, 200);
  assert.equal(calls[0].url.pathname, "/v1/delivery-issue-reports/report-1/close");
  assert.equal(calls[0].init.headers["x-cso-delivery-staff-assertion"], process.env.CSO_LOCAL_DELIVERY_STAFF_TOKEN);
  assert.equal(calls[0].init.headers["idempotency-key"], "close-key-123");
  assert.deepEqual(JSON.parse(calls[0].init.body), { expected_version: 3 });
});

test("detail proxy passes through only the upstream's verified close capability", async () => {
  process.env.NODE_ENV = "development";
  process.env.CSO_LOCAL_DELIVERY_STAFF_TOKEN = "server-held-delivery-test-token";
  let payload = { delivery_issue_report: report, audit_events: [], can_close_review: true };
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers["x-cso-delivery-staff-assertion"], "server-held-delivery-test-token");
    return Response.json(payload);
  };
  const api = proxy();
  assert.equal((await (await api.proxyDeliveryReport(request(), "detail", "report-1")).json()).can_close_review, true);
  payload = { delivery_issue_report: report, audit_events: [] };
  assert.equal((await (await api.proxyDeliveryReport(request(), "detail", "report-1")).json()).can_close_review, undefined);
});

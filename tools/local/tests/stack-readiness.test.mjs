import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_ENDPOINTS,
  checkLocalStack,
  effectiveEnvValue,
  formatReadinessReport,
  inspectLocalToken,
  classifyProbeResult,
} from "../stack-readiness.mjs";

test("classifies successful health responses, refused connections, and ambiguous failures safely", () => {
  assert.deepEqual(classifyProbeResult({ kind: "http", status: 200 }), { status: "healthy" });
  assert.deepEqual(classifyProbeResult({ kind: "http", status: 503 }), { status: "down" });
  assert.deepEqual(classifyProbeResult({ kind: "http", status: 404 }), { status: "unknown" });
  assert.deepEqual(classifyProbeResult({ kind: "error", code: "ECONNREFUSED" }), { status: "down" });
  assert.deepEqual(classifyProbeResult({ kind: "error", code: "ETIMEDOUT" }), { status: "unknown" });
});

test("probes the documented local refund stack without credentials or state-changing methods", async () => {
  const calls = [];
  const report = await checkLocalStack({
    httpProbe: async (url) => {
      calls.push({ url, method: "GET" });
      return { kind: "http", status: 200 };
    },
    tcpProbe: async (host, port) => {
      calls.push({ host, port });
      return { kind: "connected" };
    },
    tokens: { customer: { state: "missing" }, staff: { state: "missing" } },
  });

  assert.equal(report.endpoints.length, LOCAL_ENDPOINTS.length);
  assert.ok(report.endpoints.every(({ status }) => status === "healthy"));
  assert.ok(calls.filter(({ method }) => method).every(({ method }) => method === "GET"));
  assert.ok(calls.every((call) => !("headers" in call) && !("body" in call)));
  assert.ok(LOCAL_ENDPOINTS.every(({ url, host }) =>
    (url === undefined || new URL(url).hostname === "127.0.0.1") &&
    (host === undefined || host === "127.0.0.1"),
  ));
});

test("reports endpoint failures as down versus unknown without exposing probe errors", async () => {
  let index = 0;
  const report = await checkLocalStack({
    endpoints: LOCAL_ENDPOINTS.filter(({ url }) => url).slice(0, 2),
    httpProbe: async () => {
      index += 1;
      return index === 1
        ? { kind: "error", code: "ECONNREFUSED", detail: "private diagnostic" }
        : { kind: "error", code: "ETIMEDOUT", detail: "private diagnostic" };
    },
    tcpProbe: async () => ({ kind: "connected" }),
    tokens: { customer: { state: "missing" }, staff: { state: "missing" } },
  });

  assert.deepEqual(report.endpoints.map(({ status }) => status), ["down", "unknown"]);
  assert.doesNotMatch(formatReadinessReport(report), /private diagnostic/);
});

test("extracts only expiry metadata from a documented HS256 JWT and marks it unverified", () => {
  const token = jwt({ sub: "private-customer-id", exp: 1_800_000_000, iat: 1_700_000_000 });
  const metadata = inspectLocalToken(token, 1_700_000_000_000);

  assert.deepEqual(metadata, {
    state: "unverified",
    expiresAt: "2027-01-15T08:00:00.000Z",
    secondsRemaining: 100_000_000,
  });
  assert.doesNotMatch(JSON.stringify(metadata), /private-customer-id|eyJ/);
});

test("marks expired tokens as unverified and does not guess when the JWT cannot be interpreted", () => {
  assert.deepEqual(inspectLocalToken(jwt({ exp: 1_600_000_000 }), 1_700_000_000_000), {
    state: "expired-unverified",
    expiresAt: "2020-09-13T12:26:40.000Z",
    secondsRemaining: -100_000_000,
  });
  assert.deepEqual(inspectLocalToken("not-a-jwt", 1_700_000_000_000), { state: "unverified" });
  assert.deepEqual(inspectLocalToken(undefined, 1_700_000_000_000), { state: "missing" });
  assert.deepEqual(inspectLocalToken(jwt({ exp: "tomorrow" }), 1_700_000_000_000), { state: "unverified" });
});

test("uses process environment before Next.js local env, then base env without exposing values", () => {
  assert.equal(
    effectiveEnvValue("CSO_LOCAL_CUSTOMER_TOKEN", {
      processEnv: { CSO_LOCAL_CUSTOMER_TOKEN: "shell-value" },
      localEnv: "CSO_LOCAL_CUSTOMER_TOKEN=local-value\n",
      baseEnv: "CSO_LOCAL_CUSTOMER_TOKEN=base-value\n",
    }),
    "shell-value",
  );
  assert.equal(
    effectiveEnvValue("CSO_LOCAL_CUSTOMER_TOKEN", {
      processEnv: {},
      localEnv: "CSO_LOCAL_CUSTOMER_TOKEN=local-value\n",
      baseEnv: "CSO_LOCAL_CUSTOMER_TOKEN=base-value\n",
    }),
    "local-value",
  );
  assert.equal(
    effectiveEnvValue("CSO_LOCAL_CUSTOMER_TOKEN", {
      processEnv: {},
      localEnv: "",
      baseEnv: "CSO_LOCAL_CUSTOMER_TOKEN=base-value\n",
    }),
    "base-value",
  );
});

test("reads expiry metadata for all documented local login roles from effective web env", async () => {
  const customerToken = jwt({ sub: "customer-private", exp: 1_800_000_000 });
  const refundToken = jwt({ sub: "refund-private", exp: 1_800_000_100 });
  const deliveryToken = jwt({ sub: "delivery-private", exp: 1_800_000_200 });
  const supportToken = jwt({ sub: "support-private", exp: 1_800_000_300 });
  const files = new Map([
    ["apps/web/customer-portal/.env.local", `CSO_LOCAL_CUSTOMER_TOKEN=${customerToken}\n`],
    ["apps/web/customer-portal/.env", "CSO_LOCAL_CUSTOMER_TOKEN=shadowed-customer\n"],
    ["apps/web/operations-console/.env.local", `CSO_LOCAL_HUMAN_TOKEN=${refundToken}\nCSO_LOCAL_DELIVERY_STAFF_TOKEN=${deliveryToken}\n`],
    ["apps/web/operations-console/.env", `CSO_LOCAL_HUMAN_TOKEN=shadowed-refund\nCSO_LOCAL_DELIVERY_STAFF_TOKEN=shadowed-delivery\nCSO_LOCAL_SUPPORT_STAFF_TOKEN=${supportToken}\n`],
  ]);
  const { readLocalTokens } = await import("../stack-readiness.mjs");
  const tokens = await readLocalTokens({
    repositoryRoot: "/repo",
    processEnv: {},
    readText: async (path) => files.get(path.replace("/repo/", "")) ?? "",
    nowMs: 1_700_000_000_000,
  });

  assert.deepEqual(Object.keys(tokens), ["customer", "refundStaff", "deliveryStaff", "chatSupport"]);
  assert.deepEqual(Object.values(tokens).map(({ expiresAt }) => expiresAt), [
    "2027-01-15T08:00:00.000Z",
    "2027-01-15T08:01:40.000Z",
    "2027-01-15T08:03:20.000Z",
    "2027-01-15T08:05:00.000Z",
  ]);
  assert.ok(Object.values(tokens).every(({ state }) => state === "unverified"));
  assert.doesNotMatch(JSON.stringify(tokens), /private|eyJ/);
});

test("human-readable report includes expiry status but never token claims or values", () => {
  const report = {
    endpoints: [{ name: "Edge API", status: "healthy" }],
    tokens: {
      customer: inspectLocalToken(jwt({ sub: "customer-private", exp: 1_800_000_000 }), 1_700_000_000_000),
      refundStaff: { state: "missing" },
      deliveryStaff: { state: "missing" },
      chatSupport: { state: "missing" },
    },
  };
  const output = formatReadinessReport(report);

  assert.match(output, /Edge API: healthy/);
  assert.match(output, /Customer token: unverified; expiry 2027-01-15T08:00:00\.000Z/);
  assert.match(output, /Refund staff token: missing/);
  assert.match(output, /Delivery staff token: missing/);
  assert.match(output, /Chat support staff token: missing/);
  assert.doesNotMatch(output, /customer-private|eyJ|secret|payload/i);
});

function jwt(payload, header = { alg: "HS256", typ: "JWT" }) {
  return [header, payload, "signature-not-printed"].map((part) =>
    Buffer.from(JSON.stringify(part)).toString("base64url"),
  ).join(".");
}

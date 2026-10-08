import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const originals = { fetch: globalThis.fetch, window: globalThis.window };
afterEach(() => Object.assign(globalThis, originals));
const settle = () => new Promise(resolve => setImmediate(resolve));
const preview = { preview_id: "preview-1", order_reference: "PRIVATE-ORDER",
  placed_at: "2026-10-01T12:00:00Z", valid_until: "2026-10-02T12:00:00Z",
  total: { amount_minor: 0, currency: "USD" }, lines: [{ item_id: "private-item", quantity: 1 }] };
const awaiting = () => Response.json({ stage: "AWAITING_CUSTOMER_CONFIRMATION", preview });
function load(path, dependencies = require) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(dependencies, module, module.exports);
  return module.exports;
}
function harness() {
  const slots = [], effects = [], listeners = new Map();
  let cursor = 0, mounted = false;
  globalThis.window = { addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name), setInterval: () => 1, clearInterval() {} };
  const hooks = { ...require("react"), useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  }, useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
  useCallback: callback => callback, useEffect: effect => { if (!mounted) effects.push(effect); } };
  const api = load("../components/cancellation-api.ts");
  const session = load("../components/customer-session-state.ts");
  const { CancellationJourney } = load("../components/cancellation-journey.tsx", name => {
    if (name === "react") return hooks;
    if (name === "./cancellation-api") return api;
    if (name === "./customer-session-state") return session;
    if (name.endsWith(".css")) return { default: {} };
    return require(name);
  });
  const render = () => { cursor = 0; return CancellationJourney({ workflowId: "cancel-test" }); };
  render(); mounted = true; const cleanups = effects.map(effect => effect());
  return { render, listeners, session, cleanup: () => cleanups.forEach(cleanup => cleanup?.()) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

for (const status of [401, 403]) {
  test(`status ${status} clears private cancellation preview and decision controls`, async () => {
    globalThis.fetch = async () => awaiting();
    const h = harness(); await settle(); assert.equal(h.render().props.state.preview.order_reference, "PRIVATE-ORDER");
    globalThis.fetch = async () => new Response(null, { status });
    h.render().props.onRefresh(); await settle();
    assert.equal(h.render().props.state, undefined);
    assert.equal(h.render().props.onDecision, undefined);
    h.cleanup();
  });
  test(`decision ${status} clears private cancellation preview and broadcasts auth loss`, async () => {
    globalThis.fetch = async () => awaiting();
    const h = harness(); await settle();
    const epoch = h.session.customerSessionEpoch();
    globalThis.fetch = async () => new Response(null, { status });
    h.render().props.onDecision(true); await settle();
    assert.equal(h.render().props.state, undefined);
    assert.equal(h.session.customerSessionEpoch(), epoch + 1);
    h.cleanup();
  });
}
test("pagehide clears preview and rejects late status; persisted pageshow reloads authoritative state", async () => {
  globalThis.fetch = async () => awaiting();
  const h = harness(); await settle();
  const pending = deferred(); globalThis.fetch = () => pending.promise;
  h.render().props.onRefresh();
  h.listeners.get("pagehide")?.();
  assert.equal(h.render().props.state, undefined);
  pending.resolve(awaiting()); await settle();
  assert.equal(h.render().props.state, undefined);
  let reads = 0;
  globalThis.fetch = async () => { reads++; return Response.json({ stage: "ORDER_CANCELLED" }); };
  h.listeners.get("pageshow")?.({ persisted: true }); await settle();
  assert.equal(reads, 1);
  assert.equal(h.render().props.state.stage, "ORDER_CANCELLED");
  h.cleanup();
});
test("auth loss from another customer surface clears preview and prevents stale handlers or responses", async () => {
  globalThis.fetch = async () => awaiting();
  const h = harness(); await settle();
  const oldDecision = h.render().props.onDecision;
  const pending = deferred(); let calls = 0;
  globalThis.fetch = () => { calls++; return pending.promise; };
  h.render().props.onRefresh();
  h.session.notifyCustomerAuthLost();
  assert.equal(h.render().props.state, undefined);
  oldDecision(true);
  assert.equal(calls, 1);
  pending.resolve(awaiting()); await settle();
  assert.equal(h.render().props.state, undefined);
  h.cleanup();
});
test("decision auth loss invalidates an already pending status response", async () => {
  globalThis.fetch = async () => awaiting();
  const h = harness(); await settle();
  const pending = deferred();
  globalThis.fetch = url => url.endsWith("/confirmation")
    ? Promise.resolve(new Response(null, { status: 401 })) : pending.promise;
  h.render().props.onRefresh(); h.render().props.onDecision(true); await settle();
  assert.equal(h.render().props.state, undefined);
  pending.resolve(awaiting()); await settle();
  assert.equal(h.render().props.state, undefined);
  h.cleanup();
});
test("a response after unmount cannot publish private preview", async () => {
  const pending = deferred(); globalThis.fetch = () => pending.promise;
  const h = harness(); h.cleanup();
  pending.resolve(awaiting()); await settle();
  assert.equal(h.render().props.state, undefined);
});
test("a late decision cannot restore a receipt or refresh after pagehide", async () => {
  globalThis.fetch = async () => awaiting();
  const h = harness(); await settle();
  const pending = deferred(); let calls = 0;
  globalThis.fetch = () => { calls++; return pending.promise; };
  h.render().props.onDecision(true); h.listeners.get("pagehide")?.();
  pending.resolve(Response.json({ status: "confirmation_received" }, { status: 202 })); await settle();
  assert.equal(h.render().props.state, undefined);
  assert.equal(calls, 1);
  h.cleanup();
});

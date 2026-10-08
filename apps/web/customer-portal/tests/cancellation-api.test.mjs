import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
function loadApi() {
  const source = ts.transpileModule(readFileSync(new URL("../components/cancellation-api.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(require, module, module.exports);
  return module.exports;
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const preview = {
  preview_id: "preview-1",
  order_reference: "ORDER-12345",
  placed_at: "2026-10-01T12:00:00.000Z",
  valid_until: "2026-10-02T12:00:00.000Z",
  total: { amount_minor: 0, currency: "USD" },
  lines: [{ item_id: "item-1", quantity: 2 }],
};

test("only a complete zero-total awaiting preview permits a customer decision", () => {
  const { parseCancellationState } = loadApi();
  const state = parseCancellationState({ stage: "AWAITING_CUSTOMER_CONFIRMATION", preview });
  assert.equal(state.canDecide, true);
  assert.deepEqual(state.preview, preview);
  assert.equal(state.title, "Review order cancellation");
  for (const invalid of [
    { ...preview, total: { amount_minor: 1, currency: "USD" } },
    { ...preview, lines: [] },
    { ...preview, valid_until: "not-a-date" },
  ]) {
    assert.throws(() => parseCancellationState({ stage: "AWAITING_CUSTOMER_CONFIRMATION", preview: invalid }));
  }
  assert.throws(() => parseCancellationState({ stage: "AWAITING_CUSTOMER_CONFIRMATION" }));
});

test("named cancellation lines survive parsing while legacy lines remain readable", () => {
  const { parseCancellationState } = loadApi();
  const named = { ...preview, lines: [{ item_id: "item-1", quantity: 2, display_name: "Free fixture" }] };
  assert.deepEqual(parseCancellationState({ stage: "AWAITING_CUSTOMER_CONFIRMATION", preview: named }).preview.lines, named.lines);
  assert.deepEqual(parseCancellationState({ stage: "AWAITING_CUSTOMER_CONFIRMATION", preview }).preview.lines, preview.lines);
  for (const display_name of ["", "  ", "Unsafe\nname", "\u200B", "\u0085", "Free\u200Bfixture", "Free\u202Efixture", "x".repeat(301)]) {
    assert.throws(() => parseCancellationState({ stage: "AWAITING_CUSTOMER_CONFIRMATION",
      preview: { ...preview, lines: [{ item_id: "item-1", quantity: 2, display_name }] } }));
  }
});

test("confirmation receipt and reconciliation never claim the order was cancelled", () => {
  const { parseCancellationState } = loadApi();
  for (const stage of ["CANCELLATION_REQUESTED", "PENDING_RECONCILIATION"]) {
    const state = parseCancellationState({ stage });
    assert.equal(state.title, "Cancellation requested");
    assert.equal(state.canDecide, false);
    assert.equal(state.isTerminal, false);
  }
  assert.equal(parseCancellationState({ stage: "ORDER_CANCELLED" }).title, "Order cancelled");
  assert.equal(parseCancellationState({ stage: "ORDER_CANCELLED" }).isTerminal, true);
  assert.equal(parseCancellationState({ stage: "CUSTOMER_DECLINED" }).isTerminal, true);
  assert.throws(() => parseCancellationState({ stage: "FUTURE_UNKNOWN_STAGE" }));
});

test("status fetch stays same-origin and uncached", async () => {
  const { getCancellationStatus } = loadApi();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ stage: "EVALUATING" });
  };
  const state = await getCancellationStatus("cancel-abc");
  assert.equal(state.stage, "EVALUATING");
  assert.deepEqual(calls, [{ url: "/api/cancellations/cancel-abc", init: { method: "GET", cache: "no-store" } }]);
});

test("decision sends the exact preview and boolean, but does not infer final success", async () => {
  const { sendCancellationDecision } = loadApi();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ status: "confirmation_received" }, { status: 202 });
  };
  await sendCancellationDecision("cancel-abc", "preview-1", false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/cancellations/cancel-abc/confirmation");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { preview_id: "preview-1", accepted: false });
});

test("a rejected preview decision is shown as an error", async () => {
  const { sendCancellationDecision } = loadApi();
  globalThis.fetch = async () => Response.json({ error: { message: "This preview is no longer available" } }, { status: 409 });
  await assert.rejects(sendCancellationDecision("cancel-abc", "preview-1", true), /no longer available/);
});

test("status and decision errors retain HTTP authentication status even without a JSON body", async () => {
  const api = loadApi();
  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response(null, { status });
    for (const request of [() => api.getCancellationStatus("cancel-abc"),
      () => api.sendCancellationDecision("cancel-abc", "preview-1", true)]) {
      await assert.rejects(request(), cause => cause.status === status && cause instanceof Error);
    }
  }
});

test("review click starts a cancellation workflow only then returns its verified route", async () => {
  const { startCancellationReview } = loadApi();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ workflow_id: `cancel-${"a".repeat(64)}` }, { status: 202 });
  };
  assert.equal(await startCancellationReview("ORDER-12345"), `/cancellations/cancel-${"a".repeat(64)}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/cancellations");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { order_reference: "ORDER-12345" });
});

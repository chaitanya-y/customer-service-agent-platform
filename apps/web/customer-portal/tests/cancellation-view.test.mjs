import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function view() {
  const source = ts.transpileModule(readFileSync(new URL("../components/cancellation-journey.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)((name) => {
    if (name.endsWith(".css")) return { default: {} };
    if (name === "./cancellation-api") return {};
    if (name === "./customer-session-state") return {};
    return require(name);
  }, module, module.exports);
  return module.exports.CancellationReviewView;
}

const preview = {
  preview_id: "preview-1", order_reference: "ORDER-12345",
  placed_at: "2026-10-01T12:00:00.000Z", valid_until: "2026-10-02T12:00:00.000Z",
  total: { amount_minor: 0, currency: "USD" }, lines: [{ item_id: "item-1", quantity: 2 }],
};
const awaiting = {
  stage: "AWAITING_CUSTOMER_CONFIRMATION", title: "Review order cancellation",
  detail: "Check this exact order before you decide. The order is not cancelled yet.",
  preview, canDecide: true, isTerminal: false,
};

test("review presents the exact zero-total order and explicit decision controls", () => {
  const html = renderToStaticMarkup(React.createElement(view(), {
    state: awaiting, busy: false, decisionSubmitted: false, onDecision: () => {}, onRefresh: () => {},
  }));
  assert.match(html, /Review order cancellation/);
  assert.match(html, /ORDER-12345/);
  assert.match(html, /Item ID item-1/);
  assert.match(html, /quantity.*2/i);
  assert.match(html, /\$0\.00/);
  assert.match(html, /Decline/);
  assert.match(html, /Confirm cancellation/);
  assert.doesNotMatch(html, /Order cancelled/);
});

test("review identifies a new cancellation item by its trusted name", () => {
  const named = { ...preview, lines: [{ item_id: "item-1", quantity: 2, display_name: "Free fixture" }] };
  const html = renderToStaticMarkup(React.createElement(view(), {
    state: { ...awaiting, preview: named }, busy: false, decisionSubmitted: false,
    onDecision: () => {}, onRefresh: () => {},
  }));
  assert.match(html, /Free fixture/);
  assert.match(html, /Quantity.*2/);
  assert.doesNotMatch(html, /Item item-1/);
});

test("review escapes markup-like product names as text", () => {
  const named = { ...preview, lines: [{ item_id: "item-1", quantity: 2, display_name: "<img src=x> Fixture" }] };
  const html = renderToStaticMarkup(React.createElement(view(), {
    state: { ...awaiting, preview: named }, busy: false, decisionSubmitted: false,
    onDecision: () => {}, onRefresh: () => {},
  }));
  assert.match(html, /&lt;img src=x&gt; Fixture/);
  assert.doesNotMatch(html, /<img src=x>/);
});

test("receipt pending hides repeat decisions without claiming final cancellation", () => {
  const html = renderToStaticMarkup(React.createElement(view(), {
    state: awaiting, busy: false, decisionSubmitted: true, onDecision: () => {}, onRefresh: () => {},
  }));
  assert.match(html, /Decision received/);
  assert.doesNotMatch(html, /Confirm cancellation/);
  assert.doesNotMatch(html, /Order cancelled/);
});

test("only final provider-verified stage shows an order-cancelled outcome", () => {
  const View = view();
  for (const stage of ["CANCELLATION_REQUESTED", "PENDING_RECONCILIATION", "CANCELLATION_FAILED"]) {
    const html = renderToStaticMarkup(React.createElement(View, {
      state: { stage, title: "Cancellation requested", detail: "Checking the outcome", canDecide: false, isTerminal: stage === "CANCELLATION_FAILED" },
      busy: false, decisionSubmitted: false, onDecision: () => {}, onRefresh: () => {},
    }));
    assert.doesNotMatch(html, /Order cancelled/);
    assert.doesNotMatch(html, /Confirm cancellation/);
  }
  const final = renderToStaticMarkup(React.createElement(View, {
    state: { stage: "ORDER_CANCELLED", title: "Order cancelled", detail: "The order cancellation has been confirmed.", canDecide: false, isTerminal: true },
    busy: false, decisionSubmitted: false, onDecision: () => {}, onRefresh: () => {},
  }));
  assert.match(final, /Order cancelled/);
});

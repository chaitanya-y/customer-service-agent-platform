import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function component() {
  const source = ts.transpileModule(readFileSync(new URL("../components/delivery-issue-history.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)((name) => {
    if (name.endsWith(".css")) return { default: {} };
    if (name === "./delivery-issue-api") return { deliveryIssueStatusMessage: (status) => `Status ${status}` };
    return require(name);
  }, module, module.exports);
  return module.exports.DeliveryIssueHistoryPanel;
}
const report = { reportId: "report-1", status: "ACKNOWLEDGED", category: "DAMAGED",
  orderReference: "ORDER1234", createdAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T13:00:00.000Z" };
const render = (state) => renderToStaticMarkup(React.createElement(component(), {
  state, onView: () => {}, onSelect: () => {},
}));

test("history control has explicit idle, loading, empty and retry states", () => {
  const idle = render({ isLoading: false });
  assert.match(idle, /View my delivery reports/);
  assert.doesNotMatch(idle, /No delivery reports/);
  const loading = render({ isLoading: true });
  assert.match(loading, /Loading delivery reports/);
  assert.match(loading, /disabled/);
  const empty = render({ isLoading: false, reports: [], hasMore: false });
  assert.match(empty, /No delivery reports/);
  const failed = render({ isLoading: false, error: "Could not load reports." });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Try again/);
  assert.doesNotMatch(failed, /No delivery reports/);
});

test("history list shows bounded safe receipts and selection invokes existing status path", () => {
  const html = render({ isLoading: false, reports: [report], hasMore: true });
  assert.match(html, /ORDER1234/);
  assert.match(html, /Status ACKNOWLEDGED/);
  assert.match(html, /More reports exist/);
  assert.doesNotMatch(html, /staff|private|address|payment/i);
  const selected = [];
  const tree = component()({ state: { isLoading: false, reports: [report], hasMore: false },
    onView: () => {}, onSelect: (item) => selected.push(item) });
  function findButton(node) {
    if (!node || typeof node !== "object") return undefined;
    if (node.type === "button" && node.props?.["aria-label"] === "View report report-1") return node;
    return React.Children.toArray(node.props?.children).map(findButton).find(Boolean);
  }
  const button = findButton(tree);
  assert.ok(button);
  button.props.onClick();
  assert.deepEqual(selected, [report]);
});

test("closed report history offers a support link without implying the issue was fixed", () => {
  const html = render({ isLoading: false, reports: [{ ...report, status: "REVIEW_CLOSED" }], hasMore: false });
  assert.match(html, /Status REVIEW_CLOSED/);
  assert.match(html, /href="\/support"/);
  assert.match(html, /Contact support/);
  assert.doesNotMatch(html, /issue (was )?resolved|delivery (was )?fixed/i);
});

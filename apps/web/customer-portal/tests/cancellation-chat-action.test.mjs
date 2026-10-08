import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function action() {
  const source = ts.transpileModule(readFileSync(new URL("../components/support-chat.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)((name) => {
    if (name.endsWith(".css")) return { default: {} };
    if (name.startsWith("./")) return {};
    return require(name);
  }, module, module.exports);
  return module.exports.CancellationReviewAction;
}

test("chat shows a click-only review action without claiming an order was cancelled", () => {
  const html = renderToStaticMarkup(React.createElement(action(), {
    orderReference: "ORDER-12345", loading: false, onReview: () => {},
  }));
  assert.match(html, /Review cancellation/);
  assert.match(html, /ORDER-12345/);
  assert.match(html, /not cancelled yet/i);
  assert.doesNotMatch(html, /Order cancelled/);
});

test("review action disables duplicate clicks while the workflow starts and shows errors", () => {
  const html = renderToStaticMarkup(React.createElement(action(), {
    orderReference: "ORDER-12345", loading: true, error: "Please try again", onReview: () => {},
  }));
  assert.match(html, /disabled/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Please try again/);
});

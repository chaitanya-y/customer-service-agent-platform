import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
function component() {
  const source = ts.transpileModule(readFileSync(new URL("../components/support-chat.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)((name) => {
    if (name.endsWith(".css")) return { default: {} };
    if (name.startsWith("./")) return {};
    return require(name);
  }, module, module.exports);
  assert.equal(typeof module.exports.SavedAddressStatusCard, "function");
  return module.exports.SavedAddressStatusCard;
}

test("saved-address action is available without starting a conversation and explains its limit", () => {
  const html = renderToStaticMarkup(React.createElement(component(), { loading: false, onCheck: () => {} }));
  assert.match(html, /Check saved addresses/);
  assert.match(html, /does not confirm.*shipping address.*order/i);
  assert.doesNotMatch(html, /disabled|<input|<textarea|Saved addresses: 0/);
});

test("saved-address card labels account defaults, disables duplicate reads, and shows safe errors", () => {
  const Card = component();
  const html = renderToStaticMarkup(React.createElement(Card, {
    loading: false, onCheck: () => {},
    status: { schemaVersion: "1", savedAddressCount: 2, hasDefaultShippingAddress: true, hasDefaultBillingAddress: false },
  }));
  assert.match(html, /Saved addresses:.*2/);
  assert.match(html, /Default shipping address:.*Set/);
  assert.match(html, /Default billing address:.*Not set/);
  const pending = renderToStaticMarkup(React.createElement(Card, { loading: true, onCheck: () => {} }));
  assert.match(pending, /disabled/);
  assert.match(pending, /Checking/);
  const failed = renderToStaticMarkup(React.createElement(Card, { loading: false, onCheck: () => {}, error: "Please sign in again." }));
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /Saved addresses:/);
});

test("saved-address card offers explicit consultation without presenting an address-change action", () => {
  const Card = component();
  const html = renderToStaticMarkup(React.createElement(Card, {
    loading: false, onCheck: () => {}, onConsult: () => {}, consultationAvailable: true,
  }));
  assert.match(html, /Talk to a person about saved addresses/);
  assert.match(html, /specialist must verify/i);
  assert.match(html, /does not change any address/i);
  assert.doesNotMatch(html, /street|postcode|phone|<input/i);

  const unavailable = renderToStaticMarkup(React.createElement(Card, {
    loading: false, onCheck: () => {}, onConsult: () => {}, consultationAvailable: false,
  }));
  assert.match(unavailable, /Talk to a person about saved addresses/);
  assert.match(unavailable, /disabled/);
  assert.match(unavailable, /consultation is currently unavailable/i);

  const active = renderToStaticMarkup(React.createElement(Card, {
    loading: false, onCheck: () => {}, onConsult: () => {}, consultationAvailable: true,
    consultationActive: true,
  }));
  assert.doesNotMatch(active, /Talk to a person about saved addresses/);
  assert.match(active, /Describe your saved-address question/i);
});

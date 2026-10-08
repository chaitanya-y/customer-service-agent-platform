import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
function card() {
  const source = ts.transpileModule(readFileSync(new URL('../components/support-chat.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => {
    if (name.endsWith('.css')) return { default: {} };
    if (name.startsWith('./')) return {};
    return require(name);
  }, module, module.exports);
  assert.equal(typeof module.exports.RecentOrderReferencesCard, 'function');
  return module.exports.RecentOrderReferencesCard;
}
const render = props => renderToStaticMarkup(React.createElement(card(), { loading: false, onFind: () => {}, ...props }));
test('recent orders action is available before conversation and explains the bounded read', () => {
  const html = render({});
  assert.match(html, /Find my recent orders/);
  assert.match(html, /up to ten.*latest placed orders/i);
  assert.doesNotMatch(html, /disabled|<input|<textarea|No recent/);
});
test('recent orders card has distinct loading, empty, failure and retry states', () => {
  const pending = render({ loading: true });
  assert.match(pending, /disabled/);
  assert.match(pending, /Finding your recent orders/);
  const empty = render({ result: { schemaVersion: '1', orders: [], hasMore: false } });
  assert.match(empty, /No recent placed orders/);
  const failed = render({ error: 'We could not find your recent orders. Please try again.' });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Try again/);
  assert.doesNotMatch(failed, /No recent placed orders/);
});
test('recent orders card shows only references and placement dates with honest truncation', () => {
  const html = render({ result: { schemaVersion: '1', orders: [{ reference: 'ORDER1234', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: true } });
  assert.match(html, /ORDER1234/);
  assert.match(html, /<time dateTime="2026-10-01T12:00:00.000Z">Oct 1, 2026<\/time>/);
  assert.match(html, /More orders exist/i);
  assert.match(html, /Use a reference.*chat/i);
  assert.match(html, /Add an order reference if you have one/);
  assert.doesNotMatch(html, /complete history|payment|address/i);
});

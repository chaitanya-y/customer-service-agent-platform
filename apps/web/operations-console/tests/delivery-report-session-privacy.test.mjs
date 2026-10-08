import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isCurrentStaffSession, isStaffAuthorizationLoss } from "../components/staff-page-lifecycle.ts";

const component = (name) => readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), "utf8");

test("only staff authorization failures invalidate visible delivery data", () => {
  assert.equal(isStaffAuthorizationLoss({ status: 401 }), true);
  assert.equal(isStaffAuthorizationLoss({ status: 403 }), true);
  assert.equal(isStaffAuthorizationLoss({ status: 404 }), false);
  assert.equal(isStaffAuthorizationLoss(new Error("network failed")), false);
});

test("a response belongs only to the staff page generation that started it", () => {
  assert.equal(isCurrentStaffSession(false, 3, 3), true);
  assert.equal(isCurrentStaffSession(true, 3, 3), false);
  assert.equal(isCurrentStaffSession(false, 4, 3), false);
});

test("delivery queue hides private rows on page exit and authorization loss", () => {
  const source = component("delivery-report-queue");
  assert.match(source, /window\.addEventListener\("pagehide", hide\)/);
  assert.match(source, /watchStaffBfcacheRestore\(window\)/);
  assert.match(source, /isStaffAuthorizationLoss\(cause\)/);
  assert.match(source, /setReports\(undefined\)/);
});

test("delivery detail invalidates pending responses and decision controls without erasing retry keys on page exit", () => {
  const source = component("delivery-report-detail");
  assert.match(source, /window\.addEventListener\("pagehide", hide\)/);
  assert.match(source, /watchStaffBfcacheRestore\(window\)/);
  assert.match(source, /isStaffAuthorizationLoss\(cause\)/);
  assert.match(source, /if \(stopped\.current\) return/);
  assert.match(source, /isCurrentStaffSession\(/);
  assert.match(source, /setReport\(undefined\)/);
  assert.match(source, /setEvents\(\[\]\)/);
});

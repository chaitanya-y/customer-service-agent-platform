import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { watchStaffBfcacheRestore } from "../components/staff-page-lifecycle.ts";

test("support pages reload only after a back-forward cache restoration", () => {
  const listeners = new Map();
  let reloads = 0;
  const fakeWindow = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    location: { reload: () => { reloads += 1; } },
  };

  const stopWatching = watchStaffBfcacheRestore(fakeWindow);
  listeners.get("pageshow")({ persisted: false });
  assert.equal(reloads, 0);
  listeners.get("pageshow")({ persisted: true });
  assert.equal(reloads, 1);
  stopWatching();
  assert.equal(listeners.has("pageshow"), false);
});

test("both staff chat views install bfcache recovery without replaying an action", () => {
  for (const component of ["support-chat-queue.tsx", "support-chat-detail.tsx"]) {
    const source = readFileSync(new URL(`../components/${component}`, import.meta.url), "utf8");
    assert.match(source, /watchStaffBfcacheRestore\(window\)/);
    assert.match(source, /window\.addEventListener\("pagehide"/);
  }
});

test("staff chat detail ignores responses from an earlier mounted session", () => {
  const source = readFileSync(new URL("../components/support-chat-detail.tsx", import.meta.url), "utf8");
  assert.match(source, /isCurrentStaffSession\(/);
  assert.match(source, /generation\.current \+= 1/);
});

test("uncertain staff action is saved before send and restored only for explicit retry", () => {
  const source = readFileSync(new URL("../components/support-chat-detail.tsx", import.meta.url), "utf8");
  assert.match(source, /sessionStorage\.setItem\(storageKey/);
  assert.match(source, /parseSupportAttempt\(/);
  assert.match(source, /sessionStorage\.removeItem\(storageKey/);
  assert.match(source, /clearPrivateState\(false\)/);
  assert.ok(source.indexOf("sessionStorage.setItem(storageKey") < source.indexOf("await postConsoleData"));
});

test("unavailable detail offers an exact retry without exposing a stale transcript", () => {
  const source = readFileSync(new URL("../components/support-chat-detail.tsx", import.meta.url), "utf8");
  assert.match(source, /keepSupportAttemptForUnavailableDetail\(/);
  assert.match(source, /recoveryOnly/);
  assert.match(source, /Retry pending action/);
});

test("a definitive action conflict leaves recovery mode and retries detail loading", () => {
  const source = readFileSync(new URL("../components/support-chat-detail.tsx", import.meta.url), "utf8");
  assert.match(source, /pending\.current=undefined;setPendingAction\(undefined\);[\s\S]*?unavailable\.current=false;setRecoveryOnly\(false\);\s*void refresh\(\)/);
});

test("queue sign-out and auth loss clear all tab-scoped support drafts", () => {
  const source = readFileSync(new URL("../components/support-chat-queue.tsx", import.meta.url), "utf8");
  assert.match(source, /clearSupportAttemptStorage\(window\.sessionStorage\)/);
});

test("starting a new local support session cannot inherit an earlier staff draft", () => {
  const source = readFileSync(new URL("../app/support-sign-in/page.tsx", import.meta.url), "utf8");
  assert.match(source, /clearSupportAttemptStorage\(window\.sessionStorage\)/);
});

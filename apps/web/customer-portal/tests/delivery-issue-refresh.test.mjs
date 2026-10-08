import assert from "node:assert/strict";
import { test } from "node:test";

import { DeliveryIssueApiError } from "../components/delivery-issue-api.ts";
import { createDeliveryIssueRefreshController, showDeliveryIssueHistoryReport } from "../components/delivery-issue-refresh.ts";

const key = "cso.delivery-issue.report-id";
const received = {
  reportId: "report-123", status: "RECEIVED", category: "DAMAGED",
  orderReference: "ORDER1234", createdAt: "2026-10-02T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
};
const acknowledged = { ...received, status: "ACKNOWLEDGED", updatedAt: "2026-10-02T12:05:00.000Z" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const values = new Map([[key, received.reportId]]);
  const requests = [];
  let snapshot;
  const controller = createDeliveryIssueRefreshController({
    load: (id) => {
      assert.equal(id, received.reportId);
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    storage: {
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => values.set(name, value),
      removeItem: (name) => values.delete(name),
    },
    storageKey: key,
    onChange: (value) => { snapshot = value; },
  });
  controller.restore();
  return { controller, requests, values, get snapshot() { return snapshot; } };
}

test("older poll cannot regress a newer acknowledged status", async () => {
  const state = harness();
  const older = state.controller.refresh();
  const newer = state.controller.refresh();
  state.requests[1].resolve(acknowledged);
  await newer;
  state.requests[0].resolve(received);
  await older;

  assert.equal(state.snapshot.report?.status, "ACKNOWLEDGED");
  assert.equal(state.snapshot.isRefreshing, false);
  assert.equal(state.values.get(key), received.reportId);
});

test("older unauthorized poll cannot erase a newer successful receipt", async () => {
  const state = harness();
  const older = state.controller.refresh();
  const newer = state.controller.refresh();
  state.requests[1].resolve(acknowledged);
  await newer;
  state.requests[0].reject(new DeliveryIssueApiError("Sign in", 401));
  await older;

  assert.equal(state.snapshot.report?.status, "ACKNOWLEDGED");
  assert.equal(state.values.get(key), received.reportId);
});

for (const status of [401, 403, 404]) {
  test(`current ${status} poll removes the inaccessible receipt and stored report ID`, async () => {
    const state = harness();
    state.controller.confirm(received);
    const refresh = state.controller.refresh();
    state.requests[0].reject(new DeliveryIssueApiError("Report unavailable", status));
    await refresh;

    assert.equal(state.snapshot.report, undefined);
    assert.equal(state.snapshot.reportId, undefined);
    assert.equal(state.snapshot.statusError, "Report unavailable");
    assert.equal(state.values.has(key), false);
  });
}

test("temporary polling failure retains a previously confirmed receipt", async () => {
  const state = harness();
  state.controller.confirm(received);
  const refresh = state.controller.refresh();
  state.requests[0].reject(new DeliveryIssueApiError("Try again", 503));
  await refresh;

  assert.equal(state.snapshot.report?.status, "RECEIVED");
  assert.equal(state.snapshot.reportId, received.reportId);
  assert.equal(state.snapshot.statusError, "Try again");
  assert.equal(state.values.get(key), received.reportId);
});

test("a confirmed submission invalidates an already running poll for the same report", async () => {
  const state = harness();
  const refresh = state.controller.refresh();
  state.controller.confirm(acknowledged);
  state.requests[0].resolve(received);
  await refresh;

  assert.equal(state.snapshot.report?.status, "ACKNOWLEDGED");
});

test("authentication loss during refresh clears both report state and pending attempt", async () => {
  const values = new Map([[key, "report-1"], ["pending", "sensitive-attempt"]]);
  const storage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => { values.set(name, value); },
    removeItem: (name) => { values.delete(name); },
  };
  const changes = [];
  const controller = createDeliveryIssueRefreshController({
    load: async () => { throw new DeliveryIssueApiError("Sign in", 401); },
    storage, storageKey: key,
    onChange: (state) => { changes.push(state); },
    onAuthenticationLost: () => { storage.removeItem("pending"); },
  });
  controller.restore();
  await controller.refresh();
  assert.equal(values.has(key), false);
  assert.equal(values.has("pending"), false);
  assert.equal(changes.at(-1).report, undefined);
  controller.confirm({ reportId: "report-2", status: "RECEIVED", category: "DAMAGED",
    orderReference: "ORDER1234", createdAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z" });
  controller.clear();
  assert.equal(values.has(key), false);
  assert.equal(changes.at(-1).reportId, undefined);
});

test("selecting an existing history receipt refreshes authoritative status even for the same report ID", async () => {
  const state = harness();
  state.controller.confirm(received);
  const selection = showDeliveryIssueHistoryReport(state.controller, received);
  assert.equal(state.requests.length, 1);
  state.requests[0].resolve(acknowledged);
  await selection;
  assert.equal(state.snapshot.report?.status, "ACKNOWLEDGED");
});

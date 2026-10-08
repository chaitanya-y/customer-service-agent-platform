import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeliveryIssueHistoryController } from "../components/delivery-issue-history-controller.ts";
import { DeliveryIssueApiError } from "../components/delivery-issue-api.ts";

const history = { reports: [{ reportId: "report-1", status: "RECEIVED", category: "DAMAGED",
  orderReference: "ORDER1234", createdAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z" }], hasMore: false };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("history load has explicit loading, empty and retryable error states", async () => {
  const pending = deferred();
  const states = [];
  let load = () => pending.promise;
  const controller = createDeliveryIssueHistoryController({
    load: () => load(), onChange: (state) => states.push(state),
  });
  const first = controller.load();
  assert.equal(states.at(-1).isLoading, true);
  pending.resolve({ reports: [], hasMore: false });
  await first;
  assert.deepEqual(states.at(-1).reports, []);
  load = async () => { throw new DeliveryIssueApiError("Try again", 503); };
  await controller.load();
  assert.equal(states.at(-1).reports, undefined);
  assert.match(states.at(-1).error, /try again/i);
  load = async () => history;
  await controller.load();
  assert.equal(states.at(-1).reports[0].reportId, "report-1");
});

test("late history responses are ignored after a newer read or authentication loss", async () => {
  const oldRead = deferred();
  const newerRead = deferred();
  const queue = [oldRead, newerRead];
  const states = [];
  let authLost = 0;
  const controller = createDeliveryIssueHistoryController({
    load: () => queue.shift().promise, onChange: (state) => states.push(state),
    onAuthenticationLost: () => { authLost += 1; },
  });
  const first = controller.load();
  const second = controller.load();
  newerRead.resolve(history);
  await second;
  oldRead.resolve({ reports: [], hasMore: false });
  await first;
  assert.equal(states.at(-1).reports[0].reportId, "report-1");
  const unauthorized = deferred();
  queue.push(unauthorized);
  const third = controller.load();
  unauthorized.reject(new DeliveryIssueApiError("Sign in", 401));
  await third;
  assert.equal(authLost, 1);
  assert.equal(states.at(-1).reports, undefined);
  controller.clear();
  assert.equal(states.at(-1).error, undefined);
});

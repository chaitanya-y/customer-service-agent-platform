import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nextDeliveryTransitionAttempt,
  parseDeliveryTransitionAttempt,
  reconcileDeliveryDetail,
  transitionIsResolved,
} from "../components/delivery-report-detail-state.ts";

const received = { reportId: "report-1", status: "RECEIVED", version: 1 };
const claimed = { ...received, status: "CLAIMED", version: 2 };
const acknowledged = { ...received, status: "ACKNOWLEDGED", version: 3 };
const closed = { ...received, status: "REVIEW_CLOSED", version: 4 };
const detail = (report, eventIds = []) => ({ report, auditEvents: eventIds.map((eventId) => ({ eventId })) });

test("an uncertain claim retries the original key and expected version, including after storage round-trip", () => {
  const first = nextDeliveryTransitionAttempt(undefined, received, "claim", "first-uuid-key");
  const restored = parseDeliveryTransitionAttempt(JSON.stringify(first), received.reportId);
  assert.deepEqual(nextDeliveryTransitionAttempt(restored, received, "claim", "second-uuid-key"), first);
  assert.deepEqual(first, { reportId: "report-1", action: "claim", expectedVersion: 1, idempotencyKey: "first-uuid-key" });
});

test("an uncertain acknowledgment also retains its original action identity", () => {
  const first = nextDeliveryTransitionAttempt(undefined, claimed, "acknowledge", "first-ack-key");
  const restored = parseDeliveryTransitionAttempt(JSON.stringify(first), claimed.reportId);
  assert.deepEqual(nextDeliveryTransitionAttempt(restored, claimed, "acknowledge", "second-ack-key"), {
    reportId: "report-1", action: "acknowledge", expectedVersion: 2, idempotencyKey: "first-ack-key",
  });
});

test("an uncertain close retries its original version and key after storage round-trip", () => {
  const first = nextDeliveryTransitionAttempt(undefined, acknowledged, "close", "first-close-key");
  const restored = parseDeliveryTransitionAttempt(JSON.stringify(first), acknowledged.reportId);
  assert.deepEqual(nextDeliveryTransitionAttempt(restored, acknowledged, "close", "second-close-key"), {
    reportId: "report-1", action: "close", expectedVersion: 3, idempotencyKey: "first-close-key",
  });
});

test("a different report, action, or version never inherits a pending transition", () => {
  const pending = nextDeliveryTransitionAttempt(undefined, received, "claim", "first-uuid-key");
  assert.equal(nextDeliveryTransitionAttempt(pending, { ...received, reportId: "report-2" }, "claim", "other-key").idempotencyKey, "other-key");
  assert.equal(nextDeliveryTransitionAttempt(pending, received, "acknowledge", "ack-key").idempotencyKey, "ack-key");
  assert.equal(nextDeliveryTransitionAttempt(pending, claimed, "claim", "new-key").idempotencyKey, "new-key");
  assert.equal(parseDeliveryTransitionAttempt(JSON.stringify(pending), "report-2"), undefined);
  assert.equal(parseDeliveryTransitionAttempt('{"reportId":"report-1","action":"claim","expectedVersion":1,"idempotencyKey":"bad key"}', "report-1"), undefined);
});

test("authoritative progress resolves only the pending transition for that report", () => {
  const claim = nextDeliveryTransitionAttempt(undefined, received, "claim", "first-uuid-key");
  const ack = nextDeliveryTransitionAttempt(undefined, claimed, "acknowledge", "ack-uuid-key");
  assert.equal(transitionIsResolved(claim, received), false);
  assert.equal(transitionIsResolved(claim, claimed), true);
  assert.equal(transitionIsResolved(claim, acknowledged), true);
  assert.equal(transitionIsResolved(ack, claimed), false);
  assert.equal(transitionIsResolved(ack, acknowledged), true);
  assert.equal(transitionIsResolved(claim, closed), true);
  assert.equal(transitionIsResolved(ack, closed), true);
  const close = nextDeliveryTransitionAttempt(undefined, acknowledged, "close", "close-uuid-key");
  assert.equal(transitionIsResolved(close, acknowledged), false);
  assert.equal(transitionIsResolved(close, closed), true);
  assert.equal(transitionIsResolved(claim, { ...claimed, reportId: "report-2" }), false);
});

test("out-of-order refreshes cannot replace a newer mutation or later refresh", () => {
  const firstGet = 1;
  const secondGet = 2;
  const mutation = 3;
  let current = reconcileDeliveryDetail(undefined, detail(received, ["received"]), secondGet);
  current = reconcileDeliveryDetail(current, detail(received, ["old"]), firstGet);
  assert.deepEqual(current.detail.auditEvents.map((event) => event.eventId), ["received"]);

  current = reconcileDeliveryDetail(current, detail(claimed, ["received", "claimed"]), mutation);
  current = reconcileDeliveryDetail(current, detail(received, ["received"]), secondGet);
  assert.equal(current.detail.report.status, "CLAIMED");
  assert.equal(current.detail.report.version, 2);
  assert.deepEqual(current.detail.auditEvents.map((event) => event.eventId), ["received", "claimed"]);

  current = reconcileDeliveryDetail(current, detail(acknowledged, ["received", "claimed", "acknowledged"]), firstGet);
  assert.equal(current.detail.report.status, "ACKNOWLEDGED");
  assert.equal(current.detail.report.version, 3);
});

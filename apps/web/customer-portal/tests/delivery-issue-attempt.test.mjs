import assert from "node:assert/strict";
import { test } from "node:test";

import { nextDeliveryIssueAttempt, parseDeliveryIssueAttempt } from "../components/delivery-issue-api.ts";

const firstKey = "11111111-1111-4111-8111-111111111111";
const secondKey = "22222222-2222-4222-8222-222222222222";
const thirdKey = "33333333-3333-4333-8333-333333333333";
const fourthKey = "44444444-4444-4444-8444-444444444444";
const conversationId = "55555555-5555-4555-8555-555555555555";

test("an uncertain attempt retains both keys and conversation for the same input", () => {
  const keys = [firstKey, secondKey];
  const first = nextDeliveryIssueAttempt(undefined, "ORDER1234", "DAMAGED", () => keys.shift());
  const pending = { ...first, conversationId };
  const retry = nextDeliveryIssueAttempt(pending, "ORDER1234", "DAMAGED", () => secondKey);
  assert.deepEqual(retry, pending);
  assert.equal(retry.conversationCreateKey, firstKey);
  assert.equal(retry.reportKey, secondKey);
});

test("changing category or reference creates a new attempt and keys", () => {
  const firstKeys = [firstKey, secondKey];
  const existing = nextDeliveryIssueAttempt(undefined, "ORDER1234", "DAMAGED", () => firstKeys.shift());
  const values = [thirdKey, fourthKey];
  const changed = nextDeliveryIssueAttempt(existing, "ORDER1234", "WRONG", () => values.shift());
  assert.notEqual(changed.reportKey, existing.reportKey);
  assert.notEqual(changed.conversationCreateKey, existing.conversationCreateKey);
  assert.equal(changed.conversationId, undefined);
});

test("stored retry attempt restores only valid inputs, keys, and conversation IDs", () => {
  const attempt = {
    orderReference: "ORDER1234", category: "DAMAGED",
    conversationCreateKey: firstKey, reportKey: secondKey,
    conversationId,
  };
  assert.deepEqual(parseDeliveryIssueAttempt(JSON.stringify(attempt)), attempt);
  for (const invalid of ["not json", "{}", JSON.stringify({ ...attempt, category: "OTHER" }),
    JSON.stringify({ ...attempt, reportKey: "bad" }), JSON.stringify({ ...attempt, orderReference: "../order" })]) {
    assert.equal(parseDeliveryIssueAttempt(invalid), undefined);
  }
});

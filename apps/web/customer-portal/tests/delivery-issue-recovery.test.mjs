import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { recoverDeliveryIssueReport } from "../components/delivery-issue-api.ts";

const attempt = {
  orderReference: "ORDER1234", category: "DAMAGED",
  conversationCreateKey: "11111111-1111-4111-8111-111111111111",
  reportKey: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
};
const report = { reportId: "report-1", status: "ACKNOWLEDGED", category: "DAMAGED",
  orderReference: "ORDER1234", createdAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T13:00:00.000Z" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("lost create response is recovered by replay without conversation read or second create", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ delivery_issue_report: {
      report_id: report.reportId, status: report.status, category: report.category,
      order_reference: report.orderReference, created_at: report.createdAt, updated_at: report.updatedAt,
    } });
  };
  const result = await recoverDeliveryIssueReport(attempt, async () => { throw new Error("conversation must not load"); });
  assert.deepEqual(result, report);
  assert.deepEqual(calls.map((call) => call.url), [
    `/api/conversations/${attempt.conversationId}/delivery-issue-reports/replay`,
  ]);
  assert.equal(calls[0].init.headers["idempotency-key"], attempt.reportKey);
});

test("known missing receipt can create only after a fresh OPEN conversation check with the same key", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/replay")) return Response.json({ error: { code: "delivery_report_not_found" } }, { status: 404 });
    if (url === `/api/conversations/${attempt.conversationId}`) return Response.json({ data: {
      conversation_id: attempt.conversationId, status: "OPEN", control_mode: "AI", control_version: 1,
      messages: [],
    } });
    return Response.json({ delivery_issue_report: {
      report_id: report.reportId, status: "RECEIVED", category: report.category,
      order_reference: report.orderReference, created_at: report.createdAt, updated_at: report.updatedAt,
    } }, { status: 201 });
  };
  const result = await recoverDeliveryIssueReport(attempt, async (conversationId) => {
    calls.push({ url: `/api/conversations/${conversationId}` });
    return { status: "OPEN" };
  });
  assert.equal(result.status, "RECEIVED");
  assert.deepEqual(calls.map((call) => call.url), [
    `/api/conversations/${attempt.conversationId}/delivery-issue-reports/replay`,
    `/api/conversations/${attempt.conversationId}`,
    `/api/conversations/${attempt.conversationId}/delivery-issue-reports`,
  ]);
  assert.equal(calls[2].init.headers["idempotency-key"], attempt.reportKey);
});

test("closed conversation or transient replay failure never reaches create", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/replay")) return Response.json({ error: { code: "delivery_report_not_found" } }, { status: 404 });
    throw new Error("create must not run");
  };
  await assert.rejects(recoverDeliveryIssueReport(attempt, async (conversationId) => {
    calls.push({ url: `/api/conversations/${conversationId}` });
    return { status: "CLOSED" };
  }), /closed/i);
  assert.equal(calls.length, 2);
  calls.length = 0;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); throw new Error("network failed"); };
  await assert.rejects(recoverDeliveryIssueReport(attempt, async () => { throw new Error("conversation must not load"); }), /confirm receipt/i);
  assert.equal(calls.length, 1);
});

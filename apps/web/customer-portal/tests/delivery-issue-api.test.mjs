import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  createDeliveryIssueReport,
  deliveryIssueStatusMessage,
  loadDeliveryIssueReport,
  normalizeDeliveryIssueReport,
  normalizeOrderReference,
  replayDeliveryIssueReport,
  loadDeliveryIssueHistory,
  normalizeDeliveryIssueHistory,
} from "../components/delivery-issue-api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reportKey = "11111111-1111-4111-8111-111111111111";

const report = {
  report_id: "report-123",
  status: "RECEIVED",
  category: "DAMAGED",
  order_reference: "ORDER1234",
  created_at: "2026-10-02T12:00:00.000Z",
  updated_at: "2026-10-02T12:00:00.000Z",
};

test("projects only safe delivery report fields and approved status wording", () => {
  const normalized = normalizeDeliveryIssueReport({
    delivery_issue_report: { ...report, private_note: "internal details", staff_id: "staff-1" },
  });
  assert.deepEqual(normalized, {
    reportId: "report-123", status: "RECEIVED", category: "DAMAGED",
    orderReference: "ORDER1234", createdAt: report.created_at,
    updatedAt: report.updated_at,
  });
  assert.equal(deliveryIssueStatusMessage("RECEIVED"), "We received your delivery issue report. A specialist will review it.");
  assert.equal(deliveryIssueStatusMessage("CLAIMED"), "A specialist is reviewing your delivery issue report.");
  assert.equal(deliveryIssueStatusMessage("ACKNOWLEDGED"), "A specialist has acknowledged your report. We have not confirmed a resolution yet.");
  const closed = normalizeDeliveryIssueReport({ delivery_issue_report: { ...report, status: "REVIEW_CLOSED" } });
  assert.equal(closed.status, "REVIEW_CLOSED");
  assert.equal(deliveryIssueStatusMessage("REVIEW_CLOSED"),
    "A specialist completed the review of your report. This does not confirm the delivery issue was fixed or that a remedy was provided. If you still need help, contact support.");
  assert.equal(normalizeDeliveryIssueHistory({ delivery_issue_reports: [{ ...report, status: "REVIEW_CLOSED" }],
    has_more: false }).reports[0].status, "REVIEW_CLOSED");
});

test("rejects malformed or unknown status instead of claiming receipt", () => {
  for (const invalid of [
    {},
    { delivery_issue_report: { ...report, status: "RESOLVED" } },
    { delivery_issue_report: { ...report, report_id: "../other" } },
    { delivery_issue_report: { ...report, order_reference: "" } },
    { delivery_issue_report: { ...report, created_at: "not a date" } },
  ]) assert.throws(() => normalizeDeliveryIssueReport(invalid), /not valid/);
});

test("normalizes owned order reference syntax without accepting extra fields", () => {
  assert.equal(normalizeOrderReference("  ORDER1234  "), "ORDER1234");
  assert.equal(normalizeOrderReference("ORDER.REF_1:WEST"), "ORDER.REF_1:WEST");
  for (const value of ["", "ORDER 1234", "ORDER/1234", "X".repeat(101)]) {
    assert.equal(normalizeOrderReference(value), undefined);
  }
});

test("create posts a strict body and given idempotency key to same-origin BFF", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ delivery_issue_report: report }, { status: 201 });
  };

  const result = await createDeliveryIssueReport({
    conversationId: "conversation-123", orderReference: "ORDER1234",
    category: "DAMAGED", idempotencyKey: reportKey,
  });

  assert.equal(result.reportId, "report-123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/conversations/conversation-123/delivery-issue-reports");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["idempotency-key"], reportKey);
  assert.deepEqual(JSON.parse(calls[0].init.body), { order_reference: "ORDER1234", category: "DAMAGED" });
});

test("uncertain create response never confirms receipt; same caller key is reused on retry", async () => {
  const keys = [];
  let attempt = 0;
  globalThis.fetch = async (_url, init) => {
    keys.push(init.headers["idempotency-key"]);
    attempt += 1;
    return attempt === 1
      ? Response.json({ error: { code: "delivery_report_receipt_unconfirmed" } }, { status: 503 })
      : Response.json({ delivery_issue_report: report }, { status: 200 });
  };
  const input = { conversationId: "conversation-123", orderReference: "ORDER1234", category: "DAMAGED", idempotencyKey: reportKey };

  await assert.rejects(createDeliveryIssueReport(input), /could not confirm receipt/i);
  const result = await createDeliveryIssueReport(input);
  assert.equal(result.reportId, "report-123");
  assert.deepEqual(keys, [reportKey, reportKey]);
});

test("create rejects 202 and malformed or mismatched success payloads", async () => {
  for (const [status, payload] of [
    [202, { delivery_issue_report: report }],
    [201, {}],
    [201, { delivery_issue_report: { ...report, order_reference: "DIFFERENT" } }],
  ]) {
    globalThis.fetch = async () => Response.json(payload, { status });
    await assert.rejects(createDeliveryIssueReport({
      conversationId: "conversation-123", orderReference: "ORDER1234",
      category: "DAMAGED", idempotencyKey: reportKey,
    }), /could not confirm receipt/i);
  }
});

test("status load uses owner-scoped BFF and validates its safe projection", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ delivery_issue_report: { ...report, status: "ACKNOWLEDGED" } });
  };
  const result = await loadDeliveryIssueReport("report-123");
  assert.equal(result.status, "ACKNOWLEDGED");
  assert.deepEqual(calls, [{ url: "/api/delivery-issue-reports/report-123", init: { cache: "no-store" } }]);
});

test("replay posts exact original body and key and accepts current report status", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ delivery_issue_report: { ...report, status: "ACKNOWLEDGED" } });
  };
  const result = await replayDeliveryIssueReport({
    conversationId: "conversation-123", orderReference: "ORDER1234",
    category: "DAMAGED", idempotencyKey: reportKey,
  });
  assert.equal(result.kind, "found");
  assert.equal(result.report.status, "ACKNOWLEDGED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/conversations/conversation-123/delivery-issue-reports/replay");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.headers["idempotency-key"], reportKey);
  assert.deepEqual(JSON.parse(calls[0].init.body), { order_reference: "ORDER1234", category: "DAMAGED" });
});

test("only a named missing receipt permits create after replay; malformed and transient responses remain uncertain", async () => {
  const input = { conversationId: "conversation-123", orderReference: "ORDER1234", category: "DAMAGED", idempotencyKey: reportKey };
  globalThis.fetch = async () => Response.json({ error: { code: "delivery_report_not_found" } }, { status: 404 });
  assert.deepEqual(await replayDeliveryIssueReport(input), { kind: "not_found" });
  for (const response of [
    Response.json({ error: { code: "conversation_not_found" } }, { status: 404 }),
    Response.json({ error: { code: "delivery_report_unavailable" } }, { status: 503 }),
    Response.json({ delivery_issue_report: { ...report, category: "WRONG" } }),
    Response.json({ delivery_issue_report: report }, { status: 201 }),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(replayDeliveryIssueReport(input));
  }
});

test("history accepts at most ten safe receipts in updated order and never sends filters", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({
    delivery_issue_reports: [
      { ...report, report_id: "report-new", updated_at: "2026-10-02T13:00:00.000Z" },
      report,
    ], has_more: false,
  }); };
  const history = await loadDeliveryIssueHistory();
  assert.equal(history.reports.length, 2);
  assert.equal(history.reports[0].reportId, "report-new");
  assert.equal(history.hasMore, false);
  assert.deepEqual(calls, [{ url: "/api/delivery-issue-reports", init: { method: "GET", cache: "no-store" } }]);
});

test("history fails closed on private fields, duplicate IDs, bad ordering, excess rows and conflicting has_more", () => {
  for (const payload of [
    { delivery_issue_reports: [report], has_more: false, private_note: "private" },
    { delivery_issue_reports: [{ ...report, staff_id: "staff-1" }], has_more: false },
    { delivery_issue_reports: [report, report], has_more: false },
    { delivery_issue_reports: [report, { ...report, report_id: "report-new", updated_at: "2026-10-02T13:00:00.000Z" }], has_more: false },
    { delivery_issue_reports: [report], has_more: true },
    { delivery_issue_reports: Array.from({ length: 11 }, (_, index) => ({ ...report, report_id: `report-${index}` })), has_more: false },
    { delivery_issue_reports: [{ ...report, status: "RESOLVED" }], has_more: false },
    { delivery_issue_reports: [{ ...report, updated_at: "Oct 2 2026" }], has_more: false },
  ]) assert.throws(() => normalizeDeliveryIssueHistory(payload), /not valid/i);
});

test("history does not retain a stale list on authentication or transient failure", async () => {
  globalThis.fetch = async () => Response.json({ error: { code: "customer_unauthorized" } }, { status: 401 });
  await assert.rejects(loadDeliveryIssueHistory(), (error) => error.status === 401);
  globalThis.fetch = async () => Response.json({ error: { code: "down" } }, { status: 503 });
  await assert.rejects(loadDeliveryIssueHistory(), /try again/i);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deliveryReportPath,
  deliveryReportQuery,
  parseDeliveryTransition,
  normalizeDeliveryReport,
  normalizeDeliveryReportDetail,
  normalizeDeliveryReportList,
} from "../components/delivery-report.ts";

const report = {
  report_id: "report-1", status: "RECEIVED", category: "DAMAGED",
  order_reference: "ORDER1234", version: 1,
  created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-02T12:00:00Z",
};

test("delivery list and detail accept the staff report contract", () => {
  assert.deepEqual(normalizeDeliveryReportList({ delivery_issue_reports: [report] }), [{
    reportId: "report-1", status: "RECEIVED", category: "DAMAGED",
    orderReference: "ORDER1234", version: 1, assignedStaffId: undefined,
    createdAt: report.created_at, updatedAt: report.updated_at,
    claimedAt: undefined, acknowledgedAt: undefined, closedAt: undefined, canCloseReview: false,
  }]);
  assert.equal(normalizeDeliveryReportDetail({ delivery_issue_report: report, audit_events: [] }).report.reportId, "report-1");
});

test("invalid delivery responses fail closed", () => {
  assert.throws(() => normalizeDeliveryReport({ ...report, status: "REFUND_APPROVED" }));
  assert.throws(() => normalizeDeliveryReportList({ refund_cases: [report] }));
  assert.throws(() => normalizeDeliveryReportDetail({ delivery_issue_report: report, audit_events: "invalid" }));
});

test("closed staff detail preserves close time, audit event, and only an explicit close capability", () => {
  const closed = { ...report, status: "REVIEW_CLOSED", version: 4, assigned_staff_id: "staff-a",
    claimed_at: report.created_at, acknowledged_at: report.created_at, closed_at: report.updated_at };
  const event = { event_id: "event-close", event_type: "REPORT_REVIEW_CLOSED", occurred_at: report.updated_at,
    actor_type: "HUMAN", actor_id: "staff-a", report_version: 4 };
  const detail = normalizeDeliveryReportDetail({ delivery_issue_report: closed, audit_events: [event] });
  assert.equal(detail.report.closedAt, report.updated_at);
  assert.equal(detail.report.canCloseReview, false);
  assert.equal(detail.auditEvents[0].eventType, "REPORT_REVIEW_CLOSED");
  assert.equal(normalizeDeliveryReportDetail({ delivery_issue_report: { ...closed, status: "ACKNOWLEDGED" },
    audit_events: [], can_close_review: true }).report.canCloseReview, true);
  assert.equal(normalizeDeliveryReportDetail({ delivery_issue_report: { ...closed, status: "ACKNOWLEDGED" },
    audit_events: [], can_close_review: "true" }).report.canCloseReview, false);
  assert.equal(normalizeDeliveryReportDetail({ delivery_issue_report: closed,
    audit_events: [], can_close_review: true }).report.canCloseReview, false);
});

test("delivery proxy paths cannot address refund routes or inject path segments", () => {
  assert.equal(deliveryReportPath("list"), "/v1/delivery-issue-reports");
  assert.equal(deliveryReportPath("claim", "report-1"), "/v1/delivery-issue-reports/report-1/claim");
  assert.equal(deliveryReportPath("close", "report-1"), "/v1/delivery-issue-reports/report-1/close");
  assert.throws(() => deliveryReportPath("claim", "../refund-cases"));
  assert.throws(() => deliveryReportPath("refund", "report-1"));
});

test("delivery list filters are constrained to the staff contract", () => {
  assert.equal(deliveryReportQuery(new URLSearchParams("status=RECEIVED&assignee=unassigned&limit=25")), "?status=RECEIVED&assignee=unassigned&limit=25");
  assert.throws(() => deliveryReportQuery(new URLSearchParams("path=/v1/refund-cases")));
  assert.throws(() => deliveryReportQuery(new URLSearchParams("limit=500")));
  assert.equal(deliveryReportQuery(new URLSearchParams("status=REVIEW_CLOSED")), "?status=REVIEW_CLOSED");
});

test("delivery transitions require only a positive expected version", () => {
  assert.deepEqual(parseDeliveryTransition({ expected_version: 2 }), { expected_version: 2 });
  assert.throws(() => parseDeliveryTransition({ expected_version: 2, decision: "APPROVE" }));
  assert.throws(() => parseDeliveryTransition({ expected_version: 0 }));
});

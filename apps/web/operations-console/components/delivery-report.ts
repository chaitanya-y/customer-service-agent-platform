export type DeliveryReportStatus = "RECEIVED" | "CLAIMED" | "ACKNOWLEDGED" | "REVIEW_CLOSED";
export type DeliveryReportCategory = "MISSING" | "WRONG" | "DAMAGED" | "DELAYED";

export type DeliveryReport = Readonly<{
  reportId: string;
  status: DeliveryReportStatus;
  category: DeliveryReportCategory;
  orderReference: string;
  version: number;
  assignedStaffId?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  acknowledgedAt?: string;
  closedAt?: string;
  canCloseReview: boolean;
}>;

export type DeliveryAuditEvent = Readonly<{
  eventId: string;
  eventType: "REPORT_RECEIVED" | "REPORT_CLAIMED" | "REPORT_ACKNOWLEDGED" | "REPORT_REVIEW_CLOSED";
  occurredAt: string;
  actorType: "CUSTOMER" | "HUMAN";
  actorId: string;
  reportVersion: number;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Human Operations returned an invalid delivery report.");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Human Operations returned an invalid delivery report.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value);
}

export function normalizeDeliveryReport(value: unknown): DeliveryReport {
  const raw = record(value);
  if (!["RECEIVED", "CLAIMED", "ACKNOWLEDGED", "REVIEW_CLOSED"].includes(raw.status as string) ||
      !["MISSING", "WRONG", "DAMAGED", "DELAYED"].includes(raw.category as string) ||
      !Number.isSafeInteger(raw.version) || (raw.version as number) < 1) {
    throw new Error("Human Operations returned an invalid delivery report.");
  }
  return {
    reportId: string(raw.report_id), status: raw.status as DeliveryReportStatus,
    category: raw.category as DeliveryReportCategory, orderReference: string(raw.order_reference),
    version: raw.version as number, assignedStaffId: optionalString(raw.assigned_staff_id),
    createdAt: string(raw.created_at), updatedAt: string(raw.updated_at),
    claimedAt: optionalString(raw.claimed_at), acknowledgedAt: optionalString(raw.acknowledged_at),
    closedAt: optionalString(raw.closed_at), canCloseReview: false,
  };
}

export function normalizeDeliveryReportList(value: unknown): DeliveryReport[] {
  const raw = record(value);
  if (!Array.isArray(raw.delivery_issue_reports)) throw new Error("Human Operations returned an invalid delivery report list.");
  return raw.delivery_issue_reports.map(normalizeDeliveryReport);
}

export function normalizeDeliveryReportDetail(value: unknown): { report: DeliveryReport; auditEvents: DeliveryAuditEvent[] } {
  const raw = record(value);
  if (!Array.isArray(raw.audit_events)) throw new Error("Human Operations returned an invalid delivery report detail.");
  const report = normalizeDeliveryReport(raw.delivery_issue_report);
  return {
    report: { ...report, canCloseReview: raw.can_close_review === true && report.status === "ACKNOWLEDGED" },
    auditEvents: raw.audit_events.map((value: unknown) => {
      const event = record(value);
      if (!["REPORT_RECEIVED", "REPORT_CLAIMED", "REPORT_ACKNOWLEDGED", "REPORT_REVIEW_CLOSED"].includes(event.event_type as string) ||
          !["CUSTOMER", "HUMAN"].includes(event.actor_type as string) ||
          !Number.isSafeInteger(event.report_version) || (event.report_version as number) < 1) {
        throw new Error("Human Operations returned an invalid delivery audit event.");
      }
      return {
        eventId: string(event.event_id), eventType: event.event_type as DeliveryAuditEvent["eventType"],
        occurredAt: string(event.occurred_at), actorType: event.actor_type as DeliveryAuditEvent["actorType"],
        actorId: string(event.actor_id), reportVersion: event.report_version as number,
      };
    }),
  };
}

export function deliveryReportPath(action: "list" | "detail" | "claim" | "acknowledge" | "close", reportId?: string): string {
  const base = "/v1/delivery-issue-reports";
  if (action === "list") return base;
  if (!reportId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(reportId) || reportId === "." || reportId === "..") {
    throw new Error("Invalid delivery report ID.");
  }
  const path = `${base}/${encodeURIComponent(reportId)}`;
  if (action === "detail") return path;
  if (action === "claim" || action === "acknowledge" || action === "close") return `${path}/${action}`;
  throw new Error("Invalid delivery report action.");
}

export function deliveryReportQuery(params: URLSearchParams): string {
  const values = [...params.entries()];
  if (values.some(([name]) => !["status", "assignee", "limit"].includes(name)) || new Set(values.map(([name]) => name)).size !== values.length) {
    throw new Error("Invalid delivery report filters.");
  }
  const status = params.get("status");
  const assignee = params.get("assignee");
  const limit = params.get("limit");
  if ((status !== null && !["RECEIVED", "CLAIMED", "ACKNOWLEDGED", "REVIEW_CLOSED"].includes(status)) ||
      (assignee !== null && !["me", "unassigned"].includes(assignee)) ||
      (limit !== null && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100))) {
    throw new Error("Invalid delivery report filters.");
  }
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (assignee) query.set("assignee", assignee);
  if (limit) query.set("limit", limit);
  return query.size ? `?${query.toString()}` : "";
}

export function parseDeliveryTransition(value: unknown): { expected_version: number } {
  const raw = record(value);
  if (Object.keys(raw).length !== 1 || !Number.isSafeInteger(raw.expected_version) || (raw.expected_version as number) < 1) {
    throw new Error("Invalid delivery report transition.");
  }
  return { expected_version: raw.expected_version as number };
}

export function formatDeliveryDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

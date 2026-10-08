export type DeliveryIssueCategory = "MISSING" | "WRONG" | "DAMAGED" | "DELAYED";
export type DeliveryIssueStatus = "RECEIVED" | "CLAIMED" | "ACKNOWLEDGED" | "REVIEW_CLOSED";

export type DeliveryIssueReport = Readonly<{
  reportId: string;
  status: DeliveryIssueStatus;
  category: DeliveryIssueCategory;
  orderReference: string;
  createdAt: string;
  updatedAt: string;
}>;

export type DeliveryIssueHistory = Readonly<{
  reports: readonly DeliveryIssueReport[];
  hasMore: boolean;
}>;

export type DeliveryIssueAttempt = Readonly<{
  orderReference: string;
  category: DeliveryIssueCategory;
  conversationCreateKey: string;
  reportKey: string;
  conversationId?: string;
}>;

type UnknownRecord = Record<string, unknown>;

const orderReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const reportIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const statusMessages: Record<DeliveryIssueStatus, string> = {
  RECEIVED: "We received your delivery issue report. A specialist will review it.",
  CLAIMED: "A specialist is reviewing your delivery issue report.",
  ACKNOWLEDGED: "A specialist has acknowledged your report. We have not confirmed a resolution yet.",
  REVIEW_CLOSED: "A specialist completed the review of your report. This does not confirm the delivery issue was fixed or that a remedy was provided. If you still need help, contact support.",
};

export class DeliveryIssueApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DeliveryIssueApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCategory(value: unknown): value is DeliveryIssueCategory {
  return value === "MISSING" || value === "WRONG" || value === "DAMAGED" || value === "DELAYED";
}

function isStatus(value: unknown): value is DeliveryIssueStatus {
  return value === "RECEIVED" || value === "CLAIMED" || value === "ACKNOWLEDGED" || value === "REVIEW_CLOSED";
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && !Number.isNaN(Date.parse(value));
}

function isStrictIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10);
}

export function normalizeOrderReference(value: string): string | undefined {
  const reference = value.trim();
  return reference.length <= 100 && orderReferencePattern.test(reference) ? reference : undefined;
}

export function nextDeliveryIssueAttempt(
  previous: DeliveryIssueAttempt | undefined,
  orderReference: string,
  category: DeliveryIssueCategory,
  createKey: () => string = () => crypto.randomUUID(),
): DeliveryIssueAttempt {
  if (previous?.orderReference === orderReference && previous.category === category) return previous;
  return {
    orderReference,
    category,
    conversationCreateKey: createKey(),
    reportKey: createKey(),
  };
}

export function parseDeliveryIssueAttempt(value: string | null): DeliveryIssueAttempt | undefined {
  if (!value) return undefined;
  try {
    const attempt: unknown = JSON.parse(value);
    if (!isRecord(attempt)) return undefined;
    if (typeof attempt.orderReference !== "string"
      || normalizeOrderReference(attempt.orderReference) !== attempt.orderReference
      || !isCategory(attempt.category)
      || typeof attempt.conversationCreateKey !== "string"
      || !uuidPattern.test(attempt.conversationCreateKey)
      || typeof attempt.reportKey !== "string"
      || !uuidPattern.test(attempt.reportKey)
      || (attempt.conversationId !== undefined
        && (typeof attempt.conversationId !== "string" || !uuidPattern.test(attempt.conversationId)))) return undefined;
    return {
      orderReference: attempt.orderReference,
      category: attempt.category,
      conversationCreateKey: attempt.conversationCreateKey,
      reportKey: attempt.reportKey,
      ...(attempt.conversationId ? { conversationId: attempt.conversationId } : {}),
    };
  } catch {
    return undefined;
  }
}

export function deliveryIssueStatusMessage(status: DeliveryIssueStatus): string {
  return statusMessages[status];
}

export function normalizeDeliveryIssueReport(payload: unknown): DeliveryIssueReport {
  const report = isRecord(payload) && isRecord(payload.delivery_issue_report)
    ? payload.delivery_issue_report : undefined;
  if (!report
    || typeof report.report_id !== "string"
    || report.report_id.length > 160
    || !reportIdPattern.test(report.report_id)
    || !isStatus(report.status)
    || !isCategory(report.category)
    || typeof report.order_reference !== "string"
    || normalizeOrderReference(report.order_reference) !== report.order_reference
    || !isDateTime(report.created_at)
    || !isDateTime(report.updated_at)) {
    throw new DeliveryIssueApiError("The delivery issue report response was not valid.");
  }
  return {
    reportId: report.report_id,
    status: report.status,
    category: report.category,
    orderReference: report.order_reference,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
  };
}

export function normalizeDeliveryIssueHistory(payload: unknown): DeliveryIssueHistory {
  const invalid = () => new DeliveryIssueApiError("The delivery issue report history response was not valid.", 503);
  if (!isRecord(payload) || Object.keys(payload).length !== 2 ||
      !Array.isArray(payload.delivery_issue_reports) || payload.delivery_issue_reports.length > 10 ||
      typeof payload.has_more !== "boolean" ||
      (payload.has_more && payload.delivery_issue_reports.length !== 10)) throw invalid();
  const seen = new Set<string>();
  const reports = payload.delivery_issue_reports.map((raw: unknown) => {
    if (!isRecord(raw) || Object.keys(raw).length !== 6 ||
        !["report_id", "status", "category", "order_reference", "created_at", "updated_at"]
          .every((key) => Object.hasOwn(raw, key))) throw invalid();
    const report = normalizeDeliveryIssueReport({ delivery_issue_report: raw });
    if (!isStrictIsoDateTime(report.createdAt) || !isStrictIsoDateTime(report.updatedAt)) throw invalid();
    if (seen.has(report.reportId)) throw invalid();
    seen.add(report.reportId);
    return report;
  });
  if (!reports.every((report, index) => {
    const previous = reports[index - 1];
    if (!previous) return true;
    const previousTime = Date.parse(previous.updatedAt);
    const currentTime = Date.parse(report.updatedAt);
    return previousTime > currentTime ||
      (previousTime === currentTime && previous.reportId.localeCompare(report.reportId) > 0);
  })) throw invalid();
  return { reports, hasMore: payload.has_more };
}

export async function loadDeliveryIssueHistory(): Promise<DeliveryIssueHistory> {
  let response: Response;
  try { response = await fetch("/api/delivery-issue-reports", { method: "GET", cache: "no-store" }); }
  catch { throw new DeliveryIssueApiError("We could not load your delivery reports. Please try again.", 503); }
  if (response.status !== 200) {
    if (response.status === 401) throw new DeliveryIssueApiError("Please sign in to view your delivery reports.", 401);
    throw new DeliveryIssueApiError("We could not load your delivery reports. Please try again.", response.status);
  }
  try { return normalizeDeliveryIssueHistory(await readJson(response)); }
  catch { throw new DeliveryIssueApiError("We could not load your delivery reports. Please try again.", 503); }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

function createError(status: number): DeliveryIssueApiError {
  if (status === 401) return new DeliveryIssueApiError("Please sign in before reporting a delivery issue.", status);
  if (status === 404) return new DeliveryIssueApiError("We could not verify that order for this account.", status);
  if (status === 409) return new DeliveryIssueApiError("This request could not be completed. Check the order and issue category before trying again.", status);
  if (status === 400) return new DeliveryIssueApiError("Check the order reference and issue category, then try again.", status);
  return new DeliveryIssueApiError("We could not confirm receipt. Please retry this report.", status);
}

export async function createDeliveryIssueReport(input: Readonly<{
  conversationId: string;
  orderReference: string;
  category: DeliveryIssueCategory;
  idempotencyKey: string;
}>): Promise<DeliveryIssueReport> {
  let response: Response;
  try {
    response = await fetch(`/api/conversations/${encodeURIComponent(input.conversationId)}/delivery-issue-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ order_reference: input.orderReference, category: input.category }),
    });
  } catch {
    throw createError(503);
  }
  if (response.status !== 201 && response.status !== 200) throw createError(response.status);
  try {
    const report = normalizeDeliveryIssueReport(await readJson(response));
    if (report.orderReference !== input.orderReference || report.category !== input.category) throw new Error("Report mismatch");
    return report;
  } catch {
    throw createError(503);
  }
}

export async function replayDeliveryIssueReport(input: Readonly<{
  conversationId: string;
  orderReference: string;
  category: DeliveryIssueCategory;
  idempotencyKey: string;
}>): Promise<{ kind: "found"; report: DeliveryIssueReport } | { kind: "not_found" }> {
  let response: Response;
  try {
    response = await fetch(`/api/conversations/${encodeURIComponent(input.conversationId)}/delivery-issue-reports/replay`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ order_reference: input.orderReference, category: input.category }),
    });
  } catch {
    throw createError(503);
  }
  if (response.status === 404) {
    const body = await readJson(response);
    if (isRecord(body) && isRecord(body.error) && body.error.code === "delivery_report_not_found") {
      return { kind: "not_found" };
    }
    throw new DeliveryIssueApiError("This conversation is not available for your account.", 404);
  }
  if (response.status !== 200) throw createError(response.status);
  try {
    const report = normalizeDeliveryIssueReport(await readJson(response));
    if (report.orderReference !== input.orderReference || report.category !== input.category) throw new Error("Report mismatch");
    return { kind: "found", report };
  } catch {
    throw createError(503);
  }
}

export async function recoverDeliveryIssueReport(
  attempt: DeliveryIssueAttempt & { conversationId: string },
  loadConversation: (conversationId: string) => Promise<{ status: "OPEN" | "CLOSED" }>,
): Promise<DeliveryIssueReport> {
  const input = {
    conversationId: attempt.conversationId,
    orderReference: attempt.orderReference,
    category: attempt.category,
    idempotencyKey: attempt.reportKey,
  };
  const receipt = await replayDeliveryIssueReport(input);
  if (receipt.kind === "found") return receipt.report;
  const conversation = await loadConversation(attempt.conversationId);
  if (conversation.status !== "OPEN") {
    throw new DeliveryIssueApiError("This conversation is closed. No delivery issue report was found for this attempt.", 409);
  }
  return createDeliveryIssueReport(input);
}

export async function loadDeliveryIssueReport(reportId: string): Promise<DeliveryIssueReport> {
  let response: Response;
  try {
    response = await fetch(`/api/delivery-issue-reports/${encodeURIComponent(reportId)}`, { cache: "no-store" });
  } catch {
    throw new DeliveryIssueApiError("We could not refresh this report. Please try again.");
  }
  if (response.status !== 200) {
    if (response.status === 401) throw new DeliveryIssueApiError("Please sign in to view this report.", 401);
    if (response.status === 404) throw new DeliveryIssueApiError("This report is not available for this account.", 404);
    throw new DeliveryIssueApiError("We could not refresh this report. Please try again.", response.status);
  }
  const report = normalizeDeliveryIssueReport(await readJson(response));
  if (report.reportId !== reportId) throw new DeliveryIssueApiError("The delivery issue report response was not valid.");
  return report;
}

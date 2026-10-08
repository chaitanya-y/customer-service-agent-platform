import { NextRequest, NextResponse } from "next/server";

import { normalizeDeliveryIssueReport } from "../../../../../../components/delivery-issue-api";

import {
  authorizeLocalCustomerRequest,
  proxyEdgeApi,
  readIdempotencyKey,
  readJsonObject,
} from "../../../../../../lib/refund-proxy";

type RouteContext = { params: Promise<{ conversationId: string }> };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function invalidRequest(): NextResponse {
  return NextResponse.json({ error: {
    code: "invalid_delivery_report", message: "Delivery issue report is invalid.",
  } }, { status: 400, headers: { "cache-control": "no-store" } });
}

function safeError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, {
    status, headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request, { requireSameOrigin: true });
  if (authorization instanceof NextResponse) return authorization;

  const { conversationId } = await context.params;
  if (!uuidPattern.test(conversationId) || request.nextUrl.search) return invalidRequest();
  const body = await readJsonObject(request);
  if (body instanceof NextResponse) return body;
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey instanceof NextResponse) return idempotencyKey;

  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalidRequest();
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 ||
      typeof fields.order_reference !== "string" ||
      fields.order_reference.length < 1 || fields.order_reference.length > 100 ||
      !referencePattern.test(fields.order_reference) ||
      typeof fields.category !== "string" ||
      !["MISSING", "WRONG", "DAMAGED", "DELAYED"].includes(fields.category)) {
    return invalidRequest();
  }

  const response = await proxyEdgeApi({
    authorization,
    body: JSON.stringify({ order_reference: fields.order_reference, category: fields.category }),
    headers: { "idempotency-key": idempotencyKey },
    method: "POST",
    path: `/v1/conversations/${encodeURIComponent(conversationId)}/delivery-issue-reports/replay`,
  });
  if (response.status === 404) {
    const payload: unknown = await response.json().catch(() => undefined);
    const namedMissing = typeof payload === "object" && payload !== null && "error" in payload &&
      typeof payload.error === "object" && payload.error !== null && "code" in payload.error &&
      payload.error.code === "delivery_report_not_found";
    return namedMissing
      ? safeError(404, "delivery_report_not_found", "No report was found for this attempt.")
      : safeError(404, "delivery_report_unavailable", "This conversation is not available for your account.");
  }
  if (response.status === 401) return safeError(401, "customer_unauthorized", "Customer authentication is required.");
  if (response.status === 409) return safeError(409, "delivery_report_conflict", "This report attempt does not match the original request.");
  if (response.status === 400) return invalidRequest();
  if (response.status !== 200) return safeError(502, "delivery_report_unavailable", "The delivery report is unavailable.");
  try {
    const report = normalizeDeliveryIssueReport(await response.json());
    if (report.orderReference !== fields.order_reference || report.category !== fields.category) throw new Error("mismatch");
    return NextResponse.json({ delivery_issue_report: {
      report_id: report.reportId,
      status: report.status,
      category: report.category,
      order_reference: report.orderReference,
      created_at: report.createdAt,
      updated_at: report.updatedAt,
    } }, { headers: { "cache-control": "no-store" } });
  } catch {
    return safeError(502, "delivery_report_unavailable", "The delivery report is unavailable.");
  }
}

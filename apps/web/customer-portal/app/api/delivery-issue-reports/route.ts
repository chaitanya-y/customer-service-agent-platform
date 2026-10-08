import { NextRequest, NextResponse } from "next/server";

import { normalizeDeliveryIssueHistory } from "../../../components/delivery-issue-api";
import { authorizeLocalCustomerRequest, proxyEdgeApi } from "../../../lib/refund-proxy";

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, {
    status, headers: { "cache-control": "private, no-store" },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request);
  if (authorization instanceof NextResponse) return privateResponse(authorization);

  const contentLength = request.headers.get("content-length");
  if (request.nextUrl.searchParams.size > 0 || request.body !== null ||
      (contentLength !== null && contentLength !== "0") || request.headers.has("transfer-encoding")) {
    return errorResponse(400, "invalid_delivery_report_list", "Delivery report history requires no parameters.");
  }

  try {
    const response = await proxyEdgeApi({
      authorization, method: "GET", path: "/v1/delivery-issue-reports",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      if (response.status === 401) return errorResponse(401, "customer_unauthorized", "Customer authentication is required.");
      return errorResponse(response.status === 503 ? 503 : 502,
        "delivery_report_history_unavailable", "Delivery reports are unavailable.");
    }
    const history = normalizeDeliveryIssueHistory(await response.json());
    return NextResponse.json({
      delivery_issue_reports: history.reports.map((report) => ({
        report_id: report.reportId, status: report.status, category: report.category,
        order_reference: report.orderReference, created_at: report.createdAt,
        updated_at: report.updatedAt,
      })),
      has_more: history.hasMore,
    }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return errorResponse(502, "delivery_report_history_unavailable", "Delivery reports are unavailable.");
  }
}

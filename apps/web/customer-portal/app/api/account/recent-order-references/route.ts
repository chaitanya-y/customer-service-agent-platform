import { NextRequest, NextResponse } from "next/server";
import { authorizeLocalCustomerRequest, proxyEdgeApi } from "../../../../lib/refund-proxy";
import { parseRecentOrderReferences } from "../../../../components/recent-order-references-api";

function unavailable(status: number): NextResponse {
  return NextResponse.json({ error: {
    code: status === 401 || status === 403 ? "customer_unauthorized" : "recent_order_references_unavailable",
    message: status === 401 || status === 403 ? "Customer authentication is required." : "Recent orders are unavailable.",
  } }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request);
  if (authorization instanceof NextResponse) return authorization;
  const contentLength = request.headers.get("content-length");
  if (request.nextUrl.searchParams.size > 0 || request.body !== null
    || (contentLength !== null && contentLength !== "0") || request.headers.has("transfer-encoding")) {
    return NextResponse.json({ error: {
      code: "invalid_recent_order_references_request", message: "Recent orders require no parameters.",
    } }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  try {
    const response = await proxyEdgeApi({ authorization, method: "GET",
      path: "/v1/account/recent-order-references", signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) return unavailable([401, 403, 503].includes(response.status) ? response.status : 502);
    return NextResponse.json(parseRecentOrderReferences(await response.json()), {
      headers: { "cache-control": "no-store" },
    });
  } catch { return unavailable(502); }
}

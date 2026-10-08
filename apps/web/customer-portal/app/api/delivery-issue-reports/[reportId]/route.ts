import { NextRequest, NextResponse } from "next/server";

import { authorizeLocalCustomerRequest, proxyEdgeApi } from "../../../../lib/refund-proxy";

type RouteContext = {
  params: Promise<{ reportId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request);
  if (authorization instanceof NextResponse) return authorization;

  const { reportId } = await context.params;
  return proxyEdgeApi({
    authorization,
    method: "GET",
    path: `/v1/delivery-issue-reports/${encodeURIComponent(reportId)}`,
  });
}

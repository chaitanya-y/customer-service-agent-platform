import { NextRequest, NextResponse } from "next/server";

import {
  authorizeLocalCustomerRequest,
  proxyEdgeApi,
} from "../../../../lib/refund-proxy";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request);
  if (authorization instanceof NextResponse) return authorization;

  return proxyEdgeApi({
    authorization,
    method: "GET",
    path: "/v1/account/saved-address-status",
  });
}

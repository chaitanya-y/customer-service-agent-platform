import { NextRequest, NextResponse } from "next/server";

import { proxyDeliveryReport } from "../../../lib/delivery-operations-proxy";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return proxyDeliveryReport(request, "list");
}

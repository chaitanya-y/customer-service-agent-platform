import { NextRequest, NextResponse } from "next/server";

import { proxyDeliveryReport } from "../../../../../lib/delivery-operations-proxy";

type RouteContext = Readonly<{ params: Promise<{ reportId: string }> }>;

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { reportId } = await context.params;
  return proxyDeliveryReport(request, "acknowledge", reportId);
}

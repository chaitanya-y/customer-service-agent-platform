import { NextResponse } from "next/server";

import { isDeliveryLocalEnabled, LOCAL_DELIVERY_SESSION_COOKIE } from "../../../lib/delivery-operations-proxy";

export async function POST() {
  if (!isDeliveryLocalEnabled()) {
    return NextResponse.json({ error: { code: "delivery_staff_auth_unavailable", message: "Local delivery staff authentication is unavailable." } }, { status: 503 });
  }
  const response = NextResponse.json({ data: { status: "authenticated" } });
  response.cookies.set({ name: LOCAL_DELIVERY_SESSION_COOKIE, value: "active", httpOnly: true, sameSite: "lax", secure: false, path: "/" });
  return response;
}

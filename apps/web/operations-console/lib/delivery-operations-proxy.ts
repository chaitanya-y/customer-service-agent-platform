import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { deliveryReportPath, deliveryReportQuery, parseDeliveryTransition } from "../components/delivery-report";
import { safeStaffFetch } from "./safe-staff-fetch";

export const LOCAL_DELIVERY_SESSION_COOKIE = "cso_local_delivery_staff_session";
const baseUrl = process.env.HUMAN_OPERATIONS_BASE_URL ?? "http://127.0.0.1:3003";

function error(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

export function isDeliveryLocalEnabled(): boolean {
  return process.env.NODE_ENV === "development" && Boolean(process.env.CSO_LOCAL_DELIVERY_STAFF_TOKEN);
}

export function authorizeDeliveryRequest(request: NextRequest, mutation = false): string | NextResponse {
  const assertion = process.env.CSO_LOCAL_DELIVERY_STAFF_TOKEN;
  if (!isDeliveryLocalEnabled() || !assertion) return error(503, "delivery_staff_auth_unavailable", "Local delivery staff authentication is unavailable.");
  if (request.cookies.get(LOCAL_DELIVERY_SESSION_COOKIE)?.value !== "active") return error(401, "delivery_staff_unauthenticated", "Delivery staff authentication is required.");
  if (mutation && request.headers.get("origin") !== request.nextUrl.origin &&
      !(process.env.NODE_ENV !== "production" && request.headers.get("origin") === "http://127.0.0.1:3101")) {
    return error(403, "invalid_request_origin", "The request origin is not allowed.");
  }
  return assertion;
}

export async function proxyDeliveryReport(request: NextRequest, action: "list" | "detail" | "claim" | "acknowledge" | "close", reportId?: string): Promise<NextResponse> {
  const mutation = action === "claim" || action === "acknowledge" || action === "close";
  const assertion = authorizeDeliveryRequest(request, mutation);
  if (assertion instanceof NextResponse) return assertion;

  let path: string;
  try {
    path = deliveryReportPath(action, reportId);
    if (action === "list") path += deliveryReportQuery(request.nextUrl.searchParams);
  } catch {
    return error(400, "invalid_delivery_report_request", "Delivery report request is invalid.");
  }

  let body: string | undefined;
  let idempotencyKey: string | undefined;
  if (mutation) {
    idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
      return error(400, "idempotency_key_required", "An idempotency key is required.");
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return error(415, "unsupported_media_type", "Requests must use application/json.");
    }
    try { body = JSON.stringify(parseDeliveryTransition(await request.json())); }
    catch { return error(400, "invalid_delivery_report_transition", "A current report version is required."); }
  }

  try {
    const endpoint = new URL(path, baseUrl);
    const upstream = await safeStaffFetch(endpoint, {
      method: mutation ? "POST" : "GET", body, cache: "no-store",
      headers: {
        accept: "application/json", "x-cso-delivery-staff-assertion": assertion,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
    });
    const responseBody = await upstream.text();
    return new NextResponse(responseBody, { status: upstream.status, headers: {
      "cache-control": "private, no-store",
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    } });
  } catch { return error(502, "delivery_reports_unavailable", "Delivery issue reports are temporarily unavailable."); }
}

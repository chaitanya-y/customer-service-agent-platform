import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { DeliveryReportDetail } from "../../../components/delivery-report-detail";
import { LOCAL_DELIVERY_SESSION_COOKIE } from "../../../lib/delivery-operations-proxy";

export default async function DeliveryReportPage({ params }: Readonly<{ params: Promise<{ reportId: string }> }>) {
  const [{ reportId }, cookieStore] = await Promise.all([params, cookies()]);
  if (cookieStore.get(LOCAL_DELIVERY_SESSION_COOKIE)?.value !== "active") redirect("/delivery-sign-in");
  if (!reportId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(reportId)) notFound();
  return <main className="cso-page-shell"><header className="cso-topbar"><span className="cso-brand">Customer Service OS · Delivery Operations</span><ThemeControl /></header><DeliveryReportDetail reportId={reportId} /></main>;
}

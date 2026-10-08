import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DeliveryReportQueue } from "../../components/delivery-report-queue";
import { LOCAL_DELIVERY_SESSION_COOKIE } from "../../lib/delivery-operations-proxy";

export default async function DeliveryReportsPage() {
  if ((await cookies()).get(LOCAL_DELIVERY_SESSION_COOKIE)?.value !== "active") redirect("/delivery-sign-in");
  return <main className="cso-page-shell"><header className="cso-topbar"><span className="cso-brand">Customer Service OS · Delivery Operations</span><ThemeControl /></header><DeliveryReportQueue /></main>;
}

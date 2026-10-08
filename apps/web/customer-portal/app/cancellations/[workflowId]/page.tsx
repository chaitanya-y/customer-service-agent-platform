import { LOCAL_CUSTOMER_SESSION_COOKIE } from "@cso/auth";
import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CancellationJourney } from "../../../components/cancellation-journey";

export default async function CancellationPage({
  params,
}: Readonly<{ params: Promise<{ workflowId: string }> }>) {
  const [{ workflowId }, cookieStore] = await Promise.all([params, cookies()]);
  if (cookieStore.get(LOCAL_CUSTOMER_SESSION_COOKIE)?.value !== "active") redirect("/sign-in");
  if (!/^cancel-[a-f0-9]{64}$/.test(workflowId)) notFound();

  return <main className="cso-page-shell">
    <header className="cso-topbar">
      <Link className="cso-brand" href="/support">Customer Service OS</Link>
      <ThemeControl />
    </header>
    <CancellationJourney workflowId={workflowId} />
  </main>;
}

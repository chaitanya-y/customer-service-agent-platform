"use client";

import Link from "next/link";
import { useState } from "react";
import { clearDeliveryTransitionStorage } from "../../components/delivery-report-detail-state";

export default function DeliverySignInPage() {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  async function startSession() {
    setSubmitting(true); setError(undefined);
    try {
      const response = await fetch("/api/delivery-local-session", { method: "POST" });
      if (!response.ok) throw new Error();
      clearDeliveryTransitionStorage(window.sessionStorage);
      window.location.assign("/delivery-issue-reports");
    } catch { setError("Unable to start delivery staff session. Check local authentication and browser session storage."); setSubmitting(false); }
  }
  return <main className="cso-page-shell"><section className="cso-panel"><span className="cso-eyebrow">Customer Service OS</span>
    <h1>Start delivery operations</h1><p>This development-only session is for delivery staff. It does not grant access to refund cases.</p>
    {error ? <p className="cso-status-note" role="alert">{error}</p> : null}
    <button className="cso-primary-button" disabled={submitting} onClick={startSession} type="button">{submitting ? "Starting session…" : "Continue as delivery staff"}</button>
    <p><Link href="/sign-in">Refund operations sign-in</Link></p>
  </section></main>;
}

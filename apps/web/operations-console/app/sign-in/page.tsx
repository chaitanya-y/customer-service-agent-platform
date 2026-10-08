"use client";

import { useState } from "react";
import Link from "next/link";

export default function SignInPage() {
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function startLocalSession() {
    setSubmitting(true); setError(undefined);
    try {
      const response = await fetch("/api/local-session", { method: "POST" });
      if (!response.ok) throw new Error();
      window.location.assign("/refund-cases");
    } catch {
      setError("Local staff authentication is not configured.");
      setSubmitting(false);
    }
  }

  return <main className="cso-page-shell"><section className="cso-panel"><span className="cso-eyebrow">Customer Service OS</span><h1>Start local operations</h1><p>This development-only page creates a local refund staff session. Cognito replaces it in the AWS deployment without changing console routes.</p>{error ? <p className="cso-status-note" role="alert">{error}</p> : null}<button className="cso-primary-button" disabled={submitting} onClick={startLocalSession} type="button">{submitting ? "Starting session…" : "Continue locally"}</button><p><Link href="/delivery-sign-in">Delivery operations sign-in</Link> · <Link href="/support-sign-in">Human support sign-in</Link></p></section></main>;
}

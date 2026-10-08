"use client";
import Link from "next/link";
import { useState } from "react";
import { clearSupportAttemptStorage } from "../../components/support-chat-attempt";
export default function SupportSignInPage(){
  const [error,setError]=useState<string>(),[busy,setBusy]=useState(false);
  async function signIn(){setBusy(true);setError(undefined);try{clearSupportAttemptStorage(window.sessionStorage);}catch{setError("Previous support session data could not be cleared in this browser.");setBusy(false);return;}try{const response=await fetch("/api/support-local-session",{method:"POST"});if(!response.ok)throw new Error();window.location.assign("/support-chats");}catch{setError("Local support staff authentication is not configured.");setBusy(false);}}
  return <main className="cso-page-shell"><section className="cso-panel"><span className="cso-eyebrow">Support Operations</span><h1>Start human support</h1><p>This development-only SUPPORT_AGENT session can claim and answer customer chats. It grants no refund approval or delivery operations permission.</p>{error?<p role="alert">{error}</p>:null}<button className="cso-primary-button" type="button" disabled={busy} onClick={()=>void signIn()}>{busy?"Starting session…":"Continue as support staff"}</button><p><Link href="/sign-in">Refund operations sign-in</Link> · <Link href="/delivery-sign-in">Delivery operations sign-in</Link></p></section></main>;
}

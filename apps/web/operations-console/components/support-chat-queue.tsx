"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getConsoleData, OperationsApiError } from "./operations-api";
import { clearSupportAttemptStorage } from "./support-chat-attempt";
import { watchStaffBfcacheRestore } from "./staff-page-lifecycle";
import { normalizeSupportQueue, type SupportChat } from "./support-chat";
import styles from "./support-chat.module.css";
export function SupportChatQueue(){
  const [items,setItems]=useState<SupportChat[]>(),[hasMore,setHasMore]=useState(false),[offset,setOffset]=useState(0),[error,setError]=useState<string>();
  const stopped=useRef(false);
  useEffect(()=>{
    let alive=true,reading=false;
    async function refresh(){if(!alive||stopped.current||reading)return;reading=true;try{
      const queue=normalizeSupportQueue(await getConsoleData(`/api/support-chats?limit=50&offset=${offset}`));
      if(alive&&!stopped.current){setItems(queue.items);setHasMore(queue.hasMore);setError(undefined);}
    }catch(cause){if(alive&&!stopped.current){if(cause instanceof OperationsApiError&&[401,403].includes(cause.status)){stopped.current=true;setItems(undefined);try{clearSupportAttemptStorage(window.sessionStorage);}catch{/* Browser storage may be unavailable. */}}setError(cause instanceof Error?cause.message:"Unable to load support queue.");}}finally{reading=false;}}
    setItems(undefined);void refresh();
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh();},5000);
    const hide=()=>{stopped.current=true;setItems(undefined);};window.addEventListener("pagehide",hide);
    const stopWatchingRestore=watchStaffBfcacheRestore(window);
    return ()=>{alive=false;window.clearInterval(timer);window.removeEventListener("pagehide",hide);stopWatchingRestore();};
  },[offset]);
  async function signOut(){stopped.current=true;setItems(undefined);try{clearSupportAttemptStorage(window.sessionStorage);}catch{/* Browser storage may be unavailable. */}try{const response=await fetch("/api/support-local-session",{method:"DELETE"});if(!response.ok)throw new Error();window.location.assign("/support-sign-in");}catch{setError("Support sign-out could not be confirmed. Try again.");}}
  return <section className={styles.panel} aria-labelledby="support-queue-heading">
    <header className={styles.header}><div><span className="cso-eyebrow">Support Operations</span><h1 id="support-queue-heading">Human support chats</h1><p>Claim queued conversations and reply in the customer’s existing chat. This role does not approve refunds.</p></div><button type="button" onClick={()=>void signOut()}>Sign out of support</button></header>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    {!items&&!error?<p>Loading support queue…</p>:null}
    {items?.length===0?<p>No queued or assigned support chats.</p>:null}
    <div className={styles.queue}>{items?.map((chat)=><Link className={styles.queueItem} key={chat.conversationId} href={`/support-chats/${encodeURIComponent(chat.conversationId)}`}><strong>{chat.controlMode==="QUEUED"?"Waiting for a person":"Assigned to you"}</strong><span className={styles.muted}>Conversation {chat.conversationId}</span>{chat.queuedAt?<time dateTime={chat.queuedAt}>Requested {new Date(chat.queuedAt).toLocaleString()}</time>:null}</Link>)}</div>
    <div className={styles.actions}><button type="button" disabled={offset===0} onClick={()=>setOffset((value)=>Math.max(0,value-50))}>Previous</button><button type="button" disabled={!hasMore||offset>=10000} onClick={()=>setOffset((value)=>value+50)}>Next</button></div>
  </section>;
}

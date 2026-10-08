"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getConsoleData, OperationsApiError, postConsoleData } from "./operations-api";
import { normalizeSupportControl, normalizeSupportDetail, type SupportAction, type SupportDetail } from "./support-chat";
import { clearSupportAttemptStorage, keepSupportAttemptForUnavailableDetail, nextSupportAttempt, parseSupportAttempt, reconcileSupportDetail, supportAttemptBody, type SupportAttempt, type SupportSnapshot } from "./support-chat-attempt";
import { isCurrentStaffSession, watchStaffBfcacheRestore } from "./staff-page-lifecycle";
import styles from "./support-chat.module.css";

export function SupportChatControls({chat,draft,busy,pendingAction,onDraft,onAction}:Readonly<{
  chat:SupportDetail;draft:string;busy:boolean;pendingAction?:SupportAction;onDraft:(value:string)=>void;onAction:(action:SupportAction)=>void;
}>){
  return <aside className={styles.controls} aria-labelledby="support-controls-heading">
    <h2 id="support-controls-heading">Conversation control</h2>
    <p>{chat.controlMode==="QUEUED"?"Claim this conversation before replying.":chat.assignedToMe?"You are the assigned support specialist. Replies are visible to the customer.":"This conversation is not assigned to you."}</p>
    {chat.workflowStartPending?<p className={styles.notice} role="status">A refund request was accepted before handoff and may continue independently. Chat replies do not authorize a refund.</p>:null}
    <p>Closing or returning this conversation to AI does not cancel an existing refund workflow.</p>
    {pendingAction?<div className={styles.notice}><p>The last action’s result is uncertain. Retry the same action before making another change.</p><button type="button" disabled={busy} onClick={()=>onAction(pendingAction)}>Retry pending action</button></div>:null}
    {chat.canClaim?<button className="cso-primary-button" type="button" disabled={busy||Boolean(pendingAction)} onClick={()=>onAction("claim")}>Claim conversation</button>:null}
    {chat.canReply?<form onSubmit={(event)=>{event.preventDefault();onAction("messages");}}>
      <label htmlFor="support-staff-reply">Reply to customer</label>
      <textarea id="support-staff-reply" maxLength={2000} rows={5} value={draft} onChange={(event)=>onDraft(event.target.value)} disabled={busy||Boolean(pendingAction)} />
      <span className={styles.muted}>{draft.length}/2,000 characters</span>
      <button className="cso-primary-button" disabled={busy||Boolean(pendingAction)||!draft.trim()} type="submit">{busy?"Sending…":"Send reply"}</button>
    </form>:null}
    {chat.canFinish?<div className={styles.actions}>
      <button type="button" disabled={busy||Boolean(pendingAction)} onClick={()=>onAction("return-to-ai")}>Return to AI</button>
      <button type="button" disabled={busy||Boolean(pendingAction)} onClick={()=>onAction("close")}>Close conversation</button>
    </div>:null}
  </aside>;
}

export function SupportChatDetail({conversationId}:Readonly<{conversationId:string}>){
  const [chat,setChat]=useState<SupportDetail>();
  const [draft,setDraft]=useState("");
  const [error,setError]=useState<string>();
  const [busy,setBusy]=useState(false);
  const [pendingAction,setPendingAction]=useState<SupportAction>();
  const [recoveryOnly,setRecoveryOnly]=useState(false);
  const snapshot=useRef<SupportSnapshot<SupportDetail>|undefined>(undefined);
  const sequence=useRef(0),stopped=useRef(false),refreshing=useRef(false),submitting=useRef(false);
  const unavailable=useRef(false);
  const generation=useRef(0);
  const pending=useRef<SupportAttempt|undefined>(undefined);
  const storageKey=`cso.support-chat.attempt:${conversationId}`;
  const clearPrivateState=useCallback((forgetPending=true)=>{
    stopped.current=true;generation.current += 1;sequence.current+=1;refreshing.current=false;submitting.current=false;
    unavailable.current=false;snapshot.current=undefined;pending.current=undefined;setChat(undefined);setDraft("");setPendingAction(undefined);setRecoveryOnly(false);setBusy(false);
    if(forgetPending)try{window.sessionStorage.removeItem(storageKey);}catch{/* Browser storage may be unavailable. */}
  },[storageKey]);
  const refresh=useCallback(async()=>{
    if(stopped.current||refreshing.current||unavailable.current)return;
    refreshing.current=true;const requestSequence=++sequence.current,requestGeneration=generation.current;
    try{
      const detail=normalizeSupportDetail(await getConsoleData(`/api/support-chats/${encodeURIComponent(conversationId)}`));
      if(!isCurrentStaffSession(stopped.current,generation.current,requestGeneration))return;
      if(detail.conversationId!==conversationId)throw new Error("Support chat returned a mismatched conversation.");
      const next=reconcileSupportDetail(snapshot.current,detail,requestSequence);
      if(next!==snapshot.current){snapshot.current=next;setChat(next.detail);}
      if(!pending.current)setError(undefined);
    }catch(cause){
      if(!isCurrentStaffSession(stopped.current,generation.current,requestGeneration))return;
      if(cause instanceof OperationsApiError&&keepSupportAttemptForUnavailableDetail(cause.status,pending.current)){
        unavailable.current=true;snapshot.current=undefined;setChat(undefined);setDraft("");setRecoveryOnly(true);
        setError("This conversation is unavailable. The last action may have completed. Retry only the saved action to confirm its result.");
        return;
      }
      if(cause instanceof OperationsApiError&&[401,403,404].includes(cause.status)){
        clearPrivateState();
        if(cause.status===401||cause.status===403)try{clearSupportAttemptStorage(window.sessionStorage);}catch{/* Browser storage may be unavailable. */}
      }
      setError(cause instanceof Error?cause.message:"Unable to refresh support chat.");
    }finally{if(isCurrentStaffSession(stopped.current,generation.current,requestGeneration))refreshing.current=false;}
  },[clearPrivateState,conversationId]);
  useEffect(()=>{
    generation.current += 1;stopped.current=false;refreshing.current=false;unavailable.current=false;setRecoveryOnly(false);
    pending.current=undefined;setPendingAction(undefined);setDraft("");
    try{
      const raw=window.sessionStorage.getItem(storageKey);
      const restored=parseSupportAttempt(raw,conversationId);
      if(restored){pending.current=restored;setPendingAction(restored.action);setDraft(restored.text??"");}
      else if(raw)window.sessionStorage.removeItem(storageKey);
    }catch{/* An action will fail closed if browser storage is unavailable. */}
    void refresh();
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh();},5000);
    const hide=()=>clearPrivateState(false);window.addEventListener("pagehide",hide);
    const stopWatchingRestore=watchStaffBfcacheRestore(window);
    return ()=>{stopped.current=true;generation.current += 1;sequence.current+=1;window.clearInterval(timer);window.removeEventListener("pagehide",hide);stopWatchingRestore();};
  },[clearPrivateState,conversationId,refresh,storageKey]);
  async function action(nextAction:SupportAction){
    const requestGeneration=generation.current;
    const current=snapshot.current?.detail;
    if((!current&&!pending.current)||submitting.current||stopped.current)return;
    if(!pending.current&&(!current||!(nextAction==="claim"?current.canClaim:nextAction==="messages"?current.canReply:current.canFinish)))return;
    let attempt:SupportAttempt;
    try{
      attempt=pending.current??nextSupportAttempt(undefined,current!,nextAction,nextAction==="messages"?draft:undefined,()=>crypto.randomUUID());
      if(attempt.action!==nextAction)return;
      window.sessionStorage.setItem(storageKey,JSON.stringify(attempt));
      pending.current=attempt;setPendingAction(attempt.action);
    }catch{setError("This browser cannot safely retain the action for an exact retry. No action was sent.");return;}
    submitting.current=true;setBusy(true);setError(undefined);
    try{
      const value:unknown=await postConsoleData(`/api/support-chats/${encodeURIComponent(conversationId)}/${attempt.action}`,supportAttemptBody(attempt),attempt.idempotencyKey,"The support action could not be confirmed. Retry the same action.");
      if(!isCurrentStaffSession(stopped.current,generation.current,requestGeneration))return;
      if(!value||typeof value!=="object"||!("data" in value))throw new Error("The support action could not be confirmed. Retry the same action.");
      const data=(value as {data:unknown}).data;
      const control=normalizeSupportControl(attempt.action==="messages"&&data&&typeof data==="object"&&"control" in data?data.control:data);
      if(control.conversationId!==conversationId||control.controlMode!==(attempt.action==="return-to-ai"?"AI":attempt.action==="close"?control.controlMode:"HUMAN")||(attempt.action==="close"&&control.status!=="CLOSED"))throw new Error("The support action could not be confirmed. Retry the same action.");
      if(attempt.action==="messages"){
        const message=(data as {message?:{conversationId?:unknown;messageId?:unknown;sequenceNumber?:unknown;status?:unknown}}).message;
        if(message?.conversationId!==conversationId||message.status!=="ACCEPTED"||typeof message.messageId!=="string"||typeof message.sequenceNumber!=="number"||!Number.isSafeInteger(message.sequenceNumber)||message.sequenceNumber<1)throw new Error("The reply could not be confirmed. Retry the same action.");
        setDraft("");
      }
      pending.current=undefined;setPendingAction(undefined);
      try{window.sessionStorage.removeItem(storageKey);}catch{/* The confirmed action is no longer offered for retry. */}
      unavailable.current=false;setRecoveryOnly(false);
      if(attempt.action==="return-to-ai"||attempt.action==="close"){clearPrivateState();window.location.assign("/support-chats");return;}
      await refresh();
    }catch(cause){
      if(!isCurrentStaffSession(stopped.current,generation.current,requestGeneration))return;
      if(cause instanceof OperationsApiError&&cause.status>=400&&cause.status<500){
        if(cause.status===401||cause.status===403){
          clearPrivateState();
          try{clearSupportAttemptStorage(window.sessionStorage);}catch{/* Browser storage may be unavailable. */}
        }else if(cause.status===404&&pending.current){
          unavailable.current=true;snapshot.current=undefined;setChat(undefined);setDraft("");setRecoveryOnly(true);
        }else{
          pending.current=undefined;setPendingAction(undefined);
          try{window.sessionStorage.removeItem(storageKey);}catch{/* Ignore inaccessible browser storage. */}
          unavailable.current=false;setRecoveryOnly(false);
          void refresh();
        }
      }
      setError(cause instanceof Error?cause.message:"The action could not be confirmed. Retry the same action.");
    }finally{if(isCurrentStaffSession(stopped.current,generation.current,requestGeneration)){submitting.current=false;setBusy(false);}}
  }
  async function signOut(){clearPrivateState();try{clearSupportAttemptStorage(window.sessionStorage);}catch{/* Browser storage may be unavailable. */}setBusy(true);try{const result=await fetch("/api/support-local-session",{method:"DELETE"});if(!result.ok)throw new Error();window.location.assign("/support-sign-in");}catch{setError("Support sign-out could not be confirmed. Try signing out again.");}finally{setBusy(false);}}
  return <section className={styles.panel}>
    <header className={styles.header}><Link href="/support-chats">← Support chats</Link><button type="button" disabled={busy} onClick={()=>void signOut()}>Sign out of support</button></header>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    {!chat&&recoveryOnly&&pendingAction?<section className={styles.notice} aria-label="Pending support action recovery">
      <p>The conversation details are hidden. Your previous action may have succeeded. Retry the exact saved action to confirm it; do not start a new reply.</p>
      <button type="button" disabled={busy} onClick={()=>void action(pendingAction)}>Retry pending action</button>
    </section>:null}
    {!chat&&!error?<p>Loading support conversation…</p>:null}
    {chat?<><header><h1>Support conversation</h1><p className={styles.muted}>Conversation {chat.conversationId} · {chat.controlMode} · control version {chat.controlVersion}</p></header>
      <div className={styles.detailGrid}><section className={styles.transcript} aria-label="Conversation transcript" role="log" aria-live="polite">
        {chat.messages.length?chat.messages.map((message)=><article className={styles.message} key={message.messageId}><strong>{message.senderKind==="END_CUSTOMER"?"Customer":message.senderKind==="WORKFORCE"?"Support specialist":"AI assistant"}</strong><p>{message.text}</p><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></article>):<p>No messages yet.</p>}
      </section><SupportChatControls chat={chat} draft={draft} busy={busy} pendingAction={pendingAction} onDraft={setDraft} onAction={(value)=>void action(value)} /></div>
      <button type="button" disabled={busy} onClick={()=>void refresh()}>Refresh conversation</button>
    </>:null}
  </section>;
}

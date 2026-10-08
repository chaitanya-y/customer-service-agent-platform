import type { SupportAction, SupportChat, SupportCommand, SupportDetail } from "./support-chat";
export type SupportAttempt=Readonly<{conversationId:string;handoffSessionId:string;expectedControlVersion:number;action:SupportAction;idempotencyKey:string;clientMessageId?:string;text?:string}>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const attemptStoragePrefix="cso.support-chat.attempt:";
export function keepSupportAttemptForUnavailableDetail(status:number,pending:SupportAttempt|undefined):boolean{
  return status===404&&pending!==undefined;
}
export function clearSupportAttemptStorage(storage:Pick<Storage,"length"|"key"|"removeItem">):void{
  for(let index=storage.length-1;index>=0;index--){
    const key=storage.key(index);
    if(key?.startsWith(attemptStoragePrefix))storage.removeItem(key);
  }
}
export function parseSupportAttempt(value:string|null,conversationId:string):SupportAttempt|undefined{
  if(!value)return undefined;
  try{
    const parsed:unknown=JSON.parse(value);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return undefined;
    const attempt=parsed as Record<string,unknown>;
    if(attempt.conversationId!==conversationId||!uuid.test(conversationId)||typeof attempt.handoffSessionId!=="string"||!uuid.test(attempt.handoffSessionId)
      ||!Number.isSafeInteger(attempt.expectedControlVersion)||(attempt.expectedControlVersion as number)<1
      ||!(["claim","messages","return-to-ai","close"] as unknown[]).includes(attempt.action)
      ||typeof attempt.idempotencyKey!=="string"||!keyPattern.test(attempt.idempotencyKey))return undefined;
    if(attempt.action==="messages"){
      if(typeof attempt.text!=="string"||!attempt.text.trim()||attempt.text.length>2000||attempt.clientMessageId!==attempt.idempotencyKey)return undefined;
      return {conversationId,handoffSessionId:attempt.handoffSessionId,expectedControlVersion:attempt.expectedControlVersion as number,
        action:"messages",idempotencyKey:attempt.idempotencyKey,clientMessageId:attempt.idempotencyKey,text:attempt.text};
    }
    if(attempt.text!==undefined||attempt.clientMessageId!==undefined)return undefined;
    return {conversationId,handoffSessionId:attempt.handoffSessionId,expectedControlVersion:attempt.expectedControlVersion as number,
      action:attempt.action as SupportAction,idempotencyKey:attempt.idempotencyKey};
  }catch{return undefined;}
}
export function nextSupportAttempt(pending:SupportAttempt|undefined,chat:Pick<SupportChat,"conversationId"|"handoffSessionId"|"controlVersion">,action:SupportAction,text:string|undefined,newKey:()=>string):SupportAttempt{
  if(pending){
    if(pending.conversationId===chat.conversationId&&pending.handoffSessionId===chat.handoffSessionId&&pending.action===action&&pending.text===text)return pending;
    throw new Error("Retry the pending action before starting a different action.");
  }
  if(!chat.handoffSessionId)throw new Error("This conversation has no active handoff session.");
  const key=newKey();
  return {conversationId:chat.conversationId,handoffSessionId:chat.handoffSessionId,expectedControlVersion:chat.controlVersion,action,idempotencyKey:key,...(action==="messages"?{text,clientMessageId:key}:{})};
}
export function supportAttemptBody(attempt:SupportAttempt):SupportCommand{
  return {handoffSessionId:attempt.handoffSessionId,expectedControlVersion:attempt.expectedControlVersion,...(attempt.action==="messages"?{clientMessageId:attempt.clientMessageId,content:{type:"text" as const,text:attempt.text??""}}:{})};
}
export type SupportSnapshot<T extends Pick<SupportDetail,"controlVersion"|"messages">>=Readonly<{detail:T;requestSequence:number}>;
export function reconcileSupportDetail<T extends Pick<SupportDetail,"controlVersion"|"messages">>(current:SupportSnapshot<T>|undefined,incoming:T,requestSequence:number):SupportSnapshot<T>{
  const last=(detail:T)=>detail.messages.at(-1)?.sequenceNumber??0;
  if(current&&(incoming.controlVersion<current.detail.controlVersion||(incoming.controlVersion===current.detail.controlVersion&&(last(incoming)<last(current.detail)||(last(incoming)===last(current.detail)&&requestSequence<current.requestSequence)))))return current;
  return {detail:incoming,requestSequence};
}

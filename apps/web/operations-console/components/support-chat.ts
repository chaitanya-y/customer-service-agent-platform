export type SupportAction="claim"|"messages"|"return-to-ai"|"close";
export type SupportControl=Readonly<{conversationId:string;status:"OPEN"|"CLOSED";controlMode:"AI"|"QUEUED"|"HUMAN";controlVersion:number;handoffSessionId?:string}>;
export type SupportChat=SupportControl&Readonly<{assignedToMe:boolean;canClaim:boolean;canReply:boolean;canFinish:boolean;queuedAt?:string}>;
export type SupportMessage=Readonly<{messageId:string;sequenceNumber:number;senderKind:"END_CUSTOMER"|"ASSISTANT"|"WORKFORCE";text:string;createdAt:string}>;
export type SupportDetail=SupportChat&Readonly<{messages:readonly SupportMessage[];workflowStartPending:boolean;pendingRefundStarts:readonly {workflowId:string;status:"PENDING"}[]}>;
export type SupportCommand=Readonly<{handoffSessionId:string;expectedControlVersion:number;clientMessageId?:string;content?:{type:"text";text:string}}>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opaque=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
function invalid():never{throw new Error("Support chat response or command is invalid.");}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))invalid();return value as Record<string,unknown>;}
function positive(value:unknown):number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1)invalid();return value;}
function identifier(value:unknown):string{if(typeof value!=="string"||!uuid.test(value))invalid();return value;}
function date(value:unknown):string{if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))invalid();return value;}
export function normalizeSupportControl(value:unknown):SupportControl{
  const r=record(value);
  if((r.status!=="OPEN"&&r.status!=="CLOSED")||!["AI","QUEUED","HUMAN"].includes(String(r.controlMode)))invalid();
  const handoffSessionId=r.handoffSessionId===undefined?undefined:identifier(r.handoffSessionId);
  if(r.status==="OPEN"&&r.controlMode!=="AI"&&!handoffSessionId)invalid();
  return {conversationId:identifier(r.conversationId),status:r.status,controlMode:r.controlMode as SupportControl["controlMode"],controlVersion:positive(r.controlVersion),...(handoffSessionId?{handoffSessionId}:{})};
}
function summary(value:unknown):SupportChat{
  const r=record(value),control=normalizeSupportControl(r);
  for(const k of ["assignedToMe","canClaim","canReply","canFinish"])if(typeof r[k]!=="boolean")invalid();
  if((r.canReply||r.canFinish)&&(!r.assignedToMe||control.controlMode!=="HUMAN"||control.status!=="OPEN"))invalid();
  if(r.canClaim&&(control.controlMode!=="QUEUED"||control.status!=="OPEN"))invalid();
  return {...control,assignedToMe:r.assignedToMe as boolean,canClaim:r.canClaim as boolean,canReply:r.canReply as boolean,canFinish:r.canFinish as boolean,...(r.queuedAt===undefined?{}:{queuedAt:date(r.queuedAt)})};
}
export function normalizeSupportQueue(value:unknown):{items:SupportChat[];hasMore:boolean}{
  const r=record(record(value).data);if(!Array.isArray(r.items)||r.items.length>100||typeof r.hasMore!=="boolean")invalid();
  return {items:r.items.map(summary),hasMore:r.hasMore};
}
export function normalizeSupportDetail(value:unknown):SupportDetail{
  const r=record(record(value).data);if(!Array.isArray(r.messages)||!Array.isArray(r.pendingRefundStarts)||typeof r.workflowStartPending!=="boolean")invalid();
  let sequence=0;
  const messages=r.messages.map((value)=>{
    const message=record(value);const next=positive(message.sequenceNumber);
    if(next<=sequence||!["END_CUSTOMER","ASSISTANT","WORKFORCE"].includes(String(message.senderKind))||typeof message.text!=="string"||message.text.length>32768)invalid();
    sequence=next;
    return {messageId:identifier(message.messageId),sequenceNumber:next,senderKind:message.senderKind as SupportMessage["senderKind"],text:message.text,createdAt:date(message.createdAt)};
  });
  const pendingRefundStarts=r.pendingRefundStarts.map((value)=>{const p=record(value);if(typeof p.workflowId!=="string"||p.workflowId.length>200||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p.workflowId)||p.status!=="PENDING")invalid();return {workflowId:p.workflowId,status:"PENDING" as const};});
  if(r.workflowStartPending!==(pendingRefundStarts.length>0))invalid();
  return {...summary(r),messages,pendingRefundStarts,workflowStartPending:r.workflowStartPending};
}
export function supportChatPath(action:SupportAction|"list"|"read",conversationId?:string):string{
  if(!["list","read","claim","messages","return-to-ai","close"].includes(action))invalid();
  return action==="list"?"/v1/support-chats":`/v1/support-chats/${identifier(conversationId)}${action==="read"?"":`/${action}`}`;
}
export function supportChatQuery(params:URLSearchParams):string{
  for(const key of params.keys())if(!["limit","offset"].includes(key)||params.getAll(key).length!==1)invalid();
  const limit=Number(params.get("limit")??50),offset=Number(params.get("offset")??0);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>10000)invalid();
  return `?limit=${limit}&offset=${offset}`;
}
export function parseSupportCommand(action:SupportAction,value:unknown):SupportCommand{
  if(!["claim","messages","return-to-ai","close"].includes(action))invalid();
  const r=record(value);const fields=action==="messages"?["handoffSessionId","expectedControlVersion","clientMessageId","content"]:["handoffSessionId","expectedControlVersion"];
  if(Object.keys(r).length!==fields.length||Object.keys(r).some((key)=>!fields.includes(key)))invalid();
  const command={handoffSessionId:identifier(r.handoffSessionId),expectedControlVersion:positive(r.expectedControlVersion)};
  if(action!=="messages")return command;
  const content=record(r.content);
  if(typeof r.clientMessageId!=="string"||!opaque.test(r.clientMessageId)||Object.keys(content).length!==2||content.type!=="text"||typeof content.text!=="string"||!content.text.trim()||content.text.length>2000)invalid();
  return {...command,clientMessageId:r.clientMessageId,content:{type:"text",text:content.text}};
}

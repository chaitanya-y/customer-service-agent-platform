import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { z } from 'zod';
import type { SupportStaffAccess } from './support-staff-access.js';

const uuid=z.uuid();
const version=z.number().int().positive();
const key=z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const handoffCommandSchema=z.object({handoffSessionId:uuid,expectedControlVersion:version}).strict();
export const handoffReplySchema=handoffCommandSchema.extend({
  clientMessageId:z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  content:z.object({type:z.literal('text'),text:z.string().min(1).max(2000).refine((text)=>text.trim().length>0)}).strict(),
}).strict();
export const handoffListQuerySchema=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
export type HandoffPurpose='handoff_list'|'handoff_read'|'handoff_claim'|'handoff_reply'|'handoff_return_to_ai'|'handoff_close';
export type HandoffRequest=Readonly<{access:SupportStaffAccess;purpose:HandoffPurpose;conversationId?:string;body?:unknown;idempotencyKey?:string;limit?:number;offset?:number}>;
export type HandoffResult=Readonly<{statusCode:number;body:unknown}>;
export type ConversationHandoffClient={request:(input:HandoffRequest)=>Promise<HandoffResult>};
const actions={handoff_claim:'claim',handoff_reply:'messages',handoff_return_to_ai:'return-to-ai',handoff_close:'close'} as const;

export function resolveConversationHandoffConfig(environment:NodeJS.ProcessEnv):{baseUrl:string;secret:string;routingEpoch:number}|undefined {
  const secret=environment.CONVERSATION_STAFF_ASSERTION_HMAC_SECRET;
  if(!secret&&!environment.CONVERSATION_RUNTIME_BASE_URL)return undefined;
  if(!secret||Buffer.byteLength(secret)<32||[
    environment.HUMAN_ACCESS_HMAC_SECRET,environment.CONTEXT_ASSERTION_HMAC_SECRET,
    environment.HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET,environment.EDGE_SERVICE_ASSERTION_HMAC_SECRET,
  ].includes(secret))throw new Error('INVALID_CONVERSATION_HANDOFF_CONFIG');
  const baseUrl=environment.CONVERSATION_RUNTIME_BASE_URL??'http://127.0.0.1:3004';
  const url=new URL(baseUrl);
  const routingEpoch=Number(environment.CONVERSATION_ROUTING_EPOCH??1);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!Number.isSafeInteger(routingEpoch)||routingEpoch<1)throw new Error('INVALID_CONVERSATION_HANDOFF_CONFIG');
  return {baseUrl,secret,routingEpoch};
}

function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(value!==null&&typeof value==='object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function createConversationHandoffClient(options:{baseUrl:string;secret:string;routingEpoch:number;fetcher?:typeof fetch}):ConversationHandoffClient {
  const base=new URL(options.baseUrl);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||Buffer.byteLength(options.secret)<32||!Number.isSafeInteger(options.routingEpoch)||options.routingEpoch<1) throw new Error('INVALID_CONVERSATION_HANDOFF_CONFIG');
  const signingKey=new TextEncoder().encode(options.secret);
  return {async request(input){
    let path='/v1/internal/handoffs';
    const mutation=input.purpose!=='handoff_list'&&input.purpose!=='handoff_read';
    if(input.purpose!=='handoff_list') path+=`/${uuid.parse(input.conversationId)}`;
    if(mutation) path+=`/${actions[input.purpose as keyof typeof actions]}`;
    const endpoint=new URL(path,base);
    let body:Record<string,unknown>|undefined;
    if(input.purpose==='handoff_list') {
      const query=handoffListQuerySchema.parse({...(input.limit===undefined?{}:{limit:input.limit}),...(input.offset===undefined?{}:{offset:input.offset})});
      endpoint.search=new URLSearchParams({limit:String(query.limit),offset:String(query.offset)}).toString();
    }
    if(mutation) body=(input.purpose==='handoff_reply'?handoffReplySchema:handoffCommandSchema).parse(input.body);
    const idempotencyKey=mutation?key.parse(input.idempotencyKey):undefined;
    const method=mutation?'POST':'GET';
    const assertion=await new SignJWT({
      tenantId:input.access.tenantId,environmentId:input.access.environmentId,staffId:input.access.staffId,role:'SUPPORT_AGENT',
      purpose:input.purpose,requestId:randomUUID(),traceId:randomUUID(),routingEpoch:options.routingEpoch,httpMethod:method,path,
      ...(input.purpose==='handoff_list'?{}:{conversationId:input.conversationId}),
      ...(body?{handoffSessionId:body.handoffSessionId,expectedControlVersion:body.expectedControlVersion,idempotencyKey,
        requestBodySha256:createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')}:{}),
    }).setProtectedHeader({alg:'HS256',typ:'cso-conversation-staff+jwt'})
      .setIssuer('customer-service-os-human-operations').setAudience('conversation-runtime-handoff').setIssuedAt().setExpirationTime('60s').sign(signingKey);
    const response=await (options.fetcher??fetch)(endpoint,{method,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10000),
      ...(body?{body:JSON.stringify(body)}:{}),headers:{accept:'application/json','x-cso-conversation-staff-assertion':assertion,
        ...(body?{'content-type':'application/json'}:{}),...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})}});
    if(response.status>=300&&response.status<400){await response.body?.cancel();throw new Error('Conversation Runtime redirect refused');}
    return {statusCode:response.status,body:await response.json()};
  }};
}

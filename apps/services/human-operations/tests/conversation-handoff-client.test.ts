import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { jwtVerify } from 'jose';
import { createConversationHandoffClient, resolveConversationHandoffConfig } from '../src/conversation-handoff-client.js';

const secret='local-conversation-staff-signing-secret-at-least-32';
const conversationId='11111111-1111-4111-8111-111111111111';
const sessionId='22222222-2222-4222-8222-222222222222';
const access={staffId:'support-1',tenantId:'tenant-local',environmentId:'local',role:'SUPPORT_AGENT' as const};
test('support service config is opt-in and rejects partial or reused signing keys',()=>{
  assert.equal(resolveConversationHandoffConfig({}),undefined);
  assert.throws(()=>resolveConversationHandoffConfig({CONVERSATION_RUNTIME_BASE_URL:'http://127.0.0.1:3004'}));
  assert.throws(()=>resolveConversationHandoffConfig({CONVERSATION_STAFF_ASSERTION_HMAC_SECRET:secret,HUMAN_ACCESS_HMAC_SECRET:secret}));
  assert.deepEqual(resolveConversationHandoffConfig({CONVERSATION_STAFF_ASSERTION_HMAC_SECRET:secret}),{baseUrl:'http://127.0.0.1:3004',secret,routingEpoch:1});
});
test('handoff client binds support actor and exact canonical reply command to Runtime only',async()=>{
  const calls: {url:URL;options:RequestInit}[]=[];
  const client=createConversationHandoffClient({baseUrl:'http://127.0.0.1:3004',secret,routingEpoch:1,
    fetcher:async(url,options)=>{calls.push({url:new URL(String(url)),options:options!});return Response.json({data:{}});}});
  const body={handoffSessionId:sessionId,expectedControlVersion:2,clientMessageId:'reply-1',content:{type:'text' as const,text:'  Hello customer  '}};
  await client.request({access,purpose:'handoff_reply',conversationId,body,idempotencyKey:'reply-key-123'});
  assert.equal(calls.length,1);
  const call=calls[0]!;
  assert.equal(call.url.pathname,`/v1/internal/handoffs/${conversationId}/messages`);
  assert.equal(call.options.redirect,'manual');
  assert.equal(call.options.cache,'no-store');
  assert.deepEqual(JSON.parse(String(call.options.body)),body);
  const assertion=new Headers(call.options.headers).get('x-cso-conversation-staff-assertion')!;
  const {payload}=await jwtVerify(assertion,new TextEncoder().encode(secret),{audience:'conversation-runtime-handoff',issuer:'customer-service-os-human-operations',typ:'cso-conversation-staff+jwt'});
  assert.equal(payload.staffId,'support-1');
  assert.equal(payload.role,'SUPPORT_AGENT');
  assert.equal(payload.httpMethod,'POST');
  assert.equal(payload.path,call.url.pathname);
  assert.equal(payload.conversationId,conversationId);
  assert.equal(payload.handoffSessionId,sessionId);
  assert.equal(payload.expectedControlVersion,2);
  assert.equal(payload.idempotencyKey,'reply-key-123');
  const canonical=`{"clientMessageId":"reply-1","content":{"text":"  Hello customer  ","type":"text"},"expectedControlVersion":2,"handoffSessionId":"${sessionId}"}`;
  assert.equal(payload.requestBodySha256,createHash('sha256').update(canonical).digest('hex'));
  assert.equal(payload.exp!-payload.iat!,60);
});
test('handoff list binds read-only path and rejects redirects and invalid commands',async()=>{
  let call:RequestInit|undefined;let endpoint='';
  const client=createConversationHandoffClient({baseUrl:'http://127.0.0.1:3004',secret,routingEpoch:1,
    fetcher:async(url,options)=>{endpoint=String(url);call=options;return new Response(null,{status:307});}});
  await assert.rejects(client.request({access,purpose:'handoff_list',limit:50,offset:0}),/redirect/i);
  assert.match(endpoint,/\/v1\/internal\/handoffs\?limit=50&offset=0$/);
  const {payload}=await jwtVerify(new Headers(call!.headers).get('x-cso-conversation-staff-assertion')!,new TextEncoder().encode(secret));
  assert.equal(payload.httpMethod,'GET');assert.equal(payload.requestBodySha256,undefined);
  await assert.rejects(client.request({access,purpose:'handoff_claim',conversationId,body:{handoffSessionId:sessionId,expectedControlVersion:1,staffId:'forged'},idempotencyKey:'claim-key-123'}));
  await assert.rejects(client.request({access,purpose:'handoff_list',limit:101}));
  await assert.rejects(client.request({access,purpose:'handoff_read',conversationId:'../other'}));
});

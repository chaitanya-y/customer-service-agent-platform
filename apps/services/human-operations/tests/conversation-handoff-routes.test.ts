import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import type { HandoffRequest } from '../src/conversation-handoff-client.js';

const conversationId='11111111-1111-4111-8111-111111111111';
const handoffSessionId='22222222-2222-4222-8222-222222222222';
const access={staffId:'support-1',tenantId:'tenant-local',environmentId:'local',role:'SUPPORT_AGENT' as const};
const headers={'x-cso-support-staff-assertion':'support-login','idempotency-key':'action-key-123'};
function fixture() {
  const calls:HandoffRequest[]=[];
  const app=buildApp({verifyHuman:async()=>{throw new Error('refund only');},sendDecision:async()=>{throw new Error('not used');},
    support:{verifyStaff:async(value)=>{if(value!=='support-login')throw new Error();return access;},
      client:{request:async(input)=>{calls.push(input);return {statusCode:200,body:{data:{conversationId,controlMode:'HUMAN'}}};}}}});
  return {app,calls};
}
test('support chat list and reply derive staff and scope only from separate support auth',async(t)=>{
  const {app,calls}=fixture();t.after(()=>app.close());
  assert.equal((await app.inject({method:'GET',url:'/v1/support-chats',headers})).statusCode,200);
  assert.deepEqual(calls[0],{access,purpose:'handoff_list',limit:50,offset:0});
  const body={handoffSessionId,expectedControlVersion:3,clientMessageId:'reply-1',content:{type:'text',text:'Hello customer'}};
  assert.equal((await app.inject({method:'POST',url:`/v1/support-chats/${conversationId}/messages`,headers,payload:body})).statusCode,200);
  assert.deepEqual(calls[1],{access,purpose:'handoff_reply',conversationId,body,idempotencyKey:'action-key-123'});
});
test('support routes reject privileged login headers and malformed actions before Runtime calls',async(t)=>{
  const {app,calls}=fixture();t.after(()=>app.close());
  assert.equal((await app.inject({method:'GET',url:'/v1/support-chats',headers:{'x-cso-human-assertion':'refund-login'}})).statusCode,401);
  for(const body of [{handoffSessionId,expectedControlVersion:0},{handoffSessionId,expectedControlVersion:1,staffId:'forged'}]) {
    assert.equal((await app.inject({method:'POST',url:`/v1/support-chats/${conversationId}/claim`,headers,payload:body})).statusCode,400);
  }
  assert.equal((await app.inject({method:'POST',url:`/v1/support-chats/${conversationId}/close`,headers:{'x-cso-support-staff-assertion':'support-login'},payload:{handoffSessionId,expectedControlVersion:1}})).statusCode,400);
  assert.equal((await app.inject({method:'GET',url:'/v1/support-chats?tenantId=other',headers})).statusCode,400);
  assert.equal(calls.length,0);
});
test('support routes do not claim success on Runtime timeout or leak internal errors',async(t)=>{
  const app=buildApp({verifyHuman:async()=>{throw new Error();},sendDecision:async()=>{},support:{verifyStaff:async()=>access,client:{request:async()=>{throw new Error('sensitive internal error');}}}});
  t.after(()=>app.close());
  const response=await app.inject({method:'GET',url:'/v1/support-chats',headers});
  assert.equal(response.statusCode,503);assert.doesNotMatch(response.body,/sensitive internal/);
});

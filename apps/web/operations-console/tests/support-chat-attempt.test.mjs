import assert from "node:assert/strict";
import { test } from "node:test";
import { clearSupportAttemptStorage, keepSupportAttemptForUnavailableDetail, nextSupportAttempt, parseSupportAttempt, reconcileSupportDetail, supportAttemptBody } from "../components/support-chat-attempt.ts";
const chat={conversationId:"11111111-1111-4111-8111-111111111111",handoffSessionId:"22222222-2222-4222-8222-222222222222",controlVersion:2};
test("uncertain reply keeps exact payload and idempotency key even when polling advances control",()=>{
  const first=nextSupportAttempt(undefined,chat,"messages","  Hello  ",()=>"key-12345678");
  assert.equal(nextSupportAttempt(first,{...chat,controlVersion:3},"messages","  Hello  ",()=>"new-12345678"),first);
  assert.deepEqual(supportAttemptBody(first),{handoffSessionId:chat.handoffSessionId,expectedControlVersion:2,clientMessageId:"key-12345678",content:{type:"text",text:"  Hello  "}});
  assert.throws(()=>nextSupportAttempt(first,chat,"messages","Different",()=>"new-12345678"),/retry/i);
  assert.throws(()=>nextSupportAttempt(first,chat,"close",undefined,()=>"new-12345678"),/retry/i);
});
test("stale polling cannot replace a newer control state or truncate staff transcript",()=>{
  const current={detail:{...chat,messages:[{sequenceNumber:4}]},requestSequence:5};
  assert.equal(reconcileSupportDetail(current,{...chat,controlVersion:1,messages:[]},6),current);
  assert.equal(reconcileSupportDetail(current,{...chat,messages:[{sequenceNumber:2}]},6),current);
  assert.equal(reconcileSupportDetail(current,{...chat,messages:[{sequenceNumber:4}]},4),current);
});

test("a pending staff reply survives a tab reload with its exact text and idempotency identity",()=>{
  const first=nextSupportAttempt(undefined,chat,"messages","Please send a clearer photo.",()=>"key-12345678");
  const restored=parseSupportAttempt(JSON.stringify(first),chat.conversationId);
  assert.deepEqual(restored,first);
  assert.equal(restored?.clientMessageId,restored?.idempotencyKey);
  assert.equal(nextSupportAttempt(restored,{...chat,controlVersion:3},"messages","Please send a clearer photo.",()=>"different-key"),restored);
});

test("stored pending actions cannot be reused for another chat or with malformed payloads",()=>{
  const first=nextSupportAttempt(undefined,chat,"messages","Hello",()=>"key-12345678");
  assert.equal(parseSupportAttempt(JSON.stringify(first),"33333333-3333-4333-8333-333333333333"),undefined);
  assert.equal(parseSupportAttempt(JSON.stringify({...first,clientMessageId:"different-key"}),chat.conversationId),undefined);
  assert.equal(parseSupportAttempt(JSON.stringify({...first,text:""}),chat.conversationId),undefined);
  assert.equal(parseSupportAttempt(JSON.stringify({...first,action:"refund"}),chat.conversationId),undefined);
  assert.equal(parseSupportAttempt("not-json",chat.conversationId),undefined);
});

test("a non-message staff action also restores only its exact original identity",()=>{
  const first=nextSupportAttempt(undefined,chat,"claim",undefined,()=>"key-12345678");
  assert.deepEqual(parseSupportAttempt(JSON.stringify(first),chat.conversationId),first);
  assert.equal(parseSupportAttempt(JSON.stringify({...first,text:"unexpected"}),chat.conversationId),undefined);
});

test("an unavailable detail retains only an exact unresolved action for manual retry",()=>{
  const pending=nextSupportAttempt(undefined,chat,"close",undefined,()=>"key-12345678");
  assert.equal(keepSupportAttemptForUnavailableDetail(404,pending),true);
  assert.equal(keepSupportAttemptForUnavailableDetail(404,undefined),false);
  assert.equal(keepSupportAttemptForUnavailableDetail(401,pending),false);
});

test("explicit support sign-out erases every tab-scoped support attempt but no other storage",()=>{
  const values=new Map([
    [`cso.support-chat.attempt:${chat.conversationId}`,"private draft"],
    ["cso.support-chat.attempt:second","another draft"],
    ["cso.delivery-report.transition:report-1","keep"],
  ]);
  const store={get length(){return values.size;},key(index){return [...values.keys()][index]??null;},removeItem(key){values.delete(key);}};
  clearSupportAttemptStorage(store);
  assert.deepEqual([...values.entries()],[["cso.delivery-report.transition:report-1","keep"]]);
});

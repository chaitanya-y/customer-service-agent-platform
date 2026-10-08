import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSupportDetail, normalizeSupportQueue, parseSupportCommand, supportChatPath, supportChatQuery } from "../components/support-chat.ts";
const id="11111111-1111-4111-8111-111111111111", session="22222222-2222-4222-8222-222222222222";
const summary={conversationId:id,status:"OPEN",controlMode:"QUEUED",controlVersion:2,handoffSessionId:session,assignedToMe:false,canClaim:true,canReply:false,canFinish:false,queuedAt:"2026-10-02T12:00:00Z"};
test("support queue/detail validate control and project only supported transcript fields",()=>{
  assert.deepEqual(normalizeSupportQueue({data:{items:[summary],hasMore:false}}),{items:[summary],hasMore:false});
  const detail=normalizeSupportDetail({data:{...summary,workflowStartPending:true,pendingRefundStarts:[{workflowId:"refund-1",status:"PENDING"}],messages:[{messageId:"33333333-3333-4333-8333-333333333333",sequenceNumber:1,senderKind:"WORKFORCE",text:"A person is helping.",createdAt:"2026-10-02T12:01:00Z",privateNote:"not rendered"}]}});
  assert.equal(detail.messages[0].senderKind,"WORKFORCE");assert.equal(detail.messages[0].privateNote,undefined);assert.equal(detail.workflowStartPending,true);
  for(const body of [{data:{items:[{...summary,controlMode:"UNKNOWN"}],hasMore:false}},{data:{items:[{...summary,controlVersion:0}],hasMore:false}}])assert.throws(()=>normalizeSupportQueue(body),/invalid/i);
});
test("support command paths and bodies cannot impersonate staff or invoke refund actions",()=>{
  assert.equal(supportChatPath("claim",id),`/v1/support-chats/${id}/claim`);
  assert.equal(supportChatQuery(new URLSearchParams("limit=50&offset=0")),"?limit=50&offset=0");
  assert.deepEqual(parseSupportCommand("messages",{handoffSessionId:session,expectedControlVersion:2,clientMessageId:"reply-1",content:{type:"text",text:"  Hello  "}}),{handoffSessionId:session,expectedControlVersion:2,clientMessageId:"reply-1",content:{type:"text",text:"  Hello  "}});
  for(const value of [{handoffSessionId:session,expectedControlVersion:2,staffId:"forged"},{handoffSessionId:session,expectedControlVersion:0}])assert.throws(()=>parseSupportCommand("claim",value));
  assert.throws(()=>supportChatPath("APPROVE",id));assert.throws(()=>supportChatPath("read","../other"));
  assert.throws(()=>supportChatQuery(new URLSearchParams("tenantId=other")));
  assert.throws(()=>parseSupportCommand("messages",{handoffSessionId:session,expectedControlVersion:2,clientMessageId:"reply-1",content:{type:"text",text:" "}}));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const require=createRequire(import.meta.url);
function controls(){const source=ts.transpileModule(readFileSync(new URL("../components/support-chat-detail.tsx",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;const module={exports:{}};new Function("require","module","exports",source)((name)=>name.endsWith(".css")?{default:{}}:name.startsWith("./")?{}:require(name),module,module.exports);return module.exports.SupportChatControls;}
const chat={conversationId:"11111111-1111-4111-8111-111111111111",status:"OPEN",controlMode:"QUEUED",controlVersion:2,handoffSessionId:"22222222-2222-4222-8222-222222222222",assignedToMe:false,canClaim:true,canReply:false,canFinish:false,messages:[],workflowStartPending:false,pendingRefundStarts:[]};
test("queued chat offers claim but no staff composer or monetary approval",()=>{
  const html=renderToStaticMarkup(React.createElement(controls(),{chat,draft:"",busy:false,onDraft:()=>{},onAction:()=>{}}));
  assert.match(html,/Claim conversation/);assert.doesNotMatch(html,/<textarea|Approve.*refund/);
});
test("only assigned human control renders reply and finish actions with honest refund warning",()=>{
  const html=renderToStaticMarkup(React.createElement(controls(),{chat:{...chat,controlMode:"HUMAN",assignedToMe:true,canClaim:false,canReply:true,canFinish:true,workflowStartPending:true},draft:"Hello",busy:false,onDraft:()=>{},onAction:()=>{}}));
  assert.match(html,/<textarea/);assert.match(html,/Send reply/);assert.match(html,/Return to AI/);assert.match(html,/Close conversation/);
  assert.match(html,/refund.*continue|continue.*refund/i);assert.match(html,/does not cancel.*refund/i);
});
test("an uncertain reply exposes exact retry and prevents competing new actions",()=>{
  const html=renderToStaticMarkup(React.createElement(controls(),{chat:{...chat,controlMode:"HUMAN",assignedToMe:true,canClaim:false,canReply:true,canFinish:true},draft:"Hello",busy:false,pendingAction:"messages",onDraft:()=>{},onAction:()=>{}}));
  assert.match(html,/Retry pending action/);assert.match(html,/disabled/);
});

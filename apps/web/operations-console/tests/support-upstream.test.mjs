import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require=createRequire(import.meta.url),{NextRequest}=require("next/server");
const oldFetch=globalThis.fetch,oldEnv={NODE_ENV:process.env.NODE_ENV,CSO_LOCAL_SUPPORT_STAFF_TOKEN:process.env.CSO_LOCAL_SUPPORT_STAFF_TOKEN};
afterEach(()=>{globalThis.fetch=oldFetch;for(const [k,v] of Object.entries(oldEnv))if(v===undefined)delete process.env[k];else process.env[k]=v;});
function source(path,deps={}){const output=ts.transpileModule(readFileSync(new URL(path,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const module={exports:{}};new Function("require","module","exports",output)((id)=>id in deps?deps[id]:require(id),module,module.exports);return module.exports;}
function proxy(){return source("../lib/support-operations-proxy.ts",{"server-only":{},"../components/support-chat":source("../components/support-chat.ts"),"./safe-staff-fetch":source("../lib/safe-staff-fetch.ts")});}
const id="11111111-1111-4111-8111-111111111111",session="22222222-2222-4222-8222-222222222222";
function request(method="GET",extra={}){return new NextRequest("http://127.0.0.1:3101/api/support-chats",{method,headers:{cookie:"cso_local_support_staff_session=active",...(method==="POST"?{origin:"http://127.0.0.1:3101","content-type":"application/json","idempotency-key":"reply-key-123"}:{}),...extra},...(method==="POST"?{body:JSON.stringify({handoffSessionId:session,expectedControlVersion:2})}:{})});}
test("support BFF never accepts refund/delivery cookie or browser token as support authorization",async()=>{
  process.env.NODE_ENV="development";process.env.CSO_LOCAL_SUPPORT_STAFF_TOKEN="server-only-support-test";
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:{}});};
  const result=await proxy().proxySupportChat(request("GET",{cookie:"cso_local_human_session=active",authorization:"Bearer refund-token"}),"list");
  assert.equal(result.status,401);assert.equal(calls,0);
});
test("support BFF sends separate server-held support assertion and rejects cross-origin writes",async()=>{
  process.env.NODE_ENV="development";process.env.CSO_LOCAL_SUPPORT_STAFF_TOKEN="server-only-support-test";
  const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({data:{}});};
  const denied=await proxy().proxySupportChat(request("POST",{origin:"https://attacker.example"}),"claim",id);
  assert.equal(denied.status,403);assert.equal(calls.length,0);
  const response=await proxy().proxySupportChat(request("POST"),"claim",id);
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, no-store");
  assert.equal(calls[0].url.pathname,`/v1/support-chats/${id}/claim`);assert.equal(calls[0].init.redirect,"manual");
  assert.equal(calls[0].init.headers["x-cso-support-staff-assertion"],"server-only-support-test");
  assert.equal(calls[0].init.headers["x-cso-human-assertion"],undefined);
  assert.equal(calls[0].init.headers["idempotency-key"],"reply-key-123");
});
test("support BFF refuses upstream redirects and separate sign-out clears support cookie",async()=>{
  process.env.NODE_ENV="development";process.env.CSO_LOCAL_SUPPORT_STAFF_TOKEN="server-only-support-test";
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:"https://attacker.example"}});
  const api=proxy();assert.equal((await api.proxySupportChat(request(),"list")).status,502);
  const route=source("../app/api/support-local-session/route.ts",{"../../../lib/support-operations-proxy":api});
  const response=await route.DELETE(request("POST"));
  assert.equal(response.status,200);assert.match(response.headers.get("set-cookie"),/cso_local_support_staff_session=.*Max-Age=0/i);
  assert.doesNotMatch(await response.text(),/server-only-support-test/);
});

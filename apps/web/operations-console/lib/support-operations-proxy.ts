import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { parseSupportCommand, supportChatPath, supportChatQuery, type SupportAction } from "../components/support-chat";
import { safeStaffFetch } from "./safe-staff-fetch";

export const LOCAL_SUPPORT_SESSION_COOKIE="cso_local_support_staff_session";
const baseUrl=process.env.HUMAN_OPERATIONS_BASE_URL??"http://127.0.0.1:3003";
export function supportProxyError(status:number,code:string,message:string):NextResponse{return NextResponse.json({error:{code,message}},{status,headers:{"cache-control":"private, no-store"}});}
export function isSupportLocalEnabled():boolean{return process.env.NODE_ENV==="development"&&Boolean(process.env.CSO_LOCAL_SUPPORT_STAFF_TOKEN);}
export function hasSupportSameOrigin(request:NextRequest):boolean{
  const origin=request.headers.get("origin");
  return origin===request.nextUrl.origin||(process.env.NODE_ENV!=="production"&&origin==="http://127.0.0.1:3101");
}
export function authorizeSupportRequest(request:NextRequest,mutation=false):string|NextResponse{
  const token=process.env.CSO_LOCAL_SUPPORT_STAFF_TOKEN;
  if(!isSupportLocalEnabled()||!token)return supportProxyError(503,"support_staff_auth_unavailable","Local support staff authentication is unavailable.");
  if(request.cookies.get(LOCAL_SUPPORT_SESSION_COOKIE)?.value!=="active")return supportProxyError(401,"support_staff_unauthenticated","Support staff authentication is required.");
  if(mutation&&!hasSupportSameOrigin(request))return supportProxyError(403,"invalid_request_origin","The request origin is not allowed.");
  return token;
}
export async function proxySupportChat(request:NextRequest,action:SupportAction|"list"|"read",conversationId?:string):Promise<NextResponse>{
  const mutation=action!=="list"&&action!=="read";
  const token=authorizeSupportRequest(request,mutation);if(token instanceof NextResponse)return token;
  let path:string,body:string|undefined,idempotencyKey:string|undefined;
  try{path=supportChatPath(action,conversationId);if(action==="list")path+=supportChatQuery(request.nextUrl.searchParams);}
  catch{return supportProxyError(400,"invalid_support_chat_request","Support chat request is invalid.");}
  if(mutation){
    idempotencyKey=request.headers.get("idempotency-key")??undefined;
    if(!idempotencyKey||!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey))return supportProxyError(400,"idempotency_key_required","An idempotency key is required.");
    if(!request.headers.get("content-type")?.includes("application/json"))return supportProxyError(415,"unsupported_media_type","Requests must use application/json.");
    try{body=JSON.stringify(parseSupportCommand(action as SupportAction,await request.json()));}
    catch{return supportProxyError(400,"invalid_support_chat_command","A current session and version are required.");}
  }
  try{
    const response=await safeStaffFetch(new URL(path,baseUrl),{method:mutation?"POST":"GET",body,cache:"no-store",signal:AbortSignal.timeout(15000),
      headers:{accept:"application/json","x-cso-support-staff-assertion":token,...(body?{"content-type":"application/json"}:{}),...(idempotencyKey?{"idempotency-key":idempotencyKey}:{})}});
    return new NextResponse(await response.text(),{status:response.status,headers:{"cache-control":"private, no-store","content-type":response.headers.get("content-type")??"application/json"}});
  }catch{return supportProxyError(502,"support_chats_unavailable","Support chat is temporarily unavailable. Retry the same action if its result is uncertain.");}
}

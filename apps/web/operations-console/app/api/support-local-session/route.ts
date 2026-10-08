import { NextRequest, NextResponse } from "next/server";
import { hasSupportSameOrigin, isSupportLocalEnabled, LOCAL_SUPPORT_SESSION_COOKIE, supportProxyError } from "../../../lib/support-operations-proxy";
export async function POST(request:NextRequest){
  if(!hasSupportSameOrigin(request))return supportProxyError(403,"invalid_request_origin","The request origin is not allowed.");
  if(!isSupportLocalEnabled())return supportProxyError(503,"support_staff_auth_unavailable","Local support staff authentication is unavailable.");
  const response=NextResponse.json({data:{status:"authenticated"}},{headers:{"cache-control":"private, no-store"}});
  response.cookies.set({name:LOCAL_SUPPORT_SESSION_COOKIE,value:"active",httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/"});
  return response;
}
export async function DELETE(request:NextRequest){
  if(!hasSupportSameOrigin(request))return supportProxyError(403,"invalid_request_origin","The request origin is not allowed.");
  const response=NextResponse.json({data:{status:"signed_out"}},{headers:{"cache-control":"private, no-store"}});
  response.cookies.set({name:LOCAL_SUPPORT_SESSION_COOKIE,value:"",httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/",maxAge:0});
  return response;
}

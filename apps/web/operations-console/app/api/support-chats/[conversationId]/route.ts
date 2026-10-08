import { NextRequest } from "next/server";
import { proxySupportChat } from "../../../../lib/support-operations-proxy";
export async function GET(request:NextRequest,context:{params:Promise<{conversationId:string}>}){return proxySupportChat(request,"read",(await context.params).conversationId);}

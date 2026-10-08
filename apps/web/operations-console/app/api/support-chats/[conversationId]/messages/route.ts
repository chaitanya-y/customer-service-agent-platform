import { NextRequest } from "next/server";
import { proxySupportChat } from "../../../../../lib/support-operations-proxy";
export async function POST(request:NextRequest,context:{params:Promise<{conversationId:string}>}){return proxySupportChat(request,"messages",(await context.params).conversationId);}

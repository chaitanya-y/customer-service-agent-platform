import { NextRequest } from "next/server";
import { proxySupportChat } from "../../../lib/support-operations-proxy";
export async function GET(request:NextRequest){return proxySupportChat(request,"list");}

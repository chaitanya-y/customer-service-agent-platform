import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SupportChatDetail } from "../../../components/support-chat-detail";
import { LOCAL_SUPPORT_SESSION_COOKIE } from "../../../lib/support-operations-proxy";
export default async function SupportChatPage({params}:Readonly<{params:Promise<{conversationId:string}>}>){
  const [{conversationId},cookieStore]=await Promise.all([params,cookies()]);
  if(cookieStore.get(LOCAL_SUPPORT_SESSION_COOKIE)?.value!=="active")redirect("/support-sign-in");
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId))notFound();
  return <main className="cso-page-shell"><header className="cso-topbar"><span className="cso-brand">Customer Service OS · Support Operations</span><ThemeControl /></header><SupportChatDetail conversationId={conversationId} /></main>;
}

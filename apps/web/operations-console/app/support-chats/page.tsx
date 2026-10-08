import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SupportChatQueue } from "../../components/support-chat-queue";
import { LOCAL_SUPPORT_SESSION_COOKIE } from "../../lib/support-operations-proxy";
export default async function SupportChatsPage(){
  if((await cookies()).get(LOCAL_SUPPORT_SESSION_COOKIE)?.value!=="active")redirect("/support-sign-in");
  return <main className="cso-page-shell"><header className="cso-topbar"><span className="cso-brand">Customer Service OS · Support Operations</span><ThemeControl /></header><SupportChatQueue /></main>;
}

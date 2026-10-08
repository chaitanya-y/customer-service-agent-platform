import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { handoffCommandSchema, handoffReplySchema, handoffListQuerySchema, type ConversationHandoffClient, type HandoffPurpose, type HandoffRequest } from './conversation-handoff-client.js';
import { SUPPORT_STAFF_ASSERTION_HEADER, type VerifySupportStaffAssertion } from './support-staff-access.js';

export type SupportChatRoutesOptions=Readonly<{verifyStaff:VerifySupportStaffAssertion;client:ConversationHandoffClient}>;
const params=z.object({conversationId:z.uuid()}).strict();
const key=z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const error=(reply:FastifyReply,status:number,code:string,message:string)=>reply.code(status).send({error:{code,message}});
export function registerSupportChatRoutes(app:FastifyInstance,options:SupportChatRoutesOptions){
  async function handle(request:FastifyRequest,reply:FastifyReply,purpose:HandoffPurpose){
    reply.header('cache-control','private, no-store');
    let access;
    try { const assertion=request.headers[SUPPORT_STAFF_ASSERTION_HEADER];access=await options.verifyStaff(typeof assertion==='string'?assertion:undefined); }
    catch{return error(reply,401,'support_staff_unauthorized','Support staff authentication is required.');}
    const input:{access:typeof access;purpose:HandoffPurpose;conversationId?:string;body?:unknown;idempotencyKey?:string;limit?:number;offset?:number}={access,purpose};
    if(purpose==='handoff_list'){
      const query=handoffListQuerySchema.safeParse(request.query);
      if(!query.success)return error(reply,400,'invalid_support_chat_request','Support chat query is invalid.');
      input.limit=query.data.limit;input.offset=query.data.offset;
    }else{
      const parsed=params.safeParse(request.params);
      if(!parsed.success)return error(reply,400,'invalid_support_chat_request','Support conversation is invalid.');
      input.conversationId=parsed.data.conversationId;
      if(purpose!=='handoff_read'){
        const body=(purpose==='handoff_reply'?handoffReplySchema:handoffCommandSchema).safeParse(request.body);
        const parsedKey=key.safeParse(request.headers['idempotency-key']);
        if(!body.success||!parsedKey.success)return error(reply,400,'invalid_support_chat_command','A current session, version and idempotency key are required.');
        input.body=body.data;input.idempotencyKey=parsedKey.data;
      }
    }
    try{
      const result=await options.client.request(input as HandoffRequest);
      if(result.statusCode>=200&&result.statusCode<300)return reply.code(result.statusCode).send(result.body);
      const status=[400,401,403,404,409].includes(result.statusCode)?result.statusCode:503;
      const messages:Record<number,string>={400:'Support chat request is invalid.',401:'Support chat authorization is unavailable.',403:'This support chat action is not allowed.',404:'Support conversation was not found.',409:'The conversation changed. Refresh before taking another action.'};
      return error(reply,status,status===409?'support_chat_conflict':'support_chat_unavailable',messages[status]??'Support chat is temporarily unavailable.');
    }catch{return error(reply,503,'support_chat_unavailable','Support chat is temporarily unavailable.');}
  }
  app.get('/v1/support-chats',(request,reply)=>handle(request,reply,'handoff_list'));
  app.get('/v1/support-chats/:conversationId',(request,reply)=>handle(request,reply,'handoff_read'));
  for(const [action,purpose] of Object.entries({claim:'handoff_claim',messages:'handoff_reply','return-to-ai':'handoff_return_to_ai',close:'handoff_close'} as const)){
    app.post(`/v1/support-chats/:conversationId/${action}`,(request,reply)=>handle(request,reply,purpose));
  }
}

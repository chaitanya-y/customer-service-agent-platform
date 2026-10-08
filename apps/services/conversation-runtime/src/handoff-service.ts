import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { ProtectMessage, UnprotectMessage } from './message-protection.js';
import type { ConversationAccessContext } from './trusted-context.js';
import { ConversationUnavailableError, IdempotencyConflictError, MessageTooLargeError, type AcceptedMessage } from './conversation-service.js';
import { transitionHandoff, type HandoffState, type HandoffAction } from './handoff-state.js';
import { canonicalHandoffBodyHash, StaffAssertionError, type StaffAccessContext } from './staff-assertion.js';

const stateSchema = z.object({
  subject_customer_id: z.string(), status: z.enum(['OPEN', 'CLOSED']), control_mode: z.enum(['AI', 'QUEUED', 'HUMAN']),
  control_version: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER), handoff_session_id: z.string().nullable(),
  assigned_staff_id: z.string().nullable(), queued_at: z.date().nullable(),
});
type StoredState = z.infer<typeof stateSchema>;
export type ControlState = { conversationId: string; status: 'OPEN' | 'CLOSED'; controlMode: 'AI' | 'QUEUED' | 'HUMAN'; controlVersion: number; handoffSessionId?: string };
export type HandoffCommand = { handoffSessionId: string; expectedControlVersion: number; clientMessageId?: string; content?: { type: 'text'; text: string } };
export type StaffSummary = ControlState & { queuedAt: string; assignedToMe: boolean; canClaim: boolean; canReply: boolean; canFinish: boolean };
type Scope = { tenantId: string; environmentId: string; requestId: string; traceId: string; routingEpoch: number };

function state(row: StoredState): HandoffState {
  return { status: row.status, controlMode: row.control_mode, controlVersion: row.control_version, handoffSessionId: row.handoff_session_id, assignedStaffId: row.assigned_staff_id };
}
function projection(conversationId: string, value: HandoffState): ControlState {
  return { conversationId, status: value.status, controlMode: value.controlMode, controlVersion: value.controlVersion, ...(value.handoffSessionId ? { handoffSessionId: value.handoffSessionId } : {}) };
}
export class PostgresHandoffService {
  constructor(private readonly pool: Pool, private readonly protect: ProtectMessage, private readonly unprotect: UnprotectMessage, private readonly id: () => string = uuidv7) {}

  async request(input: { context: ConversationAccessContext; conversationId: string; expectedControlVersion: number; idempotencyKey: string }): Promise<ControlState> {
    return this.transaction(input.context, async (client) => {
      const row = await this.lock(client, input.context, input.conversationId);
      if (row.subject_customer_id !== input.context.subjectCustomerId) throw new ConversationUnavailableError();
      const operation = 'conversation.handoff.request';
      const scope = `${input.conversationId}:customer:${input.context.subjectCustomerId}`;
      const hash = canonicalHandoffBodyHash({ expectedControlVersion: input.expectedControlVersion });
      const duplicate = await this.replay<ControlState>(client, input.context, operation, scope, input.idempotencyKey, hash);
      if (duplicate) return duplicate;
      const changed = transitionHandoff(state(row), 'request', input.expectedControlVersion, this.id());
      await this.updateControl(client, input.context, input.conversationId, changed);
      const result = projection(input.conversationId, changed);
      await this.remember(client, input.context, operation, scope, input.idempotencyKey, hash, result);
      await this.outbox(client, input.context, input.conversationId, changed.controlVersion, 'conversation.control.changed.v1', { controlMode: changed.controlMode, status: changed.status, controlVersion: changed.controlVersion });
      return result;
    });
  }

  async command(input: { context: StaffAccessContext; conversationId: string; action: Exclude<HandoffAction, 'request'>; body: HandoffCommand; idempotencyKey: string }): Promise<ControlState | { control: ControlState; message: AcceptedMessage }> {
    const { context, body } = input;
    const purpose = { claim: 'handoff_claim', reply: 'handoff_reply', return_to_ai: 'handoff_return_to_ai', close: 'handoff_close' }[input.action];
    if (context.purpose === 'handoff_list' || context.purpose === 'handoff_read'
      || context.purpose !== purpose || context.conversationId !== input.conversationId
      || context.handoffSessionId !== body.handoffSessionId || context.expectedControlVersion !== body.expectedControlVersion
      || context.idempotencyKey !== input.idempotencyKey || context.requestBodySha256 !== canonicalHandoffBodyHash(body)) throw new StaffAssertionError();
    return this.transaction(context, async (client) => {
      const row = await this.lock(client, context, input.conversationId);
      const operation = `conversation.${purpose}`;
      const scope = `${input.conversationId}:staff:${context.staffId}`;
      const hash = canonicalHandoffBodyHash(body);
      const duplicate = await this.replay<ControlState | { control: ControlState; message: AcceptedMessage }>(client, context, operation, scope, input.idempotencyKey, hash);
      if (duplicate) return duplicate;
      const changed = transitionHandoff(state(row), input.action, body.expectedControlVersion, body.handoffSessionId, context.staffId);
      let result: ControlState | { control: ControlState; message: AcceptedMessage };
      if (input.action === 'reply') result = { control: projection(input.conversationId, changed), message: await this.reply(client, context, input.conversationId, body) };
      else {
        await this.updateControl(client, context, input.conversationId, changed);
        result = projection(input.conversationId, changed);
        await this.outbox(client, context, input.conversationId, changed.controlVersion, 'conversation.control.changed.v1', { controlMode: changed.controlMode, status: changed.status, controlVersion: changed.controlVersion });
      }
      await this.remember(client, context, operation, scope, input.idempotencyKey, hash, result);
      return result;
    });
  }

  async list(context: StaffAccessContext, limit: number, offset: number): Promise<{ items: StaffSummary[]; hasMore: boolean }> {
    if (context.purpose !== 'handoff_list' || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new StaffAssertionError();
    return this.transaction(context, async (client) => {
      const result = await client.query(`SELECT conversation_id,subject_customer_id,status,control_mode,control_version,handoff_session_id,assigned_staff_id,queued_at FROM conversation.conversations WHERE tenant_id=$1 AND environment_id=$2 AND status='OPEN' AND (control_mode='QUEUED' OR (control_mode='HUMAN' AND assigned_staff_id=$3)) ORDER BY queued_at,conversation_id LIMIT $4 OFFSET $5`, [context.tenantId, context.environmentId, context.staffId, limit + 1, offset]);
      return { items: result.rows.slice(0, limit).map((row) => this.summary(String(row.conversation_id), stateSchema.parse(row), context.staffId)), hasMore: result.rows.length > limit };
    });
  }

  async detail(context: StaffAccessContext, conversationId: string) {
    if (context.purpose !== 'handoff_read' || context.conversationId !== conversationId) throw new StaffAssertionError();
    return this.transaction(context, async (client) => {
      const row = await this.lock(client, context, conversationId);
      if (row.status !== 'OPEN' || (row.control_mode !== 'QUEUED' && !(row.control_mode === 'HUMAN' && row.assigned_staff_id === context.staffId))) throw new ConversationUnavailableError();
      const messages = await client.query(`SELECT message.message_id,message.sequence_number,message.sender_kind,message.content_length,message.content_sha256,message.created_at,message.refund_workflow_id,payload.ciphertext,payload.initialization_vector,payload.authentication_tag,payload.encryption_key_version FROM conversation.messages AS message JOIN conversation.message_payloads AS payload ON payload.tenant_id=message.tenant_id AND payload.environment_id=message.environment_id AND payload.payload_id=message.payload_id WHERE message.tenant_id=$1 AND message.environment_id=$2 AND message.conversation_id=$3 AND message.status='COMMITTED' AND message.sender_kind IN ('END_CUSTOMER','ASSISTANT','WORKFORCE') ORDER BY message.sequence_number`, [context.tenantId, context.environmentId, conversationId]);
      const pending = await client.query(`SELECT workflow_id FROM conversation.refund_start_reservations WHERE tenant_id=$1 AND environment_id=$2 AND conversation_id=$3 AND status='PENDING' ORDER BY created_at,workflow_id`, [context.tenantId, context.environmentId, conversationId]);
      return { ...this.summary(conversationId, row, context.staffId),
        messages: messages.rows.map((message) => ({ messageId: message.message_id as string, sequenceNumber: Number(message.sequence_number), senderKind: message.sender_kind as 'END_CUSTOMER' | 'ASSISTANT' | 'WORKFORCE', text: this.unprotect({ ciphertext: message.ciphertext as Buffer, initializationVector: message.initialization_vector as Buffer, authenticationTag: message.authentication_tag as Buffer, encryptionKeyVersion: message.encryption_key_version as string, plaintextByteLength: message.content_length as number, plaintextSha256: message.content_sha256 as string }), createdAt: (message.created_at as Date).toISOString(), ...(message.refund_workflow_id ? { refundWorkflowId: message.refund_workflow_id as string } : {}) })),
        pendingRefundStarts: pending.rows.map((reservation) => ({ workflowId: reservation.workflow_id as string, status: 'PENDING' as const })), workflowStartPending: pending.rows.length > 0,
      };
    });
  }

  private summary(id: string, row: StoredState, staffId: string): StaffSummary {
    if (!row.queued_at) throw new Error('Invalid handoff timestamp');
    const assignedToMe = row.assigned_staff_id === staffId;
    const canReply = row.status === 'OPEN' && row.control_mode === 'HUMAN' && assignedToMe;
    return { ...projection(id, state(row)), queuedAt: row.queued_at.toISOString(), assignedToMe, canClaim: row.status === 'OPEN' && row.control_mode === 'QUEUED', canReply, canFinish: canReply };
  }

  private async reply(client: PoolClient, context: StaffAccessContext, conversationId: string, body: HandoffCommand): Promise<AcceptedMessage> {
    if (!body.content?.text || !body.clientMessageId || !body.content.text.trim() || body.content.text.length > 2000 || Buffer.byteLength(body.content.text, 'utf8') > 32768) throw new MessageTooLargeError();
    const protectedMessage = this.protect(body.content.text);
    const clientId = `workforce:${body.handoffSessionId}:${context.staffId}:${body.clientMessageId}`;
    const previous = await client.query(`SELECT message_id,sequence_number,content_sha256 FROM conversation.messages WHERE tenant_id=$1 AND environment_id=$2 AND conversation_id=$3 AND client_message_id=$4`, [context.tenantId, context.environmentId, conversationId, clientId]);
    if (previous.rowCount) {
      if (previous.rows[0]?.content_sha256 !== protectedMessage.plaintextSha256) throw new IdempotencyConflictError();
      return { conversationId, messageId: previous.rows[0].message_id as string, sequenceNumber: Number(previous.rows[0].sequence_number), status: 'ACCEPTED' };
    }
    const allocated = await client.query(`UPDATE conversation.conversations SET next_sequence_number=next_sequence_number+1,record_version=record_version+1,updated_at=now() WHERE tenant_id=$1 AND environment_id=$2 AND conversation_id=$3 RETURNING next_sequence_number-1 AS sequence_number`, [context.tenantId, context.environmentId, conversationId]);
    const sequence = Number(allocated.rows[0]?.sequence_number);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid conversation sequence');
    const payloadId = this.id(); const messageId = this.id();
    await client.query(`INSERT INTO conversation.message_payloads(tenant_id,environment_id,payload_id,ciphertext,initialization_vector,authentication_tag,encryption_key_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())`, [context.tenantId, context.environmentId, payloadId, protectedMessage.ciphertext, protectedMessage.initializationVector, protectedMessage.authenticationTag, protectedMessage.encryptionKeyVersion]);
    await client.query(`INSERT INTO conversation.messages(tenant_id,environment_id,conversation_id,sequence_number,message_id,client_message_id,sender_kind,payload_id,content_type,content_length,content_sha256,status,created_at,handoff_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'text/plain',$9,$10,'COMMITTED',now(),$11)`, [context.tenantId, context.environmentId, conversationId, sequence, messageId, clientId, 'WORKFORCE', payloadId, protectedMessage.plaintextByteLength, protectedMessage.plaintextSha256, body.handoffSessionId]);
    await this.outbox(client, context, conversationId, sequence, 'conversation.staff-message.committed.v1', { messageId });
    return { conversationId, messageId, sequenceNumber: sequence, status: 'ACCEPTED' };
  }

  private async lock(client: PoolClient, context: Scope, id: string): Promise<StoredState> {
    const result = await client.query(`SELECT subject_customer_id, status, control_mode, control_version, handoff_session_id, assigned_staff_id, queued_at FROM conversation.conversations WHERE tenant_id=$1 AND environment_id=$2 AND conversation_id=$3 FOR UPDATE`, [context.tenantId, context.environmentId, id]);
    if (result.rowCount !== 1) throw new ConversationUnavailableError();
    return stateSchema.parse(result.rows[0]);
  }
  private async updateControl(client: PoolClient, context: Scope, id: string, changed: HandoffState) {
    await client.query(`UPDATE conversation.conversations SET status=$4, control_mode=$5, control_version=$6, handoff_session_id=$7, assigned_staff_id=$8, queued_at=CASE WHEN $5='AI' THEN NULL WHEN queued_at IS NULL THEN now() ELSE queued_at END, record_version=record_version+1, updated_at=now() WHERE tenant_id=$1 AND environment_id=$2 AND conversation_id=$3`, [context.tenantId, context.environmentId, id, changed.status, changed.controlMode, changed.controlVersion, changed.handoffSessionId, changed.assignedStaffId]);
  }
  private async replay<T>(client: PoolClient, context: Scope, operation: string, scope: string, key: string, hash: string): Promise<T | undefined> {
    const result = await client.query(`SELECT canonical_request_hash,result_json FROM events.idempotency_keys WHERE tenant_id=$1 AND environment_id=$2 AND operation=$3 AND resource_scope=$4 AND idempotency_key=$5`, [context.tenantId, context.environmentId, operation, scope, key]);
    if (!result.rowCount) return undefined;
    if (result.rows[0]?.canonical_request_hash !== hash) throw new IdempotencyConflictError();
    return result.rows[0].result_json as T;
  }
  private async remember(client: PoolClient, context: Scope, operation: string, scope: string, key: string, hash: string, result: unknown) {
    await client.query(`INSERT INTO events.idempotency_keys(tenant_id,environment_id,operation,resource_scope,idempotency_key,canonical_request_hash,result_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now())`, [context.tenantId, context.environmentId, operation, scope, key, hash, JSON.stringify(result)]);
  }
  private async outbox(client: PoolClient, context: Scope, id: string, sequence: number, eventType: string, payload: unknown) {
    const eventId = this.id();
    await client.query(`INSERT INTO events.outbox(tenant_id,environment_id,event_id,event_type,aggregate_type,aggregate_id,aggregate_sequence,routing_epoch,trace_id,schema_version,payload,status,occurred_at,created_at) VALUES($1,$2,$3,$4,'conversation',$5,$6,$7,$8,1,$9::jsonb,'PENDING',now(),now())`, [context.tenantId, context.environmentId, eventId, eventType, id, sequence, context.routingEpoch, context.traceId, JSON.stringify({ eventId, eventType, aggregateId: id, schemaVersion: 1, payload })]);
  }
  private async transaction<T>(context: Scope, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.environment_id',$2,true),set_config('app.request_id',$3,true)`, [context.tenantId, context.environmentId, context.requestId]); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type ZeroTotalCancellationStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION';
export type ZeroTotalCancellationReservation = Readonly<{
  tenantId: string; environmentId: string; workflowId: string; customerId: string;
  orderId: string; orderReference: string; previewId: string; previewExpiresAt: string;
  policyVersion: string; providerFactsDigest: string; idempotencyKey: string;
  paymentId?: string;
}>;
export type ZeroTotalCancellationExecution = Readonly<{ operationId: string; status: ZeroTotalCancellationStatus }>;
export interface ZeroTotalCancellationRepository {
  reserve(input: ZeroTotalCancellationReservation): Promise<{ kind: 'reserved'; operationId: string } | { kind: 'existing'; execution: ZeroTotalCancellationExecution } | { kind: 'conflict' }>;
  findExact(input: ZeroTotalCancellationReservation): Promise<ZeroTotalCancellationExecution | null>;
  recordStatus(operationId: string, status: Exclude<ZeroTotalCancellationStatus, 'IN_PROGRESS'>): Promise<ZeroTotalCancellationExecution>;
}

type Stored = ZeroTotalCancellationReservation & { operationId: string; status: ZeroTotalCancellationStatus };
function same(left: ZeroTotalCancellationReservation, right: ZeroTotalCancellationReservation): boolean {
  return left.tenantId === right.tenantId && left.environmentId === right.environmentId
    && left.workflowId === right.workflowId && left.customerId === right.customerId
    && left.orderId === right.orderId && left.orderReference === right.orderReference
    && left.previewId === right.previewId && left.previewExpiresAt === right.previewExpiresAt
    && left.policyVersion === right.policyVersion && left.providerFactsDigest === right.providerFactsDigest
    && left.idempotencyKey === right.idempotencyKey && left.paymentId === right.paymentId;
}
function publicExecution(value: ZeroTotalCancellationExecution): ZeroTotalCancellationExecution { return { operationId: value.operationId, status: value.status }; }

export class InMemoryZeroTotalCancellationRepository implements ZeroTotalCancellationRepository {
  private readonly values: Stored[] = [];
  async reserve(input: ZeroTotalCancellationReservation) {
    const matches = this.values.filter(value => value.tenantId === input.tenantId && value.environmentId === input.environmentId
      && (value.idempotencyKey === input.idempotencyKey || (value.workflowId === input.workflowId && value.previewId === input.previewId)
        || (value.orderId === input.orderId && value.status !== 'FAILED')));
    if (matches.length > 0) return matches.length === 1 && same(matches[0]!, input)
      ? { kind: 'existing' as const, execution: publicExecution(matches[0]!) }
      : { kind: 'conflict' as const };
    const value: Stored = { ...input, operationId: randomUUID(), status: 'IN_PROGRESS' };
    this.values.push(value);
    return { kind: 'reserved' as const, operationId: value.operationId };
  }
  async findExact(input: ZeroTotalCancellationReservation) {
    const value = this.values.find(candidate => same(candidate, input));
    return value ? publicExecution(value) : null;
  }
  async recordStatus(operationId: string, status: Exclude<ZeroTotalCancellationStatus, 'IN_PROGRESS'>) {
    const value = this.values.find(candidate => candidate.operationId === operationId);
    if (!value) throw new Error('ZERO_TOTAL_CANCELLATION_EXECUTION_NOT_FOUND');
    if (value.status !== 'SUCCEEDED' && value.status !== 'FAILED') value.status = status;
    return publicExecution(value);
  }
}

type Row = {
  operation_id: string; tenant_id: string; environment_id: string; workflow_id: string; customer_id: string;
  order_id: string; order_reference: string; preview_id: string; preview_expires_at: Date;
  policy_version: string; provider_facts_digest: string; idempotency_key: string; payment_id: string | null;
  status: ZeroTotalCancellationStatus;
};
function fromRow(row: Row): Stored {
  return {
    operationId: row.operation_id, tenantId: row.tenant_id, environmentId: row.environment_id,
    workflowId: row.workflow_id, customerId: row.customer_id, orderId: row.order_id,
    orderReference: row.order_reference, previewId: row.preview_id,
    previewExpiresAt: row.preview_expires_at.toISOString(), policyVersion: row.policy_version,
    providerFactsDigest: row.provider_facts_digest, idempotencyKey: row.idempotency_key, status: row.status,
    ...(row.payment_id === null ? {} : { paymentId: row.payment_id }),
  };
}

export class PostgresZeroTotalCancellationRepository implements ZeroTotalCancellationRepository {
  constructor(private readonly pool: Pool) {}
  async reserve(input: ZeroTotalCancellationReservation) {
    const operationId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ operation_id: string }>(`INSERT INTO cancellation.executions
        (operation_id,tenant_id,environment_id,workflow_id,customer_id,order_id,order_reference,preview_id,preview_expires_at,policy_version,provider_facts_digest,idempotency_key,payment_id,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'IN_PROGRESS') ON CONFLICT DO NOTHING RETURNING operation_id`,
      [operationId, input.tenantId, input.environmentId, input.workflowId, input.customerId, input.orderId, input.orderReference, input.previewId, input.previewExpiresAt, input.policyVersion, input.providerFactsDigest, input.idempotencyKey, input.paymentId ?? null]);
      if (inserted.rowCount === 1) { await client.query('COMMIT'); return { kind: 'reserved' as const, operationId }; }
      const existing = await client.query<Row>(`SELECT * FROM cancellation.executions WHERE tenant_id=$1 AND environment_id=$2
        AND (idempotency_key=$3 OR (workflow_id=$4 AND preview_id=$5) OR (order_id=$6 AND status <> 'FAILED'))`,
      [input.tenantId, input.environmentId, input.idempotencyKey, input.workflowId, input.previewId, input.orderId]);
      await client.query('COMMIT');
      return existing.rowCount === 1 && existing.rows[0] && same(fromRow(existing.rows[0]), input)
        ? { kind: 'existing' as const, execution: publicExecution(fromRow(existing.rows[0])) }
        : { kind: 'conflict' as const };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async findExact(input: ZeroTotalCancellationReservation) {
    const result = await this.pool.query<Row>(`SELECT * FROM cancellation.executions WHERE tenant_id=$1 AND environment_id=$2 AND idempotency_key=$3`, [input.tenantId, input.environmentId, input.idempotencyKey]);
    const row = result.rows[0];
    return row && same(fromRow(row), input) ? publicExecution(fromRow(row)) : null;
  }
  async recordStatus(operationId: string, status: Exclude<ZeroTotalCancellationStatus, 'IN_PROGRESS'>) {
    const result = await this.pool.query<{ operation_id: string; status: ZeroTotalCancellationStatus }>(`UPDATE cancellation.executions
      SET status=CASE WHEN status IN ('SUCCEEDED','FAILED') THEN status ELSE $2 END, updated_at=now()
      WHERE operation_id=$1 RETURNING operation_id,status`, [operationId, status]);
    const row = result.rows[0];
    if (!row) throw new Error('ZERO_TOTAL_CANCELLATION_EXECUTION_NOT_FOUND');
    return { operationId: row.operation_id, status: row.status };
  }
}

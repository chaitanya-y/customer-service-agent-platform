import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  toCustomerDeliveryIssueReport,
  type CustomerDeliveryIssueReport,
  type DeliveryIssueReport,
  type DeliveryIssueReportAuditEvent,
} from './delivery-issue-report.js';
import {
  DeliveryIssueReportRepositoryError,
  type CreateDeliveryIssueReportInput,
  type CustomerDeliveryIssueReportHistory,
  type CustomerListDeliveryIssueReportsInput,
  type CustomerReadDeliveryIssueReportInput,
  type DeliveryIssueReportRepository,
  type DeliveryReportScope,
  type ListDeliveryIssueReportsInput,
  type ReadDeliveryIssueReportInput,
  type TransitionDeliveryIssueReportInput,
} from './delivery-issue-report-repository.js';

type ReportRow = QueryResultRow & {
  report_id: string;
  tenant_id: string;
  environment_id: string;
  customer_id: string;
  conversation_id: string;
  order_reference: string;
  category: DeliveryIssueReport['category'];
  status: DeliveryIssueReport['status'];
  report_version: string;
  assigned_staff_id: string | null;
  created_at: Date;
  updated_at: Date;
  claimed_at: Date | null;
  acknowledged_at: Date | null;
  closed_at: Date | null;
};

type AuditRow = QueryResultRow & {
  event_id: string;
  report_id: string;
  event_type: DeliveryIssueReportAuditEvent['eventType'];
  occurred_at: Date;
  actor_type: DeliveryIssueReportAuditEvent['actorType'];
  actor_id: string;
  report_version: string;
};

type IdempotencyRow = QueryResultRow & {
  request_fingerprint: string;
  response_snapshot: DeliveryIssueReport | null;
  report_id: string | null;
};

const reportSelect = `SELECT report_id, tenant_id, environment_id, customer_id, conversation_id,
  order_reference, category, status, report_version, assigned_staff_id,
  created_at, updated_at, claimed_at, acknowledged_at, closed_at
  FROM human_operations.delivery_issue_reports`;

/** Transactional runtime store. Route-level authentication must supply trusted scope and staff identity. */
export class PostgresDeliveryIssueReportRepository implements DeliveryIssueReportRepository {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date(), private readonly ids: () => string = randomUUID) {}

  async create(input: CreateDeliveryIssueReportInput): Promise<DeliveryIssueReport> {
    return this.#inTransaction(input, async (client) => {
      const fingerprint = hash([input.customerId, input.conversationId, input.orderReference, input.category]);
      const idempotencyScope = JSON.stringify([input.customerId, input.conversationId]);
      const replay = await this.#reserveIdempotency(client, 'create', idempotencyScope, input.idempotencyKey, fingerprint);
      if (replay) return replay;
      const now = this.now();
      const result = await client.query<ReportRow>(
        `INSERT INTO human_operations.delivery_issue_reports (
          tenant_id, environment_id, report_id, customer_id, conversation_id, order_reference,
          category, status, report_version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'RECEIVED', 1, $8, $8) RETURNING *`,
        [input.tenantId, input.environmentId, `delivery-${this.ids()}`, input.customerId, input.conversationId, input.orderReference, input.category, now],
      );
      const report = toReport(requiredRow(result.rows[0], 'Created delivery report disappeared'));
      await this.#appendAudit(client, report, 'REPORT_RECEIVED', 'CUSTOMER', input.customerId);
      await this.#finishIdempotency(client, 'create', idempotencyScope, input.idempotencyKey, report);
      return report;
    });
  }

  async getForCustomer(input: CustomerReadDeliveryIssueReportInput): Promise<CustomerDeliveryIssueReport> {
    return this.#inTransaction(input, async (client) => {
      const result = await client.query<ReportRow>(
        `${reportSelect} WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() AND report_id = $1 AND customer_id = $2`,
        [input.reportId, input.customerId],
      );
      if (!result.rows[0]) throw new DeliveryIssueReportRepositoryError('REPORT_NOT_FOUND');
      return toCustomerDeliveryIssueReport(toReport(result.rows[0]));
    });
  }

  async replayForCustomer(input: CreateDeliveryIssueReportInput): Promise<CustomerDeliveryIssueReport> {
    return this.#inTransaction(input, async (client) => {
      const idempotencyScope = JSON.stringify([input.customerId, input.conversationId]);
      const existing = await client.query<IdempotencyRow>(
        `SELECT request_fingerprint, report_id FROM human_operations.delivery_issue_report_idempotency
         WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()
         AND action = 'create' AND idempotency_scope = $1 AND idempotency_key = $2`,
        [idempotencyScope, input.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row?.report_id) throw new DeliveryIssueReportRepositoryError('REPORT_NOT_FOUND');
      const fingerprint = hash([input.customerId, input.conversationId, input.orderReference, input.category]);
      if (row.request_fingerprint !== fingerprint) throw new DeliveryIssueReportRepositoryError('IDEMPOTENCY_CONFLICT');
      const result = await client.query<ReportRow>(
        `${reportSelect} WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()
         AND report_id = $1 AND customer_id = $2 AND conversation_id = $3`,
        [row.report_id, input.customerId, input.conversationId],
      );
      if (!result.rows[0]) throw new DeliveryIssueReportRepositoryError('REPORT_NOT_FOUND');
      return toCustomerDeliveryIssueReport(toReport(result.rows[0]));
    }, true);
  }

  async listForCustomer(input: CustomerListDeliveryIssueReportsInput): Promise<CustomerDeliveryIssueReportHistory> {
    return this.#inTransaction(input, async (client) => {
      const result = await client.query<ReportRow>(
        `${reportSelect} WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()
         AND customer_id = $1 ORDER BY updated_at DESC, report_id DESC LIMIT 11`,
        [input.customerId],
      );
      return { reports: result.rows.slice(0, 10).map((row) => toCustomerDeliveryIssueReport(toReport(row))),
        hasMore: result.rows.length > 10 };
    }, true);
  }

  async getForStaff(input: ReadDeliveryIssueReportInput): Promise<DeliveryIssueReport> {
    return this.#inTransaction(input, async (client) => toReport(await this.#requireReport(client, input.reportId)));
  }

  async listForStaff(input: ListDeliveryIssueReportsInput): Promise<readonly DeliveryIssueReport[]> {
    return this.#inTransaction(input, async (client) => {
      const clauses = [
        'tenant_id = security.current_tenant_id()',
        'environment_id = security.current_environment_id()',
      ];
      const parameters: unknown[] = [];
      if (input.status !== undefined) {
        parameters.push(input.status);
        clauses.push(`status = $${parameters.length}`);
      }
      if (input.assignee === 'me') {
        parameters.push(input.staffId);
        clauses.push(`assigned_staff_id = $${parameters.length}`);
      } else if (input.assignee === 'unassigned') {
        clauses.push('assigned_staff_id IS NULL');
      }
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('INVALID_REPORT_LIST_LIMIT');
      parameters.push(limit);
      const result = await client.query<ReportRow>(
        `${reportSelect} WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, report_id DESC LIMIT $${parameters.length}`,
        parameters,
      );
      return result.rows.map(toReport);
    });
  }

  async claim(input: TransitionDeliveryIssueReportInput): Promise<DeliveryIssueReport> {
    return this.#transition(input, 'claim');
  }

  async acknowledge(input: TransitionDeliveryIssueReportInput): Promise<DeliveryIssueReport> {
    return this.#transition(input, 'acknowledge');
  }

  async close(input: TransitionDeliveryIssueReportInput): Promise<DeliveryIssueReport> {
    return this.#transition(input, 'close');
  }

  async auditEvents(input: ReadDeliveryIssueReportInput): Promise<readonly DeliveryIssueReportAuditEvent[]> {
    return this.#inTransaction(input, async (client) => {
      await this.#requireReport(client, input.reportId);
      const result = await client.query<AuditRow>(
        `SELECT event_id, report_id, event_type, occurred_at, actor_type, actor_id, report_version
         FROM human_operations.delivery_issue_report_audit_events
         WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() AND report_id = $1
         ORDER BY report_version, event_id`,
        [input.reportId],
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        reportId: row.report_id,
        eventType: row.event_type,
        occurredAt: row.occurred_at.toISOString(),
        actorType: row.actor_type,
        actorId: row.actor_id,
        reportVersion: Number(row.report_version),
      }));
    });
  }

  async #transition(input: TransitionDeliveryIssueReportInput, action: 'claim' | 'acknowledge' | 'close'): Promise<DeliveryIssueReport> {
    return this.#inTransaction(input, async (client) => {
      const fingerprint = hash([input.reportId, input.staffId, input.expectedVersion]);
      const replay = await this.#reserveIdempotency(client, action, input.reportId, input.idempotencyKey, fingerprint);
      if (replay) return replay;
      const current = await this.#requireReport(client, input.reportId, true);
      if (Number(current.report_version) !== input.expectedVersion) throw new DeliveryIssueReportRepositoryError('STALE_REPORT_VERSION');
      if (action === 'claim' && current.status !== 'RECEIVED') throw new DeliveryIssueReportRepositoryError('REPORT_CONFLICT');
      if (action === 'acknowledge' && (current.status !== 'CLAIMED' || current.assigned_staff_id !== input.staffId)) {
        throw new DeliveryIssueReportRepositoryError('REPORT_CONFLICT');
      }
      if (action === 'close' && (current.status !== 'ACKNOWLEDGED' || current.assigned_staff_id !== input.staffId)) {
        throw new DeliveryIssueReportRepositoryError('REPORT_CONFLICT');
      }
      const now = this.now();
      const result = action === 'claim'
        ? await client.query<ReportRow>(
          `UPDATE human_operations.delivery_issue_reports SET status = 'CLAIMED', assigned_staff_id = $1,
           report_version = report_version + 1, claimed_at = $2, updated_at = $2
           WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() AND report_id = $3 RETURNING *`,
          [input.staffId, now, input.reportId],
        )
        : action === 'acknowledge' ? await client.query<ReportRow>(
          `UPDATE human_operations.delivery_issue_reports SET status = 'ACKNOWLEDGED',
           report_version = report_version + 1, acknowledged_at = $1, updated_at = $1
           WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() AND report_id = $2 RETURNING *`,
          [now, input.reportId],
        ) : await client.query<ReportRow>(
          `UPDATE human_operations.delivery_issue_reports SET status = 'REVIEW_CLOSED',
           report_version = report_version + 1, closed_at = $1, updated_at = $1
           WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() AND report_id = $2 RETURNING *`,
          [now, input.reportId],
        );
      const report = toReport(requiredRow(result.rows[0], 'Updated delivery report disappeared'));
      await this.#appendAudit(client, report, action === 'claim' ? 'REPORT_CLAIMED' : action === 'acknowledge' ? 'REPORT_ACKNOWLEDGED' : 'REPORT_REVIEW_CLOSED', 'HUMAN', input.staffId);
      await this.#finishIdempotency(client, action, input.reportId, input.idempotencyKey, report);
      return report;
    });
  }

  async #reserveIdempotency(client: PoolClient, action: 'create' | 'claim' | 'acknowledge' | 'close', idempotencyScope: string, key: string, fingerprint: string): Promise<DeliveryIssueReport | undefined> {
    const inserted = await client.query(
      `INSERT INTO human_operations.delivery_issue_report_idempotency
       (tenant_id, environment_id, action, idempotency_scope, idempotency_key, request_fingerprint, created_at)
       VALUES (security.current_tenant_id(), security.current_environment_id(), $1, $2, $3, $4, now())
       ON CONFLICT DO NOTHING RETURNING idempotency_key`,
      [action, idempotencyScope, key, fingerprint],
    );
    if (inserted.rowCount === 1) return undefined;
    const existing = await client.query<IdempotencyRow>(
      `SELECT request_fingerprint, response_snapshot FROM human_operations.delivery_issue_report_idempotency
       WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()
       AND action = $1 AND idempotency_scope = $2 AND idempotency_key = $3`,
      [action, idempotencyScope, key],
    );
    const row = requiredRow(existing.rows[0], 'Delivery idempotency record disappeared');
    if (row.request_fingerprint !== fingerprint) throw new DeliveryIssueReportRepositoryError('IDEMPOTENCY_CONFLICT');
    return requiredRow(row.response_snapshot ?? undefined, 'Delivery idempotency response disappeared');
  }

  async #finishIdempotency(client: PoolClient, action: 'create' | 'claim' | 'acknowledge' | 'close', idempotencyScope: string, key: string, report: DeliveryIssueReport): Promise<void> {
    await client.query(
      `UPDATE human_operations.delivery_issue_report_idempotency
       SET report_id = $1, response_snapshot = $2::jsonb
       WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()
       AND action = $3 AND idempotency_scope = $4 AND idempotency_key = $5`,
      [report.reportId, JSON.stringify(report), action, idempotencyScope, key],
    );
  }

  async #requireReport(client: PoolClient, reportId: string, lock = false): Promise<ReportRow> {
    const result = await client.query<ReportRow>(
      `${reportSelect} WHERE tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() AND report_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [reportId],
    );
    if (!result.rows[0]) throw new DeliveryIssueReportRepositoryError('REPORT_NOT_FOUND');
    return result.rows[0];
  }

  async #appendAudit(client: PoolClient, report: DeliveryIssueReport, eventType: DeliveryIssueReportAuditEvent['eventType'], actorType: DeliveryIssueReportAuditEvent['actorType'], actorId: string): Promise<void> {
    await client.query(
      `INSERT INTO human_operations.delivery_issue_report_audit_events
       (tenant_id, environment_id, event_id, report_id, event_type, occurred_at, actor_type, actor_id, report_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [report.tenantId, report.environmentId, `delivery-audit-${this.ids()}`, report.reportId, eventType, report.updatedAt, actorType, actorId, report.version],
    );
  }

  async #inTransaction<T>(scope: DeliveryReportScope, work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.environment_id', $2, true)`, [scope.tenantId, scope.environmentId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function toReport(row: ReportRow): DeliveryIssueReport {
  return {
    reportId: row.report_id,
    tenantId: row.tenant_id,
    environmentId: row.environment_id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    orderReference: row.order_reference,
    category: row.category,
    status: row.status,
    version: Number(row.report_version),
    ...(row.assigned_staff_id === null ? {} : { assignedStaffId: row.assigned_staff_id }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at.toISOString() }),
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at.toISOString() }),
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at.toISOString() }),
  };
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(message);
  return row;
}

function hash(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

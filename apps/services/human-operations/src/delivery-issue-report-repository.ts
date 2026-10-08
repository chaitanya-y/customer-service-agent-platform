import { randomUUID } from 'node:crypto';

import {
  toCustomerDeliveryIssueReport,
  type CustomerDeliveryIssueReport,
  type DeliveryIssueCategory,
  type DeliveryIssueReport,
  type DeliveryIssueReportAuditEvent,
  type DeliveryIssueReportStatus,
} from './delivery-issue-report.js';

export type DeliveryReportScope = Readonly<{ tenantId: string; environmentId: string }>;
export type CreateDeliveryIssueReportInput = DeliveryReportScope & Readonly<{
  customerId: string;
  conversationId: string;
  orderReference: string;
  category: DeliveryIssueCategory;
  idempotencyKey: string;
}>;
export type ReadDeliveryIssueReportInput = DeliveryReportScope & Readonly<{ reportId: string }>;
export type CustomerReadDeliveryIssueReportInput = ReadDeliveryIssueReportInput & Readonly<{ customerId: string }>;
export type CustomerListDeliveryIssueReportsInput = DeliveryReportScope & Readonly<{ customerId: string }>;
export type CustomerDeliveryIssueReportHistory = Readonly<{
  reports: readonly CustomerDeliveryIssueReport[];
  hasMore: boolean;
}>;
export type ListDeliveryIssueReportsInput = DeliveryReportScope & Readonly<{
  staffId: string;
  status?: DeliveryIssueReportStatus;
  assignee?: 'me' | 'unassigned';
  limit?: number;
}>;
export type TransitionDeliveryIssueReportInput = ReadDeliveryIssueReportInput & Readonly<{
  staffId: string;
  expectedVersion: number;
  idempotencyKey: string;
}>;

export type DeliveryIssueReportRepositoryErrorCode =
  | 'REPORT_NOT_FOUND'
  | 'REPORT_CONFLICT'
  | 'STALE_REPORT_VERSION'
  | 'IDEMPOTENCY_CONFLICT';

export class DeliveryIssueReportRepositoryError extends Error {
  constructor(readonly code: DeliveryIssueReportRepositoryErrorCode) {
    super(code);
    this.name = 'DeliveryIssueReportRepositoryError';
  }
}

export interface DeliveryIssueReportRepository {
  create(input: CreateDeliveryIssueReportInput): Promise<DeliveryIssueReport>;
  replayForCustomer(input: CreateDeliveryIssueReportInput): Promise<CustomerDeliveryIssueReport>;
  getForCustomer(input: CustomerReadDeliveryIssueReportInput): Promise<CustomerDeliveryIssueReport>;
  listForCustomer(input: CustomerListDeliveryIssueReportsInput): Promise<CustomerDeliveryIssueReportHistory>;
  getForStaff(input: ReadDeliveryIssueReportInput): Promise<DeliveryIssueReport>;
  listForStaff(input: ListDeliveryIssueReportsInput): Promise<readonly DeliveryIssueReport[]>;
  claim(input: TransitionDeliveryIssueReportInput): Promise<DeliveryIssueReport>;
  acknowledge(input: TransitionDeliveryIssueReportInput): Promise<DeliveryIssueReport>;
  close(input: TransitionDeliveryIssueReportInput): Promise<DeliveryIssueReport>;
  auditEvents(input: ReadDeliveryIssueReportInput): Promise<readonly DeliveryIssueReportAuditEvent[]>;
}

type Remembered = Readonly<{ fingerprint: string; snapshot: DeliveryIssueReport }>;

/** Test/dependency-injection adapter. Running service persistence is PostgreSQL. */
export class InMemoryDeliveryIssueReportRepository implements DeliveryIssueReportRepository {
  readonly #reports = new Map<string, DeliveryIssueReport>();
  readonly #audit = new Map<string, DeliveryIssueReportAuditEvent[]>();
  readonly #idempotency = new Map<string, Remembered>();

  constructor(private readonly now: () => Date = () => new Date(), private readonly ids: () => string = randomUUID) {}

  async create(input: CreateDeliveryIssueReportInput): Promise<DeliveryIssueReport> {
    const key = this.#key(input, 'create', JSON.stringify([input.customerId, input.conversationId]), input.idempotencyKey);
    const fingerprint = JSON.stringify([input.customerId, input.conversationId, input.orderReference, input.category]);
    const replay = this.#replay(key, fingerprint);
    if (replay) return replay;
    const now = this.now().toISOString();
    const report: DeliveryIssueReport = {
      reportId: `delivery-${this.ids()}`,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      customerId: input.customerId,
      conversationId: input.conversationId,
      orderReference: input.orderReference,
      category: input.category,
      status: 'RECEIVED',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#reports.set(report.reportId, report);
    this.#appendAudit(report, 'REPORT_RECEIVED', 'CUSTOMER', input.customerId);
    this.#idempotency.set(key, { fingerprint, snapshot: report });
    return report;
  }

  async getForCustomer(input: CustomerReadDeliveryIssueReportInput): Promise<CustomerDeliveryIssueReport> {
    const report = this.#require(input);
    if (report.customerId !== input.customerId) throw new DeliveryIssueReportRepositoryError('REPORT_NOT_FOUND');
    return toCustomerDeliveryIssueReport(report);
  }

  async replayForCustomer(input: CreateDeliveryIssueReportInput): Promise<CustomerDeliveryIssueReport> {
    const key = this.#key(input, 'create', JSON.stringify([input.customerId, input.conversationId]), input.idempotencyKey);
    const remembered = this.#idempotency.get(key);
    if (!remembered) throw new DeliveryIssueReportRepositoryError('REPORT_NOT_FOUND');
    const fingerprint = JSON.stringify([input.customerId, input.conversationId, input.orderReference, input.category]);
    if (remembered.fingerprint !== fingerprint) throw new DeliveryIssueReportRepositoryError('IDEMPOTENCY_CONFLICT');
    const report = this.#require({ ...input, reportId: remembered.snapshot.reportId });
    if (report.customerId !== input.customerId || report.conversationId !== input.conversationId) {
      throw new DeliveryIssueReportRepositoryError('REPORT_NOT_FOUND');
    }
    return toCustomerDeliveryIssueReport(report);
  }

  async listForCustomer(input: CustomerListDeliveryIssueReportsInput): Promise<CustomerDeliveryIssueReportHistory> {
    const rows = [...this.#reports.values()]
      .filter((report) => report.tenantId === input.tenantId && report.environmentId === input.environmentId && report.customerId === input.customerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.reportId.localeCompare(a.reportId))
      .slice(0, 11);
    return { reports: rows.slice(0, 10).map(toCustomerDeliveryIssueReport), hasMore: rows.length > 10 };
  }

  async getForStaff(input: ReadDeliveryIssueReportInput): Promise<DeliveryIssueReport> {
    return this.#require(input);
  }

  async listForStaff(input: ListDeliveryIssueReportsInput): Promise<readonly DeliveryIssueReport[]> {
    return [...this.#reports.values()]
      .filter((report) => report.tenantId === input.tenantId && report.environmentId === input.environmentId)
      .filter((report) => input.status === undefined || report.status === input.status)
      .filter((report) => input.assignee === undefined || (input.assignee === 'me' ? report.assignedStaffId === input.staffId : report.assignedStaffId === undefined))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.reportId.localeCompare(a.reportId))
      .slice(0, input.limit ?? 100);
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
    this.#require(input);
    return this.#audit.get(input.reportId) ?? [];
  }

  #transition(input: TransitionDeliveryIssueReportInput, action: 'claim' | 'acknowledge' | 'close'): DeliveryIssueReport {
    const key = this.#key(input, action, input.reportId, input.idempotencyKey);
    const fingerprint = JSON.stringify([input.reportId, input.staffId, input.expectedVersion]);
    const replay = this.#replay(key, fingerprint);
    if (replay) return replay;
    const current = this.#require(input);
    if (current.version !== input.expectedVersion) throw new DeliveryIssueReportRepositoryError('STALE_REPORT_VERSION');
    if (action === 'claim' && current.status !== 'RECEIVED') throw new DeliveryIssueReportRepositoryError('REPORT_CONFLICT');
    if (action === 'acknowledge' && (current.status !== 'CLAIMED' || current.assignedStaffId !== input.staffId)) {
      throw new DeliveryIssueReportRepositoryError('REPORT_CONFLICT');
    }
    if (action === 'close' && (current.status !== 'ACKNOWLEDGED' || current.assignedStaffId !== input.staffId)) {
      throw new DeliveryIssueReportRepositoryError('REPORT_CONFLICT');
    }
    const now = this.now().toISOString();
    const next: DeliveryIssueReport = action === 'claim'
      ? { ...current, status: 'CLAIMED', version: current.version + 1, assignedStaffId: input.staffId, claimedAt: now, updatedAt: now }
      : action === 'acknowledge'
        ? { ...current, status: 'ACKNOWLEDGED', version: current.version + 1, acknowledgedAt: now, updatedAt: now }
        : { ...current, status: 'REVIEW_CLOSED', version: current.version + 1, closedAt: now, updatedAt: now };
    this.#reports.set(next.reportId, next);
    this.#appendAudit(next, action === 'claim' ? 'REPORT_CLAIMED' : action === 'acknowledge' ? 'REPORT_ACKNOWLEDGED' : 'REPORT_REVIEW_CLOSED', 'HUMAN', input.staffId);
    this.#idempotency.set(key, { fingerprint, snapshot: next });
    return next;
  }

  #require(input: ReadDeliveryIssueReportInput): DeliveryIssueReport {
    const report = this.#reports.get(input.reportId);
    if (!report || report.tenantId !== input.tenantId || report.environmentId !== input.environmentId) {
      throw new DeliveryIssueReportRepositoryError('REPORT_NOT_FOUND');
    }
    return report;
  }

  #appendAudit(report: DeliveryIssueReport, eventType: DeliveryIssueReportAuditEvent['eventType'], actorType: DeliveryIssueReportAuditEvent['actorType'], actorId: string): void {
    const events = this.#audit.get(report.reportId) ?? [];
    events.push({ eventId: `delivery-audit-${this.ids()}`, reportId: report.reportId, eventType, occurredAt: report.updatedAt, actorType, actorId, reportVersion: report.version });
    this.#audit.set(report.reportId, events);
  }

  #key(scope: DeliveryReportScope, action: string, idempotencyScope: string, idempotencyKey: string): string {
    return JSON.stringify([scope.tenantId, scope.environmentId, action, idempotencyScope, idempotencyKey]);
  }

  #replay(key: string, fingerprint: string): DeliveryIssueReport | undefined {
    const remembered = this.#idempotency.get(key);
    if (remembered && remembered.fingerprint !== fingerprint) throw new DeliveryIssueReportRepositoryError('IDEMPOTENCY_CONFLICT');
    return remembered?.snapshot;
  }
}

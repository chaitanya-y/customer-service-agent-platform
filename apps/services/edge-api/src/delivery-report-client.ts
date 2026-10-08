import { z } from 'zod';

import { CONTEXT_ASSERTION_HEADER } from './context-assertion.js';
import { DELIVERY_REPORT_ASSERTION_HEADER } from './delivery-report-assertion.js';

const ownershipSchema = z.object({
  schemaVersion: z.literal('1'),
  reference: z.string().min(1).max(100),
}).strict();
const reportSchema = z.object({
  report_id: z.string().min(1).max(160),
  status: z.enum(['RECEIVED', 'CLAIMED', 'ACKNOWLEDGED', 'REVIEW_CLOSED']),
  category: z.enum(['MISSING', 'WRONG', 'DAMAGED', 'DELAYED']),
  order_reference: z.string().min(1).max(100),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
}).strict();
const reportEnvelopeSchema = z.object({ delivery_issue_report: reportSchema }).strict();
const reportHistorySchema = z.object({
  delivery_issue_reports: z.array(reportSchema).max(10),
  has_more: z.boolean(),
}).strict().refine((value) => {
  if (value.has_more && value.delivery_issue_reports.length !== 10) return false;
  const ids = new Set<string>();
  return value.delivery_issue_reports.every((report, index) => {
    if (ids.has(report.report_id)) return false;
    ids.add(report.report_id);
    const previous = value.delivery_issue_reports[index - 1];
    if (!previous) return true;
    const previousTime = Date.parse(previous.updated_at);
    const currentTime = Date.parse(report.updated_at);
    return previousTime > currentTime ||
      (previousTime === currentTime && previous.report_id.localeCompare(report.report_id) > 0);
  });
});

export type CustomerDeliveryReport = z.infer<typeof reportSchema>;
export type CustomerDeliveryReportHistory = z.infer<typeof reportHistorySchema>;
export type DeliveryReportCategory = CustomerDeliveryReport['category'];

type Fetcher = typeof fetch;

export function createDeliveryReportClient({
  gatewayBaseUrl,
  humanOperationsBaseUrl,
  timeoutMilliseconds = 10_000,
  fetcher = fetch,
}: {
  gatewayBaseUrl: string;
  humanOperationsBaseUrl: string;
  timeoutMilliseconds?: number;
  fetcher?: Fetcher;
}) {
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000 || timeoutMilliseconds > 60_000) {
    throw new Error('Invalid delivery report request timeout');
  }
  const gateway = gatewayBaseUrl.replace(/\/$/, '');
  const humanOperations = humanOperationsBaseUrl.replace(/\/$/, '');

  return {
    async listReports(assertion: string): Promise<
      | { kind: 'found'; history: CustomerDeliveryReportHistory }
      | { kind: 'unavailable' }
    > {
      try {
        const response = await fetcher(new Request(
          `${humanOperations}/internal/v1/delivery-issue-reports`,
          {
            method: 'GET',
            cache: 'no-store',
            redirect: 'error',
            headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: assertion, 'cache-control': 'no-store' },
            signal: AbortSignal.timeout(timeoutMilliseconds),
          },
        ));
        if (response.status !== 200) return { kind: 'unavailable' };
        const parsed = reportHistorySchema.safeParse(await response.json());
        return parsed.success ? { kind: 'found', history: parsed.data } : { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async verifyOwnedOrder(
      orderReference: string,
      assertion: string,
    ): Promise<'owned' | 'not_found' | 'unavailable'> {
      try {
        const response = await fetcher(new Request(
          `${gateway}/internal/v1/delivery-order-ownership/${encodeURIComponent(orderReference)}`,
          {
            method: 'GET',
            redirect: 'error',
            headers: { [CONTEXT_ASSERTION_HEADER]: assertion },
            signal: AbortSignal.timeout(timeoutMilliseconds),
          },
        ));
        if (response.status === 404) return 'not_found';
        if (response.status !== 200) return 'unavailable';
        const parsed = ownershipSchema.safeParse(await response.json());
        return parsed.success && parsed.data.reference === orderReference ? 'owned' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },

    async createReport(input: {
      body: { order_reference: string; category: DeliveryReportCategory };
      assertion: string;
      idempotencyKey: string;
    }): Promise<
      | { kind: 'created'; report: CustomerDeliveryReport }
      | { kind: 'conflict' }
      | { kind: 'unconfirmed' }
    > {
      try {
        const response = await fetcher(new Request(
          `${humanOperations}/internal/v1/delivery-issue-reports`,
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'content-type': 'application/json',
              [DELIVERY_REPORT_ASSERTION_HEADER]: input.assertion,
              'idempotency-key': input.idempotencyKey,
            },
            body: JSON.stringify(input.body),
            signal: AbortSignal.timeout(timeoutMilliseconds),
          },
        ));
        if (response.status === 409) return { kind: 'conflict' };
        if (response.status !== 201 && response.status !== 200) return { kind: 'unconfirmed' };
        const parsed = reportEnvelopeSchema.safeParse(await response.json());
        if (!parsed.success ||
            parsed.data.delivery_issue_report.order_reference !== input.body.order_reference ||
            parsed.data.delivery_issue_report.category !== input.body.category) {
          return { kind: 'unconfirmed' };
        }
        return { kind: 'created', report: parsed.data.delivery_issue_report };
      } catch {
        return { kind: 'unconfirmed' };
      }
    },

    async replayReport(input: {
      body: { order_reference: string; category: DeliveryReportCategory };
      assertion: string;
      idempotencyKey: string;
    }): Promise<
      | { kind: 'found'; report: CustomerDeliveryReport }
      | { kind: 'not_found' }
      | { kind: 'conflict' }
      | { kind: 'unavailable' }
    > {
      try {
        const response = await fetcher(new Request(
          `${humanOperations}/internal/v1/delivery-issue-reports/replay`,
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'content-type': 'application/json',
              [DELIVERY_REPORT_ASSERTION_HEADER]: input.assertion,
              'idempotency-key': input.idempotencyKey,
            },
            body: JSON.stringify(input.body),
            signal: AbortSignal.timeout(timeoutMilliseconds),
          },
        ));
        if (response.status === 404) return { kind: 'not_found' };
        if (response.status === 409) return { kind: 'conflict' };
        if (response.status !== 200) return { kind: 'unavailable' };
        const parsed = reportEnvelopeSchema.safeParse(await response.json());
        if (!parsed.success ||
            parsed.data.delivery_issue_report.order_reference !== input.body.order_reference ||
            parsed.data.delivery_issue_report.category !== input.body.category) {
          return { kind: 'unavailable' };
        }
        return { kind: 'found', report: parsed.data.delivery_issue_report };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async getReport(reportId: string, assertion: string): Promise<
      | { kind: 'found'; report: CustomerDeliveryReport }
      | { kind: 'not_found' }
      | { kind: 'unavailable' }
    > {
      try {
        const response = await fetcher(new Request(
          `${humanOperations}/internal/v1/delivery-issue-reports/${encodeURIComponent(reportId)}`,
          {
            method: 'GET',
            redirect: 'error',
            headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: assertion },
            signal: AbortSignal.timeout(timeoutMilliseconds),
          },
        ));
        if (response.status === 404) return { kind: 'not_found' };
        if (response.status !== 200) return { kind: 'unavailable' };
        const parsed = reportEnvelopeSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.delivery_issue_report.report_id !== reportId) {
          return { kind: 'unavailable' };
        }
        return { kind: 'found', report: parsed.data.delivery_issue_report };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

export type DeliveryReportClient = ReturnType<typeof createDeliveryReportClient>;

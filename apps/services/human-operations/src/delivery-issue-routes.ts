import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type DeliveryIssueReport } from './delivery-issue-report.js';
import { DeliveryIssueReportRepositoryError, type DeliveryIssueReportRepository } from './delivery-issue-report-repository.js';
import { DELIVERY_REPORT_ASSERTION_HEADER, type VerifyDeliveryReportAssertion } from './delivery-report-access.js';
import { DELIVERY_STAFF_ASSERTION_HEADER, type VerifyDeliveryStaffAssertion } from './delivery-staff-access.js';

export type DeliveryIssueRoutesOptions = {
  repository: DeliveryIssueReportRepository;
  verifyCustomer: VerifyDeliveryReportAssertion;
  verifyStaff: VerifyDeliveryStaffAssertion;
};

const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const keySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const createBodySchema = z.object({
  order_reference: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  category: z.enum(['MISSING', 'WRONG', 'DAMAGED', 'DELAYED']),
}).strict();
const reportParamsSchema = z.object({ reportId: opaqueId }).strict();
const customerListQuerySchema = z.object({}).strict();
const listQuerySchema = z.object({
  status: z.enum(['RECEIVED', 'CLAIMED', 'ACKNOWLEDGED', 'REVIEW_CLOSED']).optional(),
  assignee: z.enum(['me', 'unassigned']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const transitionBodySchema = z.object({ expected_version: z.number().int().positive() }).strict();

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
function reportResponse(report: DeliveryIssueReport) {
  return {
    report_id: report.reportId, status: report.status, category: report.category,
    order_reference: report.orderReference, version: report.version,
    ...(report.assignedStaffId ? { assigned_staff_id: report.assignedStaffId } : {}),
    created_at: report.createdAt, updated_at: report.updatedAt,
    ...(report.claimedAt ? { claimed_at: report.claimedAt } : {}),
    ...(report.acknowledgedAt ? { acknowledged_at: report.acknowledgedAt } : {}),
    ...(report.closedAt ? { closed_at: report.closedAt } : {}),
  };
}
function customerResponse(report: {
  reportId: string; status: string; category: string; orderReference: string; createdAt: string; updatedAt: string;
}) {
  return { report_id: report.reportId, status: report.status, category: report.category,
    order_reference: report.orderReference, created_at: report.createdAt, updated_at: report.updatedAt };
}
function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
function failure(reply: FastifyReply, cause: unknown) {
  if (cause instanceof DeliveryIssueReportRepositoryError) {
    if (cause.code === 'REPORT_NOT_FOUND') return error(reply, 404, 'delivery_report_not_found', 'Delivery issue report was not found.');
    return error(reply, 409, 'delivery_report_conflict', 'Delivery issue report could not be changed.');
  }
  return error(reply, 503, 'delivery_report_unavailable', 'Delivery issue reporting is unavailable right now.');
}

export function registerDeliveryIssueRoutes(app: FastifyInstance, options: DeliveryIssueRoutesOptions): void {
  const { repository } = options;
  app.post('/internal/v1/delivery-issue-reports', async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    const key = keySchema.safeParse(header(request, 'idempotency-key'));
    if (!body.success || !key.success) return error(reply, 400, 'invalid_delivery_report', 'Delivery issue report is invalid.');
    let access;
    try {
      access = await options.verifyCustomer(header(request, DELIVERY_REPORT_ASSERTION_HEADER),
        'delivery_issue_report_create', { body: body.data, idempotencyKey: key.data });
    } catch { return error(reply, 401, 'delivery_report_unauthorized', 'Delivery authorization is required.'); }
    try {
      const report = await repository.create({
        tenantId: access.tenantId, environmentId: access.environmentId,
        customerId: access.subjectCustomerId, conversationId: access.conversationId,
        orderReference: access.orderReference, category: access.category, idempotencyKey: access.idempotencyKey,
      });
      return reply.code(201).header('Cache-Control', 'private, no-store').send({ delivery_issue_report: customerResponse(report) });
    } catch (cause) { return failure(reply, cause); }
  });

  app.post('/internal/v1/delivery-issue-reports/replay', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const body = createBodySchema.safeParse(request.body);
    const key = keySchema.safeParse(header(request, 'idempotency-key'));
    if (!body.success || !key.success) return error(reply, 400, 'invalid_delivery_report', 'Delivery issue report is invalid.');
    let access;
    try {
      access = await options.verifyCustomer(header(request, DELIVERY_REPORT_ASSERTION_HEADER),
        'delivery_issue_report_replay', { body: body.data, idempotencyKey: key.data });
    } catch { return error(reply, 401, 'delivery_report_unauthorized', 'Delivery authorization is required.'); }
    try {
      const report = await repository.replayForCustomer({
        tenantId: access.tenantId, environmentId: access.environmentId,
        customerId: access.subjectCustomerId, conversationId: access.conversationId,
        orderReference: access.orderReference, category: access.category, idempotencyKey: access.idempotencyKey,
      });
      return reply.header('Cache-Control', 'private, no-store').send({ delivery_issue_report: customerResponse(report) });
    } catch (cause) { return failure(reply, cause); }
  });

  app.get('/internal/v1/delivery-issue-reports', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!customerListQuerySchema.safeParse(request.query).success || request.body !== undefined ||
        Number(header(request, 'content-length') ?? '0') > 0 || header(request, 'transfer-encoding') !== undefined) {
      return error(reply, 400, 'invalid_delivery_report_query', 'Delivery report query is invalid.');
    }
    let access;
    try {
      access = await options.verifyCustomer(header(request, DELIVERY_REPORT_ASSERTION_HEADER), 'delivery_issue_report_list');
    } catch { return error(reply, 401, 'delivery_report_unauthorized', 'Delivery authorization is required.'); }
    try {
      const history = await repository.listForCustomer({ tenantId: access.tenantId,
        environmentId: access.environmentId, customerId: access.subjectCustomerId });
      return reply.send({ delivery_issue_reports: history.reports.map(customerResponse), has_more: history.hasMore });
    } catch (cause) { return failure(reply, cause); }
  });

  app.get('/internal/v1/delivery-issue-reports/:reportId', async (request, reply) => {
    const params = reportParamsSchema.safeParse(request.params);
    if (!params.success) return error(reply, 400, 'invalid_delivery_report', 'Delivery issue report is invalid.');
    let access;
    try {
      access = await options.verifyCustomer(header(request, DELIVERY_REPORT_ASSERTION_HEADER),
        'delivery_issue_report_read', { reportId: params.data.reportId });
    } catch { return error(reply, 401, 'delivery_report_unauthorized', 'Delivery authorization is required.'); }
    try {
      const report = await repository.getForCustomer({ tenantId: access.tenantId, environmentId: access.environmentId,
        customerId: access.subjectCustomerId, reportId: access.reportId });
      return reply.header('Cache-Control', 'private, no-store').send({ delivery_issue_report: customerResponse(report) });
    } catch (cause) { return failure(reply, cause); }
  });

  async function staff(request: FastifyRequest, reply: FastifyReply) {
    try { return await options.verifyStaff(header(request, DELIVERY_STAFF_ASSERTION_HEADER)); }
    catch { error(reply, 401, 'delivery_staff_unauthorized', 'Delivery staff authorization is required.'); return undefined; }
  }

  app.get('/v1/delivery-issue-reports', async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return error(reply, 400, 'invalid_delivery_report_query', 'Delivery report query is invalid.');
    const access = await staff(request, reply);
    if (!access) return reply;
    try {
      const reports = await repository.listForStaff({ tenantId: access.tenantId, environmentId: access.environmentId,
        staffId: access.staffId,
        ...(query.data.status === undefined ? {} : { status: query.data.status }),
        ...(query.data.assignee === undefined ? {} : { assignee: query.data.assignee }),
        ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
      });
      return reply.header('Cache-Control', 'private, no-store').send({ delivery_issue_reports: reports.map(reportResponse) });
    } catch (cause) { return failure(reply, cause); }
  });

  app.get('/v1/delivery-issue-reports/:reportId', async (request, reply) => {
    const params = reportParamsSchema.safeParse(request.params);
    if (!params.success) return error(reply, 400, 'invalid_delivery_report', 'Delivery issue report is invalid.');
    const access = await staff(request, reply);
    if (!access) return reply;
    try {
      const scope = { tenantId: access.tenantId, environmentId: access.environmentId, reportId: params.data.reportId };
      const report = await repository.getForStaff(scope);
      const audit = await repository.auditEvents(scope);
      return reply.header('Cache-Control', 'private, no-store').send({ delivery_issue_report: reportResponse(report),
        can_close_review: report.status === 'ACKNOWLEDGED' && report.assignedStaffId === access.staffId,
        audit_events: audit.map((event) => ({ event_id: event.eventId, event_type: event.eventType,
          occurred_at: event.occurredAt, actor_type: event.actorType, actor_id: event.actorId,
          report_version: event.reportVersion })) });
    } catch (cause) { return failure(reply, cause); }
  });

  for (const action of ['claim', 'acknowledge', 'close'] as const) {
    app.post(`/v1/delivery-issue-reports/:reportId/${action}`, async (request, reply) => {
      const params = reportParamsSchema.safeParse(request.params);
      const body = transitionBodySchema.safeParse(request.body);
      const key = keySchema.safeParse(header(request, 'idempotency-key'));
      if (!params.success || !body.success || !key.success) {
        return error(reply, 400, 'invalid_delivery_report_transition', 'Delivery report transition is invalid.');
      }
      const access = await staff(request, reply);
      if (!access) return reply;
      try {
        const input = { tenantId: access.tenantId, environmentId: access.environmentId,
          reportId: params.data.reportId, staffId: access.staffId,
          expectedVersion: body.data.expected_version, idempotencyKey: key.data };
        const report = await repository[action](input);
        return reply.header('Cache-Control', 'private, no-store').send({ delivery_issue_report: reportResponse(report) });
      } catch (cause) { return failure(reply, cause); }
    });
  }
}

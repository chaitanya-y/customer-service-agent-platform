import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { GetConversation } from './conversation-runtime-client.js';
import type { SignContextAssertion } from './context-assertion.js';
import type { AuthenticatedCustomer } from './customer-identity.js';
import type { DeliveryReportClient } from './delivery-report-client.js';
import type { SignDeliveryReportAssertion } from './delivery-report-assertion.js';

const conversationIdSchema = z.uuid();
const reportIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const keySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const createBodySchema = z.object({
  order_reference: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  category: z.enum(['MISSING', 'WRONG', 'DAMAGED', 'DELAYED']),
}).strict();
const conversationSchema = z.object({
  data: z.object({ conversationId: conversationIdSchema, status: z.string() }).passthrough(),
}).passthrough();

function scopeReportKey(identity: AuthenticatedCustomer, conversationId: string, key: string): string {
  return createHash('sha256').update(JSON.stringify([
    'delivery-report-create-v1', identity.tenantId, identity.environmentId,
    identity.customerId, conversationId, key,
  ])).digest('hex');
}

export function registerDeliveryIssueRoutes(app: FastifyInstance, options: {
  verifyRequestIdentity: (authorization: string | undefined) => Promise<AuthenticatedCustomer>;
  createCorrelationId: () => string;
  signConversationContext?: SignContextAssertion;
  signGatewayContext: SignContextAssertion;
  signDeliveryReportAssertion?: SignDeliveryReportAssertion;
  getConversation?: GetConversation;
  deliveryReportClient?: DeliveryReportClient;
}): void {
  const serviceUnavailable = { error: {
    code: 'delivery_report_unavailable',
    message: 'Delivery issue reporting is unavailable right now.',
  } };
  const receiptUnconfirmed = { error: {
    code: 'delivery_report_receipt_unconfirmed',
    message: 'Receipt was not confirmed. Please retry with the same request key.',
  } };

  app.get('/v1/delivery-issue-reports', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const contentLength = request.headers['content-length'];
    if (Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0 ||
        request.body !== undefined || (contentLength !== undefined && contentLength !== '0') ||
        request.headers['transfer-encoding'] !== undefined) {
      return reply.code(400).send({ error: {
        code: 'invalid_delivery_report_list', message: 'Delivery report history requires no parameters.',
      } });
    }
    let identity: AuthenticatedCustomer;
    try { identity = await options.verifyRequestIdentity(request.headers.authorization); }
    catch { return reply.code(401).send({ error: {
      code: 'customer_unauthorized', message: 'Customer authentication is required',
    } }); }
    if (!options.signDeliveryReportAssertion || !options.deliveryReportClient) {
      return reply.code(503).send(serviceUnavailable);
    }
    try {
      const assertion = await options.signDeliveryReportAssertion({
        purpose: 'delivery_issue_report_list', identity, requestId: options.createCorrelationId(),
      });
      const result = await options.deliveryReportClient.listReports(assertion);
      if (result.kind !== 'found') return reply.code(503).send(serviceUnavailable);
      return reply.send(result.history);
    } catch { return reply.code(503).send(serviceUnavailable); }
  });

  app.post('/v1/conversations/:conversationId/delivery-issue-reports', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const params = z.object({ conversationId: conversationIdSchema }).strict().safeParse(request.params);
    const body = createBodySchema.safeParse(request.body);
    const key = keySchema.safeParse(request.headers['idempotency-key']);
    if (!params.success || !body.success || !key.success) {
      return reply.code(400).send({ error: { code: 'invalid_delivery_report', message: 'Delivery issue report is invalid.' } });
    }
    let identity: AuthenticatedCustomer;
    try {
      identity = await options.verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } });
    }
    if (!options.signConversationContext || !options.signDeliveryReportAssertion ||
        !options.getConversation || !options.deliveryReportClient) {
      return reply.code(503).send(serviceUnavailable);
    }
    const requestId = options.createCorrelationId();
    const traceId = options.createCorrelationId();
    let createAttempted = false;
    try {
      const conversationAssertion = await options.signConversationContext({
        identity, requestId, traceId, channelId: 'web',
      });
      const conversation = await options.getConversation({
        conversationId: params.data.conversationId,
        contextAssertion: conversationAssertion,
      });
      if (conversation.statusCode === 404) {
        return reply.code(404).send({ error: { code: 'conversation_not_found', message: 'Conversation was not found' } });
      }
      if (conversation.statusCode !== 200) return reply.code(503).send(serviceUnavailable);
      const parsedConversation = conversationSchema.safeParse(conversation.body);
      if (!parsedConversation.success || parsedConversation.data.data.conversationId !== params.data.conversationId) {
        return reply.code(503).send(serviceUnavailable);
      }
      if (parsedConversation.data.data.status !== 'OPEN') {
        return reply.code(409).send({ error: { code: 'conversation_not_open', message: 'This conversation is not open.' } });
      }

      const gatewayAssertion = await options.signGatewayContext({
        identity, requestId, traceId, channelId: 'web',
      });
      const ownership = await options.deliveryReportClient.verifyOwnedOrder(
        body.data.order_reference,
        gatewayAssertion,
      );
      if (ownership === 'not_found') {
        return reply.code(404).send({ error: { code: 'order_not_found', message: 'Order was not found' } });
      }
      if (ownership !== 'owned') return reply.code(503).send(serviceUnavailable);

      const scopedKey = scopeReportKey(identity, params.data.conversationId, key.data);
      const deliveryAssertion = await options.signDeliveryReportAssertion({
        purpose: 'delivery_issue_report_create',
        identity,
        conversationId: params.data.conversationId,
        orderReference: body.data.order_reference,
        category: body.data.category,
        idempotencyKey: scopedKey,
        requestId,
      });
      createAttempted = true;
      const result = await options.deliveryReportClient.createReport({
        body: body.data,
        assertion: deliveryAssertion,
        idempotencyKey: scopedKey,
      });
      if (result.kind === 'conflict') {
        return reply.code(409).send({ error: { code: 'delivery_report_conflict', message: 'This request key was already used for a different report.' } });
      }
      if (result.kind !== 'created') return reply.code(503).send(receiptUnconfirmed);
      return reply.code(201).send({ delivery_issue_report: result.report });
    } catch {
      // A create may have committed before the connection failed. Never claim
      // that a report was received without an authoritative response.
      return reply.code(503).send(createAttempted ? receiptUnconfirmed : serviceUnavailable);
    }
  });

  app.post('/v1/conversations/:conversationId/delivery-issue-reports/replay', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const params = z.object({ conversationId: conversationIdSchema }).strict().safeParse(request.params);
    const body = createBodySchema.safeParse(request.body);
    const key = keySchema.safeParse(request.headers['idempotency-key']);
    if (!params.success || !body.success || !key.success) {
      return reply.code(400).send({ error: { code: 'invalid_delivery_report', message: 'Delivery issue report is invalid.' } });
    }
    let identity: AuthenticatedCustomer;
    try {
      identity = await options.verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } });
    }
    if (!options.signConversationContext || !options.signDeliveryReportAssertion ||
        !options.getConversation || !options.deliveryReportClient) {
      return reply.code(503).send(serviceUnavailable);
    }
    try {
      const requestId = options.createCorrelationId();
      const conversationAssertion = await options.signConversationContext({
        identity, requestId, traceId: options.createCorrelationId(), channelId: 'web',
      });
      const conversation = await options.getConversation({
        conversationId: params.data.conversationId, contextAssertion: conversationAssertion,
      });
      if (conversation.statusCode === 404) {
        return reply.code(404).send({ error: { code: 'conversation_not_found', message: 'Conversation was not found' } });
      }
      if (conversation.statusCode !== 200) return reply.code(503).send(serviceUnavailable);
      const parsed = conversationSchema.safeParse(conversation.body);
      if (!parsed.success || parsed.data.data.conversationId !== params.data.conversationId ||
          !['OPEN', 'CLOSED'].includes(parsed.data.data.status)) {
        return reply.code(503).send(serviceUnavailable);
      }
      const scopedKey = scopeReportKey(identity, params.data.conversationId, key.data);
      const assertion = await options.signDeliveryReportAssertion({
        purpose: 'delivery_issue_report_replay', identity,
        conversationId: params.data.conversationId,
        orderReference: body.data.order_reference, category: body.data.category,
        idempotencyKey: scopedKey, requestId,
      });
      const result = await options.deliveryReportClient.replayReport({
        body: body.data, assertion, idempotencyKey: scopedKey,
      });
      if (result.kind === 'not_found') {
        return reply.code(404).send({ error: { code: 'delivery_report_not_found', message: 'Delivery issue report was not found.' } });
      }
      if (result.kind === 'conflict') {
        return reply.code(409).send({ error: { code: 'delivery_report_conflict', message: 'This request key was already used for a different report.' } });
      }
      if (result.kind !== 'found') return reply.code(503).send(serviceUnavailable);
      return reply.send({ delivery_issue_report: result.report });
    } catch {
      return reply.code(503).send(serviceUnavailable);
    }
  });

  app.get('/v1/delivery-issue-reports/:reportId', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const params = z.object({ reportId: reportIdSchema }).strict().safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'invalid_delivery_report', message: 'Delivery issue report is invalid.' } });
    }
    let identity: AuthenticatedCustomer;
    try {
      identity = await options.verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } });
    }
    if (!options.signDeliveryReportAssertion || !options.deliveryReportClient) {
      return reply.code(503).send(serviceUnavailable);
    }
    try {
      const assertion = await options.signDeliveryReportAssertion({
        purpose: 'delivery_issue_report_read', identity,
        reportId: params.data.reportId, requestId: options.createCorrelationId(),
      });
      const result = await options.deliveryReportClient.getReport(params.data.reportId, assertion);
      if (result.kind === 'not_found') {
        return reply.code(404).send({ error: { code: 'delivery_report_not_found', message: 'Delivery issue report was not found.' } });
      }
      if (result.kind !== 'found') return reply.code(503).send(serviceUnavailable);
      return reply.send({ delivery_issue_report: result.report });
    } catch {
      return reply.code(503).send(serviceUnavailable);
    }
  });
}

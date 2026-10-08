import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PostgresHandoffService } from './handoff-service.js';
import { sendStableError } from './app.js';
import { CONTEXT_ASSERTION_HEADER, type VerifyContextAssertion } from './trusted-context.js';
import { STAFF_ASSERTION_HEADER, StaffAssertionError, type VerifyStaffAssertion } from './staff-assertion.js';

const key = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const parameters = z.object({ conversationId: z.uuid() });
const command = z.object({ handoffSessionId: z.uuid(), expectedControlVersion: version }).strict();
const replyBody = command.extend({ clientMessageId: key, content: z.object({ type: z.literal('text'), text: z.string().min(1).max(2000).regex(/\S/) }).strict() }).strict();

export function registerHandoffRoutes(app: FastifyInstance, service: PostgresHandoffService | undefined, verifyCustomer: VerifyContextAssertion, verifyStaff?: VerifyStaffAssertion): void {
  async function staff(request: FastifyRequest) {
    if (!verifyStaff) throw new StaffAssertionError();
    const raw = request.headers[STAFF_ASSERTION_HEADER];
    const context = await verifyStaff(typeof raw === 'string' ? raw : undefined);
    if (context.httpMethod !== request.method || context.path !== request.url.split('?')[0]) throw new StaffAssertionError();
    return context;
  }
  function requireService(): PostgresHandoffService { if (!service) throw new Error('Handoff service unavailable'); return service; }
  const invalid = { error: { code: 'INVALID_HANDOFF_REQUEST', message: 'Handoff request is invalid', retryable: false } };
  app.post('/v1/conversations/:conversationId/handoff', async (request, response) => {
    response.header('cache-control', 'no-store');
    const params = parameters.safeParse(request.params);
    const body = z.object({ expectedControlVersion: version }).strict().safeParse(request.body);
    const idempotency = key.safeParse(request.headers['idempotency-key']);
    if (!params.success || !body.success || !idempotency.success) return response.code(400).send(invalid);
    try {
      const raw = request.headers[CONTEXT_ASSERTION_HEADER];
      const context = await verifyCustomer(typeof raw === 'string' ? raw : undefined);
      return { data: await requireService().request({ context, conversationId: params.data.conversationId, expectedControlVersion: body.data.expectedControlVersion, idempotencyKey: idempotency.data }), meta: { requestId: context.requestId, apiVersion: '2026-08-05' } };
    } catch (error) { return sendStableError(response, error, request.log); }
  });
  app.get('/v1/internal/handoffs', async (request, response) => {
    response.header('cache-control', 'no-store');
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict().safeParse(request.query);
    if (!query.success) return response.code(400).send(invalid);
    try { const context = await staff(request); return { data: await requireService().list(context, query.data.limit, query.data.offset), meta: { requestId: context.requestId, apiVersion: '2026-08-05' } }; }
    catch (error) { return sendStableError(response, error, request.log); }
  });
  app.get('/v1/internal/handoffs/:conversationId', async (request, response) => {
    response.header('cache-control', 'no-store');
    const params = parameters.safeParse(request.params);
    if (!params.success) return response.code(400).send(invalid);
    try { const context = await staff(request); return { data: await requireService().detail(context, params.data.conversationId), meta: { requestId: context.requestId, apiVersion: '2026-08-05' } }; }
    catch (error) { return sendStableError(response, error, request.log); }
  });
  for (const [suffix, action] of [['claim', 'claim'], ['messages', 'reply'], ['return-to-ai', 'return_to_ai'], ['close', 'close']] as const) {
    app.post(`/v1/internal/handoffs/:conversationId/${suffix}`, async (request, response) => {
      response.header('cache-control', 'no-store');
      const params = parameters.safeParse(request.params);
      const body = (action === 'reply' ? replyBody : command).safeParse(request.body);
      const idempotency = key.safeParse(request.headers['idempotency-key']);
      if (!params.success || !body.success || !idempotency.success) return response.code(400).send(invalid);
      try { const context = await staff(request); return { data: await requireService().command({ context, conversationId: params.data.conversationId, action, body: body.data, idempotencyKey: idempotency.data }), meta: { requestId: context.requestId, apiVersion: '2026-08-05' } }; }
      catch (error) { return sendStableError(response, error, request.log); }
    });
  }
}

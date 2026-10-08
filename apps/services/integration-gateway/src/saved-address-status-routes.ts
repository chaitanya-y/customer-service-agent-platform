import type { FastifyInstance } from 'fastify';
import { savedAddressStatusSchema, type GetSavedAddressStatus } from './saved-address-status.js';
import { CONTEXT_ASSERTION_HEADER, type VerifyContextAssertion } from './trusted-context.js';

export function registerSavedAddressStatusRoutes(app: FastifyInstance, verify: VerifyContextAssertion, lookup?: GetSavedAddressStatus): void {
  app.get('/v1/account/saved-address-status', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    let context;
    try {
      const assertion = request.headers[CONTEXT_ASSERTION_HEADER];
      context = await verify(typeof assertion === 'string' ? assertion : undefined);
    } catch {
      return reply.code(401).send({ error: { code: 'context_unauthorized', message: 'Trusted context is required' } });
    }
    // Fastify does not parse GET bodies; inspect framing as well as parsed input.
    if (Object.keys(request.query as Record<string, unknown>).length || request.body !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
      || request.headers['transfer-encoding'] !== undefined) {
      return reply.code(400).send({ error: { code: 'invalid_saved_address_status_request', message: 'Saved address status requires no parameters' } });
    }
    try {
      if (!lookup) throw new Error('Unavailable');
      return savedAddressStatusSchema.parse(await lookup(context));
    } catch {
      // Provider error strings can contain personal data. Never log or reflect them.
      return reply.code(502).send({ error: { code: 'saved_address_status_unavailable', message: 'Saved address status is unavailable' } });
    }
  });
}

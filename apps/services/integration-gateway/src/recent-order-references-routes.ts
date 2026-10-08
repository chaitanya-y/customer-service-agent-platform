import type { FastifyInstance } from 'fastify';
import { recentOrderReferencesSchema, type GetRecentOrderReferences } from './recent-order-references.js';
import { CONTEXT_ASSERTION_HEADER, type VerifyContextAssertion } from './trusted-context.js';

export function registerRecentOrderReferencesRoutes(app: FastifyInstance, verify: VerifyContextAssertion, lookup?: GetRecentOrderReferences): void {
  app.get('/v1/account/recent-order-references', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    let context;
    try {
      const assertion = request.headers[CONTEXT_ASSERTION_HEADER];
      context = await verify(typeof assertion === 'string' ? assertion : undefined);
    } catch {
      return reply.code(401).send({ error: { code: 'context_unauthorized', message: 'Trusted context is required' } });
    }
    // GET bodies are not parsed by Fastify; reject their framing too.
    if (Object.keys(request.query as Record<string, unknown>).length || request.body !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
      || request.headers['transfer-encoding'] !== undefined) {
      return reply.code(400).send({ error: { code: 'invalid_recent_order_references_request', message: 'Recent order references require no parameters' } });
    }
    try {
      if (!lookup) throw new Error('Unavailable');
      return recentOrderReferencesSchema.parse(await lookup(context));
    } catch {
      // Provider diagnostics can contain private customer data or credentials.
      return reply.code(502).send({ error: { code: 'recent_order_references_unavailable', message: 'Recent order references are unavailable' } });
    }
  });
}

import type { FastifyInstance } from 'fastify';
import type { SignContextAssertion } from './context-assertion.js';
import type { AuthenticatedCustomer } from './customer-identity.js';
import { recentOrderReferencesSchema, type RecentOrderReferencesClient } from './recent-order-references-client.js';

export function registerRecentOrderReferencesRoutes(app: FastifyInstance, options: {
  verifyRequestIdentity: (authorization: string | undefined) => Promise<AuthenticatedCustomer>;
  createCorrelationId: () => string;
  signGatewayContext: SignContextAssertion;
  recentOrderReferencesClient?: RecentOrderReferencesClient;
}): void {
  app.get('/v1/account/recent-order-references', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const contentLength = request.headers['content-length'];
    if (Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0 ||
        request.body !== undefined || (contentLength !== undefined && contentLength !== '0') ||
        request.headers['transfer-encoding'] !== undefined) {
      return reply.code(400).send({ error: {
        code: 'invalid_recent_order_references_request', message: 'Recent orders require no parameters',
      } });
    }
    let identity: AuthenticatedCustomer;
    try { identity = await options.verifyRequestIdentity(request.headers.authorization); }
    catch { return reply.code(401).send({ error: {
      code: 'customer_unauthorized', message: 'Customer authentication is required',
    } }); }
    try {
      if (!options.recentOrderReferencesClient) throw new Error('Unavailable');
      const assertion = await options.signGatewayContext({
        identity, requestId: options.createCorrelationId(), traceId: options.createCorrelationId(), channelId: 'web',
      });
      const parsed = recentOrderReferencesSchema.safeParse(await options.recentOrderReferencesClient.getReferences(assertion));
      if (!parsed.success) throw new Error('Unavailable');
      return reply.send(parsed.data);
    } catch { return reply.code(503).send({ error: {
      code: 'recent_order_references_unavailable', message: 'Recent orders are unavailable',
    } }); }
  });
}

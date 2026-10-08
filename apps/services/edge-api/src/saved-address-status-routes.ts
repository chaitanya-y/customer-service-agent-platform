import type { FastifyInstance } from 'fastify';

import type { SignContextAssertion } from './context-assertion.js';
import type { AuthenticatedCustomer } from './customer-identity.js';
import { savedAddressStatusSchema, type SavedAddressStatusClient } from './saved-address-status-client.js';

export function registerSavedAddressStatusRoutes(app: FastifyInstance, options: {
  verifyRequestIdentity: (authorization: string | undefined) => Promise<AuthenticatedCustomer>;
  createCorrelationId: () => string;
  signGatewayContext: SignContextAssertion;
  savedAddressStatusClient?: SavedAddressStatusClient;
}): void {
  app.get('/v1/account/saved-address-status', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const contentLength = request.headers['content-length'];
    if (Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0 ||
        request.body !== undefined ||
        (contentLength !== undefined && contentLength !== '0') ||
        request.headers['transfer-encoding'] !== undefined) {
      return reply.code(400).send({ error: {
        code: 'invalid_saved_address_status_request',
        message: 'Saved address status requires no parameters',
      } });
    }
    let identity: AuthenticatedCustomer;
    try {
      identity = await options.verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: {
        code: 'customer_unauthorized', message: 'Customer authentication is required',
      } });
    }
    if (!options.savedAddressStatusClient) {
      return reply.code(503).send({ error: {
        code: 'saved_address_status_unavailable', message: 'Saved address status is unavailable',
      } });
    }
    try {
      const assertion = await options.signGatewayContext({
        identity,
        requestId: options.createCorrelationId(),
        traceId: options.createCorrelationId(),
        channelId: 'web',
      });
      const result = await options.savedAddressStatusClient.getStatus(assertion);
      const parsed = savedAddressStatusSchema.safeParse(result);
      if (!parsed.success) throw new Error('Saved address status unavailable');
      return reply.send(parsed.data);
    } catch {
      return reply.code(503).send({ error: {
        code: 'saved_address_status_unavailable', message: 'Saved address status is unavailable',
      } });
    }
  });
}

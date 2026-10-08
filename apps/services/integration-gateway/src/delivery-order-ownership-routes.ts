import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { GetOrderContext } from './get-order-context.js';
import {
  CONTEXT_ASSERTION_HEADER,
  type VerifyContextAssertion,
} from './trusted-context.js';

const orderReferenceSchema = z.string().min(1).max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

type RouteParams = { orderReference: string };

export function registerDeliveryOrderOwnershipRoutes(
  app: FastifyInstance,
  getOrderContext: GetOrderContext,
  verifyContextAssertion: VerifyContextAssertion,
): void {
  app.get<{ Params: RouteParams }>(
    '/internal/v1/delivery-order-ownership/:orderReference',
    async (request, reply) => {
      const parsedReference = orderReferenceSchema.safeParse(request.params.orderReference);
      if (!parsedReference.success) {
        return reply.code(400).send({
          error: { code: 'invalid_order_reference', message: 'Order reference is invalid' },
        });
      }

      const assertion = request.headers[CONTEXT_ASSERTION_HEADER];
      let accessContext;
      try {
        accessContext = await verifyContextAssertion(
          typeof assertion === 'string' ? assertion : undefined,
        );
      } catch {
        return reply.code(401).send({
          error: { code: 'context_unauthorized', message: 'Trusted context is required' },
        });
      }

      try {
        const orderContext = await getOrderContext(parsedReference.data, accessContext);
        if (!orderContext || orderContext.reference !== parsedReference.data) {
          return reply.code(404).send({
            error: { code: 'order_not_found', message: 'Order was not found' },
          });
        }

        return { schemaVersion: '1', reference: orderContext.reference };
      } catch {
        request.log.error('Commerce provider delivery ownership lookup failed');
        return reply.code(502).send({
          error: {
            code: 'commerce_provider_unavailable',
            message: 'Commerce provider request failed',
          },
        });
      }
    },
  );
}

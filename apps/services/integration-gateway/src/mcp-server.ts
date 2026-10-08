import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { GetOrderContext } from './get-order-context.js';
import { toOrderItems } from './order-items.js';
import { toOrderTotal } from './order-total.js';
import { toOrderStatus } from './order-status.js';
import type { GetPaymentStatus } from './payment-status.js';
import type { GetProductCatalog } from './product-catalog.js';
import { recentOrderReferencesSchema, type GetRecentOrderReferences } from './recent-order-references.js';
import type { OrderAccessContext } from './trusted-context.js';

type McpServerDependencies = {
  getOrderContext: GetOrderContext;
  getProductCatalog?: GetProductCatalog;
  getPaymentStatus: GetPaymentStatus;
  getRecentOrderReferences?: GetRecentOrderReferences;
  accessContext: OrderAccessContext | null;
};

function toolResult(
  payload: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

export function createIntegrationMcpServer({
  getOrderContext,
  getProductCatalog,
  getPaymentStatus,
  getRecentOrderReferences,
  accessContext,
}: McpServerDependencies): McpServer {
  const server = new McpServer({
    name: 'customer-service-os-integration-gateway',
    version: '0.1.0',
  });

  server.registerTool(
    'lookup_order',
    {
      title: 'Look up order',
      description:
        'Read an order by reference and return an authorization-filtered order context.',
      inputSchema: {
        orderReference: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe('Customer-facing order reference'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ orderReference }) => {
      if (!accessContext) {
        return toolResult(
          {
            error: {
              code: 'context_unauthorized',
              message: 'Trusted context is required',
            },
          },
          true,
        );
      }

      try {
        const orderContext = await getOrderContext(
          orderReference,
          accessContext,
        );

        if (!orderContext) {
          return toolResult(
            {
              error: {
                code: 'order_not_found',
                message: 'Order was not found',
              },
            },
            true,
          );
        }

        return toolResult(orderContext);
      } catch {
        return toolResult(
          {
            error: {
              code: 'commerce_provider_unavailable',
              message: 'Commerce provider request failed',
            },
          },
          true,
        );
      }
    },
  );

  server.registerTool(
    'lookup_order_status',
    {
      title: 'Look up order status',
      description: 'Read customer-safe status and tracking for an owned order.',
      inputSchema: {
        orderReference: z.string().trim().min(1).max(100),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ orderReference }) => {
      if (!accessContext) {
        return toolResult({
          error: { code: 'context_unauthorized', message: 'Trusted context is required' },
        }, true);
      }

      try {
        const orderContext = await getOrderContext(orderReference, accessContext);
        if (!orderContext) {
          return toolResult({
            error: { code: 'order_not_found', message: 'Order was not found' },
          }, true);
        }
        return toolResult(toOrderStatus(orderContext));
      } catch {
        return toolResult({
          error: {
            code: 'commerce_provider_unavailable',
            message: 'Commerce provider request failed',
          },
        }, true);
      }
    },
  );

  server.registerTool(
    'lookup_order_items',
    {
      title: 'Look up order items',
      description: 'Read customer-safe names and quantities for an owned order.',
      inputSchema: {
        orderReference: z.string().trim().min(1).max(100),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ orderReference }) => {
      if (!accessContext) {
        return toolResult({
          error: { code: 'context_unauthorized', message: 'Trusted context is required' },
        }, true);
      }

      try {
        const orderContext = await getOrderContext(orderReference, accessContext);
        if (!orderContext) {
          return toolResult({
            error: { code: 'order_not_found', message: 'Order was not found' },
          }, true);
        }
        return toolResult(toOrderItems(orderContext));
      } catch {
        return toolResult({
          error: {
            code: 'commerce_provider_unavailable',
            message: 'Commerce provider request failed',
          },
        }, true);
      }
    },
  );

  server.registerTool(
    'lookup_payment_status',
    {
      title: 'Look up payment status',
      description: 'Read aggregate payment and refund status for an owned order.',
      inputSchema: {
        orderReference: z.string().trim().min(1).max(100),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ orderReference }) => {
      if (!accessContext) {
        return toolResult({
          error: { code: 'context_unauthorized', message: 'Trusted context is required' },
        }, true);
      }

      try {
        const status = await getPaymentStatus(orderReference, accessContext);
        if (!status) {
          return toolResult({
            error: { code: 'order_not_found', message: 'Order was not found' },
          }, true);
        }
        return toolResult(status);
      } catch {
        return toolResult({
          error: { code: 'commerce_provider_unavailable', message: 'Commerce provider request failed' },
        }, true);
      }
    },
  );

  server.registerTool(
    'lookup_product_catalog',
    {
      title: 'Look up product catalog',
      description: 'Read public product details from the authorized commerce channel.',
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe('Product search text'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      if (!accessContext) {
        return toolResult({
          error: { code: 'context_unauthorized', message: 'Trusted context is required' },
        }, true);
      }
      if (!getProductCatalog) {
        return toolResult({
          error: { code: 'catalog_unavailable', message: 'Product catalog is unavailable' },
        }, true);
      }

      try {
        return toolResult(await getProductCatalog(query, accessContext));
      } catch {
        return toolResult({
          error: { code: 'catalog_unavailable', message: 'Product catalog is unavailable' },
        }, true);
      }
    },
  );

  server.registerTool('lookup_order_total', {
    title: 'Look up order total',
    description: 'Read only the tax-inclusive total of an owned order, not payment or refund facts.',
    inputSchema: { orderReference: z.string().trim().min(1).max(100) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ orderReference }) => {
    if (!accessContext) {
      return toolResult({
        error: { code: 'context_unauthorized', message: 'Trusted context is required' },
      }, true);
    }
    try {
      const order = await getOrderContext(orderReference, accessContext);
      if (!order) {
        return toolResult({
          error: { code: 'order_not_found', message: 'Order was not found' },
        }, true);
      }
      return toolResult(toOrderTotal(order));
    } catch {
      return toolResult({
        error: { code: 'commerce_provider_unavailable', message: 'Commerce provider request failed' },
      }, true);
    }
  });

  server.registerTool('lookup_recent_order_references', {
    title: 'Look up recent order references',
    description: 'Read up to ten latest placed order references for the verified customer.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    if (!accessContext) {
      return toolResult({
        error: { code: 'context_unauthorized', message: 'Trusted context is required' },
      }, true);
    }
    try {
      if (!getRecentOrderReferences) throw new Error('Unavailable');
      return toolResult(recentOrderReferencesSchema.parse(await getRecentOrderReferences(accessContext)));
    } catch {
      return toolResult({
        error: { code: 'recent_order_references_unavailable', message: 'Recent order references are unavailable' },
      }, true);
    }
  });
  return server;
}

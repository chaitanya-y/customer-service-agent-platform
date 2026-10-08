import { z } from 'zod';
import { recentOrderReferenceSchema, recentOrderReferencesSchema, type GetRecentOrderReferences } from './recent-order-references.js';
type Options = { adminApiUrl: string; apiKey: string; channelToken: string; expectedChannelCode: string; expectedTenantId: string; expectedEnvironmentId: string; fetcher?: typeof fetch };

const query = `query RecentOrderReferences($customerId: ID!, $options: OrderListOptions!) {
  activeChannel { code }
  customer(id: $customerId) {
    id
    orders(options: $options) {
      items { code orderPlacedAt active customer { id } }
    }
  }
}`;
const providerResponseSchema = z.object({
  data: z.object({
    activeChannel: z.object({ code: z.string().min(1) }).strict(),
    customer: z.object({
      id: z.string().min(1),
      orders: z.object({ items: z.array(z.object({
        code: recentOrderReferenceSchema.shape.reference,
        orderPlacedAt: recentOrderReferenceSchema.shape.placedAt,
        active: z.literal(false),
        customer: z.object({ id: z.string().min(1) }).strict(),
      }).strict()).max(11) }).strict(),
    }).strict(),
  }).strict(),
  errors: z.array(z.unknown()).max(0).optional(),
}).strict();

export function createVendureRecentOrderReferencesLookup(options: Options): GetRecentOrderReferences {
  return async (context) => {
    try {
      if (!options.channelToken.trim() || !options.expectedChannelCode.trim()
        || !options.expectedTenantId.trim() || !options.expectedEnvironmentId.trim()
        || context.tenantId !== options.expectedTenantId
        || context.environmentId !== options.expectedEnvironmentId) throw new Error('Unavailable');
      const response = await (options.fetcher ?? fetch)(options.adminApiUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'vendure-api-key': options.apiKey, 'vendure-token': options.channelToken },
        body: JSON.stringify({ query, variables: {
          customerId: context.subjectCustomerId,
          options: { take: 11, sort: { orderPlacedAt: 'DESC' }, filter: { active: { eq: false }, orderPlacedAt: { isNull: false } } },
        } }),
      });
      if (!response.ok) throw new Error('Unavailable');
      const { data } = providerResponseSchema.parse(await response.json());
      if (data.activeChannel.code !== options.expectedChannelCode || data.customer.id !== context.subjectCustomerId) throw new Error('Unavailable');
      const items = data.customer.orders.items;
      // Validate all eleven rows before discarding the pagination sentinel.
      if (items.some((item) => item.customer.id !== context.subjectCustomerId)
        || new Set(items.map((item) => item.code)).size !== items.length
        || items.some((item, index) => index > 0 && Date.parse(items[index - 1]!.orderPlacedAt) < Date.parse(item.orderPlacedAt))) throw new Error('Unavailable');
      return recentOrderReferencesSchema.parse({ schemaVersion: '1',
        orders: items.slice(0, 10).map((item) => ({ reference: item.code, placedAt: item.orderPlacedAt })),
        hasMore: items.length === 11,
      });
    } catch {
      // Never retain or expose raw provider errors or credentials.
      throw new Error('Recent order references are unavailable');
    }
  };
}

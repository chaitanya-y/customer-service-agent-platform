import { z } from 'zod';
import { CONTEXT_ASSERTION_HEADER } from './context-assertion.js';

export const recentOrderReferencesSchema = z.object({
  schemaVersion: z.literal('1'),
  orders: z.array(z.object({
    reference: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    placedAt: z.iso.datetime({ offset: true }),
  }).strict()).max(10),
  hasMore: z.boolean(),
}).strict().refine(value => new Set(value.orders.map(order => order.reference)).size === value.orders.length
  && (!value.hasMore || value.orders.length === 10)
  && value.orders.every((order, index) => index === 0
    || Date.parse(value.orders[index - 1]!.placedAt) >= Date.parse(order.placedAt)));

export type RecentOrderReferences = z.infer<typeof recentOrderReferencesSchema>;
export type RecentOrderReferencesClient = ReturnType<typeof createRecentOrderReferencesClient>;

export function createRecentOrderReferencesClient({ baseUrl, timeoutMilliseconds = 10_000, fetcher = fetch }: {
  baseUrl: string; timeoutMilliseconds?: number; fetcher?: typeof fetch;
}) {
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000 || timeoutMilliseconds > 60_000) {
    throw new Error('Invalid recent-orders request timeout');
  }
  const endpoint = new URL('/v1/account/recent-order-references', baseUrl);
  return {
    async getReferences(assertion: string): Promise<RecentOrderReferences | 'unavailable'> {
      try {
        const response = await fetcher(new Request(endpoint, {
          method: 'GET', cache: 'no-store', redirect: 'error',
          headers: { [CONTEXT_ASSERTION_HEADER]: assertion, 'cache-control': 'no-store' },
          signal: AbortSignal.timeout(timeoutMilliseconds),
        }));
        if (response.status !== 200) return 'unavailable';
        const parsed = recentOrderReferencesSchema.safeParse(await response.json());
        return parsed.success ? parsed.data : 'unavailable';
      } catch { return 'unavailable'; }
    },
  };
}

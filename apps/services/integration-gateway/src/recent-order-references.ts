import { z } from 'zod';
import type { OrderAccessContext } from './trusted-context.js';

export const recentOrderReferenceSchema = z.object({
  reference: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  placedAt: z.iso.datetime({ offset: true }),
}).strict();
export const recentOrderReferencesSchema = z.object({
  schemaVersion: z.literal('1'),
  orders: z.array(recentOrderReferenceSchema).max(10),
  hasMore: z.boolean(),
}).strict().refine((value) => (!value.hasMore || value.orders.length === 10)
  && new Set(value.orders.map((order) => order.reference)).size === value.orders.length
  && value.orders.every((order, index) => index === 0 || Date.parse(value.orders[index - 1]!.placedAt) >= Date.parse(order.placedAt)));
export type RecentOrderReferences = z.infer<typeof recentOrderReferencesSchema>;
export type GetRecentOrderReferences = (context: OrderAccessContext) => Promise<unknown>;

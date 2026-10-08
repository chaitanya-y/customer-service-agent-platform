import { z } from 'zod';
import type { OrderAccessContext } from './trusted-context.js';

export const savedAddressStatusSchema = z.object({
  schemaVersion: z.literal('1'),
  savedAddressCount: z.number().int().min(0).max(1000),
  hasDefaultShippingAddress: z.boolean(),
  hasDefaultBillingAddress: z.boolean(),
}).strict().refine((value) => value.savedAddressCount > 0 || (!value.hasDefaultShippingAddress && !value.hasDefaultBillingAddress));

export type SavedAddressStatus = z.infer<typeof savedAddressStatusSchema>;
export type GetSavedAddressStatus = (context: OrderAccessContext) => Promise<unknown>;

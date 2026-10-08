import { z } from 'zod';

import { CONTEXT_ASSERTION_HEADER } from './context-assertion.js';

export const savedAddressStatusSchema = z.object({
  schemaVersion: z.literal('1'),
  savedAddressCount: z.number().int().min(0).max(1_000),
  hasDefaultShippingAddress: z.boolean(),
  hasDefaultBillingAddress: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.savedAddressCount === 0 &&
      (value.hasDefaultShippingAddress || value.hasDefaultBillingAddress)) {
    context.addIssue({ code: 'custom', message: 'Empty address book cannot have a default' });
  }
});

export type SavedAddressStatus = z.infer<typeof savedAddressStatusSchema>;
export type SavedAddressStatusClient = ReturnType<typeof createSavedAddressStatusClient>;

export function createSavedAddressStatusClient({
  baseUrl,
  timeoutMilliseconds = 10_000,
  fetcher = fetch,
}: {
  baseUrl: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
}) {
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000 ||
      timeoutMilliseconds > 60_000) {
    throw new Error('Invalid saved-address request timeout');
  }
  const endpoint = new URL('/v1/account/saved-address-status', baseUrl);

  return {
    async getStatus(assertion: string): Promise<SavedAddressStatus | 'unavailable'> {
      try {
        const response = await fetcher(new Request(endpoint, {
          method: 'GET',
          redirect: 'error',
          headers: { [CONTEXT_ASSERTION_HEADER]: assertion },
          signal: AbortSignal.timeout(timeoutMilliseconds),
        }));
        if (response.status !== 200) return 'unavailable';
        const parsed = savedAddressStatusSchema.safeParse(await response.json());
        return parsed.success ? parsed.data : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}

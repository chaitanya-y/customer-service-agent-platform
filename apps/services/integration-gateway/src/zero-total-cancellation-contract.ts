import { z } from 'zod';

export const ZERO_TOTAL_CANCELLATION_POLICY_VERSION = 'NO_PAYMENT_ZERO_TOTAL_V1' as const;

const opaque = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const utcTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)));

export const zeroTotalCancellationFactsRequestSchema = z.object({ orderReference: opaque }).strict();
export const zeroTotalCancellationIntentSchema = z.object({
  orderId: opaque,
  orderReference: opaque,
  previewId: opaque,
  previewExpiresAt: utcTimestamp,
  policyVersion: z.literal(ZERO_TOTAL_CANCELLATION_POLICY_VERSION),
  providerFactsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

export type ZeroTotalCancellationIntent = z.infer<typeof zeroTotalCancellationIntentSchema>;

export const ZERO_TOTAL_CANCELLATION_FACTS_PATH = '/internal/v1/zero-total-cancellation-facts';
export const ZERO_TOTAL_CANCELLATION_EXECUTE_PATH = '/internal/v1/zero-total-cancellations';
export const ZERO_TOTAL_CANCELLATION_RECONCILE_PATH = '/internal/v1/zero-total-cancellation-reconciliations';

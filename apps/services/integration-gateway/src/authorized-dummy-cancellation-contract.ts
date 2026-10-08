import { z } from 'zod';

export const AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION = 'AUTHORIZED_DUMMY_V1' as const;

const opaque = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const utcTimestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)));

export const authorizedDummyCancellationFactsRequestSchema = z.object({ orderReference: opaque }).strict();
export const authorizedDummyCancellationIntentSchema = z.object({
  orderId: opaque,
  orderReference: opaque,
  paymentId: opaque,
  previewId: opaque,
  previewExpiresAt: utcTimestamp,
  policyVersion: z.literal(AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION),
  providerFactsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

export type AuthorizedDummyCancellationIntent = z.infer<typeof authorizedDummyCancellationIntentSchema>;

export const AUTHORIZED_DUMMY_CANCELLATION_FACTS_PATH = '/internal/v1/authorized-dummy-cancellation-facts';
export const AUTHORIZED_DUMMY_CANCELLATION_EXECUTE_PATH = '/internal/v1/authorized-dummy-cancellations';
export const AUTHORIZED_DUMMY_CANCELLATION_RECONCILE_PATH = '/internal/v1/authorized-dummy-cancellation-reconciliations';

import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';

export const ZERO_TOTAL_CANCELLATION_POLICY_VERSION = 'NO_PAYMENT_ZERO_TOTAL_V1' as const;

export type ZeroTotalCancellationFacts = Readonly<{
  orderId: string;
  orderReference: string;
  policyVersion: typeof ZERO_TOTAL_CANCELLATION_POLICY_VERSION;
  providerFactsDigest: string;
  eligible: boolean;
  placedAt: string | null;
  total: Readonly<{ amountMinor: number; currency: string }>;
  lines: readonly Readonly<{ id: string; quantity: number; orderPlacedQuantity: number; displayName?: string | undefined }>[];
}>;

export type ZeroTotalCancellationIntent = Readonly<{
  orderId: string;
  orderReference: string;
  previewId: string;
  previewExpiresAt: string;
  policyVersion: typeof ZERO_TOTAL_CANCELLATION_POLICY_VERSION;
  providerFactsDigest: string;
  idempotencyKey: string;
}>;

export type ZeroTotalCancellationActivityContext = Readonly<{
  workflowId: string;
  access: WorkflowJourneyAccess;
}>;

export type FetchZeroTotalCancellationFactsInput = ZeroTotalCancellationActivityContext & Readonly<{
  orderReference: string;
}>;
export type ZeroTotalCancellationActionInput = ZeroTotalCancellationActivityContext & Readonly<{
  intent: ZeroTotalCancellationIntent;
}>;
export type ZeroTotalCancellationActionResult = Readonly<{
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION';
  operationId?: string;
}>;
export type ZeroTotalCancellationReconciliationResult = ZeroTotalCancellationActionResult
  | Readonly<{ status: 'NOT_FOUND' }>;

export type ZeroTotalCancellationActivities = Readonly<{
  fetchZeroTotalCancellationFacts(input: FetchZeroTotalCancellationFactsInput): Promise<ZeroTotalCancellationFacts>;
  executeZeroTotalCancellation(input: ZeroTotalCancellationActionInput): Promise<ZeroTotalCancellationActionResult>;
  reconcileZeroTotalCancellation(input: ZeroTotalCancellationActionInput): Promise<ZeroTotalCancellationReconciliationResult>;
}>;

import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';

export const AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION = 'AUTHORIZED_DUMMY_V1' as const;

export type AuthorizedDummyCancellationFacts = Readonly<{
  orderId: string;
  orderReference: string;
  policyVersion: typeof AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION;
  providerFactsDigest: string;
  eligible: boolean;
  placedAt: string | null;
  total: Readonly<{ amountMinor: number; currency: string }>;
  payment: Readonly<{ id: string; state: string; amountMinor: number }> | null;
  lines: readonly Readonly<{ id: string; quantity: number; orderPlacedQuantity: number }>[];
}>;

export type AuthorizedDummyCancellationIntent = Readonly<{
  orderId: string;
  paymentId: string;
  orderReference: string;
  previewId: string;
  previewExpiresAt: string;
  policyVersion: typeof AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION;
  providerFactsDigest: string;
  idempotencyKey: string;
}>;

export type AuthorizedDummyCancellationActivityContext = Readonly<{
  workflowId: string;
  access: WorkflowJourneyAccess;
}>;

export type FetchAuthorizedDummyCancellationFactsInput = AuthorizedDummyCancellationActivityContext & Readonly<{
  orderReference: string;
}>;
export type AuthorizedDummyCancellationActionInput = AuthorizedDummyCancellationActivityContext & Readonly<{
  intent: AuthorizedDummyCancellationIntent;
}>;
export type AuthorizedDummyCancellationActionResult = Readonly<{
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION';
  operationId?: string;
}>;
export type AuthorizedDummyCancellationReconciliationResult = AuthorizedDummyCancellationActionResult
  | Readonly<{ status: 'NOT_FOUND' }>;

export type AuthorizedDummyCancellationActivities = Readonly<{
  fetchAuthorizedDummyCancellationFacts(input: FetchAuthorizedDummyCancellationFactsInput): Promise<AuthorizedDummyCancellationFacts>;
  executeAuthorizedDummyCancellation(input: AuthorizedDummyCancellationActionInput): Promise<AuthorizedDummyCancellationActionResult>;
  reconcileAuthorizedDummyCancellation(input: AuthorizedDummyCancellationActionInput): Promise<AuthorizedDummyCancellationReconciliationResult>;
}>;

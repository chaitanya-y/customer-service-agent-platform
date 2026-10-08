import {
  condition, continueAsNew, defineQuery, defineSignal, proxyActivities, setHandler, sleep, uuid4, workflowInfo,
} from '@temporalio/workflow';

import {
  AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION,
  type AuthorizedDummyCancellationActivities, type AuthorizedDummyCancellationFacts,
  type AuthorizedDummyCancellationIntent,
} from './authorized-dummy-cancellation-activities.js';
import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';

const factsActivities = proxyActivities<Pick<AuthorizedDummyCancellationActivities, 'fetchAuthorizedDummyCancellationFacts'>>({
  startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 },
});
// A failed activity transport can mean the provider mutation committed. Temporal must not re-run it.
const executeActivities = proxyActivities<Pick<AuthorizedDummyCancellationActivities, 'executeAuthorizedDummyCancellation'>>({
  startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 },
});
const reconcileActivities = proxyActivities<Pick<AuthorizedDummyCancellationActivities, 'reconcileAuthorizedDummyCancellation'>>({
  startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 },
});

const PREVIEW_LIFETIME_MS = 15 * 60_000;
const RECONCILIATION_INTERVAL = '5 minutes';
const MAX_RECONCILIATION_ATTEMPTS_PER_RUN = 288;

export type AuthorizedDummyCancellationPreview = Readonly<{
  previewId: string;
  createdAt: string;
  validUntil: string;
  orderId: string;
  orderReference: string;
  placedAt: string;
  total: AuthorizedDummyCancellationFacts['total'];
  lines: AuthorizedDummyCancellationFacts['lines'];
  payment: NonNullable<AuthorizedDummyCancellationFacts['payment']>;
  policyVersion: typeof AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION;
  providerFactsDigest: string;
}>;
export type AuthorizedDummyCancellationRequest = Readonly<{
  orderReference: string;
  policyVersion: typeof AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION;
  access: WorkflowJourneyAccess;
  recovery?: Readonly<{ preview: AuthorizedDummyCancellationPreview; intent: AuthorizedDummyCancellationIntent }>;
}>;
export type AuthorizedDummyCancellationConfirmation = Readonly<{ previewId: string; accepted: boolean }>;
export type AuthorizedDummyCancellationState = Readonly<{
  stage: 'EVALUATING' | 'NOT_ELIGIBLE' | 'AWAITING_CUSTOMER_CONFIRMATION' | 'PREVIEW_EXPIRED'
    | 'CUSTOMER_DECLINED' | 'PREVIEW_INVALIDATED' | 'CANCELLATION_REQUESTED'
    | 'PENDING_RECONCILIATION' | 'BOTH_CANCELLED' | 'CANCELLATION_FAILED' | 'FACTS_UNAVAILABLE';
  preview?: AuthorizedDummyCancellationPreview;
  operationId?: string;
}>;

export const confirmAuthorizedDummyCancellation = defineSignal<[AuthorizedDummyCancellationConfirmation]>('authorized-dummy-cancellation.confirmation');
export const getAuthorizedDummyCancellationState = defineQuery<AuthorizedDummyCancellationState>('authorized-dummy-cancellation.state');
export const getAuthorizedDummyCancellationAccess = defineQuery<WorkflowJourneyAccess>('authorized-dummy-cancellation.access');

function eligible(facts: AuthorizedDummyCancellationFacts, reference: string): boolean {
  return facts.eligible && facts.policyVersion === AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION
    && facts.orderReference === reference && facts.orderId.length > 0
    && /^[a-f0-9]{64}$/.test(facts.providerFactsDigest)
    && facts.placedAt !== null && Number.isFinite(Date.parse(facts.placedAt))
    && Number.isSafeInteger(facts.total.amountMinor) && facts.total.amountMinor > 0
    && facts.payment !== null && facts.payment.id.length > 0 && facts.payment.state === 'Authorized'
    && facts.payment.amountMinor === facts.total.amountMinor && facts.total.currency.length > 0
    && facts.lines.length > 0 && facts.lines.every(line => line.id.length > 0 && Number.isSafeInteger(line.quantity)
      && line.quantity > 0 && line.quantity === line.orderPlacedQuantity);
}

function samePreviewFacts(preview: AuthorizedDummyCancellationPreview, facts: AuthorizedDummyCancellationFacts): boolean {
  return eligible(facts, preview.orderReference) && facts.orderId === preview.orderId
    && facts.providerFactsDigest === preview.providerFactsDigest && facts.placedAt === preview.placedAt
    && facts.total.amountMinor === preview.total.amountMinor && facts.total.currency === preview.total.currency
    && JSON.stringify(facts.payment) === JSON.stringify(preview.payment)
    && JSON.stringify(facts.lines) === JSON.stringify(preview.lines);
}

export async function authorizedDummyCancellationWorkflow(request: AuthorizedDummyCancellationRequest): Promise<AuthorizedDummyCancellationState> {
  let state: AuthorizedDummyCancellationState = { stage: 'EVALUATING' };
  let confirmation: AuthorizedDummyCancellationConfirmation | undefined;
  setHandler(getAuthorizedDummyCancellationState, () => state);
  setHandler(getAuthorizedDummyCancellationAccess, () => request.access);
  setHandler(confirmAuthorizedDummyCancellation, received => {
    if (state.stage === 'AWAITING_CUSTOMER_CONFIRMATION' && state.preview
      && received.previewId === state.preview.previewId && typeof received.accepted === 'boolean'
      && Date.now() < Date.parse(state.preview.validUntil) && confirmation === undefined) confirmation = received;
  });

  if (request.recovery) {
    state = { stage: 'PENDING_RECONCILIATION', preview: request.recovery.preview };
    return reconcile(request, request.recovery.preview, request.recovery.intent, next => { state = next; });
  }
  if (request.policyVersion !== AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION) {
    state = { stage: 'NOT_ELIGIBLE' }; return state;
  }
  const context = { workflowId: workflowInfo().workflowId, access: request.access };
  let facts: AuthorizedDummyCancellationFacts;
  try { facts = await factsActivities.fetchAuthorizedDummyCancellationFacts({ ...context, orderReference: request.orderReference }); }
  catch { state = { stage: 'FACTS_UNAVAILABLE' }; return state; }
  if (!eligible(facts, request.orderReference)) { state = { stage: 'NOT_ELIGIBLE' }; return state; }

  const createdAt = new Date(Date.now()).toISOString();
  const preview: AuthorizedDummyCancellationPreview = {
    previewId: uuid4(), createdAt, validUntil: new Date(Date.now() + PREVIEW_LIFETIME_MS).toISOString(),
    orderId: facts.orderId, orderReference: facts.orderReference, placedAt: facts.placedAt!,
    total: facts.total, lines: facts.lines, payment: facts.payment!, policyVersion: facts.policyVersion,
    providerFactsDigest: facts.providerFactsDigest,
  };
  state = { stage: 'AWAITING_CUSTOMER_CONFIRMATION', preview };
  await condition(() => confirmation !== undefined, PREVIEW_LIFETIME_MS);
  if (confirmation === undefined || Date.now() >= Date.parse(preview.validUntil)) {
    state = { stage: 'PREVIEW_EXPIRED', preview }; return state;
  }
  if (!confirmation.accepted) { state = { stage: 'CUSTOMER_DECLINED', preview }; return state; }

  try { facts = await factsActivities.fetchAuthorizedDummyCancellationFacts({ ...context, orderReference: request.orderReference }); }
  catch { state = { stage: 'FACTS_UNAVAILABLE', preview }; return state; }
  if (Date.now() >= Date.parse(preview.validUntil) || !samePreviewFacts(preview, facts)) {
    state = { stage: 'PREVIEW_INVALIDATED', preview }; return state;
  }
  const intent: AuthorizedDummyCancellationIntent = {
    orderId: preview.orderId, paymentId: preview.payment.id, orderReference: preview.orderReference, previewId: preview.previewId,
    previewExpiresAt: preview.validUntil, policyVersion: preview.policyVersion,
    providerFactsDigest: preview.providerFactsDigest, idempotencyKey: `authorized-dummy-cancel:${preview.previewId}`,
  };
  state = { stage: 'CANCELLATION_REQUESTED', preview };
  try {
    const result = await executeActivities.executeAuthorizedDummyCancellation({ ...context, intent });
    if (result.status === 'SUCCEEDED') { state = { stage: 'BOTH_CANCELLED', preview,
      ...(result.operationId === undefined ? {} : { operationId: result.operationId }) }; return state; }
    if (result.status === 'FAILED') { state = { stage: 'CANCELLATION_FAILED', preview,
      ...(result.operationId === undefined ? {} : { operationId: result.operationId }) }; return state; }
  } catch { /* The write may have committed; only reconciliation is safe. */ }
  state = { stage: 'PENDING_RECONCILIATION', preview };
  return reconcile(request, preview, intent, next => { state = next; });
}

async function reconcile(
  request: AuthorizedDummyCancellationRequest, preview: AuthorizedDummyCancellationPreview,
  intent: AuthorizedDummyCancellationIntent, setState: (state: AuthorizedDummyCancellationState) => void,
): Promise<AuthorizedDummyCancellationState> {
  const context = { workflowId: workflowInfo().workflowId, access: request.access, intent };
  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS_PER_RUN; attempt += 1) {
    try {
      const result = await reconcileActivities.reconcileAuthorizedDummyCancellation(context);
      if (result.status === 'SUCCEEDED') {
        const state: AuthorizedDummyCancellationState = { stage: 'BOTH_CANCELLED', preview,
          ...(result.operationId === undefined ? {} : { operationId: result.operationId }) };
        setState(state); return state;
      }
      if (result.status === 'FAILED') {
        const state: AuthorizedDummyCancellationState = { stage: 'CANCELLATION_FAILED', preview,
          ...(result.operationId === undefined ? {} : { operationId: result.operationId }) };
        setState(state); return state;
      }
    } catch { /* A read failure is not evidence of a failed or missing mutation. */ }
    await sleep(RECONCILIATION_INTERVAL);
  }
  return continueAsNew<typeof authorizedDummyCancellationWorkflow>({ ...request, recovery: { preview, intent } });
}

import {
  condition, continueAsNew, defineQuery, defineSignal, proxyActivities, setHandler, sleep, uuid4, workflowInfo,
} from '@temporalio/workflow';

import {
  ZERO_TOTAL_CANCELLATION_POLICY_VERSION,
  type ZeroTotalCancellationActivities, type ZeroTotalCancellationFacts,
  type ZeroTotalCancellationIntent,
} from './zero-total-cancellation-activities.js';
import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';

const factsActivities = proxyActivities<Pick<ZeroTotalCancellationActivities, 'fetchZeroTotalCancellationFacts'>>({
  startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 },
});
// A failed activity transport can mean the provider mutation committed. Temporal must not re-run it.
const executeActivities = proxyActivities<Pick<ZeroTotalCancellationActivities, 'executeZeroTotalCancellation'>>({
  startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 },
});
const reconcileActivities = proxyActivities<Pick<ZeroTotalCancellationActivities, 'reconcileZeroTotalCancellation'>>({
  startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 },
});

const PREVIEW_LIFETIME_MS = 15 * 60_000;
const RECONCILIATION_INTERVAL = '5 minutes';
const MAX_RECONCILIATION_ATTEMPTS_PER_RUN = 288;

export type ZeroTotalCancellationPreview = Readonly<{
  previewId: string;
  createdAt: string;
  validUntil: string;
  orderId: string;
  orderReference: string;
  placedAt: string;
  total: ZeroTotalCancellationFacts['total'];
  lines: ZeroTotalCancellationFacts['lines'];
  policyVersion: typeof ZERO_TOTAL_CANCELLATION_POLICY_VERSION;
  providerFactsDigest: string;
}>;
export type ZeroTotalCancellationRequest = Readonly<{
  orderReference: string;
  policyVersion: typeof ZERO_TOTAL_CANCELLATION_POLICY_VERSION;
  access: WorkflowJourneyAccess;
  recovery?: Readonly<{ preview: ZeroTotalCancellationPreview; intent: ZeroTotalCancellationIntent }>;
}>;
export type ZeroTotalCancellationConfirmation = Readonly<{ previewId: string; accepted: boolean }>;
export type ZeroTotalCancellationState = Readonly<{
  stage: 'EVALUATING' | 'NOT_ELIGIBLE' | 'AWAITING_CUSTOMER_CONFIRMATION' | 'PREVIEW_EXPIRED'
    | 'CUSTOMER_DECLINED' | 'PREVIEW_INVALIDATED' | 'CANCELLATION_REQUESTED'
    | 'PENDING_RECONCILIATION' | 'ORDER_CANCELLED' | 'CANCELLATION_FAILED' | 'FACTS_UNAVAILABLE';
  preview?: ZeroTotalCancellationPreview;
  operationId?: string;
}>;

export const confirmZeroTotalCancellation = defineSignal<[ZeroTotalCancellationConfirmation]>('zero-total-cancellation.confirmation');
export const getZeroTotalCancellationState = defineQuery<ZeroTotalCancellationState>('zero-total-cancellation.state');
export const getZeroTotalCancellationAccess = defineQuery<WorkflowJourneyAccess>('zero-total-cancellation.access');

function eligible(facts: ZeroTotalCancellationFacts, reference: string): boolean {
  return facts.eligible && facts.policyVersion === ZERO_TOTAL_CANCELLATION_POLICY_VERSION
    && facts.orderReference === reference && facts.orderId.length > 0
    && /^[a-f0-9]{64}$/.test(facts.providerFactsDigest)
    && facts.placedAt !== null && Number.isFinite(Date.parse(facts.placedAt))
    && facts.total.amountMinor === 0 && facts.total.currency.length > 0
    && facts.lines.length > 0 && facts.lines.every(line => line.id.length > 0 && Number.isSafeInteger(line.quantity)
      && line.quantity > 0 && line.quantity === line.orderPlacedQuantity);
}

function samePreviewFacts(preview: ZeroTotalCancellationPreview, facts: ZeroTotalCancellationFacts): boolean {
  return eligible(facts, preview.orderReference) && facts.orderId === preview.orderId
    && facts.providerFactsDigest === preview.providerFactsDigest && facts.placedAt === preview.placedAt
    && facts.total.amountMinor === preview.total.amountMinor && facts.total.currency === preview.total.currency
    && facts.lines.length === preview.lines.length
    && facts.lines.every((line, index) => line.id === preview.lines[index]?.id
      && line.quantity === preview.lines[index]?.quantity
      && line.orderPlacedQuantity === preview.lines[index]?.orderPlacedQuantity);
}

export async function zeroTotalCancellationWorkflow(request: ZeroTotalCancellationRequest): Promise<ZeroTotalCancellationState> {
  let state: ZeroTotalCancellationState = { stage: 'EVALUATING' };
  let confirmation: ZeroTotalCancellationConfirmation | undefined;
  setHandler(getZeroTotalCancellationState, () => state);
  setHandler(getZeroTotalCancellationAccess, () => request.access);
  setHandler(confirmZeroTotalCancellation, received => {
    if (state.stage === 'AWAITING_CUSTOMER_CONFIRMATION' && state.preview
      && received.previewId === state.preview.previewId && typeof received.accepted === 'boolean'
      && Date.now() < Date.parse(state.preview.validUntil) && confirmation === undefined) confirmation = received;
  });

  if (request.recovery) {
    state = { stage: 'PENDING_RECONCILIATION', preview: request.recovery.preview };
    return reconcile(request, request.recovery.preview, request.recovery.intent, next => { state = next; });
  }
  if (request.policyVersion !== ZERO_TOTAL_CANCELLATION_POLICY_VERSION) {
    state = { stage: 'NOT_ELIGIBLE' }; return state;
  }
  const context = { workflowId: workflowInfo().workflowId, access: request.access };
  let facts: ZeroTotalCancellationFacts;
  try { facts = await factsActivities.fetchZeroTotalCancellationFacts({ ...context, orderReference: request.orderReference }); }
  catch { state = { stage: 'FACTS_UNAVAILABLE' }; return state; }
  if (!eligible(facts, request.orderReference)) { state = { stage: 'NOT_ELIGIBLE' }; return state; }

  const createdAt = new Date(Date.now()).toISOString();
  const preview: ZeroTotalCancellationPreview = {
    previewId: uuid4(), createdAt, validUntil: new Date(Date.now() + PREVIEW_LIFETIME_MS).toISOString(),
    orderId: facts.orderId, orderReference: facts.orderReference, placedAt: facts.placedAt!,
    total: facts.total, lines: facts.lines, policyVersion: facts.policyVersion,
    providerFactsDigest: facts.providerFactsDigest,
  };
  state = { stage: 'AWAITING_CUSTOMER_CONFIRMATION', preview };
  await condition(() => confirmation !== undefined, PREVIEW_LIFETIME_MS);
  if (confirmation === undefined || Date.now() >= Date.parse(preview.validUntil)) {
    state = { stage: 'PREVIEW_EXPIRED', preview }; return state;
  }
  if (!confirmation.accepted) { state = { stage: 'CUSTOMER_DECLINED', preview }; return state; }

  try { facts = await factsActivities.fetchZeroTotalCancellationFacts({ ...context, orderReference: request.orderReference }); }
  catch { state = { stage: 'FACTS_UNAVAILABLE', preview }; return state; }
  if (Date.now() >= Date.parse(preview.validUntil) || !samePreviewFacts(preview, facts)) {
    state = { stage: 'PREVIEW_INVALIDATED', preview }; return state;
  }
  const intent: ZeroTotalCancellationIntent = {
    orderId: preview.orderId, orderReference: preview.orderReference, previewId: preview.previewId,
    previewExpiresAt: preview.validUntil, policyVersion: preview.policyVersion,
    providerFactsDigest: preview.providerFactsDigest, idempotencyKey: `zero-total-cancel:${preview.previewId}`,
  };
  state = { stage: 'CANCELLATION_REQUESTED', preview };
  try {
    const result = await executeActivities.executeZeroTotalCancellation({ ...context, intent });
    if (result.status === 'SUCCEEDED') { state = { stage: 'ORDER_CANCELLED', preview,
      ...(result.operationId === undefined ? {} : { operationId: result.operationId }) }; return state; }
    if (result.status === 'FAILED') { state = { stage: 'CANCELLATION_FAILED', preview,
      ...(result.operationId === undefined ? {} : { operationId: result.operationId }) }; return state; }
  } catch { /* The write may have committed; only reconciliation is safe. */ }
  state = { stage: 'PENDING_RECONCILIATION', preview };
  return reconcile(request, preview, intent, next => { state = next; });
}

async function reconcile(
  request: ZeroTotalCancellationRequest, preview: ZeroTotalCancellationPreview,
  intent: ZeroTotalCancellationIntent, setState: (state: ZeroTotalCancellationState) => void,
): Promise<ZeroTotalCancellationState> {
  const context = { workflowId: workflowInfo().workflowId, access: request.access, intent };
  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS_PER_RUN; attempt += 1) {
    try {
      const result = await reconcileActivities.reconcileZeroTotalCancellation(context);
      if (result.status === 'SUCCEEDED') {
        const state: ZeroTotalCancellationState = { stage: 'ORDER_CANCELLED', preview,
          ...(result.operationId === undefined ? {} : { operationId: result.operationId }) };
        setState(state); return state;
      }
      if (result.status === 'FAILED') {
        const state: ZeroTotalCancellationState = { stage: 'CANCELLATION_FAILED', preview,
          ...(result.operationId === undefined ? {} : { operationId: result.operationId }) };
        setState(state); return state;
      }
    } catch { /* A read failure is not evidence of a failed or missing mutation. */ }
    await sleep(RECONCILIATION_INTERVAL);
  }
  return continueAsNew<typeof zeroTotalCancellationWorkflow>({ ...request, recovery: { preview, intent } });
}

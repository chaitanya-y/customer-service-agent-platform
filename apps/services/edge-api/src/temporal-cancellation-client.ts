import { createHash } from 'node:crypto';

import { WorkflowClient, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';

export type CancellationAccess = Readonly<{
  tenantId: string;
  environmentId: string;
  subjectCustomerId: string;
  requestId: string;
  traceId: string;
}>;

export type CancellationWorkflowStartInput = Readonly<{
  workflowId: string;
  orderReference: string;
  policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1';
  access: CancellationAccess;
}>;

export type CancellationPreview = Readonly<{
  previewId: string;
  createdAt: string;
  validUntil: string;
  orderId: string;
  orderReference: string;
  placedAt: string;
  total: Readonly<{ amountMinor: 0; currency: string }>;
  lines: readonly Readonly<{ id: string; quantity: number; orderPlacedQuantity: number }>[];
  policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1';
  providerFactsDigest: string;
}>;

export type CancellationWorkflowView = Readonly<{
  stage: 'EVALUATING' | 'FACTS_UNAVAILABLE' | 'NOT_ELIGIBLE' | 'AWAITING_CUSTOMER_CONFIRMATION'
    | 'PREVIEW_EXPIRED' | 'CUSTOMER_DECLINED' | 'PREVIEW_INVALIDATED' | 'CANCELLATION_REQUESTED'
    | 'PENDING_RECONCILIATION' | 'ORDER_CANCELLED' | 'CANCELLATION_FAILED';
  preview?: CancellationPreview;
}>;

export type StartCancellationWorkflow = (input: CancellationWorkflowStartInput) => Promise<Readonly<{ workflowId: string }>>;
export type GetCancellationWorkflow = (input: Readonly<{ workflowId: string; access: CancellationAccess }>) => Promise<CancellationWorkflowView>;
export type ConfirmCancellationWorkflow = (input: Readonly<{
  workflowId: string; access: CancellationAccess; previewId: string; accepted: boolean;
}>) => Promise<void>;

export class CancellationWorkflowNotFoundError extends Error {
  constructor() {
    super('Cancellation workflow was not found for this customer');
    this.name = 'CancellationWorkflowNotFoundError';
  }
}

export class CancellationPreviewUnavailableError extends Error {
  constructor() {
    super('This cancellation preview is no longer available');
    this.name = 'CancellationPreviewUnavailableError';
  }
}

function sameOwner(actual: CancellationAccess, expected: CancellationAccess): boolean {
  return actual.tenantId === expected.tenantId
    && actual.environmentId === expected.environmentId
    && actual.subjectCustomerId === expected.subjectCustomerId;
}

function startDigest(input: CancellationWorkflowStartInput): string {
  return createHash('sha256').update(JSON.stringify([
    'zero-total-cancellation-v1', input.access.tenantId, input.access.environmentId,
    input.access.subjectCustomerId, input.orderReference, input.policyVersion,
  ])).digest('hex');
}

export function createTemporalCancellationClient({ client, taskQueue }: Readonly<{
  client: WorkflowClient;
  taskQueue: string;
}>): Readonly<{
  startCancellationWorkflow: StartCancellationWorkflow;
  getCancellationWorkflow: GetCancellationWorkflow;
  confirmCancellationWorkflow: ConfirmCancellationWorkflow;
}> {
  async function ownedHandle(workflowId: string, access: CancellationAccess) {
    const handle = client.getHandle(workflowId);
    let actual: CancellationAccess;
    try {
      actual = await handle.query<CancellationAccess>('zero-total-cancellation.access');
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) throw new CancellationWorkflowNotFoundError();
      throw error;
    }
    if (!sameOwner(actual, access)) throw new CancellationWorkflowNotFoundError();
    return handle;
  }

  return {
    async startCancellationWorkflow(input) {
      const digest = startDigest(input);
      try {
        const handle = await client.start('zeroTotalCancellationWorkflow', {
          taskQueue,
          workflowId: input.workflowId,
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          workflowIdConflictPolicy: 'FAIL',
          memo: { zeroTotalCancellationStartDigest: digest },
          args: [{ orderReference: input.orderReference, policyVersion: input.policyVersion, access: input.access }],
        });
        return { workflowId: handle.workflowId };
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        const handle = await ownedHandle(input.workflowId, input.access);
        const existing = await handle.describe();
        if (existing.memo?.zeroTotalCancellationStartDigest !== digest) {
          throw new Error('Existing cancellation workflow does not match this request');
        }
        return { workflowId: input.workflowId };
      }
    },
    async getCancellationWorkflow({ workflowId, access }) {
      const handle = await ownedHandle(workflowId, access);
      return handle.query<CancellationWorkflowView>('zero-total-cancellation.state');
    },
    async confirmCancellationWorkflow({ workflowId, access, previewId, accepted }) {
      const handle = await ownedHandle(workflowId, access);
      const current = await handle.query<CancellationWorkflowView>('zero-total-cancellation.state');
      if (current.stage !== 'AWAITING_CUSTOMER_CONFIRMATION' || current.preview?.previewId !== previewId) {
        throw new CancellationPreviewUnavailableError();
      }
      // Temporal owns the preview deadline; the Edge clock is never an authority.
      try {
        await handle.signal('zero-total-cancellation.confirmation', { previewId, accepted });
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) {
          const latest = await handle.query<CancellationWorkflowView>('zero-total-cancellation.state');
          if (latest.stage !== 'AWAITING_CUSTOMER_CONFIRMATION' || latest.preview?.previewId !== previewId) {
            throw new CancellationPreviewUnavailableError();
          }
        }
        throw error;
      }
    },
  };
}

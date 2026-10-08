import { SignJWT } from 'jose';
import { z } from 'zod';

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const workflowJourneyAccessSchema = z
  .object({
    tenantId: opaqueId,
    environmentId: opaqueId,
    subjectCustomerId: opaqueId,
    requestId: opaqueId,
    traceId: opaqueId,
  })
  .strict();

export type WorkflowJourneyAccess = z.infer<typeof workflowJourneyAccessSchema>;

const refundExecutionSchema = z.object({
  orderId: z.string().trim().min(1).max(160),
  reasonCode: z.string().trim().min(1).max(100),
  amount: z.object({
    amountMinor: z.number().int().positive().refine(Number.isSafeInteger),
    currency: z.literal('USD'),
  }).strict(),
  selection: z.object({
    scope: z.enum(['FULL_ORDER', 'SELECTED_ITEMS']),
    itemIds: z.array(z.string()).max(100),
  }).strict(),
  previewId: z.string().trim().min(1).max(160),
  idempotencyKey: z.string().min(1).max(240),
}).strict();

const zeroTotalCancellationSchema = z.object({
  orderId: opaqueId,
  orderReference: opaqueId,
  previewId: opaqueId,
  previewExpiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    .refine(value => Number.isFinite(Date.parse(value))),
  policyVersion: z.literal('NO_PAYMENT_ZERO_TOTAL_V1'),
  providerFactsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

const authorizedDummyCancellationSchema = zeroTotalCancellationSchema.extend({
  paymentId: opaqueId,
  policyVersion: z.literal('AUTHORIZED_DUMMY_V1'),
}).strict();

export type RefundExecutionIntent = Readonly<{
  orderId: string;
  reasonCode: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
  selection: Readonly<{ scope: 'FULL_ORDER' | 'SELECTED_ITEMS'; itemIds: readonly string[] }>;
  previewId: string;
  idempotencyKey: string;
}>;

export type WorkflowAccessAssertionInput = Readonly<{
  workflowId: string;
  workflowType?: 'ZERO_TOTAL_CANCELLATION' | 'AUTHORIZED_DUMMY_CANCELLATION';
  access: WorkflowJourneyAccess;
  refundExecution?: RefundExecutionIntent;
  zeroTotalCancellation?: z.infer<typeof zeroTotalCancellationSchema>;
  authorizedDummyCancellation?: z.infer<typeof authorizedDummyCancellationSchema>;
  purpose:
    | 'refund_fact_refresh'
    | 'refund_execute'
    | 'refund_reconcile'
    | 'human_case_open'
    | 'human_case_close'
    | 'refund_evidence_open'
    | 'refund_evidence_read'
    | 'human_case_transition'
    | 'zero_total_cancel_facts'
    | 'zero_total_cancel_execute'
    | 'zero_total_cancel_reconcile'
    | 'authorized_dummy_cancel_facts'
    | 'authorized_dummy_cancel_execute'
    | 'authorized_dummy_cancel_reconcile';
}>;

export type SignWorkflowAccessAssertion = (
  input: WorkflowAccessAssertionInput,
) => Promise<string>;

type WorkflowAccessAssertionSignerOptions = Readonly<{
  secret: string;
  issuer: string;
  audience: string;
  lifetimeSeconds?: number;
  now?: () => Date;
}>;

export function createHmacWorkflowAccessAssertionSigner({
  secret,
  issuer,
  audience,
  lifetimeSeconds = 60,
  now = () => new Date(),
}: WorkflowAccessAssertionSignerOptions): SignWorkflowAccessAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Workflow access assertion secret must contain at least 32 bytes');
  }
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
    throw new Error('Workflow access assertion lifetime must be between 1 and 300 seconds');
  }

  const signingKey = new TextEncoder().encode(secret);

  return async (unvalidatedInput) => {
    const access = workflowJourneyAccessSchema.parse(unvalidatedInput.access);
    const workflowId = opaqueId.parse(unvalidatedInput.workflowId);
    const cancellationPurpose = unvalidatedInput.purpose === 'zero_total_cancel_facts'
      || unvalidatedInput.purpose === 'zero_total_cancel_execute'
      || unvalidatedInput.purpose === 'zero_total_cancel_reconcile';
    const authorizedDummyPurpose = unvalidatedInput.purpose === 'authorized_dummy_cancel_facts'
      || unvalidatedInput.purpose === 'authorized_dummy_cancel_execute'
      || unvalidatedInput.purpose === 'authorized_dummy_cancel_reconcile';
    if (authorizedDummyPurpose !== (unvalidatedInput.workflowType === 'AUTHORIZED_DUMMY_CANCELLATION')) {
      throw new Error('Workflow type has the wrong assertion purpose');
    }
    if (cancellationPurpose !== (unvalidatedInput.workflowType === 'ZERO_TOTAL_CANCELLATION')) {
      throw new Error('Workflow type has the wrong assertion purpose');
    }
    const cancellationWritePurpose = unvalidatedInput.purpose === 'zero_total_cancel_execute'
      || unvalidatedInput.purpose === 'zero_total_cancel_reconcile';
    if (!cancellationWritePurpose && unvalidatedInput.zeroTotalCancellation !== undefined) {
      throw new Error('Cancellation intent has the wrong assertion purpose');
    }
    const zeroTotalCancellation = cancellationWritePurpose
      ? zeroTotalCancellationSchema.parse(unvalidatedInput.zeroTotalCancellation) : undefined;
    const authorizedDummyWritePurpose = unvalidatedInput.purpose === 'authorized_dummy_cancel_execute'
      || unvalidatedInput.purpose === 'authorized_dummy_cancel_reconcile';
    if (!authorizedDummyWritePurpose && unvalidatedInput.authorizedDummyCancellation !== undefined) {
      throw new Error('Authorized dummy cancellation intent has the wrong assertion purpose');
    }
    const authorizedDummyCancellation = authorizedDummyWritePurpose
      ? authorizedDummyCancellationSchema.parse(unvalidatedInput.authorizedDummyCancellation) : undefined;
    if (unvalidatedInput.purpose !== 'refund_execute' && unvalidatedInput.refundExecution !== undefined) {
      throw new Error('Refund execution intent has the wrong assertion purpose');
    }
    const refundExecution = unvalidatedInput.purpose === 'refund_execute'
      ? refundExecutionSchema.parse(unvalidatedInput.refundExecution)
      : undefined;
    const issuedAt = Math.floor(now().getTime() / 1_000);

    return new SignJWT({
      accessVersion: '1',
      workflow: { workflowId, ...((cancellationPurpose || authorizedDummyPurpose)
        ? { workflowType: unvalidatedInput.workflowType } : {}) },
      tenant: {
        tenantId: access.tenantId,
        environmentId: access.environmentId,
      },
      subject: { customerId: access.subjectCustomerId },
      purpose: unvalidatedInput.purpose,
      ...(refundExecution === undefined ? {} : { refundExecution }),
      ...(zeroTotalCancellation === undefined ? {} : { zeroTotalCancellation }),
      ...(authorizedDummyCancellation === undefined ? {} : { authorizedDummyCancellation }),
      request: { requestId: access.requestId, traceId: access.traceId },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'cso-workflow+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + lifetimeSeconds)
      .sign(signingKey);
  };
}

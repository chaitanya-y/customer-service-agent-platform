import { jwtVerify } from 'jose';
import { z } from 'zod';

import type { OrderAccessContext } from './trusted-context.js';
import { authorizedDummyCancellationIntentSchema, type AuthorizedDummyCancellationIntent } from './authorized-dummy-cancellation-contract.js';
import { zeroTotalCancellationIntentSchema, type ZeroTotalCancellationIntent } from './zero-total-cancellation-contract.js';

export const WORKFLOW_ACCESS_ASSERTION_HEADER = 'x-cso-workflow-assertion';

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const refundExecutionIntentSchema = z.object({
  orderId: z.string().trim().min(1).max(160),
  reasonCode: z.string().trim().min(1).max(100),
  amount: z.object({ amountMinor: z.number().int().positive(), currency: z.literal('USD') }).strict(),
  selection: z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('FULL_ORDER'), itemIds: z.array(z.string()).length(0) }).strict(),
    z.object({
      scope: z.literal('SELECTED_ITEMS'),
      itemIds: z.array(opaqueId).min(1).max(100)
        .refine((itemIds) => new Set(itemIds).size === itemIds.length),
    }).strict(),
  ]),
  idempotencyKey: z.string().min(1).max(240),
  previewId: z.string().trim().min(1).max(160),
}).strict();

export type RefundExecutionIntent = z.infer<typeof refundExecutionIntentSchema>;
export type WorkflowAccessContext = OrderAccessContext & {
  refundExecution?: RefundExecutionIntent;
  workflowType?: 'ZERO_TOTAL_CANCELLATION' | 'AUTHORIZED_DUMMY_CANCELLATION';
  zeroTotalCancellation?: ZeroTotalCancellationIntent;
  authorizedDummyCancellation?: AuthorizedDummyCancellationIntent;
};

const workflowAccessClaimsSchema = z
  .object({
    accessVersion: z.literal('1'),
    workflow: z
      .object({
        workflowId: opaqueId,
        workflowType: z.enum(['ZERO_TOTAL_CANCELLATION', 'AUTHORIZED_DUMMY_CANCELLATION']).optional(),
      })
      .strict(),
    tenant: z
      .object({
        tenantId: opaqueId,
        environmentId: opaqueId,
      })
      .strict(),
    subject: z
      .object({
        customerId: opaqueId,
      })
      .strict(),
    purpose: z.enum(['refund_fact_refresh', 'refund_execute', 'refund_reconcile',
      'zero_total_cancel_facts', 'zero_total_cancel_execute', 'zero_total_cancel_reconcile',
      'authorized_dummy_cancel_facts', 'authorized_dummy_cancel_execute', 'authorized_dummy_cancel_reconcile']),
    refundExecution: refundExecutionIntentSchema.optional(),
    zeroTotalCancellation: zeroTotalCancellationIntentSchema.optional(),
    authorizedDummyCancellation: authorizedDummyCancellationIntentSchema.optional(),
    request: z
      .object({
        requestId: opaqueId,
        traceId: opaqueId,
      })
      .strict(),
    iss: z.string().min(1).max(200),
    aud: z.string().min(1).max(200),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type VerifyWorkflowAccessAssertion = (
  assertion: string | undefined,
) => Promise<WorkflowAccessContext>;

type WorkflowAccessAssertionVerifierOptions = {
  secret: string;
  expectedIssuer: string;
  expectedAudience: string;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  expectedPurpose?: 'refund_fact_refresh' | 'refund_execute' | 'refund_reconcile'
    | 'zero_total_cancel_facts' | 'zero_total_cancel_execute' | 'zero_total_cancel_reconcile'
    | 'authorized_dummy_cancel_facts' | 'authorized_dummy_cancel_execute' | 'authorized_dummy_cancel_reconcile';
  now?: () => Date;
};

export function createHmacWorkflowAccessAssertionVerifier({
  secret,
  expectedIssuer,
  expectedAudience,
  expectedTenantId,
  expectedEnvironmentId,
  expectedPurpose = 'refund_fact_refresh',
  now = () => new Date(),
}: WorkflowAccessAssertionVerifierOptions): VerifyWorkflowAccessAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Workflow access assertion secret must contain at least 32 bytes');
  }

  const verificationKey = new TextEncoder().encode(secret);

  return async (assertion) => {
    if (!assertion || assertion.length > 8_192) {
      throw new Error('WORKFLOW_ACCESS_UNAUTHORIZED');
    }

    try {
      const currentDate = now();
      const { payload } = await jwtVerify(assertion, verificationKey, {
        algorithms: ['HS256'],
        issuer: expectedIssuer,
        audience: expectedAudience,
        typ: 'cso-workflow+jwt',
        currentDate,
      });
      const claims = workflowAccessClaimsSchema.parse(payload);
      const nowSeconds = Math.floor(currentDate.getTime() / 1_000);

      if (
        claims.tenant.tenantId !== expectedTenantId ||
        claims.tenant.environmentId !== expectedEnvironmentId ||
        claims.iat > nowSeconds + 30 ||
        claims.exp <= nowSeconds ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 300
        || claims.purpose !== expectedPurpose
        || (claims.purpose === 'refund_execute' && !claims.refundExecution)
        || (claims.purpose !== 'refund_execute' && claims.refundExecution !== undefined)
        || (claims.purpose.startsWith('zero_total_cancel_') && claims.workflow.workflowType !== 'ZERO_TOTAL_CANCELLATION')
        || (claims.purpose.startsWith('authorized_dummy_cancel_') && claims.workflow.workflowType !== 'AUTHORIZED_DUMMY_CANCELLATION')
        || (!claims.purpose.startsWith('zero_total_cancel_') && !claims.purpose.startsWith('authorized_dummy_cancel_')
          && claims.workflow.workflowType !== undefined)
        || (['zero_total_cancel_execute', 'zero_total_cancel_reconcile'].includes(claims.purpose) && !claims.zeroTotalCancellation)
        || (!['zero_total_cancel_execute', 'zero_total_cancel_reconcile'].includes(claims.purpose) && claims.zeroTotalCancellation !== undefined)
        || (['authorized_dummy_cancel_execute', 'authorized_dummy_cancel_reconcile'].includes(claims.purpose) && !claims.authorizedDummyCancellation)
        || (!['authorized_dummy_cancel_execute', 'authorized_dummy_cancel_reconcile'].includes(claims.purpose)
          && claims.authorizedDummyCancellation !== undefined)
      ) {
        throw new Error('WORKFLOW_ACCESS_UNAUTHORIZED');
      }

      return {
        contextId: claims.workflow.workflowId,
        tenantId: claims.tenant.tenantId,
        environmentId: claims.tenant.environmentId,
        subjectCustomerId: claims.subject.customerId,
        routingEpoch: 1,
        requestId: claims.request.requestId,
        traceId: claims.request.traceId,
        ...(claims.refundExecution === undefined ? {} : { refundExecution: claims.refundExecution }),
        ...(claims.workflow.workflowType === undefined ? {} : { workflowType: claims.workflow.workflowType }),
        ...(claims.zeroTotalCancellation === undefined ? {} : { zeroTotalCancellation: claims.zeroTotalCancellation }),
        ...(claims.authorizedDummyCancellation === undefined ? {} : { authorizedDummyCancellation: claims.authorizedDummyCancellation }),
      };
    } catch {
      throw new Error('WORKFLOW_ACCESS_UNAUTHORIZED');
    }
  };
}

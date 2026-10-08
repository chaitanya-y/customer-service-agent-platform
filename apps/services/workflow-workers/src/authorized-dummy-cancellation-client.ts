import { z } from 'zod';

import type {
  FetchAuthorizedDummyCancellationFactsInput, AuthorizedDummyCancellationActionInput,
  AuthorizedDummyCancellationActivities,
} from './authorized-dummy-cancellation-activities.js';
import type { SignWorkflowAccessAssertion } from './workflow-access-assertion.js';

const factsSchema = z.object({
  orderId: z.string().min(1), orderReference: z.string().min(1),
  policyVersion: z.literal('AUTHORIZED_DUMMY_V1'),
  providerFactsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  eligible: z.boolean(), placedAt: z.string().nullable(),
  total: z.object({ amountMinor: z.number().int().refine(Number.isSafeInteger), currency: z.string().min(1) }).strict(),
  payment: z.object({ id: z.string().min(1), state: z.string().min(1),
    amountMinor: z.number().int().refine(Number.isSafeInteger) }).strict().nullable(),
  lines: z.array(z.object({ id: z.string().min(1), quantity: z.number().int(),
    orderPlacedQuantity: z.number().int() }).strict()),
}).strict();
const executionSchema = z.object({ status: z.enum(['SUCCEEDED', 'FAILED', 'PENDING_RECONCILIATION']),
  operationId: z.string().min(1) }).strict();
const reconciliationSchema = z.union([
  executionSchema,
  z.object({ status: z.literal('NOT_FOUND') }).strict(),
]);

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Options = Readonly<{
  baseUrl: string;
  signWorkflowAccessAssertion: SignWorkflowAccessAssertion;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  timeoutMilliseconds?: number;
  fetchImpl?: FetchLike;
}>;

export function createIntegrationGatewayAuthorizedDummyCancellationClient({
  baseUrl, signWorkflowAccessAssertion, expectedTenantId, expectedEnvironmentId,
  timeoutMilliseconds = 5_000, fetchImpl = fetch,
}: Options): AuthorizedDummyCancellationActivities {
  const factsUrl = new URL('/internal/v1/authorized-dummy-cancellation-facts', baseUrl);
  const executeUrl = new URL('/internal/v1/authorized-dummy-cancellations', baseUrl);
  const reconcileUrl = new URL('/internal/v1/authorized-dummy-cancellation-reconciliations', baseUrl);
  function assertScope(access: FetchAuthorizedDummyCancellationFactsInput['access']): void {
    if (access.tenantId !== expectedTenantId || access.environmentId !== expectedEnvironmentId) {
      throw new Error('WORKFLOW_ACCESS_SCOPE_MISMATCH');
    }
  }
  async function post(url: URL, body: unknown, token: string): Promise<Response> {
    return fetchImpl(url, { method: 'POST', redirect: 'error', headers: {
      'content-type': 'application/json', 'x-cso-workflow-assertion': token,
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMilliseconds) });
  }
  return {
    async fetchAuthorizedDummyCancellationFacts(input) {
      assertScope(input.access);
      const token = await signWorkflowAccessAssertion({ workflowId: input.workflowId,
        workflowType: 'AUTHORIZED_DUMMY_CANCELLATION', access: input.access, purpose: 'authorized_dummy_cancel_facts' });
      const response = await post(factsUrl, { orderReference: input.orderReference }, token);
      if (!response.ok) throw new Error(`Cancellation facts unavailable (${response.status})`);
      return factsSchema.parse(await response.json());
    },
    async executeAuthorizedDummyCancellation(input: AuthorizedDummyCancellationActionInput) {
      assertScope(input.access);
      const token = await signWorkflowAccessAssertion({ workflowId: input.workflowId,
        workflowType: 'AUTHORIZED_DUMMY_CANCELLATION', access: input.access,
        purpose: 'authorized_dummy_cancel_execute', authorizedDummyCancellation: input.intent });
      let response: Response;
      try { response = await post(executeUrl, input.intent, token); }
      catch { return { status: 'PENDING_RECONCILIATION' }; }
      if (response.status >= 500) return { status: 'PENDING_RECONCILIATION' };
      if (!response.ok) return { status: 'FAILED' };
      try { return executionSchema.parse(await response.json()); }
      catch { return { status: 'PENDING_RECONCILIATION' }; }
    },
    async reconcileAuthorizedDummyCancellation(input: AuthorizedDummyCancellationActionInput) {
      assertScope(input.access);
      const token = await signWorkflowAccessAssertion({ workflowId: input.workflowId,
        workflowType: 'AUTHORIZED_DUMMY_CANCELLATION', access: input.access,
        purpose: 'authorized_dummy_cancel_reconcile', authorizedDummyCancellation: input.intent });
      try {
        const response = await post(reconcileUrl, input.intent, token);
        if (!response.ok) return { status: 'PENDING_RECONCILIATION' };
        return reconciliationSchema.parse(await response.json());
      } catch { return { status: 'PENDING_RECONCILIATION' }; }
    },
  };
}

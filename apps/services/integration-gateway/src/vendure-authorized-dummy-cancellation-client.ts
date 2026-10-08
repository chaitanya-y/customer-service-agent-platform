import { z } from 'zod';

import { AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION } from './authorized-dummy-cancellation-contract.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const paymentSchema = z.object({
  id: z.string().min(1), state: z.string(), amount: z.number().int().nonnegative(),
  method: z.string(), handlerCode: z.string(), paymentMethodId: z.string(), handlerArgsDigest: digest,
});
const factsSchema = z.object({
  orderId: z.string().min(1), orderReference: z.string().min(1), customerId: z.string().nullable(),
  channelIds: z.array(z.string()), orderType: z.string(), state: z.string(), active: z.boolean(),
  placedAt: z.string().nullable(), currencyCode: z.string(), totalWithTax: z.number().int(),
  lines: z.array(z.object({ id: z.string(), quantity: z.number().int(), orderPlacedQuantity: z.number().int() })),
  paymentCount: z.number().int().nonnegative(), payment: paymentSchema.nullable(),
  refundCount: z.number().int().nonnegative(), fulfillmentCount: z.number().int().nonnegative(),
  digest, eligible: z.boolean(),
});
const markerSchema = z.object({
  operationId: z.string().min(1), orderId: z.string().min(1), tenantId: z.string().min(1),
  environmentId: z.string().min(1), customerId: z.string().min(1), orderReference: z.string().min(1),
  paymentId: z.string().min(1), factsDigest: digest, workflowId: z.string().min(1),
  previewId: z.string().min(1), previewExpiresAt: z.string(),
  policyVersion: z.literal(AUTHORIZED_DUMMY_CANCELLATION_POLICY_VERSION),
  idempotencyKey: z.string().min(1), status: z.literal('SUCCEEDED'),
});
const resultSchema = z.object({
  status: z.literal('SUCCEEDED'), operationId: z.string().min(1), paymentId: z.string().min(1),
}).strict();

export type VendureAuthorizedDummyCancellationFacts = z.infer<typeof factsSchema>;
export type VendureAuthorizedDummyCancellationMarker = z.infer<typeof markerSchema>;
export type GuardedVendureAuthorizedDummyCancellationInput = Readonly<{
  operationId: string; tenantId: string; environmentId: string; customerId: string;
  orderId: string; orderReference: string; paymentId: string; expectedFactsDigest: string;
  workflowId: string; previewId: string; previewExpiresAt: string; policyVersion: string; idempotencyKey: string;
}>;
export interface AuthorizedDummyCancellationProvider {
  getFacts(orderId: string): Promise<VendureAuthorizedDummyCancellationFacts | null>;
  cancel(input: GuardedVendureAuthorizedDummyCancellationInput): Promise<z.infer<typeof resultSchema>>;
  getMarker(operationId: string): Promise<VendureAuthorizedDummyCancellationMarker | null>;
}

const factsQuery = `query AuthorizedDummyCancellationFacts($orderId: ID!) {
  activeChannel { code }
  authorizedDummyCancellationFacts(orderId: $orderId) {
    orderId orderReference customerId channelIds orderType state active placedAt currencyCode totalWithTax
    lines { id quantity orderPlacedQuantity }
    paymentCount payment { id state amount method handlerCode paymentMethodId handlerArgsDigest }
    refundCount fulfillmentCount digest eligible
  }
}`;
const cancelMutation = `mutation GuardedAuthorizedDummyCancellation($input: GuardedAuthorizedDummyCancellationInput!) {
  guardedCancelAuthorizedDummyOrder(input: $input) { status operationId paymentId }
}`;
const markerQuery = `query AuthorizedDummyCancellationMarker($operationId: String!) {
  activeChannel { code }
  authorizedDummyCancellationMarker(operationId: $operationId) {
    operationId orderId tenantId environmentId customerId orderReference paymentId factsDigest
    workflowId previewId previewExpiresAt policyVersion idempotencyKey status
  }
}`;
const channelQuery = `query AuthorizedDummyCancellationChannel { activeChannel { code } }`;

export function createVendureAuthorizedDummyCancellationClient({ adminApiUrl, apiKey, channelToken, expectedChannelCode, fetcher = fetch }: {
  adminApiUrl: string; apiKey: string; channelToken: string; expectedChannelCode: string; fetcher?: typeof fetch;
}): AuthorizedDummyCancellationProvider {
  if (typeof channelToken !== 'string' || !channelToken.trim()
    || typeof expectedChannelCode !== 'string' || !expectedChannelCode.trim()) {
    throw new Error('VENDURE_AUTHORIZED_DUMMY_CANCELLATION_CHANNEL_BINDING_REQUIRED');
  }
  async function request(query: string, variables: Record<string, unknown>, checkChannel = true): Promise<unknown> {
    const response = await fetcher(adminApiUrl, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'vendure-api-key': apiKey, 'vendure-token': channelToken },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error('VENDURE_AUTHORIZED_DUMMY_CANCELLATION_HTTP_ERROR');
    const payload = z.object({
      data: z.record(z.string(), z.unknown()).optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    }).safeParse(await response.json());
    if (!payload.success || payload.data.errors?.length || !payload.data.data) {
      throw new Error('VENDURE_AUTHORIZED_DUMMY_CANCELLATION_RESPONSE_INVALID');
    }
    if (checkChannel) {
      const channel = z.object({ code: z.string().min(1) }).safeParse(payload.data.data.activeChannel);
      if (!channel.success || channel.data.code !== expectedChannelCode) {
        throw new Error('VENDURE_AUTHORIZED_DUMMY_CANCELLATION_CHANNEL_MISMATCH');
      }
    }
    return payload.data.data;
  }
  return {
    async getFacts(orderId) {
      const data = z.object({ authorizedDummyCancellationFacts: factsSchema.nullable() })
        .parse(await request(factsQuery, { orderId }));
      return data.authorizedDummyCancellationFacts;
    },
    async cancel(input) {
      // Query-only channel proof is a preflight, not an atomic mutation guard.
      // The provider must enforce ctx.channelId within its transaction.
      await request(channelQuery, {});
      const data = z.object({ guardedCancelAuthorizedDummyOrder: resultSchema })
        .parse(await request(cancelMutation, { input }, false));
      const result = data.guardedCancelAuthorizedDummyOrder;
      if (result.operationId !== input.operationId || result.paymentId !== input.paymentId) {
        throw new Error('VENDURE_AUTHORIZED_DUMMY_CANCELLATION_IDENTITY_MISMATCH');
      }
      return result;
    },
    async getMarker(operationId) {
      const data = z.object({ authorizedDummyCancellationMarker: markerSchema.nullable() })
        .parse(await request(markerQuery, { operationId }));
      return data.authorizedDummyCancellationMarker;
    },
  };
}

import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const factsSchema = z.object({
  orderId: z.string(), orderReference: z.string(), customerId: z.string().nullable(), channelIds: z.array(z.string()),
  orderType: z.string(), state: z.string(), active: z.boolean(), placedAt: z.string().nullable(), currencyCode: z.string(), totalWithTax: z.number().int(),
  lines: z.array(z.object({ id: z.string(), quantity: z.number().int(), orderPlacedQuantity: z.number().int() })),
  paymentCount: z.number().int().nonnegative(), refundCount: z.number().int().nonnegative(), fulfillmentCount: z.number().int().nonnegative(),
  digest, eligible: z.boolean(),
});
const markerSchema = z.object({
  operationId: z.string(), orderId: z.string(), tenantId: z.string(), environmentId: z.string(),
  customerId: z.string(), orderReference: z.string(), factsDigest: digest,
  workflowId: z.string(), previewId: z.string(), previewExpiresAt: z.string(), policyVersion: z.string(), idempotencyKey: z.string(),
  status: z.literal('SUCCEEDED'),
});
const guardedResultSchema = z.object({ status: z.literal('SUCCEEDED'), operationId: z.string() });

export type VendureZeroTotalCancellationFacts = z.infer<typeof factsSchema>;
export type VendureZeroTotalCancellationMarker = z.infer<typeof markerSchema>;
export type GuardedVendureCancellationInput = Readonly<{
  operationId: string; tenantId: string; environmentId: string; customerId: string;
  orderId: string; orderReference: string; expectedFactsDigest: string;
  workflowId: string; previewId: string; previewExpiresAt: string; policyVersion: string; idempotencyKey: string;
}>;
export interface ZeroTotalCancellationProvider {
  getFacts(orderId: string): Promise<VendureZeroTotalCancellationFacts | null>;
  cancel(input: GuardedVendureCancellationInput): Promise<{ status: 'SUCCEEDED'; operationId: string }>;
  getMarker(operationId: string): Promise<VendureZeroTotalCancellationMarker | null>;
}

const factsQuery = `query ZeroTotalCancellationFacts($orderId: ID!) {
  activeChannel { code }
  zeroTotalCancellationFacts(orderId: $orderId) {
    orderId orderReference customerId channelIds orderType state active placedAt currencyCode totalWithTax
    lines { id quantity orderPlacedQuantity }
    paymentCount refundCount fulfillmentCount digest eligible
  }
}`;
const cancelMutation = `mutation GuardedZeroTotalCancellation($input: GuardedZeroTotalCancellationInput!) {
  guardedCancelZeroTotalOrder(input: $input) { status operationId }
}`;
const markerQuery = `query ZeroTotalCancellationMarker($operationId: String!) {
  activeChannel { code }
  zeroTotalCancellationMarker(operationId: $operationId) {
    operationId orderId tenantId environmentId customerId orderReference factsDigest
    workflowId previewId previewExpiresAt policyVersion idempotencyKey status
  }
}`;
const channelQuery = `query ZeroTotalCancellationChannel { activeChannel { code } }`;

export function createVendureZeroTotalCancellationClient({ adminApiUrl, apiKey, channelToken, expectedChannelCode, fetcher = fetch }: {
  adminApiUrl: string; apiKey: string; channelToken: string; expectedChannelCode: string; fetcher?: typeof fetch;
}): ZeroTotalCancellationProvider {
  if (typeof channelToken !== 'string' || !channelToken.trim()
    || typeof expectedChannelCode !== 'string' || !expectedChannelCode.trim()) {
    throw new Error('VENDURE_ZERO_TOTAL_CANCELLATION_CHANNEL_BINDING_REQUIRED');
  }
  async function request(query: string, variables: Record<string, unknown>, checkChannel = true): Promise<unknown> {
    const response = await fetcher(adminApiUrl, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'vendure-api-key': apiKey, 'vendure-token': channelToken }, body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw new Error('VENDURE_ZERO_TOTAL_CANCELLATION_HTTP_ERROR');
    const payload = z.object({ data: z.record(z.string(), z.unknown()).optional(), errors: z.array(z.object({ message: z.string() })).optional() }).safeParse(await response.json());
    if (!payload.success || payload.data.errors?.length || !payload.data.data) throw new Error('VENDURE_ZERO_TOTAL_CANCELLATION_RESPONSE_INVALID');
    if (checkChannel) {
      const channel = z.object({ code: z.string().min(1) }).safeParse(payload.data.data.activeChannel);
      if (!channel.success || channel.data.code !== expectedChannelCode) {
        throw new Error('VENDURE_ZERO_TOTAL_CANCELLATION_CHANNEL_MISMATCH');
      }
    }
    return payload.data.data;
  }
  async function getFacts(orderId: string): Promise<VendureZeroTotalCancellationFacts | null> {
    const data = z.object({ zeroTotalCancellationFacts: factsSchema.nullable() }).parse(await request(factsQuery, { orderId }));
    return data.zeroTotalCancellationFacts;
  }
  return {
    getFacts,
    async cancel(input) {
      // activeChannel is Query-only: this preflight cannot atomically bind the
      // mutation. The provider must still enforce ctx.channelId inside its guard.
      await request(channelQuery, {});
      const data = z.object({ guardedCancelZeroTotalOrder: guardedResultSchema }).parse(await request(cancelMutation, { input }, false));
      if (data.guardedCancelZeroTotalOrder.operationId !== input.operationId) throw new Error('VENDURE_ZERO_TOTAL_CANCELLATION_OPERATION_MISMATCH');
      return data.guardedCancelZeroTotalOrder;
    },
    async getMarker(operationId) {
      const data = z.object({ zeroTotalCancellationMarker: markerSchema.nullable() }).parse(await request(markerQuery, { operationId }));
      const marker = data.zeroTotalCancellationMarker;
      if (!marker) return null;
      if (marker.operationId !== operationId) throw new Error('VENDURE_ZERO_TOTAL_CANCELLATION_OPERATION_MISMATCH');
      // The provider's zero-total marker lookup is global. Prove order scope
      // through its channel-filtered facts read before exposing the marker.
      const facts = await getFacts(marker.orderId);
      if (!facts || facts.orderId !== marker.orderId || facts.customerId !== marker.customerId
        || facts.orderReference !== marker.orderReference) {
        throw new Error('VENDURE_ZERO_TOTAL_CANCELLATION_MARKER_SCOPE_MISMATCH');
      }
      return marker;
    },
  };
}

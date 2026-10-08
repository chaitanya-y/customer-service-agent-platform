import { z } from 'zod';
import type { RequestInstrumentation } from '@cso/observability-node';
import { toRefundContext } from './refund-context.js';

import type {
  CommerceOrder,
  CommerceProvider,
  Money,
} from './commerce.js';

const orderFields = `
  id
  code
  state
  active
  currencyCode
  orderPlacedAt
  totalWithTax
  customer {
    id
    firstName
    lastName
    emailAddress
  }
  lines {
    id
    quantity
    orderPlacedQuantity
    unitPriceWithTax
    linePriceWithTax
    productVariant {
      id
      sku
      name
    }
  }
  payments {
    id
    state
    amount
    method
    transactionId
    refunds {
      id
      state
      total
      lines {
        orderLineId
      }
    }
  }
  fulfillments {
    id
    state
    method
    trackingCode
  }
`;

const orderByCodeQuery = `
  query Orders($options: OrderListOptions) {
    activeChannel { code }
    orders(options: $options) {
      totalItems
      items { ${orderFields} }
    }
  }
`;

const orderByIdQuery = `
  query Order($id: ID!) {
    activeChannel { code }
    order(id: $id) { ${orderFields} }
  }
`;
const refundOrderMutation = `
  mutation RefundOrder($input: RefundOrderInput!) {
    refundOrder(input: $input) {
      __typename
      ... on Refund { id }
    }
  }
`;

const vendureOrderSchema = z.object({
  id: z.string(),
  code: z.string(),
  state: z.string(),
  active: z.boolean(),
  currencyCode: z.string(),
  orderPlacedAt: z.string().nullable(),
  totalWithTax: z.number().int().nonnegative(),
  customer: z
    .object({
      id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      emailAddress: z.string(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      id: z.string(),
      quantity: z.number().int(),
      orderPlacedQuantity: z.number().int().nonnegative().optional(),
      unitPriceWithTax: z.number().int(),
      linePriceWithTax: z.number().int(),
      productVariant: z.object({
        id: z.string(),
        sku: z.string(),
        name: z.string(),
      }),
    }),
  ),
  // Only explicit arrays establish payment/refund history; null is unavailable, not empty.
  payments: z.array(
      z.object({
        id: z.string(),
        state: z.string(),
        amount: z.number().int().nonnegative(),
        method: z.string(),
        transactionId: z.string().nullable(),
        refunds: z.array(
          z.object({
            id: z.string(),
            state: z.string(),
            total: z.number().int().nonnegative(),
            lines: z.array(
              z.object({
                orderLineId: z.string(),
              }),
            ),
          }),
        ),
      }),
    ),
  fulfillments: z
    .array(
      z.object({
        id: z.string(),
        state: z.string(),
        method: z.string(),
        trackingCode: z.string().nullable(),
      }),
    )
    .nullable(),
});

const vendureResponseSchema = z.object({
  data: z
    .object({
      activeChannel: z.object({ code: z.string().min(1) }),
      orders: z.object({
        totalItems: z.number().int().nonnegative(),
        items: z.array(vendureOrderSchema),
      }),
    })
    .optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
      }),
    )
    .optional(),
});
const vendureOrderByIdResponseSchema = z.object({
  data: z.object({ activeChannel: z.object({ code: z.string().min(1) }), order: vendureOrderSchema.nullable() }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type VendureClientOptions = {
  adminApiUrl: string;
  apiKey: string;
  channelToken: string;
  expectedChannelCode: string;
  fetcher?: Fetcher;
  telemetry?: RequestInstrumentation;
};

type LookupFailure = 'http' | 'invalid_payload' | 'graphql' | 'no_data' | 'duplicate' | 'channel';
type LookupResult<T> =
  | { status: number; payload: T }
  | { status: number; telemetryError: 'application_error'; failure: LookupFailure };

async function vendureOrderLookup<T>(
  options: VendureClientOptions,
  fetcher: Fetcher,
  body: string,
  schema: z.ZodType<T>,
  validate: (payload: T) => LookupFailure | undefined,
): Promise<LookupResult<T>> {
  const headers = {
    'content-type': 'application/json',
    'vendure-api-key': options.apiKey,
    'vendure-token': options.channelToken,
  };
  const request = async (requestHeaders: Headers): Promise<LookupResult<T>> => {
    const response = await fetcher(options.adminApiUrl, {
      method: 'POST',
      redirect: 'error',
      headers: requestHeaders,
      body,
    });
    if (!response.ok) {
      return { status: response.status, telemetryError: 'application_error', failure: 'http' };
    }
    let rawPayload: unknown;
    try {
      rawPayload = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { status: response.status, telemetryError: 'application_error', failure: 'invalid_payload' };
    }
    const parsed = schema.safeParse(rawPayload);
    if (!parsed.success) {
      return { status: response.status, telemetryError: 'application_error', failure: 'invalid_payload' };
    }
    const failure = validate(parsed.data);
    return failure === undefined
      ? { status: response.status, payload: parsed.data }
      : { status: response.status, telemetryError: 'application_error', failure };
  };

  return options.telemetry?.withClientRequest(
    { operation: 'vendure.order_lookup', method: 'POST', propagate: false },
    headers,
    request,
  ) ?? request(new Headers(headers));
}

function money(amountMinor: number, currency: string): Money {
  return {
    amountMinor,
    currency,
  };
}

function normalizeProviderMethod(method: string): string {
  return method.trim() || 'unspecified';
}

function toCommerceOrder(
  order: z.infer<typeof vendureOrderSchema>,
): CommerceOrder {
  const currency = order.currencyCode;

  return {
    source: {
      provider: 'vendure',
      orderId: order.id,
    },
    reference: order.code,
    status: order.state,
    active: order.active,
    placedAt: order.orderPlacedAt,
    customer: order.customer
      ? {
          id: order.customer.id,
          name: `${order.customer.firstName} ${order.customer.lastName}`.trim(),
          email: order.customer.emailAddress,
        }
      : null,
    total: money(order.totalWithTax, currency),
    items: order.lines.map((line) => ({
      id: line.id,
      sku: line.productVariant.sku,
      name: line.productVariant.name,
      quantity: line.quantity,
      ...(line.orderPlacedQuantity !== undefined && line.orderPlacedQuantity > 0
        ? { orderedQuantity: line.orderPlacedQuantity } : {}),
      unitPrice: money(line.unitPriceWithTax, currency),
      lineTotal: money(line.linePriceWithTax, currency),
    })),
    payments: order.payments.map((payment) => ({
      id: payment.id,
      status: payment.state,
      amount: money(payment.amount, currency),
      method: normalizeProviderMethod(payment.method),
      transactionReference: payment.transactionId,
      refunds: payment.refunds.map((refund) => ({
        id: refund.id,
        status: refund.state,
        amount: money(refund.total, currency),
        lineIds: refund.lines.map((line) => line.orderLineId),
      })),
    })),
    fulfillments: (order.fulfillments ?? []).map((fulfillment) => ({
      id: fulfillment.id,
      status: fulfillment.state,
      method: normalizeProviderMethod(fulfillment.method),
      trackingCode: fulfillment.trackingCode,
    })),
  };
}

export function createVendureCommerceProvider(
  options: VendureClientOptions,
): CommerceProvider {
  if (typeof options.channelToken !== 'string' || !options.channelToken.trim()
    || typeof options.expectedChannelCode !== 'string' || !options.expectedChannelCode.trim()) {
    throw new Error('Vendure channel binding is required');
  }
  const fetcher = options.fetcher ?? fetch;

  const provider: CommerceProvider = {
    async getOrderByReference(reference) {
      const result = await vendureOrderLookup(options, fetcher, JSON.stringify({
          query: orderByCodeQuery,
          variables: {
            options: {
              filter: {
                code: {
                  eq: reference,
                },
              },
              take: 2,
            },
          },
        }), vendureResponseSchema, (payload) => {
          if (payload.errors?.length) return 'graphql';
          if (!payload.data) return 'no_data';
          if (payload.data.activeChannel.code !== options.expectedChannelCode) return 'channel';
          if (payload.data.orders.totalItems > 1) return 'duplicate';
          if (payload.data.orders.totalItems !== payload.data.orders.items.length
            || payload.data.orders.items.some((order) => order.code !== reference)) return 'invalid_payload';
          return undefined;
        });

      if ('failure' in result) {
        if (result.failure === 'http') throw new Error(`Vendure request failed with HTTP status ${result.status}`);
        if (result.failure === 'no_data') throw new Error('Vendure returned no GraphQL data');
        if (result.failure === 'duplicate') throw new Error('Vendure returned duplicate order references');
        if (result.failure === 'graphql') throw new Error('Vendure returned a GraphQL error');
        if (result.failure === 'channel') throw new Error('Vendure returned an unexpected channel');
        throw new Error('Vendure returned invalid GraphQL data');
      }

      const payload = result.payload;
      if (!payload.data) throw new Error('Vendure returned no GraphQL data');

      const order = payload.data.orders.items[0];
      return order ? toCommerceOrder(order) : null;
    },
    async getOrderById(orderId) {
      const result = await vendureOrderLookup(options, fetcher, JSON.stringify({
          query: orderByIdQuery,
          variables: { id: orderId },
        }), vendureOrderByIdResponseSchema, (payload) => {
          if (payload.errors?.length || !payload.data) return 'graphql';
          if (payload.data.activeChannel.code !== options.expectedChannelCode) return 'channel';
          if (payload.data.order && payload.data.order.id !== orderId) return 'invalid_payload';
          return undefined;
        });

      if ('failure' in result) {
        if (result.failure === 'http') throw new Error(`Vendure request failed with HTTP status ${result.status}`);
        if (result.failure === 'graphql') throw new Error('Vendure returned a GraphQL error');
        if (result.failure === 'channel') throw new Error('Vendure returned an unexpected channel');
        throw new Error('Vendure returned invalid GraphQL data');
      }

      const payload = result.payload;
      if (!payload.data) throw new Error('Vendure returned a GraphQL error');

      return payload.data.order ? toCommerceOrder(payload.data.order) : null;
    },
    async executeRefund(input) {
      if (typeof input.orderId !== 'string' || !input.orderId.trim()) return { status: 'FAILED' };
      // This fresh read binds the payment to the selected channel/order. It is not
      // an atomic provider-side guard against changes between read and mutation.
      const order = await provider.getOrderById(input.orderId);
      if (!order) return { status: 'FAILED' };
      const payment = order.payments.find((candidate) => candidate.id === input.paymentId);
      const current = toRefundContext(order, { scope: 'FULL_ORDER', itemIds: [] },
        { observationId: 'refund-provider-preflight', observedAt: new Date().toISOString() });
      if (!payment || payment.status.toUpperCase() !== 'SETTLED'
        || !current.facts.transactionRefundable
        || !Number.isSafeInteger(input.amount.amountMinor) || input.amount.amountMinor <= 0
        || input.amount.currency !== current.facts.refundableAmount.currency
        || input.amount.amountMinor > current.facts.refundableAmount.amountMinor) return { status: 'FAILED' };
      const response = await fetcher(options.adminApiUrl, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'vendure-api-key': options.apiKey, 'vendure-token': options.channelToken },
        body: JSON.stringify({ query: refundOrderMutation, variables: { input: { paymentId: input.paymentId, amount: input.amount.amountMinor, reason: input.reason } } }),
      });
      if (!response.ok) throw new Error(`Vendure refund failed with HTTP status ${response.status}`);
      const payload = z.object({ data: z.object({ refundOrder: z.object({ __typename: z.string(), id: z.string().optional() }) }).optional(), errors: z.array(z.object({ message: z.string() })).optional() }).parse(await response.json());
      if (payload.errors?.length || !payload.data) throw new Error('Vendure refund GraphQL outcome unknown');
      const result = payload.data.refundOrder;
      if (result.__typename !== 'Refund') return { status: 'FAILED' as const };
      return result.id === undefined
        ? { status: 'SUBMITTED' as const }
        : { status: 'SUBMITTED' as const, providerRefundId: result.id };
    },
  };
  return provider;
}

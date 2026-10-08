import { z } from 'zod';

const readOnlyAnswerSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
}).strict();

const refundAnswerSchema = readOnlyAnswerSchema.passthrough();

const recentOrdersResponseSchema = z.object({
  journey: z.literal('recent_orders'),
  status: z.enum(['answer_ready', 'source_unavailable']),
  customer_answer: readOnlyAnswerSchema,
}).strict();

const orderStatusResponseSchema = z.object({
  journey: z.literal('order_status'),
  status: z.enum(['answer_ready', 'awaiting_order_reference', 'source_unavailable']),
  customer_answer: readOnlyAnswerSchema,
}).strict();

const orderItemsResponseSchema = z.object({
  journey: z.literal('order_items'),
  status: z.enum(['answer_ready', 'awaiting_order_reference', 'source_unavailable']),
  customer_answer: readOnlyAnswerSchema,
}).strict();

const paymentStatusResponseSchema = z.object({
  journey: z.literal('payment_status'),
  status: z.enum(['answer_ready', 'awaiting_order_reference', 'source_unavailable']),
  customer_answer: readOnlyAnswerSchema,
}).strict();

const orderTotalResponseSchema = z.object({
  journey: z.literal('order_total'),
  status: z.enum(['answer_ready', 'awaiting_order_reference', 'source_unavailable']),
  customer_answer: readOnlyAnswerSchema,
}).strict();

const productPolicyResponseSchema = z.object({
  journey: z.literal('product_policy'),
  status: z.enum(['answer_ready', 'awaiting_product', 'source_unavailable']),
  customer_answer: readOnlyAnswerSchema,
}).strict();

const clarifyResponseSchema = z.object({
  journey: z.literal('clarify'),
  status: z.literal('clarification_required'),
  customer_answer: readOnlyAnswerSchema,
}).strict();

const cancellationReadyResponseSchema = z.object({
  journey: z.literal('cancellation'),
  status: z.literal('cancellation_request_ready'),
  order_reference: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/),
  customer_answer: readOnlyAnswerSchema,
}).strict();

const cancellationAwaitingResponseSchema = z.object({
  journey: z.literal('cancellation'),
  status: z.literal('awaiting_order_reference'),
  order_reference: z.null().optional(),
  customer_answer: readOnlyAnswerSchema,
}).strict();

export const readyRefundProposalSchema = z.object({
  proposalId: z.string().min(1),
  journeyType: z.literal('REFUND'),
  missingFields: z.array(z.string()).length(0),
  intent: z.object({
    orderId: z.string().min(1),
    reasonCode: z.string().min(1),
    scope: z.enum(['FULL_ORDER', 'SELECTED_ITEMS']),
    itemIds: z.array(z.string()),
    requestedAmount: z.object({
      amountMinor: z.number().int().positive(),
      currency: z.string().min(1),
    }).strict(),
  }).strict(),
}).passthrough();

const refundBaseShape = {
  journey: z.literal('refund'),
  customer_message: z.string().trim().min(1).max(2_000),
  order_reference: z.string().trim().min(1).max(100).nullable().optional(),
  customer_answer: refundAnswerSchema,
};

const readyRefundResponseSchema = z.object({
  ...refundBaseShape,
  status: z.literal('refund_proposal_ready'),
  refund_proposal: readyRefundProposalSchema,
}).passthrough();

const nonReadyRefundResponseSchema = z.object({
  ...refundBaseShape,
  status: z.enum(['awaiting_order_reference', 'order_context_loaded', 'awaiting_refund_details']),
  refund_proposal: z.unknown().optional(),
}).passthrough();

const supportResponseSchema = z.union([
  recentOrdersResponseSchema,
  orderStatusResponseSchema,
  orderItemsResponseSchema,
  paymentStatusResponseSchema,
  orderTotalResponseSchema,
  productPolicyResponseSchema,
  clarifyResponseSchema,
  cancellationReadyResponseSchema,
  cancellationAwaitingResponseSchema,
  readyRefundResponseSchema,
  nonReadyRefundResponseSchema,
]);

export type SupportResponse = z.infer<typeof supportResponseSchema>;
export type ReadyRefundProposal = z.infer<typeof readyRefundProposalSchema>;

export function parseSupportResponse(body: unknown): SupportResponse {
  return supportResponseSchema.parse(body);
}

export function getReadyRefundProposal(response: SupportResponse): ReadyRefundProposal | null {
  return response.journey === 'refund' && response.status === 'refund_proposal_ready'
    ? response.refund_proposal
    : null;
}

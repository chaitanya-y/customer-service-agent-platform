# Read-only payment and refund status support

Date: 2026-10-02. This is the next bounded customer-chat journey, not a
payment or refund mutation. It answers whether a verified customer's order has
a recorded payment and whether Vendure records a pending or settled refund.

## Boundaries

- Reuse the existing authenticated conversation, Agent Runtime support router,
  signed Gateway assertion, and owner-checked Vendure order read.
- Add a dedicated `lookup_payment_status` read-only MCP tool. Never derive a
  payment answer from order-status data, which omits payments. Do not add raw
  payment or refund details to the general `lookup_order` response.
- The tool returns only `schemaVersion`, `reference`, `paymentStatus`, and
  `refundStatus` under the canonical v1 contract. No payment IDs, method,
  transaction references, card details, refund IDs, customer PII, or amounts.
- Missing and foreign-customer orders have the same not-found response. No
  customer identifier or ownership claim may come from model text.
- The Agent Runtime validates the strict tool DTO and formats a short,
  deterministic answer. Edge accepts only the existing three-field read-only
  response shape for journey `payment_status`, persists the message, and never
  starts Temporal for this path.

## Status interpretation

Payment states are aggregated across payments in the order currency. Only
`Settled` counts as captured. `PAID` requires positive total and exact settled
coverage; a positive smaller amount is `PARTIALLY_PAID`. A sole authorized
payment is `AUTHORIZED`, not paid. All-declined attempts with no successful or
authorized payment are `DECLINED`; no attempts is `NOT_RECORDED`. Inconsistent
currency/amount, excess settlement, or unknown state is `UNCERTAIN` rather
than an optimistic answer.

Refund states are aggregated only for settled payments. Settled/completed
refunds count as recorded; pending/processing/submitted do not. A partial
recorded refund plus pending balance is distinct from either alone. Failed or
cancelled attempts are not success. Inconsistent currency/amount or unknown
provider state is `UNCERTAIN`. The response must never promise when money will
appear on a bank statement.

The specialist asks for one order reference if none can be resolved, uses a
generic response for missing/foreign orders, and clarifies mixed requests.
Questions about the status of an existing refund are informational; an explicit
request to initiate a refund stays on the governed refund journey.

## Verification

Contract and boundary tests cover exact safe fields, owner isolation,
settled/authorized/declined/partial/multiple attempts, pending versus recorded
refunds, provider inconsistency, classifier boundaries, strict DTO rejection,
and Edge's no-Temporal behavior. One bounded live local read of an existing
owned order may follow if the relevant services and login token are healthy.
No real or local payment/refund write is authorized by this journey.

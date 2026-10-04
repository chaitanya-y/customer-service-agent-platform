# Read-only order total

Status: implemented and backend-verified locally on 2026-10-02. This is a
customer-owned order **total** question, not a payment, invoice, refund, or
balance-due journey. The source is Vendure's current tax-inclusive
`totalWithTax`, mapped to `CommerceOrder.total`. A cancelled or modified order
may have a different current total from its original purchase; we do not
represent this number as an immutable historical receipt.

## Flow and trust boundary

1. A narrowly recognized question such as “What is the total for order
   ORDER-123?” routes deterministically to `order_total`. Mixed payment,
   invoice, refund, or action requests clarify instead; a model cannot
   introduce this journey on its own.
2. Agent Runtime calls `lookup_order_total` through the signed MCP integration
   context. Integration Gateway verifies the customer and retrieves the exact
   referenced order. It refuses a missing, different, or non-owned order.
3. The tool returns only strict v1 `schemaVersion`, `reference`, and
   `{amountMinor,currency}`. Agent Runtime checks the response and reference,
   formats the known currency's minor units deterministically, and says
   “tax-inclusive total.” Unsupported or malformed facts fail closed.
4. Edge accepts only bounded read-only answer text for this journey and
   persists it in the same customer conversation. It does not create a
   refund proposal, cancellation request, Temporal workflow, or commerce
   mutation.

The [v1 contract](../contracts/tools/order-total/v1/order-total.schema.json)
supports USD, EUR, GBP, INR, CAD, AUD, JPY, and KWD. This explicit list avoids
guessing decimal places for an unknown currency. A source owner must review
new currencies before expanding it.

## Verification

- Test-first cases covered routing, owner denial, missing/mismatched reference,
  malformed amounts/currencies, unsupported currency, timeout/unavailable
  source, mixed-intent clarification, and an LLM-invented route. Full suites:
  Agent Runtime 564 passed, Integration Gateway 348 passed, Edge API 169
  passed, canonical contracts 112 passed. Changed service typechecks and
  relevant Ruff checks passed.
- One authenticated local Edge chat for the existing owned test order
  `9KWUQ1TBZ7NUV8EU` returned: “The tax-inclusive total for order
  9KWUQ1TBZ7NUV8EU is USD 1563.80.” Its persisted conversation
  `01a0fcb5-4103-708d-924a-d1cabbd4b6c3` contained exactly the customer
  question and that answer, with no refund workflow link or cancellation
  request. The exact route required no model call. No order or payment was
  changed.
- The separate [synthetic v6 evaluation](evaluation/READ_ONLY_ORDER_TOTAL_V6.md)
  passed 20/20 repeated trials across ten formatting, fail-closed, and
  mixed-intent cases. It grades exact read-only traces offline; it is not a
  live owner-authentication, browser, or model-quality result.

This does not prove browser usability, performance under load, production
identity, an invoice/receipt document, amount actually paid, a customer's
remaining balance, or a refundable amount. The local customer token is a
development credential; public deployment remains blocked by the
[production identity roadmap](PRODUCTION_IDENTITY_ROADMAP.md).

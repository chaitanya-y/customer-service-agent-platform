# Owned-order items chat design

## Goal and scope

The authenticated customer can ask what items and quantities are in one of their
orders in the existing `/support` conversation. The answer is read-only and
cannot open a refund workflow. This is the next small vertical slice in the
broader journey portfolio, not order modification, cancellation, replacement,
payment support, or a new customer UI.

The user authorized autonomous in-project decisions while they are away. This
design deliberately uses only verified commerce facts and the existing customer
identity boundary. It does not treat a model's answer or order reference as
authorization.

## Approaches considered

1. **Separate customer-safe `lookup_order_items` tool (chosen).** Gateway checks
   order ownership and projects only reference, item names, and quantities. The
   Agent Runtime formats these facts deterministically. This repeats a little
   status-tool plumbing but keeps sensitive fields out of the read-only agent.
2. Extend `lookup_order_status` with items. This is smaller code, but changes an
   existing status contract and sends item facts to a specialist that does not
   need them.
3. Call the existing full `lookup_order` tool. This would expose internal item
   identifiers, payment details, and prices to a read-only answer path, so it
   is rejected.

## Wire and journey behavior

`lookup_order_items` accepts one customer-facing `orderReference` of 1–100
characters and returns a version-1 object with exactly these fields:

```json
{
  "schemaVersion": "1",
  "reference": "9KWUQ1TBZ7NUV8EU",
  "items": [{ "name": "Laptop 13 inch 8GB", "quantity": 1 }]
}
```

The projection admits 1–20 items, nonblank names no longer than 300 characters,
and integer quantities from 1 through 10,000. Invalid or excessively large provider data
fails closed as unavailable; it is not silently truncated. The Agent Runtime
also bounds the final answer to 2,000 characters. It does not include SKU,
internal IDs, prices, payments, address, inventory, or claims about shipment.

The response variant is `journey=order_items` with `answer_ready`,
`awaiting_order_reference`, or `source_unavailable`. An absent or ambiguous
reference asks for one reference. Missing and other-customer orders use the
same safe unavailable wording. A model may propose this route, but a current
turn that explicitly requests a refund or mixes refund action with item lookup
is governed by the existing refund/clarification safety checks. Previous
refund conversation alone does not change the current turn's route. Edge
accepts this strict read-only variant and never starts Temporal for it.

## Flow and failure handling

Customer Portal → Edge authenticated conversation → Agent Runtime structured
current-turn route → Gateway audience-bound assertion → owned Vendure order
lookup → minimal item projection → deterministic customer answer → Conversation
Runtime persistence. Gateway's existing owner check happens before projection.
Provider errors, invalid projection, malformed model output, or overlong
answer do not disclose partial commerce data or create a workflow.

## Verification

Tests must cover the canonical schema and unsafe extra fields; Gateway owner
masking and bounded projection; Agent Runtime reference resolution, no-item or
malformed data, deterministic wording, and current-turn route safety; Edge
strict response parsing and zero Temporal starts; plus cross-service contract
tests. The offline read-only evaluation dataset must also include an owned
order, a not-found/non-owner masking pair, and a forbidden private-field case.
A bounded local smoke may ask a test customer's owned order question
using the configured model. It must not create or settle a refund.

## Progress record

- 2026-10-02: Design selected after read-only journey and first-policy-response
  audits. Baseline contract suite: 103 passing tests using Node 24. The policy
  first-response `source_unavailable` remains unexplained; a possible RAG
  cold start is a hypothesis, not a proven cause. No timeout was changed.
- 2026-10-02: Edge's new read-only response tests failed first (unsupported
  journey produced a 502 in the chat path); the strict response variant and
  canonical support schema then passed the focused tests. The full Edge suite
  passed 101 tests and Edge/customer-portal type checks passed. Gateway and
  Agent Runtime integration is still in progress at this checkpoint.
- 2026-10-02: The new Gateway tool passes owner-check and minimal-projection
  review. Fresh coordinator runs passed 83 Gateway tests, 105 contract tests,
  and Gateway typecheck. Agent Runtime and offline evaluation integration
  remain under review; no live customer or model call has been made for this
  slice yet.
- 2026-10-02: Agent Runtime review caught and fixed two boundary issues before
  live testing: generic product questions must not be forced into order-items,
  and the returned order reference must match the requested reference. The
  offline private-field fixture now includes nested item SKU and unit price,
  rather than only top-level extras. Fresh suites passed: 354 Agent Runtime,
  281 evaluation, 101 Edge, 83 Gateway, and 105 contract tests. The changed
  Python files passed Ruff check and format, and Gateway, Edge, and customer
  portal TypeScript checks passed. Repository-wide formatter failures were in
  pre-existing unrelated files; no broad formatting rewrite was made.
- 2026-10-02: A single authorized read-only local API smoke returned the
  owned order's item and quantity, persisted both chat turns, and showed zero
  refund workflow links. It used the configured model but neither requested
  nor executed a refund. The first-policy-answer inconsistency remains a
  separate, unproven cold-start hypothesis; no timeout change was made.

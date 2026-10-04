# Read-Only Support Journeys Design

Date: 2026-09-30
Status: Owner-approved conversational design; implementation not started

## Intent and scope

Extend the authenticated Customer Portal conversation with two journeys: product
and policy questions, and order status and tracking. Both use the existing
customer identity, tenant context, message persistence and chat interface.
Neither journey passes through refund intake, constructs a refund proposal,
starts Temporal, opens a refund case, or invokes a commerce mutation. The
existing governed refund journey remains unchanged for explicit refund actions.

Success means a customer can ask a policy or product question and receive a
short, source-backed answer, or ask about an owned order and receive its
authoritative current state. Unavailable or ambiguous information produces a
plain clarification or safe unavailable answer, never an invented fact.

## Alternatives and decision

1. Add branches inside the existing refund graph. This has the smallest initial
   diff, but incorrectly couples read-only questions to refund proposal state
   and makes accidental workflow creation more likely.
2. Add a typed journey router before separate specialists. **Selected.** One
   authenticated chat entry point routes to refund, order status, product and
   policy, or clarification. Each specialist has only its permitted tools and
   response contract.
3. Give one general-purpose model all tools. This offers flexible mixed-intent
   answers but weakens the bounded-tool and testable-contract approach already
   used by the project.

## Customer flow and service boundaries

```text
Customer Portal /support
  -> Edge API authenticates customer and persists the turn
  -> Agent Runtime verifies its audience-specific assertion
  -> typed journey router reads bounded customer-message history
       -> order_status specialist -> read-only MCP lookup_order
       -> product_policy specialist -> CUSTOMER_SAFE RAG evidence and, for
          product facts, read-only Gateway catalog lookup
       -> refund specialist -> existing /refunds/intake behavior only for an
          explicit refund-action request
       -> clarify -> safe question, no specialist tools
  -> Edge persists the validated assistant text in Conversation Runtime
  -> only a refund result with a valid ready proposal can start Temporal
```

The Agent Runtime routing result identifies exactly one primary journey for a
turn: `refund`, `order_status`, `product_policy`, or `clarify`. Informational
questions about refund policy use `product_policy`; an explicit request to
initiate a refund uses `refund`. Unclear or conflicting intent uses `clarify`,
not `refund`. A customer may change journeys across turns in the same
conversation. The router must not treat prior refund discussion as authority
to start another workflow on a later informational turn. Dispatch to the
existing refund graph is in-process and occurs only after selecting `refund`.

Edge and Agent Runtime use a version 1 discriminated response contract with
`journey` and `status`. The new read-only statuses are `answer_ready`,
`awaiting_order_reference`, `awaiting_product`, and `source_unavailable`;
`clarify` uses `clarification_required`. Existing refund statuses remain as-is.
Edge accepts a refund proposal only from the `refund` variant. The read-only
variants carry a customer answer but no proposal field.
Conversation Runtime keeps its existing text message storage; the new variants
do not create a new durable workflow or conversation data type.

## Order status and tracking

The specialist requests an order reference when the bounded customer history
does not contain one unambiguous reference. It uses the existing `lookup_order`
MCP tool and its signed Gateway assertion. Integration Gateway already returns
the same `order_not_found` result for nonexistent and other-customer orders;
the specialist must not disclose which case occurred.

The answer may include the verified customer-facing order reference, current
order state, fulfillment state and tracking code when present. It must not
expose internal IDs, payment details or another customer's facts. Current
`OrderContext` has no authoritative carrier event stream, carrier URL or delivery
estimate. The specialist therefore makes no claim about those values; if asked,
it says they are not available. Status reflects the latest lookup, not a
guarantee about future delivery. No provider write or workflow is involved.

## Product and policy questions

For policy questions, Agent Runtime calls the existing Knowledge/RAG
`/v1/customer-evidence` API with only the signed knowledge assertion and query
text. The service, not the customer or model, selects the tenant, environment,
active release, locale, effective time and `CUSTOMER_SAFE` classification.
The answer uses only evidence that supports the requested claim. It includes a
readable source title and section in the persisted answer text, not an internal
source URI. Missing or irrelevant approved evidence yields a bounded
cannot-verify answer rather than a policy invented by the model.

For a specific product question, Agent Runtime uses a new read-only Integration
Gateway catalog lookup. The Gateway returns a small provider-neutral projection
of only published, enabled products in the authorized tenant/channel: public
name, description, variant names, price/currency and availability if each is
authoritative in Vendure. Search input is bounded and returns at most five
matches. A missing or ambiguous product yields a clarification. The specialist
must not invent product effects, stock, pricing, shipping promises or policy
terms. If a question needs both product facts and policy, it may use both
read-only sources; every claim remains attributable to the correct source.

The catalog lookup is an MCP tool with a canonical schema and cross-language
contract tests. The model does not call Vendure directly. The Gateway verifies
signed tenant/customer context and maps that tenant to the correct Vendure
channel. If no safe channel mapping exists, the lookup fails closed. The tool
never returns internal-only products or customer-specific order/payment data.

## Error handling and safety

- Invalid or missing audience-specific assertions return unauthorized before
  routing or retrieval. Customer-supplied tenant, environment and customer IDs
  never override verified claims.
- Gateway or RAG outage returns a safe retryable answer/error. No stale or
  invented state is substituted for an authoritative lookup.
- Model routing and answer output are schema-validated. Unsupported policy or
  product claims fail closed to a short fallback; source content is treated as
  data, not instructions.
- A new read-only journey never starts Temporal, enters Human Operations or
  reaches a refund-write route, including on mixed or ambiguous messages.
- No raw prompts, retrieved chunks, order references, tokens or personal data
  are added to telemetry. Existing trace/request correlation is retained.

## Verification and acceptance

Automated tests use synthetic facts and fake model/retrieval clients; they do not
call paid models or create refunds. Required coverage includes:

1. Routing policy questions and order-status requests to their own specialists,
   explicit refund actions to the existing specialist, and ambiguous/mixed
   actions to clarification.
2. Multi-turn references, missing references, malformed order facts, tracking
   present/absent, Gateway outage and nonexistent/other-customer order masking.
3. Tenant- and classification-filtered policy evidence, valid source titles,
   no-evidence abstention, ambiguous products and unpublished products.
4. Edge contract and persistence behavior: read-only answers are saved without
   refund workflow links; only a valid `refund` ready proposal starts Temporal.
5. Existing refund, customer-authentication and cross-language contract
   regressions, plus relevant lint/typecheck/build checks.

A local browser smoke may follow with an already authorized customer and safe
test order. Any live OpenAI call requires separate approval for the exact test.
No refund execution test is required to validate these read-only journeys.

## Non-goals

No carrier integration, live event feed, guaranteed delivery estimate, order
mutation, cancellation, return creation, refund-policy decision, new login-token
format, policy authoring, database migration or UI redesign. Knowledge for a
tenant must already be approved and published; this change does not invent
Mitti Cosmetics policies or automatically publish source documents.

# Delivery-issue report and acknowledgment design

## Decision and scope

The next non-refund journey is a deliberately limited delivery-issue report.
An authenticated customer explicitly submits one owned order reference and one
category (`MISSING`, `WRONG`, `DAMAGED`, or `DELAYED`) from the existing support
page. The system durably records a report, lets a separately authorized staff
member claim and acknowledge it, and shows the customer the authoritative
status. An acknowledgment means the report was seen, **not** that the issue was
resolved, a replacement was shipped, or a refund was approved.

The user authorized autonomous in-project implementation and testing. This
slice does not require an LLM and must not call the refund graph, create a
refund case, change a Vendure order, or alter Conversation Runtime's control
mode. Existing chat messages and this explicit form share the support page;
the form is not represented as a model-selected action.

## Alternatives considered

1. Reuse `REFUND_TAKEOVER` in Human Operations. Rejected: the database,
   decisions, review packet, and Operations UI are refund-specific. It could
   falsely imply an approved financial remedy. Extending the existing human
   role enum also risks access to refund cases because its current visibility
   rule admits any non-supervisor role to some refund case types.
2. Put a transient report in the chat transcript. Rejected: this offers no
   durable staff queue, claim, or auditable status.
3. Use a separate delivery report table, routes, and staff assertion within
   Human Operations. Selected: more plumbing, but the refund boundary stays
   intact and the customer's status has an authoritative source.

## Ownership and trust boundaries

- Edge authenticates the customer and verifies the conversation belongs to
  the same tenant, environment, and customer. Client-supplied tenant/customer
  IDs are never accepted.
- Integration Gateway verifies a short-lived, audience-bound customer context
  assertion from Edge and checks that the referenced Vendure order belongs to
  that customer. A narrow ownership result contains only the order reference.
  Missing and foreign orders produce the same response. No full order context
  crosses into the delivery-report path.
- Edge signs a separate, short-lived Human Operations service assertion with
  purpose `delivery_issue_report_create`, the verified customer, conversation,
  order reference, category, request ID, and a digest binding the request body.
  The existing conversation-assistant-message assertion cannot create cases.
- The new assertion uses `x-cso-delivery-report-assertion`, JWT type
  `cso-delivery-report+jwt`, audience `human-operations-delivery-report`, and
  at most a 60-second default lifetime. Its create claims include tenant ID,
  environment ID, subject customer ID, conversation ID, order reference,
  category, idempotency key, request ID, and SHA-256 of the canonical strict
  body `{order_reference,category}`. A separate
  `delivery_issue_report_read` assertion binds the same customer to one report
  ID and carries no create fields. Human Operations recomputes and compares
  the create body digest and all signed request fields.
- Human Operations verifies the new audience, purpose, tenant, environment,
  body digest, and expiry before a transactional insert. Its delivery staff
  routes use a separate delivery-role assertion; no delivery role is added to
  the refund-case verifier or refund-case visibility rules.
- Customer reads through Edge recheck subject and tenant. Staff reads and
  writes require the delivery staff role. Neither side can enumerate cases
  from another tenant or customer.

## API and durable state

Customer POST `/v1/conversations/:conversationId/delivery-issue-reports`
requires bearer authentication,
`Idempotency-Key`, and a strict body:

```json
{"order_reference":"ORDER1234","category":"DAMAGED"}
```

It returns a report ID, `RECEIVED` status, category, order reference, and
timestamps. Customer GET `/v1/delivery-issue-reports/:reportId` returns the
same minimal projection for the owner. No private notes, staff identity,
payment data, or order internals are returned.

Human Operations owns a separate `delivery_issue_reports` table and related
idempotency/audit records. The state machine is `RECEIVED -> CLAIMED ->
ACKNOWLEDGED`. Claim and acknowledge use optimistic expected-version checks;
only the assigned staff member can acknowledge. Repeating the same key and
identical input returns the same result; reusing a key with different input is
a conflict. Insert, idempotency record, and audit event commit together.

Staff routes are separate `/v1/delivery-issue-reports` list/detail/claim/
acknowledge operations. Operations Console gets a distinct delivery queue and
detail view, not extra options on a refund case. The customer page can poll the
minimal report status initially; a live-update channel is optional later.

## Customer wording and failure behavior

- `RECEIVED`: “We received your delivery issue report. A specialist will
  review it.”
- `CLAIMED`: “A specialist is reviewing your delivery issue report.”
- `ACKNOWLEDGED`: “A specialist has acknowledged your report. We have not
  confirmed a resolution yet.”

If ownership cannot be verified or Gateway is unavailable, no report is
created. If Human Operations may have committed but Edge lost the response,
Edge must not claim success; it tells the customer that receipt is unconfirmed
and allows a retry with the **same** idempotency key. Staff being offline after
commit does not erase the receipt. No inferred eligibility, delivery promise,
replacement, or refund amount appears in the response.

## Verification and release gates

Test owner/non-owner masking, auth audience/purpose/body binding, strict input,
duplicate idempotency and conflict, transaction rollback, tenant isolation and
row-level security, claim/version races, staff-role denial, customer-safe
projection, out-of-order or failed service calls, and zero refund workflow or
commerce writes. A local smoke uses a test order and makes no refund request.

This is a report-and-acknowledgment slice, not the full delivery remedy. Before
production exposure, confirm retention and deletion policy, rate limits and
abuse controls, staff operating procedure, and on-call handling for stuck
`RECEIVED` reports. Evidence upload, staff messaging, remedies, and closure
need separate designs and tests.

## Progress record

- 2026-10-02: Architecture selected after auditing the refund-specific Human
  Operations and Conversation Runtime boundaries. No delivery-report code or
  migration has been implemented at this checkpoint.
- 2026-10-02: Edge's narrow create/read assertion signer was implemented
  test-first: the focused test failed on the missing module, then 3 tests and
  Edge typecheck passed. Gateway ownership and Human Operations persistence
  are in parallel development; no customer route is live yet.

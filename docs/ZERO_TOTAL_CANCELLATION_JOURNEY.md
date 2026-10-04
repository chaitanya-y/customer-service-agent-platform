# Zero-total cancellation journey

Status: locally implemented and backend-verified on 2026-10-02. This is a deliberately narrow policy for a placed, unfulfilled, customer-owned order whose total is exactly zero and which has **no payment, refund, or fulfillment**. It does not cancel an authorization, refund money, or cover shipped/paid orders. Browser walkthrough and production identity are pending.

## Customer and service flow

The implemented provider policy is `NO_PAYMENT_ZERO_TOTAL_V1`: a regular,
inactive, placed Vendure order in `PaymentSettled`, with at least one original
positive-quantity line and no payment, refund, or fulfillment. Here
`PaymentSettled` is Vendure's placed-order state for the zero-total fixture;
it is not evidence that a payment was taken or settled.

1. In the shared support chat, an explicit cancellation request is recognized by a bounded, model-free Agent Runtime classifier. It can ask for the order reference or acknowledge the request. It does not decide eligibility, call a mutating tool, or start a workflow.
2. The customer clicks **Review cancellation**. The Customer Portal sends the authenticated order reference to Edge, which starts or reopens a deterministic customer-scoped `zeroTotalCancellationWorkflow` with Temporal duplicate rejection. This click does not cancel the order.
3. The worker obtains signed, owner-scoped facts from Gateway and Vendure. Gateway joins each provider line ID to exactly one item in the same owned order and supplies its bounded variant name; a missing, duplicate, or unsafe name makes new facts unavailable. Names with Unicode control/format characters, including invisible and bidirectional overrides, or with no letter/number are refused at Gateway, Worker, Edge, and Portal boundaries. If eligible, the worker presents an exact 15-minute preview with the order reference, item names and original line quantities, zero total, policy version, and a provider-facts digest. Edge strips internal order ID and digest from the customer response. Names are display-only, never an authorization key. Older recorded previews without names still show a labeled item ID.
4. The customer confirms or declines that exact preview. Temporal owns expiry and checks the current preview ID. A decline ends without a commerce write.
5. On confirmation, Temporal refreshes facts and digest. Only then does a purpose-scoped Worker assertion authorize the Gateway execute route. The Gateway records an idempotent PostgreSQL operation and calls a guarded Vendure plugin. Inside a local SQLite transaction, the plugin acquires an order-unique marker, rechecks owner/channel/state/payment/fulfillment/refund/original lines/digest, calls Vendure `cancelOrder`, verifies final `Cancelled`, then commits the marker.
6. If the provider response is uncertain, the worker does **not** retry the write. It reconciles the provider marker and final order state on a timer. The customer sees a pending status until `ORDER_CANCELLED` is authoritative. This is not a refund journey.

The Edge routes are `POST /v1/cancellations`, `GET /v1/cancellations/:workflowId`, and `POST /v1/cancellations/:workflowId/confirmation`. The Portal proxies them through authenticated same-origin `/api/cancellations` routes and displays `/cancellations/:workflowId`.

## Local verification

The first disposable fixture, order `EJ4P5T4W2BKUH56Y` (Vendure ID 9, customer 7), produced a valid preview. After customer confirmation the first execution became `PENDING_RECONCILIATION`. A real integration failure exposed GraphQL numeric `ID` values reaching the provider as numbers while the SQLite marker stores strings. A regression test was added and the plugin now canonicalizes IDs. One controlled retry of the same operation ID through the guarded plugin succeeded, the signed Gateway reconciliation returned `SUCCEEDED`, and Temporal's scheduled reconciliation advanced the customer view to `ORDER_CANCELLED`. This validates recovery, but is not a clean first-attempt result.

A second independently placed fixture, order `VRG4PLUWDE79UJJ8` (Vendure ID 10, customer 7), passed the normal Edge → Temporal → Gateway → guarded Vendure path after the fix. Its preview matched the zero total and one original line; customer confirmation returned only a receipt; the customer view then reached `ORDER_CANCELLED`. Vendure order and marker, plus Gateway ledger, independently reported `Cancelled`/`SUCCEEDED`. A fresh live shared-chat turn returned a typed `cancellation_request` action and no refund workflow after Agent Runtime was restarted. No OpenAI call is needed for this explicit intent.

At this checkpoint: Agent Runtime 443 tests, Edge 147 tests, Gateway 142 tests, Workflow Workers 91 tests, Customer Portal 69 tests, canonical contracts 109 tests, and simulator 9 focused cancellation tests pass. Typechecks/builds pass for the changed TypeScript apps; the Portal build passed. These numbers are local test counts, not production reliability claims. A replay regression showed that an uncertain Gateway execute request could repeat the provider call; an existing operation now takes a reconciliation-only path. Cancelled-order item history had separate tests and a live owner-scoped API check: Vendure's zero current quantity remained zero in trusted facts, while support displayed the original ordered quantity for the customer's historical question. **Superseded 2026-10-02:** OrderItems v1 cannot mark that quantity as historical and now fails closed for cancelled orders. OrderContext still retains the historical field; a versioned customer projection is needed before support can answer that question truthfully.

## Local setup and safe replay

Use the [normal local stack runbook](LOCAL_REFUND_RUNBOOK.md) to start Vendure (3001), Gateway (3002), Temporal (7233), Workflow Workers (task queue `refund-workflows`), Agent Runtime (8000), Edge (3000), Conversation Runtime (3004), and Customer Portal (3100), with their PostgreSQL/dependency services available. The queue name is shared infrastructure, not refund authority for this workflow. Apply Gateway migration `006_zero_total_cancellation_executions.sql` with the package `migrate` command before enabling the flow. Vendure's server startup calls `runMigrations(config)` before bootstrap; verify both plugin marker migrations have applied, rather than assuming a healthy server implies the correct schema. Use a **new**, explicitly authorized disposable, zero-total, placed order owned by the same test customer identity; orders 9 and 10 are already cancelled and cannot be reused as positive fixtures. Keep secrets in ignored local `.env` files and do not paste customer or Worker JWTs into documentation. Confirm the order has no payment, refund, or fulfillment before testing. On each run verify the customer-visible stage, Gateway ledger row, provider marker, and Vendure order state. Do not interpret a `202` confirmation response as cancellation success.

## Boundaries still open

The Gateway cancellation adapter now requires a nonblank Vendure channel
token and expected code. Facts and marker reads verify `activeChannel.code`;
the mutation uses the token and a fresh channel-checked preflight. A non-null
zero-total marker is also tied back to channel-scoped order/customer/reference
facts before the Gateway accepts it. The combined Gateway suite passed
250/250 tests, typecheck, and build after this hardening. A read-only live
Admin query confirmed the locally configured channel token resolves to its
expected channel; no new cancellation was executed. Vendure's guarded plugin
checks order membership in its request channel transactionally. Its marker
lookup now joins the marker to a channel-visible order and persisted
owner/reference in one local SQLite read, rather than returning a global
operation marker. The simulator's typed suite passed 27 tests with one
explicit known SQLite concurrency skip, plus typecheck and build. The
client's expected-code preflight is not atomic with the mutation, and the
cached SQLite query-runner concurrency hazard remains. Keep this as a local,
single-channel safety checkpoint, not production multi-tenant proof.

- Manual browser UI walkthrough and accessibility QA are not proven by API/build tests.
- This local dummy-commerce proof is not a real PSP authorization release, paid-order cancellation, or production payment claim.
- The deterministic workflow ID supports same-order replay during Temporal retention; a future production identity/retention policy needs explicit design.
- New previews show owner-checked item names; legacy Temporal previews still fall back to labeled line IDs. Browser accessibility and recognition with real customers remain unverified.
- Current-worker tests cover nameless legacy-shaped facts and previews, but no captured pre-change Temporal history fixture has been replayed after this display change. Verify such a history before a rolling production rollout with old open workflows.
- Fulfillment and payment races have focused guard tests, but production load/failure recovery and a real external commerce provider remain unverified.

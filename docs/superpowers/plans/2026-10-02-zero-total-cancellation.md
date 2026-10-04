# Zero-total order cancellation design and implementation record

Implementation status on 2026-10-02: the isolated Vendure fixtures, guarded provider plugin, Gateway ledger and assertion routes, separate Temporal worker, Edge start/read/confirm routes, Agent Runtime intent classifier, and Portal review UI are implemented. The classifier does not call the refund graph or a model. Two disposable local orders were cancelled: the first proved recovery from an uncertain first provider response after a numeric GraphQL ID fix; the second passed the normal path end to end. See [the journey record](../../ZERO_TOTAL_CANCELLATION_JOURNEY.md). Browser QA and paid-order/authorization variants remain open.

Verification record: fixture orders `EJ4P5T4W2BKUH56Y` (ID 9) and `VRG4PLUWDE79UJJ8` (ID 10) were each checked as placed, inactive, zero total, and without payments, refunds or fulfillments before confirmation. Gateway migration 006 was applied to local PostgreSQL. Gateway 140 tests, simulator 9 focused tests, Workflow Workers 91 tests, Agent Runtime 437 tests, Edge 147 tests, and Customer Portal 69 tests passed at this checkpoint. Both provider markers and order states are now `SUCCEEDED`/`Cancelled`; Gateway ledger rows are `SUCCEEDED`; the customer-safe Edge stages reached `ORDER_CANCELLED`.

Scope: the smallest independent cancellation journey for a disposable, customer-owned local Vendure order that is truly placed but has a zero total and no payment. This is not a refund and does not prove release of a bank authorization. The current refund workflow and MCP tools remain unchanged.

## Why this is a separate workflow

Vendure exposes `cancelOrder` and `cancelPayment` separately. Its default order process permits cancellation even after shipped/delivered, so a Gateway read-before-write check cannot enforce a strict unfulfilled-only policy. A cancellation may reduce remaining line quantities to zero, which current order-context readers do not accept. These are provider facts, not model decisions.

## Phase 0: prove the fixture safely

Create an isolated zero-price/free-shipping local Vendure order for a dedicated test customer, then verify it is placed (`active=false`, `orderPlacedAt` set), has exactly zero total, no payments, no fulfillments, no refunds, and positive original item quantities. Merely cancelling a Draft does not test the customer cancellation journey. If this fixture cannot be constructed with installed Vendure state transitions, stop and redesign; do not weaken the invariant to make a test pass.

## Phase 1: policy, preview, and provider guard

- Define `NO_PAYMENT_ZERO_TOTAL` policy v1 and a versioned contract. The model can identify intent, but a deterministic service fetches owner-scoped facts. Only a placed, unfulfilled, zero-total order with no payments/refunds can produce a full-order preview. No partial lines or store credit.
- Preview binds exact order reference and internal order ID, original lines, total, policy version, provider facts digest, preview ID, and expiry. Customer consent must name the exact current preview. Temporal owns deadline, invalidation, and durable state, not the browser clock.
- Add a Vendure plugin guarded mutation. In one local SQLite transaction, acquire an operation marker/write lock, re-read owner/channel, placement, line, fulfillment, payment/refund, and state facts, require the expected digest, call Vendure `OrderService.cancelOrder`, turn any error result into a thrown rollback, and re-read the final `Cancelled` state before committing the marker.
- Gateway maintains a tenant/environment/order-scoped idempotency and reconciliation ledger. The provider marker is authoritative after an uncertain HTTP response. Never call built-in `cancelOrder` directly from an unguarded Gateway read-before-write path.
- Update read-only order projections to distinguish historical purchased quantity from zero remaining quantity after cancellation. Do not silently report zero as the ordered amount or make current contract validators accept incoherent data.

## Phase 2: dedicated workflow and customer UI

- Add a separate Temporal cancellation workflow, narrow fact-refresh/execute/reconcile assertions, Edge routes, and Customer Portal preview/confirmation page. Do not use refund `CANCELLED` stages, tools, or approval permissions.
- The shared support chat may recognize an explicit present-turn cancellation request, but its typed answer is only an intent acknowledgment. It must not start the cancellation or reuse `refund_workflow_id`. A separate customer click on a `Review cancellation` action starts or reopens the dedicated workflow. Edge binds its workflow ID to tenant, environment, customer, and normalized order reference, verifies ownership on every read/signal, and starts with Temporal duplicate rejection. This keeps model classification separate from customer consent and avoids another unprotected post-message start window. A durable cross-journey conversation link is a later schema change; the customer cancellation page remains directly addressable by its workflow ID.
- UI may say `Cancellation requested` while provider outcome is uncertain; `Order cancelled` only after re-query of the provider marker and actual order state. No refund or payment-release claim.
- No live test on a non-disposable customer order. Validate stale consent, replay, simultaneous attempts, fulfillment race, transaction rollback, crash after provider commit, and reconciliation.

## Later authorized-payment variant

Only after the zero-total path is proven, add an explicitly local-dummy `AUTHORIZED_DUMMY` policy. It requires exactly one `Authorized` payment, no settlement/fulfillment/refund, full coverage, and a preview naming both order cancellation and simulated authorization cancellation. The provider transaction performs both local steps and verifies final order/payment states. Never imply real bank hold release from the dummy handler. A real PSP requires a compensating saga and provider-level proof, not the local SQLite atomicity claim.

Implementation owners should keep new contracts/policy, Vendure plugin, Gateway ledger, Temporal/Edge, and Portal changes separate until their shared schemas are reviewed. This design creates no cancellation capability by itself.

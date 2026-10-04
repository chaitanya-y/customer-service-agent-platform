# Delivery-issue report and acknowledgment implementation plan

> Follow the agreed autonomous, bounded scope in the companion design. Use
> test-first changes and distinct file ownership. The coordinator integrates.

**Goal:** A customer can explicitly report a delivery issue against an owned
order and see durable receipt/acknowledgment, with no refund or order mutation.

**Design:** `docs/superpowers/specs/2026-10-02-delivery-issue-report-design.md`

## Guardrails

- Preserve all existing dirty files and local data. Do not commit, push, merge,
  deploy, create a refund, or call a payment provider as part of this plan.
- Never reuse refund cases, refund role visibility, or refund workflow signals.
- Strict customer and staff assertions, tenant/environment binding, ownership
  lookup, idempotency, and safe error wording are release blockers.
- Local and offline tests may use synthetic orders. A live smoke may only
  create a delivery report for an explicitly identified local test order.
- If any cross-service boundary cannot be made safe, stop that slice and
  document the gap rather than claiming the journey complete.

## Task 1: Gateway owner-check projection

**Owner:** Gateway worker. Files limited to Gateway source/tests and a narrow
contract under `contracts/tools/delivery-order-ownership/`.

- [x] Write failing tests for owned order, missing/foreign masking, invalid
  reference, missing/wrong-audience assertion, and provider failure.
- [x] Add a dedicated route or tool that returns only version and reference
  after `getOrderContext` owner verification; never serialize the full order.
- [x] Run Gateway, contract, and Gateway type checks.

## Task 2: Human Operations durable report store

**Owner:** Persistence worker. Files limited to new migration 005, new delivery
report model/repository, and repository tests. No edits to refund tables or
existing refund repository.

- [x] Write failing tests for transactional create/idempotent replay/conflict,
  owner read, tenant masking, claim/version race, acknowledgment, audit, and
  rollback.
- [x] Add separate report, audit, and idempotency tables with forced RLS and
  explicit grants. Implement a Postgres repository plus a small fake for
  route tests if needed.
- [x] Run migration and repository tests against local Postgres only if safe,
  then Human Operations typecheck.

## Task 3: Human Operations auth and routes

**Owner:** A separate Human Operations worker after Task 2 interfaces freeze.
New files for delivery assertions and route module; minimal server/app
registration only. No edits to refund-role authorizer semantics.

- [x] Write failing tests for service assertion body binding/audience/purpose,
  delivery-staff assertion, create/read/list/claim/ack rules, and safe errors.
- [x] Add separately scoped verification and routes; require expected version
  and idempotency keys on writes.
- [x] Run Human Operations tests and typecheck; verify refund suite unchanged.

## Task 4: Edge API and Customer Portal

**Owner:** Coordinator for Edge; portal worker for UI after contract freeze.

- [x] Add strict Edge create/read routes. Verify customer and conversation,
  owner-check through Gateway, sign body-bound report-create assertion, and
  call Human Operations with the same idempotency key. Test error ordering,
  unconfirmed receipts, and zero refund workflow starts.
- [x] Add the Customer Portal form and report status card on the existing
  support page; keep chat separate. No free text or photo upload in v1.
- [x] Test owner/tenant denial, duplicate request retries, customer-safe
  projection, responsive UI, and Edge/portal type checks.

## Task 5: Operations Console and integration

**Owner:** Operations UI worker after staff route contract freeze; coordinator
for integration and docs.

- [x] Add a separate delivery queue/detail and claim/ack controls, using a
  distinct delivery staff session. Never surface refund actions in this UI.
- [x] Verify complete cross-service contract, migrations, local auth, no
  refund-path regression, tenant isolation, and one bounded local report flow.
- [x] Update journey/runbook and verification docs with what did and did not
  pass. Check account usage; stop when 85% used or higher.

## Checkpoint

- 2026-10-02: Plan created after owned-order-items passed its fresh suites and
  one live read-only API smoke. No delivery-report code or migration exists yet.
- 2026-10-02: Separate Gateway, Edge, Human Operations, Customer Portal, and
  Operations Console slices implemented. Migration 005 applied; non-superuser
  PostgreSQL integration tests passed. One bounded local API flow created an
  owned delivery report, claimed and acknowledged it, and verified six-field
  customer readback. Both Next.js apps built. Manual browser testing and the
  production gates in the design remain open; this checkpoint is not a public
  deployment claim.

# Delivery issue review closure

Status: owner-authorized local design, 2026-10-02. This is an administrative
review outcome, not proof that a delivery problem was fixed or a remedy given.

## Decision

`ACKNOWLEDGED` only proves assigned staff received the report. A separate
terminal `REVIEW_CLOSED` state records that the assigned specialist ended the
review. The only allowed transition is `ACKNOWLEDGED -> REVIEW_CLOSED`, using
the same tenant/environment, staff assertion, exact report version, and
idempotency key guards as claim and acknowledgment. The action records
`closed_at` and `REPORT_REVIEW_CLOSED` in the durable audit trail in the same
transaction. The customer cannot invoke it.

The customer sees this fixed message: “A specialist completed the review of
your report. This does not confirm the delivery issue was fixed or that a
remedy was provided. If you still need help, contact support.” “Contact
support” links to the existing support chat. No claim about compensation,
delivery success, a return label, or automatic follow-up is allowed.

## Contract and migration

- Staff route: `POST /v1/delivery-issue-reports/:reportId/close`, strict body
  `{ "expected_version": positive integer }`, existing staff assertion and
  `Idempotency-Key`. No customer close route.
- Staff report adds optional `closed_at` only when closed. Existing customer
  projection stays exactly six fields: report ID, order reference, category,
  status, created at, updated at. The new status is the only new customer
  value; no staff ID, audit, notes, or PII is exposed.
- Additive Human Operations migration after `005_delivery_issue_reports.sql`
  adds `closed_at` and extends report status/invariant, audit event type, and
  idempotency action checks. Preserve RLS and grants. No old report changes
  status during migration.
- Both PostgreSQL and in-memory repositories enforce assigned staff, current
  `ACKNOWLEDGED` state, expected version, exact-scope idempotent replay,
  audit atomicity, and a one-way terminal state. Wrong staff, stale version,
  missing/foreign report, duplicate other-key close, and pre-ack close fail.
- Edge validates the new status on read/list/replay but does not gain mutation
  power. Portal history renders fixed copy and a support link. Operations
  Console offers Close review only to the claimed assigned specialist after
  acknowledgment and reconciles uncertain command responses through a fresh
  authoritative read.

## Verification and rollout boundary

Use red-green tests for repo transitions, route authentication and strict
body, customer projection, status parsers, console retry/session behavior,
then full changed-app suites, typechecks, builds, contract tests, and an
isolated PostgreSQL migration check if feasible. No live delivery status is
changed merely to test this. Running local services need a coordinated
restart/migration before the UI can use the new action. Browser QA remains a
separate manual check.

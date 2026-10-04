# Delivery review closure implementation plan

**Spec:** `docs/superpowers/specs/2026-10-02-delivery-review-closure.md`

**Global constraints:** Preserve all existing dirty work. Do not commit,
push, merge, run a live customer report transition, or modify the excluded
storefront. This closes a review only; it does not resolve delivery or create
a commerce action. Never put staff identity/audit/notes into customer reads.

## Task 1: Human Operations source of truth

- [x] Add failing repository and route tests for `ACKNOWLEDGED -> REVIEW_CLOSED`, assigned staff, expected version, exact-key replay, audit, wrong scope, pre-ack close, and strict staff-only body.
- [x] Extend types, both repositories, staff route, and additive PostgreSQL migration with `closed_at`, audit event, and idempotency action. Preserve six-field customer projection and RLS. Staff detail has a verified-session-derived advisory `can_close_review` boolean, never included in customer responses.
- [x] Pass focused and full Human Operations suites and typecheck/build. Full 74/74 passed against an isolated PostgreSQL 17 cluster; migration 001–006 preserved existing ACKNOWLEDGED rows, RLS, and grants. No live project DB was changed.

## Task 2: Edge and Customer Portal read projection

- [x] Add failing parser/projection tests for the new terminal status and no private fields.
- [x] Accept `REVIEW_CLOSED` in strict Edge/Portal customer reads/list/replay, render fixed honest copy and support link, and preserve existing authentication and pagination.
- [x] Pass focused and full Edge/Portal suites, typechecks, and Portal build (Edge 168/168; Portal 153/153).

## Task 3: Operations Console staff close action

- [x] Add failing tests for the staff-only close proxy/detail, command retry, stale/auth-loss state, and legacy claim/ack retry resolution after a later close.
- [x] Show Close review only for assigned staff in `ACKNOWLEDGED`, send exact expected version and idempotency key, reconcile uncertain responses with a fresh read, and show audit/closed time.
- [x] Pass focused and full Console suites, typecheck, and build (74/74).

## Task 4: Integrated verification and record

- [x] Run canonical contract tests (111/111) and `git diff --check`; independent scoped reviews found no Critical, Important, or Minor issues in trust, terminal-state, retry, or customer-copy boundaries.
- [x] Update journey/verification docs with results and explicit manual-browser/live-transition limitations.
- [x] Leave work uncommitted in the existing dirty tree and report that Git safety decision.

Ruling: close is an administrative review closure with a fixed support follow-up
path and no promised remedy. If this policy is too weak for later operations,
the cost is another workflow/status design, not an incorrect claim that a
delivery problem was fixed.

# Delivery report receipt recovery after conversation closure

Status: locally implemented and backend verified, 2026-10-02; manual browser QA remains pending. Scope is **replay-only receipt lookup** for an uncertain delivery report; no new delivery report, refund, cancellation, model call, or commerce write may occur in the recovery path.

## Contract and authorization

- Public: `POST /v1/conversations/:conversationId/delivery-issue-reports/replay` with the original strict `{order_reference,category}` body and `Idempotency-Key`. The customer identity comes only from the verified Bearer token. A closed but owner-accessible conversation is allowed; missing/other-owner conversations are masked. No query-supplied customer identity.
- Internal: `POST /internal/v1/delivery-issue-reports/replay` with the same body, same scoped key, and a new 60-second `delivery_issue_report_replay` assertion. The assertion binds tenant, environment, customer, conversation, original body, original key, and its digest. It is not accepted for create or read.
- Repository: read the existing `create` idempotency row under tenant/environment/customer/conversation scope, compare the original fingerprint, then load the *current* report for that customer. Never insert/reserve/mutate/audit on replay. Unknown or other-owner key is 404; changed body/key fingerprint is a generic 409. All responses are no-store and use the existing six-field customer projection.
- Web: retain an uncertain attempt in session storage. On retry, attempt replay first with the original key/body/conversation before any possible create. A found receipt clears the pending attempt and shows current status. A known missing receipt may use the existing same-key create only while the conversation is still open; a closed conversation never creates another report. Transient lookup failure remains uncertain. Authentication loss clears sensitive UI state.

## Tests and verification

1. Red tests for exact replay, missing key, changed body, wrong customer/tenant, closed conversation, and zero new writes. PostgreSQL integration test with the non-superuser role and RLS where available.
2. Edge/Portal tests for assertion purpose/body/key binding, closed-conversation owner lookup, no Gateway order read in replay, no-store, strict response, upstream redirect refusal, and lost-response recovery.
3. Run focused and full affected package tests, typechecks, builds, then a bounded local API recovery exercise with a disposable report if the local stack is healthy. Manual browser QA remains separate.

File ownership: Human Operations agent owns only `apps/services/human-operations/**`; Edge/Portal agent owns only `apps/services/edge-api/**` and `apps/web/customer-portal/**`; coordinator owns this plan, final documentation, integration checks, and local service/test coordination. Agents must not edit each other's paths, commit, push, or touch unrelated services.

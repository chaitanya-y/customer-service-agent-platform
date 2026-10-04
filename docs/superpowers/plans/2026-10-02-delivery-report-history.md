# Customer delivery report history

Status: implemented and locally API-tested, 2026-10-02; manual browser QA remains. This is a read-only extension of the delivery issue journey so a customer can rediscover receipts on a different browser/device. It never creates, reopens, acknowledges, resolves, refunds, or changes an order.

## Frozen contract

- Public `GET /v1/delivery-issue-reports` and Portal `GET /api/delivery-issue-reports` accept no query or body. Identity is the verified customer session/Bearer token, never a caller-supplied customer ID. Response is exactly `{delivery_issue_reports: [six-field customer receipt], has_more: boolean}` with at most ten rows, newest `updated_at` first. Eleven owner-scoped rows are read internally to determine `has_more`; no historical pagination in v1.
- Edge signs a new short-lived `delivery_issue_report_list` assertion bound to tenant, environment and customer. Human Operations uses `GET /internal/v1/delivery-issue-reports` for a strictly read-only PostgreSQL query with tenant/environment/customer predicates and RLS. Staff endpoints and credentials remain separate.
- Each receipt contains only `report_id`, `status`, `category`, `order_reference`, `created_at`, `updated_at`. No staff ID, audit, address, item, payment, transcript or internal order ID. Fail closed on malformed service response, duplicate IDs, bad ordering, excess rows, unknown status, or conflicting `has_more`. All successful and failed responses are `private, no-store`; credential-forwarding calls refuse redirects.
- The customer form offers an explicit **View my delivery reports** action with loading, empty, error/retry and a bounded list. Selecting a receipt shows its existing status card and authoritative refresh. Do not persist a list or assume `sessionStorage` proves ownership. Authentication loss clears visible reports and pending reads.

## Test gates

1. Human Operations: in-memory and PostgreSQL owner/tenant/environment isolation, bound of ten plus `has_more`, order, no-write query, forced RLS, and wrong-purpose assertion rejection.
2. Edge/Portal: no-auth 401, strict contract/no private fields, no client filters, no-store, no redirects, transient failure, UI empty/loading/retry/select and account-loss clearing. No model/Temporal/Gateway/provider write.
3. Full affected package tests/typechecks/builds; bounded live two-customer API read if local stack is healthy. Manual visual browser QA remains a separate gate.

Ownership: Human Operations agent owns only `apps/services/human-operations/**`; Edge/Portal agent owns only `apps/services/edge-api/**` and `apps/web/customer-portal/**`. Coordinator owns this plan, integration verification, and final docs. No agent commits, pushes or changes unrelated paths.

## Completion evidence

- Human Operations full suite: 62 passing non-database tests, 8 optional database skips. Its focused PostgreSQL repository file passed 6/6 using the restricted application role. Edge passed 163/163; Portal passed 107/107. Affected typechecks and builds passed.
- Authenticated local Edge and Portal history reads returned two safe reports for one customer, including a closed-conversation recovered receipt. Another signed customer saw no reports. The list made no provider, model, Gateway, or workflow call.
- Independent review identified a Portal race between an outstanding report submission and a separate history 401. The coordinator reproduced it with a synthetic UI harness, then added epoch invalidation at each asynchronous boundary. Pagehide clears visible data without losing an uncertain retry key. The replay BFF now projects six safe fields and redacts upstream errors. New tests cover these boundaries.
- The automated browser could not access the local site under its active security policy; a human visual walkthrough, including back/forward restoration and retry across devices, remains a release gate.

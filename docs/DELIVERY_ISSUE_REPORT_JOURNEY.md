# Delivery issue report and review closure

Updated 2026-10-02. This is a separate, local-tested customer service journey.
It records, acknowledges, and can administratively close a review. It does
**not** verify that the delivery issue is fixed, provide a remedy, create a
replacement, cancel an order, or initiate a refund.

## Customer and staff flow

1. An authenticated customer opens `/support`, enters an order reference, and
   chooses `MISSING`, `WRONG`, `DAMAGED`, or `DELAYED` in the separate delivery
   form. The form creates a dedicated conversation without changing the chat.
2. Edge checks that the conversation belongs to this customer and is open.
   Gateway verifies the same customer's ownership of the order and returns only
   schema version and reference. A missing and another customer's order are
   indistinguishable to the caller.
3. Edge sends a short-lived, body-bound delivery assertion to Human Operations.
   Human Operations commits the report, its idempotency result, and a received
   audit event in one PostgreSQL transaction. The customer sees `RECEIVED` only
   after an authoritative response. An uncertain response retains the same
   request key for retry instead of claiming success.
4. The customer may explicitly choose **View my delivery reports** on
   `/support`. This is a separate, read-only account lookup, not a model call
   or a new report. It returns at most ten of this customer's reports, newest
   update first, and indicates when more exist. Choosing one refreshes its
   authoritative current status. The list is useful after changing browser or
   device; a browser's remembered report ID is not the source of truth.
5. A separately authorized delivery staff member opens the delivery queue,
   claims the report with an expected version, and acknowledges it. The
   customer's status progresses `RECEIVED → CLAIMED → ACKNOWLEDGED`.
6. Only the assigned staff member may close an acknowledged review with the
   current version and a stable idempotency key. The terminal status is
   `REVIEW_CLOSED`; the audit and closure time are committed with it. The
   customer sees a fixed message explaining that review closure is not proof
   that the issue was fixed or a remedy given, with a link back to support.

The customer response contains only `report_id`, `status`, `category`,
`order_reference`, `created_at`, and `updated_at`. It contains no staff ID,
audit notes, internal case details, or payment information. Neither
acknowledgment nor review closure is a resolution. The existing refund case
queue and refund permissions are not
used; this flow never calls Temporal refund workflow or a commerce mutation.

## Service and token boundaries

| Boundary | Authentication | Purpose |
| --- | --- | --- |
| Customer Portal → Edge | Existing local customer session/Bearer token | Customer identity |
| Edge → Conversation Runtime | Existing conversation-audience assertion | Own open conversation |
| Edge → Gateway | Existing Gateway-audience assertion | Order ownership proof |
| Edge → Human Operations | `x-cso-delivery-report-assertion`, audience `human-operations-delivery-report`, 60 seconds | Body-bound create, replay, one-report read, or bounded customer history; each has a distinct signed purpose |
| Operations Console → Human Operations | `x-cso-delivery-staff-assertion`, audience `human-operations-delivery-staff` | Delivery queue, claim, acknowledgment, and assigned-staff review closure |

The delivery staff JWT is separate from the refund staff JWT even in local
development: different JWT type, audience, role set, header, and web session.
It uses the Human Operations signing secret; this is **not** a second copy of a
customer token. See [Local authentication and secrets](LOCAL_AUTH_AND_SECRETS.md).

Staff claim/acknowledgment/closure retries keep their key and expected version in this
tab across an ordinary reload or page exit. A successful delivery sign-in clears
all delivery retry keys before navigating; a delivery queue/detail 401 or 403
also clears them. Other journeys' storage is untouched. A failed sign-in keeps
the uncertain attempt, and blocked storage cleanup prevents successful sign-in
navigation rather than knowingly carrying an old key into a new session.
These are session reset boundaries, not a browser-visible staff identity check:
the local token remains server-only. When replacing its configured staff
identity, restart the console and explicitly sign in again; silently swapping
server credentials without a new sign-in or authorization failure is not
detected by this tab-scoped retry state. Backend staff-bound fingerprints and
assignment checks remain authoritative.

## Start and test locally

Use the existing [local refund runbook](LOCAL_REFUND_RUNBOOK.md) for PostgreSQL,
Vendure, Conversation Runtime, Edge, Gateway, Human Operations, and the web apps.
Apply Human Operations migrations `005_delivery_issue_reports.sql` and
`006_delivery_review_closure.sql` with the
service's migration command before starting its new routes. Human Operations
must have `CONTEXT_ASSERTION_HMAC_SECRET` matching Edge even when photo storage
is disabled. `REFUND_EVIDENCE_STORAGE_DIR` remains optional. Use only ignored
local environment files for secrets and tokens.

Generate a **delivery** staff token from Human Operations with
`pnpm --silent local:delivery-token`, set `CSO_LOCAL_DELIVERY_STAFF_TOKEN` in the
Operations Console's effective private environment, and restart that console.
Its default local lifetime is 30 days; production staff authentication is a
separate deployment decision. Open the customer form at
`http://127.0.0.1:3100/support` and the staff queue at
`http://127.0.0.1:3101/delivery-issue-reports`.

For a test, use only an order owned by the current local customer. Submit one
issue and check that the customer sees `RECEIVED`; claim and acknowledge it in
the staff queue, then refresh the customer status to see `ACKNOWLEDGED`. The
assigned staff member can then choose **Close review**; verify the customer
sees `REVIEW_CLOSED`, the honest follow-up message, and a support link. Do not
expect a refund link, payment event, replacement order, or resolved-delivery
message. Use only a disposable test report for this manual check.

For a backend-only repeat on a different disposable, currently owned local
order, use Node 24 from the repository root with the ignored local web env
files already configured:

```bash
node --env-file=apps/web/customer-portal/.env.local \
  --env-file=apps/web/operations-console/.env \
  tools/local/verify-delivery-review-closure.mjs \
  --run --order-reference=OWNED_TEST_ORDER
```

The script checks that the order appears in the signed-in customer's recent
references before creating one new conversation/report. It will not run
without `--run` and an explicit reference. Do **not** rerun it automatically
after a network timeout: inspect the created report first, or another
disposable report may be created.

## Verified on 2026-10-02

- Review closure was added as a separate assigned-staff-only, version-bound,
  idempotent terminal transition after acknowledgment. An isolated PostgreSQL
  17 test cluster applied migrations 001–006 and kept an existing acknowledged
  report unchanged. The restricted app role passed the Human Operations suite
  74/74 with zero skips; RLS and grants remained intact. Edge passed 168/168,
  Customer Portal 153/153, and Operations Console 74/74; changed app
  typechecks/builds passed. The Console receives a `can_close_review` boolean
  only from the staff-authenticated Human Operations detail response and
  treats it as advisory; the backend rechecks assignment and version at POST.
  The reviewed additive migration 006 was subsequently applied to the local
  project database. A read-only staff detail for an existing acknowledged
  report returned HTTP 200, `ACKNOWLEDGED`, `can_close_review: true`, and an
  audit array. The database still had 8 acknowledged, 1 claimed, and 45
  received reports after migration. A subsequent one-shot backend smoke did
  close a new disposable report; browser QA remains pending.

- A guarded local backend smoke created exactly one `DELAYED` report for the
  owned test order `9KWUQ1TBZ7NUV8EU`: report
  `delivery-ab8acd27-3626-45a2-9994-2b0c548db792` in conversation
  `01a0fc92-99bf-764e-a513-cb28ef25acfe`. Authenticated staff claim,
  acknowledgment, and closure reached `REVIEW_CLOSED` version 4 with a
  `closed_at` timestamp. Same-key closure replay returned the identical
  result; a different-key stale closure returned 409. Customer readback
  returned exactly the six public fields, with no refund or order mutation.
  A separate read-only staff detail confirmed the received, claimed,
  acknowledged, and review-closed audit events. The opt-in verifier and five
  focused tests are in
  [`tools/local/verify-delivery-review-closure.mjs`](../tools/local/verify-delivery-review-closure.mjs).
  It creates a fresh conversation and report on each invocation, so do not
  automatically rerun after an uncertain failure. This is backend-only proof,
  not a manual customer/staff browser walkthrough.

- Delivery staff retry session-reset regressions now exercise the actual sign-in,
  queue, and detail component handlers with controlled HTTP responses and browser
  storage. Eleven tests cover new sign-in, failed sign-in, blocked cleanup,
  queue/detail/transition 401 and 403, uncertain same-key retry, and ordinary
  page exit. The Operations Console suite passed 62/62 and its typecheck passed.
  This is automated component-handler coverage, not a live identity-switch
  browser walkthrough; existing Node module-format warnings remain.
- The additive migration ran against local PostgreSQL. Its repository tests
  passed with the non-superuser app role, including forced-RLS isolation,
  idempotency, audit transactionality, and rollback after an audit failure.
- A bounded live API test for the existing owned local order
  `9KWUQ1TBZ7NUV8EU` created report
  `delivery-09f416c4-77f6-4b16-8743-e0f6b38325cd`, returned `RECEIVED`,
  then separate staff claim and acknowledgment returned `ACKNOWLEDGED`.
  Customer readback exposed exactly the six safe fields above. No refund
  action was called in this test.
- Edge, Gateway, Human Operations, Customer Portal, and Operations Console
  focused tests passed. Both Next.js apps built successfully, and the changed
  TypeScript packages typechecked. This is **not** a completed manual browser
  pass of both forms and staff controls.
- Customer polling now ignores older overlapping responses and removes a stored
  receipt when the current account gets an authoritative 401 or 404. Staff
  claim/acknowledgment retries preserve their idempotency key and expected
  version after an uncertain response; older refreshes cannot roll back the
  displayed state. The customer and staff web proxies refuse upstream
  redirects so their server-held local tokens cannot follow a redirect. Edge's
  three signed delivery calls also refuse redirects; native-fetch regression
  tests reproduced and then prevented cross-origin assertion forwarding.
- Receipt recovery now works when the dedicated conversation has closed. A
  customer retry checks the original request key, body, conversation, and
  identity through a distinct, short-lived replay assertion. Human Operations
  reads the committed idempotency record and returns the **current** six-field
  customer receipt; it never inserts another report or audit event. A missing
  key returns 404 and changed body returns 409. The Portal tries this lookup
  before any same-key create retry; it only falls back to create when the
  receipt is known missing and the conversation is still open. Transient
  lookup errors remain uncertain rather than creating a duplicate.
- On 2026-10-02, the focused PostgreSQL repository suite passed 4/4 with the
  non-superuser, non-BYPASSRLS app role, including no-row-mutation and audit
  checks. Human Operations passed 59 non-database tests, Edge 158/158, and
  Customer Portal 91/91; affected typechecks and builds passed. A backend-only
  live check used one owned local order, created one report, closed its
  conversation, and recovered the same receipt via Edge. It also confirmed
  changed-body conflict, missing-key no-write, and owner readback. The
  disposable report ID was `delivery-6c0cbd67-0cea-440f-a488-4efafa164f81`.
  The repeatable check is
  [`tools/local/verify-delivery-receipt-recovery.mjs`](../tools/local/verify-delivery-receipt-recovery.mjs);
  it uses ignored local customer/support tokens and creates a fresh report.
- Customer report history was then added as an explicit read-only route through
  Portal → Edge → Human Operations. Human Operations applies tenant,
  environment, and customer predicates under forced PostgreSQL RLS, reads at
  most eleven rows, and returns ten customer-safe receipts plus `has_more`.
  The request accepts no caller-supplied identity, filters, or body. The
  focused PostgreSQL repository suite passed 6/6 under the restricted app
  role, including owner isolation, newest-update ordering, bounds, and no
  writes. Human Operations passed 62 non-database tests (8 opt-in database
  skips); Edge 163/163; Portal 107/107. A local authenticated Edge and Portal
  read returned this test customer's two reports, including the recovered
  receipt, while a different signed customer saw zero. Typechecks and builds
  passed. These are API/test results, not a manual visual browser pass.
- A security review reproduced an in-flight UI race: a late report-create
  response could republish a previous customer's receipt after history returned
  401. Submission now checks a request epoch after every awaited step; pagehide
  clears visible report/history state and invalidates late responses while
  preserving an uncertain retry key in session storage. On back/forward
  restoration the form restores that attempt for an explicit authoritative
  retry, not a stored receipt. The replay web proxy now projects only six safe
  receipt fields and redacts upstream diagnostics. Regression tests cover
  late create, late conversation creation, pagehide, malformed replay, and
  private error fields.

## Remaining release gates

- Manually test both browser UIs, including a failed/uncertain submission and
  a staff claim-version conflict. The automated browser was denied access to
  the local site by a saved browser permission in this task, so this remains a
  human walkthrough gate. Do not bypass that browser preference.
- Define report retention/deletion, rate limits/abuse controls, delivery staff
  staffing and escalation procedures, and real production identity before
  enabling this journey for public traffic.
- A browser walkthrough of lost-response retry, closed-conversation replay,
  report history on a second device, and back/forward navigation is still
  required. The backend-only checks do not prove the visual UI or production
  identity.

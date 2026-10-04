# Refund execution safety review (2026-10-02)

This is a completed local code-hardening record, not a new refund-policy
release or a production/provider validation.

## Additional selection and monetary integrity checkpoint

A later audit found that Vendure's current refund mutation sends an amount,
payment ID, and reason but no line attribution. A prior amount-only refund can
therefore have empty `lineIds`; the old selected-item calculation treated that
as proof that another request for the same item was safe. Gateway now rejects
selected-item contexts after any consuming refund with empty or unrecognized
line attribution, as well as duplicate, empty, unknown, or already-refunded
selected item IDs. A selected-item context also requires a positive refundable
maximum: zero-priced selections and exhausted payment balances are not valid
refund selections. Full-order requests retain their remaining-payment-balance
calculation. Gateway route and signed execution schemas require canonical
selections. This favors safety over availability: an unrelated prior
amount-only refund can prevent a later selected-item request until an
operator resolves the ambiguity.

Vendure normalization now rejects negative order, payment, or refund amounts.
The provider-neutral context additionally rejects mixed currencies, negative
or unsafe monetary values, and selected line totals outside the order
currency; it returns zero refundable amount rather than relabeling foreign
currency as the order currency. Red-green focused tests established these
cases. Two execution-route regressions also confirm malformed money cannot
reach the provider. A subsequent zero-maximum checkpoint added three pure-context
tests: the zero-priced and exhausted-balance cases failed before the guard,
then passed after it; a one-cent remaining maximum stays valid. The final
combined Gateway suite passed 305/305 on Node 24, and its
typecheck and build passed. No live provider refund was performed for this
checkpoint.

The remaining provider boundary is important: a fresh channel-bound provider
preflight does **not** enforce item allocation atomically at Vendure. Before
the conservative order claim described below, two distinct workflows could
both read the same pre-mutation facts and reserve different executions.
Adding Vendure refund
lines needs a separate contract, quantity semantics, legacy-history handling,
and race review; deprecated schema fields alone are not a complete fix. Do
not treat this checkpoint as production proof of duplicate-refund prevention.

A read-only concurrency audit of the installed Vendure service confirmed its
standard refund method checks existing balance, calls the payment handler, and
only then saves the new refund. The original Gateway reservation was unique
by key and workflow/preview, not order. Gateway now implements a durable claim
per tenant/environment/order in `refund.order_claims`. The new execution row,
order claim, and request audit commit in one PostgreSQL transaction before any
provider dispatch. A claim collision rolls back the new execution and returns
`refund_execution_conflict`; a proven identical existing execution retry still
returns its recorded outcome. An initial provider read proves ownership only; the
Gateway refreshes eligibility after acquiring the claim.

Claims are permanent: `IN_PROGRESS`, `SUBMITTED`, `PENDING_RECONCILIATION`,
`SUCCEEDED`, and `FAILED` all retain them, even after a pre-dispatch rejection.
There is no lease, automatic expiry, release, or transfer API. This deliberately
blocks legitimate later partial refunds, including disjoint item selections.
The short database transaction never holds a lock across provider HTTP. A crash
after reservation leaves a durable blocker, and a replay never blindly dispatches
again. An unresolved blocker is a safety/availability limitation, not proof that
the provider executed or failed. This application-only fence cannot stop direct
Vendure Admin writes or other provider-side bypasses. A
real provider-side solution needs an order/intent claim that survives crashes,
restricted bypass access, PSP idempotency, exact-identity reconciliation, and
tests for concurrent workflows, retries, legacy history, and conflicting
Admin writes. The local SQLite transaction-ownership hazard prevents claiming
that a quick transaction wrapper around Vendure's default mutation is safe.

Migration `008_refund_order_claims.sql` creates the order-unique primary key and
backfills one ownerless claim for each historical order scope, across every
execution status. Multiple historical executions are preserved, not deleted or
chosen as a supposedly authoritative owner. It also adds the nullable
`execution_intent_sha256` column to the execution ledger. New executions persist
a versioned SHA-256 of order ID, amount/currency, selection scope, sorted item IDs,
and reason code. Key/workflow/preview and this digest must all match for replay;
an independently valid signed request with a changed selection or reason conflicts.
The digest is stored at reservation time, not derived from later provider facts.
Historical rows have no provable selection/reason and retain NULL: their execution
retries now fail closed with `refund_execution_conflict`. Read-only reconciliation
using an exact recorded provider refund ID remains available. New intents for
their claimed orders are also blocked. The application receives only SELECT
and INSERT rights on claims. A new reservation against an unmigrated database
fails closed because the claim table is absent.

At the initial offline checkpoint this migration was **not applied**. Before rollout,
pause refund execution, drain/stop old Gateway writers, apply the migration through
the normal administrative migration path, and activate the new Gateway code before
resuming. Old Gateway instances do not consult the claim table; mixed-version
writers or rollback to old code can bypass the guard. No provider/Admin concurrency
protection or production crash recovery has been verified by these offline tests.

The order-claim checkpoint added 16 offline regressions. Ten missing-guard cases
failed before implementation, including two distinct selected-item workflows
both dispatching from the same initial facts. The later Gateway suite passed
343/343 on Node 24; typecheck and build passed. Tests cover every execution status,
exact replay, scope isolation, unresolved/provider-read failure, a pre-dispatch
reservation, post-claim eligibility refresh, and transaction rollback/commit
boundaries. The initial PostgreSQL query-contract tests used controlled pool
doubles; the isolated database check below adds real uniqueness and transaction
evidence. Process-crash persistence and provider-side effects remain untested.
No real refund was created.

An additional isolated local PostgreSQL check applied migrations 001–008 to
the disposable `cso_refund_claim_check_20261002` database and passed the
opt-in `tests/integration/refund-order-claim.test.ts` test. Two concurrent
repositories attempted distinct workflows for one synthetic order; exactly
one reserved, one conflicted, and the database held one execution and one
claim. Exact replay survived a new repository instance after a recorded
`FAILED`; changed reason, selection, and the competing workflow conflicted.
This exercises actual PostgreSQL uniqueness and transaction behavior, not a
process crash, external provider effect, or Vendure Admin bypass. The disposable
test database was removed after the passing check.

For the local development stack, the Gateway and Temporal Worker were stopped
before migration 008 was applied through the normal migrator to the main local
PostgreSQL database. A read-only check found six historical executions on six
orders (five `SUCCEEDED`, one `FAILED`), six backfilled claims, and six NULL
legacy intent digests; no in-progress historical execution was found. Gateway
and Worker were then restarted; Gateway listened on port 3002 and Worker
reported `RUNNING`. This is **local rollout only**, not production deployment,
provider-race validation, or permission-bypass proof. Existing legacy exact
replays fail closed because their selection/reason was never persisted.

The exact-intent review also added three regression tests and extended the
real-signed route test. Four tests failed before the digest correction, reproducing
changed selection/reason replay and acceptance of unproven historical rows. These
checks also protect item-set canonicalization and mutation of caller-owned arrays.
After correction the combined Gateway suite passed 343/343, with typecheck and
build passing on Node 24. Migration 008 remains unapplied; these are offline checks,
not real PostgreSQL/provider validation.

## Confirmed failures before the fixes

1. A short-lived `refund_execute` assertion bound workflow/customer/purpose,
   but not the exact execution body. In an isolated fake-provider test, the
   same assertion with a different idempotency key and amount caused a second
   provider call for the same preview. Possession of that assertion was a
   prerequisite; this was not demonstrated as a customer-controlled path.
2. Reconciliation selected a refund by amount and currency alone. An older
   settled same-amount refund could be mistaken for the current submitted
   refund and incorrectly mark the current execution successful.
3. Several Node service-to-service requests carrying short-lived assertions
   followed redirects. Synthetic cross-origin 307 tests demonstrated that
   assertion headers—and for POST requests, bodies—reached a different origin.
   This requires a redirected configured upstream/intermediary and was not
   demonstrated as a direct customer-controlled redirect.

## Intended and implemented boundaries

- Worker execution assertions must sign the exact order, reason, amount,
  selection, preview and idempotency key sent to Gateway. Gateway must reject
  missing/changed intent before reading order facts or calling a provider.
- Gateway must reserve one execution per tenant/environment/workflow/preview
  atomically. An identical retry returns its recorded state; a changed intent
  or key conflicts. A timeout or unknown provider outcome remains pending for
  reconciliation, never a second blind write.
- Reconciliation must match the current execution's provider refund ID. If
  the identity is unknown, it cannot use a same-amount older refund as proof
  of success.
- All signed Node service calls and Vendure credentialed calls reject HTTP
  redirects instead of forwarding headers or bodies.

The Worker signs the exact instruction it sends; Gateway rejects unbound or
altered assertions before provider access. Gateway's PostgreSQL repository
has a unique workflow/preview index and exact-retry/conflict behavior. All
Node service boundaries found in this review now reject redirects. The
Agent Runtime refund lookup also binds returned facts to the requested order
and applies a bounded MCP operation deadline; previously, a valid-looking
different-reference result could be loaded and a stalled MCP session could
wait indefinitely beyond the HTTP socket timeout.

## Verification and rollout

The final combined offline suites passed: 107 contracts, 123 Edge, 120
Gateway, 80 Workflow Workers, 411 Agent Runtime, and 281 evaluation-runner
tests. Gateway, Edge, and Worker TypeScript checks passed; changed Python Ruff
checks passed. Focused tests first reproduced altered-intent replay, older
same-amount reconciliation, mismatched refund facts, MCP stalls, and redirect
leakage using synthetic fakes/loopback servers, then passed after the fixes.

Local PostgreSQL had zero duplicate workflow/preview groups before migration
005. The additive unique index and matching migration bookkeeping record were
applied in one administrative transaction without deleting existing rows.
The application role can see the index; the recorded digest matches the
checked-in migration. Other environments **must** apply migration 005 through
their normal migration process before starting the new Gateway code. If
historic duplicates exist, the migration fails and needs operator review,
not automatic deletion.

The local Worker was restarted on Node 24 and reported `RUNNING`; Gateway's
watch process restarted after its final code change. No live provider refund,
settlement, duplicate write, or new browser-to-provider smoke was performed
for this hardening. Legacy unbound execution assertions now fail closed, so
Worker and Gateway versions must roll out together. Keep live monetary testing
on a fresh disposable order and verify the provider's final state before
claiming the journey passed end to end after this change.

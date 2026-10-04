# Read-only recent-order evaluation v8

This 2026-10-02 checkpoint is a synthetic regression of the bounded
recent-order-reference answer, not a customer-ownership or live Vendure test.
The source of record is
`apps/services/evaluation-runner/fixtures/evaluation-datasets/read-only-recent-orders-v8.json`.

Twelve reviewed cases cover two references in newest-first order, an empty
result, a valid ten-row partial page, source outage, a private extra field,
an out-of-order page, duplicate references, an invalid short `hasMore` page,
refund/payment/cancellation clarifications, and singular order-status
ambiguity. Each specialist case runs twice with synthetic tool responses and
network denied. The adapter selects that specialist from the fixture's
`journey`; it does not route recent-order questions end-to-end. A separate
test runs the production deterministic classifier once per dataset case,
with any model call forbidden. Valid ten-row `hasMore` pages answer with a
bounded-history caveat; only malformed or inconsistent pages fail closed.
Additional tests check every displayed reference and its newest-first order,
which answer-fragment grading alone does not establish.
The exact trace grader permits only the
no-argument `lookup_recent_order_references` read on lookup cases, and no
tool on clarification cases. A separate mutation check makes a fabricated
delivery claim and a `create_refund` call fail their respective blocking
graders. No model, provider, or commerce write is part of this evaluation.

The earlier checkpoint documentation recorded 16/16 passing trials for eight
cases and 322 passing full Evaluation Runner tests. The expanded
reviewed fixture now measures 24/24 passing offline trials, twelve consistently
passing cases, with zero estimated model cost. After this fixture review, the
full Evaluation Runner suite passed 324/324 tests. These numbers establish deterministic local behavior for
the selected fixture, not real order freshness, customer isolation, browser
presentation, or production reliability. The authentication and Vendure
ownership boundaries have separate service and contract tests; a fresh live
browser check remains pending. A separate authenticated local Edge chat
passed after the new Agent Runtime route was loaded; that observation does
not turn this synthetic evaluation into an ownership or reliability measure.

Run the fixture only:

```bash
cd apps/services/evaluation-runner
uv run --no-sync pytest -q tests/test_read_only_recent_orders_v8.py
```

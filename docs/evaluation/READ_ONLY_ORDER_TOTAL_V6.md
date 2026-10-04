# Read-only order-total evaluation v6

Status: offline synthetic regression passed on 2026-10-02. This tests the
customer-facing **current tax-inclusive order total** answer, not the amount
paid, a receipt, an invoice, a refundable balance, or a refund action.

The [v6 dataset](../../apps/services/evaluation-runner/fixtures/evaluation-datasets/read-only-order-total-v6.json)
has ten reviewed cases. Three check USD, INR, and zero-decimal JPY formatting.
Four fail closed for missing order, mismatched reference, unsupported currency,
or an extra unreviewed source field. Three mixed invoice, payment, or refund
questions must clarify without a tool call. The positive and fail-closed cases
invoke the production specialist with fake tool results; the mixed-intent cases
also invoke the deterministic classifier. This distinction matters: the suite
does not prove every natural phrasing will be recognized by the full intake
path. A separate no-model assertion now checks that all seven order-total
fixture questions do select `order_total` through the real classifier. Another
mutation check confirms that a fabricated payment-success claim fails the
answer grader and an extra refund tool call fails the trajectory grader.

Each case ran twice: **20/20 trials passed**, all ten cases were consistent,
and the blocking answer and trajectory graders checked the reviewed response
fragments and exact read-only tool traces. Network connections were denied.
The current full Evaluation Runner suite passed 316 tests. To reproduce the
focused check:

```bash
cd apps/services/evaluation-runner
uv run --no-sync pytest -q tests/test_read_only_order_total_v6.py
```

This is not a RAGAS or LLM-judge score. The zero cost and latency fields mean
the offline fixture did not use a model or measure a live service. Gateway
contract tests cover ownership denial separately; one authenticated local Edge
chat proved a successful owner-scoped answer for an existing test order. No
browser, production identity, live invoice, or load behavior is established.
See [the journey note](../ORDER_TOTAL_JOURNEY.md) for the source and trust
boundary.

The historical v2 read-only fixture is preserved. Its exact expected drift is
two repeated `failed-refund` wording trials and two repeated
`policy-empty-evidence` retrieval-query trace trials. The latter still returns
the same safe source-unavailable answer. The v2 test requires those four
specific differences; it does not silently relax grading or rewrite the old
dataset. New behavior is covered by later versioned fixtures.

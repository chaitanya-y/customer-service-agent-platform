# Evaluation entrypoint

This directory is the durable index for Customer Service Agent Platform evaluation.
Start here, then use the linked reports for exact artifacts and limitations.

## RAGAS checkpoint — 2026-09-15

The bounded measurement baseline is frozen and the quality gate is **not green**.
The authorized v4 large-refund trial completed execution but failed its blocking
reviewed-policy answer check: the response stayed generic and retained one RAG
citation instead of presenting the required USD 750 request against the USD 500
specialist-review threshold. Context precision, context recall, and faithfulness
were 1.0;
response relevancy was 0.5704 and factual correctness (precision) was 0.33.
No retry was performed.

The preceding v3 campaign attempted five cases three times (15 attempts): five
answers were scored, ten were `SYSTEM_ERROR`, and zero cases passed all three
repetitions. Human review/calibration is incomplete. LangSmith export and Tau
benchmarking have not started. These results are evaluation evidence, not a
production reliability claim.

## Newer deterministic support regressions — 2026-10-02

The RAGAS gate above has **not** been superseded by the newer read-only
support evaluations. Those cases use synthetic, network-disabled service
projections and blocking answer/tool-trajectory graders; they do not call a
judge model or measure live retrieval quality. The reviewed reports cover
[status clarity](READ_ONLY_STATUS_CLARITY_V5.md) (12/12 trials),
[order total](READ_ONLY_ORDER_TOTAL_V6.md) (20/20),
[catalog price](READ_ONLY_CATALOG_PRICE_V7.md) (20/20), and
[recent order references](READ_ONLY_RECENT_ORDERS_V8.md) (24/24).
The [return/exchange discussion fixture](RETURN_EXCHANGE_DISCUSSION_V4.md)
also checks that unsupported exchange claims and commerce actions are blocked;
it is a discussion, not a return or exchange workflow.

These results support narrow deterministic behavior. They do not close the
pending RAGAS quality gate, human calibration, LangSmith export, Tau benchmark,
browser checks, or production reliability measurement.

A [2026-10-02 one-case RAGAS diagnostic](RAGAS_LARGE_REFUND_2026_10_02.md)
of the current large-refund answer had one guard rejection before scoring and
one accepted answer that passed blocking checks. The accepted answer's
non-blocking response-relevancy score was below target. This neither replaces
the frozen baseline nor establishes repeated reliability.

## Evidence and guides

- [Closure review](RAGAS_CLOSURE_REVIEW.md): frozen v4 measurement, exact scores,
  usage, review preparation, and next approval boundary.
- [v4 policy-answer guide](RAGAS_V4_POLICY_ANSWER.md): offline implementation and
  the deterministic policy-answer criterion.
- [v3 baseline](RAGAS_V3_BASELINE.md): five-case campaign results and scored
  coverage.
- [Evaluation strategy](EVALUATION_STRATEGY.md): evaluation sequence, gates, and
  limits.
- [Evaluation Runner guide](../../apps/services/evaluation-runner/README.md):
  datasets, offline commands, safeguards, and result interpretation.

## Other measured foundations

The local retrieval check covered five cases against 18 chunks: Recall@3 was
1.0, MRR was 1.0, and forbidden-evidence rate was 0.0. Agent-runtime coverage
includes seven core cases plus one retrieval-outage case offline; this is not a
full workflow evaluation. This documentation update introduces no new product
behavior, paid run, service operation, secret, or refund action.

## Safe reading order

1. Read the [Codex handoff](../CODEX_HANDOFF.md) for repository-wide context.
2. Read the [closure review](RAGAS_CLOSURE_REVIEW.md) for the latest measured
   status and explicit limitations.
3. Use the [Evaluation Runner guide](../../apps/services/evaluation-runner/README.md)
   before running any command; paid calls require separate explicit approval.

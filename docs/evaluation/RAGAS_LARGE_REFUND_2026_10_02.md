# Large-refund RAGAS diagnostic — 2026-10-02

This is a two-attempt diagnostic of **one** reviewed synthetic case,
`large-refund-review-answer-v1` from the pinned v4 dataset. It is not a
campaign, an end-to-end browser test, a refund, or evidence of production
reliability. No customer data, internal-only knowledge, or commerce mutation
was sent. The answer model saw synthetic case facts and retrieved
`CUSTOMER_SAFE` policy; the second attempt's judges saw that answer and the
case's review reference. Both attempts used `gpt-5-nano` for answer/judge,
`text-embedding-3-small` for embeddings, one repetition, a 4,096-token judge
ceiling, and `refund-policy-v2`. LangSmith/RAGAS tracking exports were off.

| Attempt | Outcome | Scoring and usage |
| --- | --- | --- |
| `refund-ragas-v4-large-current-20261002-001` | `SYSTEM_ERROR`: answer guard rejected the model output with `DELIVERY_AGE_TEXT_REJECTED` before a public answer or judge. Raw rejected text was **not** retained. | Unscored; 4,831 measured tokens, including 4,822 answer and 9 query-embedding tokens; no judge calls. |
| `refund-ragas-v4-large-diagnostic-20261002-002` | `COMPLETED`, 1/1 blocking pass. Diagnostic capture was enabled for this reviewed synthetic dataset; no rejection occurred, so its private sidecar has an empty rejection list. | 26,514 measured tokens: 4,236 answer, 22,229 judge, 40 judge-embedding, 9 query-embedding. |

The second response was exactly: “Your requested refund of $750 is above the
$500 specialist-review threshold, so it requires specialist review before it
can be approved.” Its cited evidence list was empty; the v4 case permits zero
citations because this amount statement is checked against the verified policy
catalog rather than inferred from retrieved prose. Expected evidence,
prohibited-claim, reviewed-policy, context precision, context recall,
faithfulness, and factual-correctness graders passed. Response relevancy was
**0.5516**, below its 0.7 target, but is explicitly non-blocking for this
fixture. The RAGAS summary's 1/1 pass therefore does **not** mean every metric
passed. Context precision was approximately 1.0, context recall 1.0,
faithfulness 1.0, and factual correctness (precision) 1.0 for this one
accepted answer.

Both private artifact directories are mode 0700; result, usage, and the second
run's empty rejection sidecar are mode 0600. They are local temporary evidence,
not committed project fixtures:

| Artifact | SHA-256 |
| --- | --- |
| `/private/tmp/cso-ragas-large-current-20261002.V7Tbfk/result.json` | `e4eb5529454b3125e1b885e199dd4c4bc05e4048bda9a61835846898cefd4c46` |
| `/private/tmp/cso-ragas-large-current-20261002.V7Tbfk/usage.json` | `1e4ac1b49f774671f6c97f273a54d58d4569d25bbdf8dac046bd79d9c0bb85f5` |
| `/private/tmp/cso-ragas-large-diagnostic-20261002.AfBtP3/result.json` | `588662e072f2a5eff670ddb6dfb9fd8e3daa96d91f567dd03e6b344d9fe88c54` |
| `/private/tmp/cso-ragas-large-diagnostic-20261002.AfBtP3/usage.json` | `d3acf75ade684acfe42959b882b52a5d6f18d410b63a836bcd5641c620feb675` |
| `/private/tmp/cso-ragas-large-diagnostic-20261002.AfBtP3/rejection.json` | `e07c279d264146772023df6cf1856cf2402c1e4a0cac2f3feae25bcc01479a79` |

The checkout was broadly uncommitted. These content hashes identify the
principal tested paths at the time, rather than a release commit:

| Input | SHA-256 |
| --- | --- |
| Agent Runtime `refund/answer.py` | `e6317bcb7be0bcd860eb1e1c99a5a49d14fb530ec498bf3154e4f5b1695b25d0` |
| Agent Runtime `refund/presentation.py` | `aeb0ff47ee28811b36b11f5f5829068deae46699351e790d6c5ffa519bf304b8` |
| Evaluation Runner `adapters/refund_rag_answer.py` | `67f64670d2fa97edf92b4d29da266c88464bd378c6bba877a95a2d8915117cb7` |
| Evaluation Runner `live_rag_evaluation.py` | `5ad7eeda37335fe0e6b956e253d92c5cf85edddbf15e9b7fc0e50f0db85aa272` |
| `refund-rag-answer-v4.json` | `f080c7c0f5f58cf560e3854a6454c97262bcd260f1af3168fdc6fbca2cea7681` |

**Interpretation:** Current deterministic amount presentation can produce the
reviewed $750/$500 answer, but the first model output was blocked. Because the
first rejected text was not captured and the second was accepted, these runs
cannot establish whether the first rejection was a correct safety decision or
a false positive. Do not blindly repeat paid trials. Diagnose the guard with
offline cases or a newly justified, tightly scoped synthetic diagnostic;
then run a same-version repeated/held-out evaluation and human review. The
frozen RAGAS gate, LangSmith export, and Tau benchmark remain open.

# Bounded RAGAS measurement and review checkpoint

Date: 2026-09-15
Status: Bounded measurement baseline frozen on 2026-09-15;
quality gate failed; owner review and human calibration are not complete.

Update: a separate, single-case prompt-v10 trial passed its blocking gate on
2026-10-02. See the dated addendum below. The September results remain frozen.

Frozen means preserve the measured results and stop automatic retry campaigns.
It does not mean production qualification or that every RAG evaluation task is
complete. Remaining owner decisions can be appended without changing historical
scores. LangSmith design is the next stage; implementation and external export
are not yet approved by this checkpoint.

## Single v4 trial

Run `refund-ragas-v4-large-review-20260915-001` used the reviewed
`large-refund-review-answer-v1` case from dataset v4, one repetition,
`refund-policy-v2`, prompt v9, `gpt-5-nano` answer and judges, and
`text-embedding-3-small` query/judge embeddings. Evaluation version remains
`refund-ragas-v2`; this is independent of dataset version.

The run began at 20:48:08 UTC and ended at 20:50:10 UTC (122 seconds).
Retrieval plus answer latency was 21.953 seconds; that is not the total judge
runtime or a user-facing p95 measurement.

Preflight verified OpenSearch, the configured tenant-local index/release,
1536-dimensional vectors and the cached pinned cross-encoder. All three
retrieved chunks were CUSTOMER_SAFE. No server restart, token renewal, commerce
call, refund, new dependency, rejection capture, or LangSmith export occurred.

Observed answer:

> Automatic approval is not guaranteed for larger refund requests. The policy splits refunds into ranges: small refunds may be automatically approved after eligibility and required evidence; mid-sized refunds require human approval; very large refunds require human takeover and case handling. For order EVAL-REFUND-004, whether your request is auto-approved depends on the refund amount relative to those ranges.

Expected application-rendered answer:

> Your requested refund of $750 is above the $500 specialist-review threshold, so it requires specialist review before it can be approved.

The trial **completed but failed**. This is a quality failure, not an execution
failure. The version, catalog hash and required application facts matched.
The answer missed the exact reviewed monetary explanation and retained one real
RAG citation. That citation was from retrieved evidence, not fabricated, but
this reviewed application-only response requires zero RAG citations.

| Check | Result | Blocking? |
| --- | --- | --- |
| Expected retrieval evidence | Pass | No |
| Minimum citation count (minimum zero) | Pass; one citation observed | No |
| Prohibited claim | Pass | Yes |
| Reviewed policy answer | Fail: wording mismatch and expected zero citations | Yes |
| Context precision | 1.0000 rounded | No |
| Context recall | 1.0000 | No |
| Faithfulness | 1.0000 | No |
| Response relevancy | 0.5704; below provisional 0.7 | No |
| Factual correctness, precision mode | 0.3300; below provisional 0.7 | No |

The expected monetary presentation was not observed. The public result does not
retain the model's chosen purpose, so it does not prove which purpose was selected
or precisely why the renderer path was missed. Preserve this as a regression
candidate; do not claim a proven root cause or modify prompts/guards without a
separate scoped change. No retry was performed.

This illustrates why faithfulness is insufficient alone: a grounded answer can
still be generic and fail the reviewed task. One repetition cannot establish
reliability. V4 is not a direct improvement comparison with v3 because its
criterion changed.

## Measured usage and artifact verification

| Component | Recorded SDK invocations | Tokens |
| --- | ---: | ---: |
| Answer | 1 | 3,786 |
| RAGAS judges | 11 | 24,056 |
| Judge embeddings | 2 | 56 |
| Query embedding | 1 | 9 |
| Total | 15 | 27,907 |

All 15 recorded invocations succeeded. These counters are not independent
transport-level retry counts. Usage status COMPLETED means execution completed,
not that quality passed. Measurement is COMPLETE. Dollar cost is unknown because
no verified pricing schedule was configured. Reasoning tokens are already included
in output totals and must not be added again.

Coordinator verification parsed the result/usage through their production
Pydantic models, checked one case/one repetition, matching run IDs, CUSTOMER_SAFE
evidence, and owner-only file permissions. Historical v3 artifact hashes still
match their original recorded digests. No application code changed in this batch;
the preceding 268-test result remains historical offline evidence, not a new run.

Private files under `/private/tmp/cso-ragas-close.7Uj06X/live/`:

| File | SHA-256 |
| --- | --- |
| result.json | `40322f639071918423d621eee3cd7c303cfd89c80fe18d7d3227bdb326ba2422` |
| usage.json | `47f1a0d7127207beb8b756136f02d8e876484f0dea909c62f4bab5506dbee74a` |

These files are mode 0600 and outside Git. Temporary artifacts may not survive
cleanup; this sanitized report records the outcome. No commit or push occurred.

## Machine-assisted v3 review, not human calibration

The independent review reconfirmed 15 attempts, five scored answers, ten
SYSTEM_ERROR trials, zero cases passing all three repetitions, 95 successful
recorded invocations and 204,047 tokens. Historical grades remain unchanged.

| Scored answer | Existing guided owner decision | Remaining observation |
| --- | --- | --- |
| Final sale, repetition 2 | Needs eligibility-wording correction | Source-supported exceptions do not authorize an individual denial |
| Large refund, repetitions 1 and 3 | Needs explicit threshold comparison | Generic tiers and unrelated advice do not address the known USD 750 amount |
| Provider timing, repetition 2 | Needs a more direct answer | Grounded timing content includes an irrelevant proposal footer |
| Provider timing, repetition 3 | Pending owner decision | Same relevance concern; faithfulness 0.8333 and relevance 0.4975 are existing scores, not new ratings |

Provider repetition 3 states:

> Thanks for checking on your refund. After your refund is approved, we submit it to the original payment method. Banks and payment providers may take 5 to 10 business days to show the refund in your bank account. We cannot guarantee a provider's settlement time.
>
> Proposed refund amount: USD 125.00. This is a request, not a refund approval.

The timing propositions cover the reference and retain conditionality. The
proposed assessment is **needs a more direct answer** because the footer does not
answer the timing question. This is an assistant assessment pending owner review.
Claim-level judge explanations were not retained, so we cannot establish why
faithfulness differs from repetition 2's 1.0.

Rejection review distinguishes causes from whole-answer safety:

- Two identifier captures have demonstrable terminal-colon false-positive causes.
- One incorrect-item capture has an OR-alternative scope-matching false-positive
  cause. That does not endorse its separate claim that review was already underway.
- Two captures contain clear personalized-conclusion concerns (final-sale denial
  and a large-refund path inferred from full-order scope rather than amount).
- Five window-framing captures remain ambiguous. Their time windows are supported
  by policy, and imperative or conditional request instructions do not necessarily
  claim verified delivery age. They may be overly strict guard rejections. Other
  omissions or unsupported claims must be reviewed separately; for example,
  one answer drops the digital-goods exclusion's access/download condition.

Do not label this as seven proven true positives. The supported summary is three
identifiable false-positive rejection causes, two clear conclusion concerns and
five unresolved framing cases. Historical broad rejection codes are unchanged.

## Next boundary

The authorized run and review-preparation work are finished. The quality gate is
not green, and no human numeric ratings, blind review or calibrated release
thresholds have been established.

Finish the owner's guided review and record unresolved disagreements honestly.
The baseline is frozen with a failed gate and a tracked monetary-presentation
issue; perfect scores are not required to begin LangSmith. Announce LangSmith
before starting, and obtain permission for any external export. A targeted
presentation fix or another paid trial requires separate scope/approval; do not
restart an open-ended retry campaign. External Tau benchmarking, expanded/held-out
cases and production observability remain separate stages.

## Targeted v10 regression on 2026-10-02

One authorized trial, `refund-ragas-v4-large-review-v10-20261002-001`, reused
the synthetic `large-refund-review-answer-v1` case and unchanged v4 fixture,
`refund-policy-v2`, `gpt-5-nano` answer/judges, and
`text-embedding-3-small` query/judge embeddings. Evaluation version was
`refund-ragas-v2`; answer prompt version was `refund-answer-v10`. There was no
retry, real customer input, commerce call, or refund execution.

The narrowly scoped implementation routes a personal future automatic-approval
question to the deterministic amount-review presenter only when the trusted
policy projection and requested amount are present. The raw model answer still
passes the existing safety guard before presentation. This does not change the
v4 reference, silently authorize a refund, or allow the model to invent a
threshold.

Observed final answer:

> Your requested refund of $750 is above the $500 specialist-review threshold, so it requires specialist review before it can be approved.

The trial completed and **passed its blocking checks**. It returned zero RAG
citations, hit the expected CUSTOMER_SAFE evidence, passed the reviewed policy
answer and prohibited-claim checks, and met its minimum citation count of zero.
The RAGAS grades were context precision approximately 1.0, context recall 1.0,
faithfulness 1.0, and factual correctness 1.0. Response relevancy was **0.58647**,
below the provisional 0.7 target; this grade is informational, not a blocking
pass. The recorded retrieval-plus-answer latency was 26.478 seconds, not total
evaluation time or user-facing p95.

Usage measurement was COMPLETE: one answer invocation (4,855 tokens), 11 judge
invocations (22,376), two judge-embedding invocations (45), and one query
embedding invocation (9), totaling **27,285 tokens**. Estimated dollar cost
remains unknown because no verified pricing schedule was configured. These
invocation counters are not proof of transport-level retry counts.

Private, mode-0600 artifacts outside Git:

| File | SHA-256 |
| --- | --- |
| `/private/tmp/cso-ragas-v10.zDK7Qe/result.json` | `0f9d827ae630c205c73d3abf4db412301820fa8e5f62cdb522d1bb73baebb048` |
| `/private/tmp/cso-ragas-v10.zDK7Qe/usage.json` | `02252084c5bb2f4251ff8ed05c70337754e113ce8ca8b4bc26a3c416141d09b2` |

The focused implementation tests and complete offline suites passed: Agent
Runtime 466/466 and Evaluation Runner 298/298. One live repetition cannot
establish reliability, calibrate the semantic grader, or complete the full
five-case v4 evaluation. Human review and held-out/repeated trials remain
separate future decisions. The earlier failed v9 trial is not overwritten or
presented as if it passed.

### Distinct damaged-item v10 trial on 2026-10-02

Run `refund-ragas-v4-damaged-v10-20261002-001` used the unchanged v4
`damaged-item-evidence-answer-v1` synthetic case, the same model and evaluator
configuration, one repetition, and no retry. It completed and passed both
blocking checks. The answer said photo evidence is required **before approval**
and stated the general 30-calendar-day policy with a separate unverified-timing
qualification. It also included a final-sale exception not requested by the
customer, so the answer is less focused than desired.

The informational grades were context precision approximately 1.0, context
recall 1.0, faithfulness 0.6667, response relevancy 0.6639, and factual
correctness 0.62. The last three missed the provisional 0.7 thresholds. The
RAGAS grades alone do not identify which individual sentence each judge
penalized; the unrelated final-sale paragraph is a human-observed focus issue,
not a claimed proven cause of every score. One pass does not show consistent
quality or establish a general damaged-item success rate.

Usage measurement was COMPLETE: one answer invocation (5,768 tokens), 11 judge
invocations (28,871), two judge embeddings (86), and one query embedding (14),
totaling **34,739 tokens**. Estimated dollar cost remains unknown. The result
and usage files are private mode 0600 and outside Git:

| File | SHA-256 |
| --- | --- |
| `/private/tmp/cso-ragas-damaged-v10.Qos3SR/result.json` | `671f846b964e8a03af781b53f37fde82543df2502db0cae4430846f184e27d53` |
| `/private/tmp/cso-ragas-damaged-v10.Qos3SR/usage.json` | `a04ab5d409a2bfd4f4a2207165434c32281bcc681226c33291ec5a8c2d7399e2` |

### Incorrect-item evaluator failure on 2026-10-02

The one bounded `incorrect-item-verification-answer-v1` v10 attempt
(`refund-ragas-v4-incorrect-v10-20261002-001`) **did not produce a result or
quality score**. The answer call completed, then a RAGAS faithfulness judge
raised `IncompleteOutputException` because its output reached the configured
4,096-token limit. The evaluator treats this as a fatal system failure. It is
not an agent failure, a pass, or a zero score. No automatic paid retry was run.

The private usage sidecar reported `FAILED`, measurement `COMPLETE`, and
23,413 measured tokens: 4,511 answer, 18,888 judge SDK responses, and 14
query embedding. It recorded six judge responses, including the response
whose structured output was then rejected by RAGAS. Measurement `COMPLETE`
means usage was captured for the instrumented SDK responses, **not** that the
judge produced a valid score or that unobserved transport retries are ruled
out. Dollar cost remains unknown. The mode-0600 sidecar is
`/private/tmp/cso-ragas-incorrect-v10.6JNOLi/usage.json`, SHA-256
`39b1117f799e76b9817a40f9346a9889298d0907abb5a0731ff567e132fbd77b`.
No result file exists. This case needs an explicit evaluator-budget decision
before another paid measurement.

The evaluator now exposes a bounded `--judge-max-tokens` choice (1,024–8,192,
default 4,096) and records it in completed sample versions. Offline tests
verified both the transport request and version evidence; Evaluation Runner
300/300 passed. This configuration change does not retroactively repair the
failed attempt or prove that a larger budget will work. A distinct run is
needed for any new quality measurement.

One deliberate v12 follow-up, `refund-ragas-v4-incorrect-v12-20261002-001`,
used the same synthetic incorrect-item case with an explicitly recorded
8,192-token judge ceiling. It completed and passed the blocking checks. This
single completion shows that this particular judge attempt did not truncate;
it does **not** prove 8,192 is sufficient for every case or that v12 improved
answer quality over v10, which had no scored incorrect-item result.

The answer addressed the published incorrect-item request window and
order/item verification, but was long and repeated unrelated final-sale
exclusions and payment-method information. Informational grades: context
precision approximately 1.0, context recall 1.0, faithfulness 0.8571,
response relevancy **0.5356**, and factual correctness **0.50**. The last two
missed the provisional 0.7 target. The grader scores are observations, not a
sentence-level explanation of which claims caused them. The customer-facing
focus issue is independently visible in the answer.

Usage measurement was COMPLETE: 39,354 tokens, comprising one answer (4,935),
11 judges (34,347), two judge embeddings (58), and one query embedding (14).
Estimated dollar cost is unknown. The private mode-0600 artifacts are:

| File | SHA-256 |
| --- | --- |
| `/private/tmp/cso-ragas-incorrect-v12.NSmFKq/result.json` | `9ee4b19bfeb1aaec70eb65869a144c88a54c1e02d25c5df87ccbc7b0380ebfdb` |
| `/private/tmp/cso-ragas-incorrect-v12.NSmFKq/usage.json` | `4a1c877468563c1356e644383f7f5753319ef79a8f83c1d9e4c1d75c7480720c` |

Do not average v10 and v12 grades as one baseline or call three distinct-case
single trials a full five-case v4 run. No further paid incorrect-item retry was
run in this checkpoint.

### Provider timing and final-sale v12 boundary

The distinct provider-processing case
(`refund-ragas-v4-provider-v12-20261002-001`) completed and passed blocking
checks. Its customer answer was short and conditional: original payment method
after approval, a possible 5–10-business-day bank/provider posting window,
and no settlement-time guarantee. It did not add an unrelated proposed-refund
footer. Informational scores were context precision 0.8333, recall 1.0,
faithfulness 0.8, response relevancy **0.5719** (below provisional 0.7), and
factual correctness 1.0. This is one trial, not a timing reliability claim.
Usage was COMPLETE at 27,318 tokens; dollar cost remains unknown. Its private
mode-0600 result and usage SHA-256 digests are, respectively,
`4fae8273f5a38508e8812ae185fdc1c9ecce37f048d238d3adab5d0d2f7d54b6`
and `1c3d192b63f284ddd0e0c05d71ede274b9cd5c0073cf812dbbe6bd58ef1b0822`
under `/private/tmp/cso-ragas-provider-v12.OMY8Q2/`.

The distinct final-sale exception case
(`refund-ragas-v4-final-v12-20261002-001`) produced a `SYSTEM_ERROR` before
semantic grading. The production answer boundary reported
`DELIVERY_AGE_TEXT_REJECTED`; no answer or citations were retained in the
public result, so this code alone does not prove a false positive or identify
the offending sentence. No judges ran and no paid retry or private rejected
answer capture was attempted. Usage was COMPLETE at 4,863 recorded tokens
(one answer plus query embedding); cost remains unknown. Its private mode-0600
result and usage digests are `4dc64cc523c6ddf6e51cbc03c83816ee7a394d914aa8a54d28a7d39747fc7b96`
and `c011db6350819c854233c71f56e0e631b4cc248ee2ea65a284d196e10b099854`
under `/private/tmp/cso-ragas-final-v12.PMwH30/`.

| V4 seed case | Latest bounded outcome | Version | Interpretation |
| --- | --- | --- | --- |
| Larger-refund review | Blocking pass; relevancy below target | v10 | Exact trusted $750/$500 sentence; not a v12 score |
| Damaged-item evidence | Blocking pass; three semantic minima below target | v10 | Required photo-before-approval rule present; answer over-included a final-sale exception |
| Incorrect-item verification | Blocking pass after earlier unscored judge failure | v12, judge budget 8,192 | Answer overlong; relevancy and factual correctness below target |
| Provider processing | Blocking pass; relevancy below target | v12, judge budget 8,192 | Short conditional timing answer, no proposal footer |
| Final-sale exception | `SYSTEM_ERROR`, no score | v12, judge budget 8,192 | Answer guard rejected output before judges; cause unresolved |

This table is **mixed-version, one-attempt-per-outcome coverage**, not a
same-version five-case baseline or calibrated release gate. The paid campaign
stopped here. The next defensible evaluation work is human review of the
visible answers, a bounded diagnosis of the final-sale rejection if needed,
and an owner-approved same-version repeated/held-out plan; do not present
the four blocking passes as overall agent reliability.

### Current code after independent safety review

An independent read-only review found that the first v10 detector could mix
signals from different questions and overwrite past-status or general-policy
answers with amount-review text. It also missed a common word order. Focused
composer-level negative and positive regressions reproduced both defects;
the detector now evaluates one question clause at a time and recognizes only
future personal approval or personal eligibility wording. A second review
found that v11 still confused automatic *payment return* with approval and
excluded a valid future approval question when it mentioned already-uploaded
evidence or a previously damaged item. The final narrow expression requires
automatic approval itself and limits the past-status exclusion to past
approval. The prompt remains labeled `refund-answer-v12`; the deterministic
post-processing now has its own `answer_presentation` version field
(`refund-answer-presentation-v1`) in new evaluation samples. The historical
v10 and v12 paid artifacts above did **not** record that field, and the v12
trials preceded the final detector refinement. They remain measurements of
their exact historical runs, not a same-version baseline for current code.
Agent Runtime 481/481 and Evaluation Runner 300/300 offline tests plus Ruff
checks passed after version evidence was added. No additional paid trial was
run after the final detector refinement and presentation-version addition.

### 2026-10-02 final-sale diagnosis and prompt v13 checkpoint

A single diagnostic run of `final-sale-exception-answer-v1` on the current v12
prompt again stopped before judging with `DELIVERY_AGE_TEXT_REJECTED`. This
time the rejected synthetic answer was captured privately. It cited the
final-sale exception correctly but also restated the separate 14-day
change-of-mind rule **without its required unopened-item condition**. The
delivery-window guard was right to reject the broadened claim. It was not a
token-expiry or service-availability failure. Run
`refund-ragas-v4-final-current-v12-20261002-001` recorded 4,812 tokens: one
answer call and one query embedding, no judges. The private result, usage and
rejection sidecar are under
`/private/tmp/cso-ragas-final-current.gLhyCi/` with SHA-256 hashes
`536a5c30cf80bd923d957ce50ff8a6f15f4f799d962dba094b7900ed122104ad`,
`c817d7eb331a9f5332dfaee8bcadd8aee4fa205886512c5f51928d15f5e8aa92`,
and `099fdfe19172ab94911ff0ee690f276bf478b0baf274f2c737f4205a311c6d54`,
respectively. All are mode 0600 inside an owner-only temporary directory.

The prompt was narrowed to keep final-sale answers on the exclusion and its
exceptions, and to preserve every condition when a separately requested
delivery window is discussed. This is `refund-answer-v13`. A **single new**
synthetic paid run, `refund-ragas-v4-final-v13-20261002-001`, completed with
one cited final-sale section and passed the configured blocking checks.
However, human inspection found a customer-specific denial (“for your order,
a refund would not be available”) even though the item's final-sale status
was not verified. RAGAS context precision was approximately 1.0, context
recall **0.50**, faithfulness **0.25**, response relevancy 0.7207, and factual
correctness 0.75. The semantic minima were informational for this v4 case, so
the configured `pass_rate=1.0` is **not** a release-quality pass. One trial
cannot establish reliability, and these scores are not directly comparable
to the unscored v12 attempt. Usage was COMPLETE at 30,848 tokens: one answer
(3,368), 11 judges (27,385), two judge embeddings (84), and one query
embedding (11); dollar cost is unknown. Private mode-0600 result and usage
files under `/private/tmp/cso-ragas-final-v13.C4DINh/` have SHA-256 hashes
`758ca89b5a3d34aa418db938a7e1e52b5264816e509ac517e29277ce13b6b8a5`
and `38e649adc1295fa78f4a4a6dae7cb64e84163dbe547dc04d392d1b3ceff5eb2a`.

After that run, a red-first regression reproduced the missed personalized
denial. The production answer guard now rejects that narrow wording and an
item-specific “cannot be refunded” denial without relaxing the general policy
or procedural answer checks. Agent Runtime 570/570 offline tests and Ruff
lint/format passed. Evaluation Runner 316/316 passed after its provenance
expectations were updated to prompt v13. The v13 trial predates this guard
correction; at that checkpoint, **no paid post-guard retry** had run. Its old
`pass_rate` must not be reinterpreted as a measurement of the corrected code.
The later, separate recheck is recorded below.

### One post-guard final-sale recheck on 2026-10-02

One deliberately bounded recheck of the same synthetic final-sale case ran
after the guard correction as
`refund-ragas-v4-final-v13-postguard-20261002-001`. It used prompt v13,
`gpt-5-nano` for the answer and configured judges,
`text-embedding-3-small` for embeddings, and an 8,192-token judge ceiling.
The result is **SYSTEM_ERROR, unscored**: the answer boundary returned
`DELIVERY_AGE_TEXT_REJECTED` before a public answer, citation, or RAGAS judge
was produced. The raw rejected answer was not captured, so this error code
alone cannot establish which sentence caused rejection or whether it was a
true or false positive. It must not be called a quality pass or compared with
the earlier v13 semantic grades. There was no retry, commerce call, or refund.

Usage measurement was COMPLETE with 4,090 recorded tokens: one successful
answer invocation (4,079 tokens), one query embedding (11 tokens), and zero
judge or judge-embedding calls. Cost remains unpriced. Private mode-0600
artifacts are under `/private/tmp/cso-ragas-final-postguard.00oD2X/`:

| File | SHA-256 |
| --- | --- |
| `result.json` | `972c3709158868989328509afcffcaa1ea3203b6af3ceb72a38d7265019b40da` |
| `usage.json` | `8c68f9daa8e204bc008771c213bf31b317cf283399e6abb5a9f0569b27cd9126` |

The final-sale quality gate remains unresolved. Do not start identical paid
retries; a new hypothesis would require safely scoped rejection diagnostics
and human review of the source conditions before another trial.

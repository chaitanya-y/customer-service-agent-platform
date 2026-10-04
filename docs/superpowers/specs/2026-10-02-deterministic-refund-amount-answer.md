# Proposed deterministic refund amount answer

Status: design only; **not implemented**. This is a response-composition
change, not a new refund authorization or payment path.

## Observation

`LangChainRefundAnswerComposer.compose` verifies order/item binding, calls the
model, validates its draft text/citations, and only then selects
`amount_review` and replaces that draft with a trusted policy-catalog answer.
For the reviewed synthetic $750 request, one current-code trial failed at
`DELIVERY_AGE_TEXT_REJECTED` before any answer or RAGAS judge. A diagnostic
retry passed and returned the exact deterministic $750/$500 sentence. The
first raw draft was not captured, so the rejection cannot be labeled a guard
false positive. See [the trial record](../../evaluation/RAGAS_LARGE_REFUND_2026_10_02.md).

The current order is intentionally fail closed, but it makes this narrow
answer depend on model prose that the customer will never see. Prompt examples
could lower the rejection rate but cannot eliminate that dependency. Weakening
the delivery-age guard would have a wider safety impact and is not proposed.

## Candidate boundary

Consider a model-free branch **only** when all conditions hold:

1. The customer question is solely about whether *their proposed refund*
   could be automatically approved. A mixed policy, delivery, order-status,
   or action request must not be silently collapsed to an amount answer.
2. The proposal's order and selected item IDs exactly bind to the
   owner-checked order context, as the composer already requires.
3. The requested amount is a positive, safe USD minor-unit value from the
   validated proposal; scope and required details are present.
4. A `VerifiedRefundPolicy` came from the hash-pinned local policy catalog,
   and its currency matches the proposed amount.

Then render the existing three amount bands directly from the policy catalog,
with no model call, no model draft, no citation, and no eligibility/approval
claim. Above the specialist threshold, say the proposed amount *requires*
specialist review **before** approval is possible. At/below the automatic
limit, say automatic approval is merely possible after other checks. The
branch must not authorize, create, or execute a refund. If any precondition
fails, keep the existing fail-closed/context-required behavior; do not invent
amounts or substitute policy prose for verified catalog values.

## Important tradeoffs

- This removes variable model language and answer-model cost for a genuinely
  deterministic question. It also removes the ability of that specific model
  draft to introduce an unsafe delivery-age or monetary statement; it does
  **not** weaken guards on paths that still use the model.
- The intent detector must be stricter than today's broad clause detector for
  a pre-model short-circuit. Otherwise a mixed request could lose a second
  question or an urgent human-service concern. Ambiguous mixed intent should
  clarify or use the normal governed path.
- The current tests intentionally assert that unsafe raw model text is
  rejected even when `amount_review` ultimately replaces it. Those tests
  should continue covering model-backed routes; new tests should prove the
  exact model-free route never constructs/invokes a model draft.
- Telemetry and evaluation must distinguish `deterministic_amount_review`
  from `refund-answer-v13` generation. A new presentation/routing version
  and immutable evaluation fixture are preferable to rewriting the frozen
  v4 measurements. Zero answer-model tokens must be represented honestly.
- Human calibration, repeated held-out trials, and end-to-end auth/provider
  tests remain necessary. One passing synthetic answer is not reliability.

## Verification required before enablement

Use test-driven implementation. Cover all three policy bands, exact
thresholds, missing/invalid money, stale or mismatched catalog binding,
missing details, item/order mismatch, and mixed/past-status wording. Assert
no model invocation, no refund/cancellation tool, exact public answer shape,
and version/usage evidence on the deterministic branch. Keep the existing
model-backed guard tests. Run Agent Runtime and Evaluation Runner full suites,
then one reviewed synthetic trial and a separate authenticated local read.
Do not perform a live refund as part of answer verification.

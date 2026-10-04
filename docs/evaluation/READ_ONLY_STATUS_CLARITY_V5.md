# Read-only status clarity, synthetic v5

The six-case `read-only-support-v5.json` dataset evaluates two narrow customer
answer risks: an order-level refund aggregate must not be presented as the
outcome of a particular attempt, and tracking codes must stay paired with
their own fulfillment. It also checks ordinary concise refund wording and
fail-closed handling of a control character in provider tracking data.

The fixture runs the real Agent Runtime read-only specialists against synthetic
owned-order projections. The fake records exact tool names and arguments; no
network, model, provider mutation, Temporal workflow, or refund is involved.
The blocking graders compare required/forbidden answer fragments and the
reviewed trace. Two repetitions must agree. This is a regression check for
deterministic specialist behavior, **not** proof of owner authentication,
Vendure truth, carrier delivery, or model reliability.

On 2026-10-02, the v5 test passed 12/12 trials across six cases. The full
Evaluation Runner suite passed 313 tests. The older v2 fixture is intentionally
unchanged: its `failed-refund` case still expects “failed,” whereas the current
Gateway projection combines failed and cancelled provider attempts. The v2
runner test now records exactly that two-trial historical drift while requiring
every other v2 case to pass. The current wording is graded in v5, not silently
rewritten into the older version.

Run offline from `apps/services/evaluation-runner`:

```bash
uv run --no-sync pytest -q tests/test_read_only_status_clarity_v5.py
uv run --no-sync pytest -q
```

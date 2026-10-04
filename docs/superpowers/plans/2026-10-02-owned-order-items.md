# Owned-order items chat implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer an authenticated customer's question about the names and quantities in an owned order inside the existing support chat, without starting a refund.

**Architecture:** Gateway owns the order-ownership check and emits a minimal item projection. Agent Runtime validates that projection and formats a bounded deterministic answer. Edge strictly accepts the new read-only response variant and persists it without creating a Temporal workflow.

**Tech Stack:** TypeScript, Zod, MCP, FastAPI/Pydantic, JSON Schema, Node test runner, pytest.

**Spec:** `docs/superpowers/specs/2026-10-02-owned-order-items-design.md`

## Global constraints

- Work only in this repository; preserve all pre-existing dirty files and secrets.
- The existing Gateway owner check precedes the projection. Do not send full order context, payment fields, prices, or internal IDs to the read-only specialist.
- Use the canonical v1 wire fields from the spec exactly. Reject, never truncate, invalid or oversized source data.
- A read-only answer never opens Temporal or executes commerce actions.
- Write a failing behavior test before each production change; no live refund or settlement.
- Workers use distinct file ownership; the coordinator alone integrates and handles Git.

## Review focus

1. Another customer's order and an unknown order must have indistinguishable customer output: Gateway and specialist tests.
2. A current turn containing two references must not silently fall back to an older reference: specialist test.
3. A previous refund turn must not turn a later item question into a refund: classifier/router test.
4. Provider items exceeding the count, name, or quantity bound must not produce a partial answer: Gateway and specialist tests.
5. A forged or malformed `order_items` result must not cause Edge to start a workflow: Edge test.

---

### Task 1: Customer-safe Gateway contract and tool

**Files:** Create `contracts/tools/order-items/v1/order-items.schema.json`, `apps/services/integration-gateway/src/order-items.ts`, `apps/services/integration-gateway/tests/order-items.test.ts`, and `tests/contract/order-items-contract.test.mjs`; modify `apps/services/integration-gateway/src/mcp-server.ts` and its test.

**Interfaces:** `toOrderItems(order: OwnedOrderContext): {schemaVersion:'1'; reference:string; items:{name:string; quantity:number}[]}`. MCP tool name `lookup_order_items`, input `{orderReference:string}`. Output is the exact spec object or the existing `context_unauthorized`, `order_not_found`, `commerce_provider_unavailable` error shapes.

- [x] Write tests first: owner mismatch and absent order get the same not-found shape; valid projection has only names/quantities; invalid counts/names/quantities fail closed; extra fields fail schema.
- [x] Run focused tests and confirm the expected missing-tool/projection/schema failure.
- [x] Add the minimal projection, strict schema, and owner-checked MCP tool.
- [x] Run Gateway and contract suites; 83 Gateway and 105 contract tests passed.

### Task 2: Agent Runtime read-only item specialist

**Files:** Modify `apps/services/agent-runtime/agent_runtime/integrations/order_lookup.py`, `apps/services/agent-runtime/agent_runtime/support/classifier.py`, `apps/services/agent-runtime/agent_runtime/support/schemas.py`, and `apps/services/agent-runtime/agent_runtime/support/router.py`; create `apps/services/agent-runtime/agent_runtime/support/order_items.py` and tests `tests/test_support_order_items.py` under the same service; extend classifier/router tests there.

**Interfaces:** `OrderItems` validates the exact v1 projection; `McpOrderLookupClient.lookup_order_items(order_reference: str) -> OrderItems`; `answer_order_items(request: SupportIntakeRequest, order_lookup: OrderItemsLookup) -> ReadOnlySupportResponse`; route `order_items` with the three statuses in the spec.

- [x] Write tests first for owned-item answer, missing/ambiguous reference, not-found masking, provider failure/malformed bounds, overlong formatted text, previous-refund/current-items isolation, and mixed current-turn clarification.
- [x] Run focused tests and confirm expected missing feature failures.
- [x] Add only the new read-only model/client/specialist/route, retaining existing refund guard behavior.
- [x] Run the full Agent Runtime suite (354 passed) and Ruff. No Python type checker is configured for this service.

### Task 3: Edge contract, no-workflow gate, and documentation

**Files:** Modify `contracts/ai-io/support-intake/v1/support-intake-response.schema.json`, `apps/services/edge-api/src/support-response.ts`, `apps/services/edge-api/tests/support-response.test.ts`, `apps/services/edge-api/tests/support-journeys.test.ts`, `tests/contract/json-contracts.test.mjs`, and `docs/READ_ONLY_SUPPORT_JOURNEYS.md`.

**Interfaces:** `journey='order_items'` with `status` in `answer_ready | awaiting_order_reference | source_unavailable` and `{customer_answer:{message:string}}`, no extra keys. `getReadyRefundProposal` remains null for this variant.

- [x] Write failing tests for accepted strict variant, rejected proposal/extra fields, persisted response, and zero Temporal starts.
- [x] Run focused tests and confirm expected validation failures.
- [x] Add the schema and Edge parser variant; update journey documentation with truthful verification status.
- [x] Run Edge (101 passed), contract (105 passed), and frontend type checks.

### Task 4: Offline evaluation coverage

**Files:** Modify `apps/services/evaluation-runner/evaluation_runner/adapters/read_only_support.py`, `apps/services/evaluation-runner/evaluation_runner/read_only_graders.py`, `apps/services/evaluation-runner/fixtures/evaluation-datasets/read-only-support-v1.json`, `apps/services/evaluation-runner/tests/test_read_only_support_evaluation.py`, and `apps/services/evaluation-runner/README.md`.

**Interfaces:** The adapter invokes the real `answer_order_items` specialist with a synthetic `lookup_order_items` dependency; the trace names that tool. The grader accepts `order_items` as read-only but still rejects proposals and forbidden answer fragments.

- [x] Write failing tests for three owned-order-items cases: successful names/quantities, identical not-found/non-owner wording, and no private payment/ID/price fields in the answer.
- [x] Run focused tests and confirm the expected unsupported-journey failure.
- [x] Extend the adapter, grader and reviewed dataset minimally; update case/trial counts and the evaluation README. A review strengthened the private-field fixture with nested SKU/unit price.
- [x] Run evaluation tests: 281 passed offline, with no network or paid model calls.

### Integration gate

- [x] Review each file diff and ensure no worker overwrote another's changes.
- [x] Run cross-service Gateway, Agent Runtime, Edge, contract, evaluation, and customer frontend checks using repository-supported runtimes. Counts: 83, 354, 101, 105, 281, respectively; all three relevant TypeScript checks passed.
- [x] Run `git diff --check`; no whitespace errors. Repository-wide evaluation formatter reports three unrelated pre-existing files, so changed-file formatting is checked separately.
- [x] Perform one bounded read-only live API smoke: HTTP 202, owned item answer persisted, zero workflow links; no refund action. This was backend API proof, not browser proof.
- [x] Update the progress record and check account usage. It was 29% used at the last check, below the agreed 85% stop point.

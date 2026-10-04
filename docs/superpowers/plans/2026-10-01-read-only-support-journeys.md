# Read-Only Support Journeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add product and policy answers and owned-order status answers to the existing authenticated chat without sending those turns through refund intake or starting a refund workflow.

**Architecture:** Edge keeps authenticating and persisting every turn, but sends chat turns to a new Agent Runtime `/support/intake` endpoint. A typed router chooses exactly one journey and passes only its permitted read-only clients to the selected specialist; the existing refund graph is invoked in-process only for an explicit refund action. Edge accepts a discriminated response and starts Temporal only when the `refund` variant contains a valid ready proposal.

**Tech Stack:** FastAPI, Pydantic, LangChain structured output, Fastify, Zod, MCP, Vendure Shop API, JSON Schema, Python pytest, Node test runner, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-30-read-only-support-journeys-design.md`

## Global Constraints

- Keep `/support` and Conversation Runtime's persisted text-message format; no UI redesign or database migration.
- Journeys are exactly `refund`, `order_status`, `product_policy`, `clarify`; new status values are `answer_ready`, `awaiting_order_reference`, `awaiting_product`, `source_unavailable`, and `clarification_required` for clarify. Existing refund statuses remain unchanged.
- Product and policy and order status turns must never use refund intake, construct a refund proposal, start Temporal, open Human Operations, or mutate commerce.
- Only an explicit current-turn refund action can enter the existing refund graph. Refund-policy information routes to `product_policy`; ambiguous or mixed intent routes to `clarify`.
- `lookup_order` must remain indistinguishable for nonexistent and other-customer orders. No internal IDs, payment data, unsupported carrier events, URL, or ETA in customer answers.
- Knowledge/RAG retains server-owned tenant, environment, release, locale, effective-time, and `CUSTOMER_SAFE` filters; the answer cites readable title and section, never internal URI.
- Catalog search is bounded to five published, enabled products in the authorized tenant/channel; absent channel mapping fails closed. Claims about price, stock, or effects require authoritative source facts.
- All three audience-specific assertions are checked before routing or retrieval. Customer-supplied identity and tenant fields are ignored.
- Synthetic/fake tests only. No paid OpenAI call, live refund action, secret edit, server restart, push, or merge without separate authorization.
- Preserve the unrelated `pnpm-lock.yaml`, `tools/simulators/commerce-sandbox/src/vendure-config.ts`, and `.superpowers/` local changes. Commit messages use plain words without a hyphen separator.

## Review Focus

1. A status question following a refund turn must not inherit refund intent: Task 5 tests that the current turn routes to `order_status` and Task 6 tests no workflow start.
2. A customer naming two order references must not get one guessed: Task 2 tests `awaiting_order_reference` without a lookup.
3. A product name that matches several catalog products must not silently choose one: Task 4 tests `awaiting_product` with no asserted price.
4. Retrieved text that says to ignore instructions must not control the answer: Task 4 tests source text is treated as data and unsupported claims are rejected.
5. A missing tenant-to-channel mapping must not fall back to a default catalog: Task 3 tests a closed, source-unavailable result without a Vendure request.

## File and ownership map

- Coordinator owns shared response/request contracts, `apps/services/agent-runtime/agent_runtime/support/router.py`, `main.py`, Edge client and chat route, integration tests, and final verification.
- Order-status worker owns only `apps/services/agent-runtime/agent_runtime/support/order_status.py` and `tests/test_support_order_status.py`. It consumes the existing `McpOrderLookupClient` interface; it does not edit refund code.
- Catalog worker owns only `apps/services/integration-gateway/src/product-catalog.ts`, `vendure-catalog-client.ts`, `tests/product-catalog.test.ts`, and `tests/vendure-catalog-client.test.ts`. Coordinator wires it into existing Gateway files after the worker finishes.
- Product/policy worker owns only `apps/services/agent-runtime/agent_runtime/support/product_policy.py`, `integrations/product_catalog.py`, and their focused tests. It consumes the contract and Gateway tool produced earlier; it does not edit router or Edge files.
- Start with coordinator plus one worker. Add a second worker only after the shared contracts are fixed and its files are independent, per `docs/MULTI_AGENT_WORKING_AGREEMENT.md`. Use Terra medium for narrow typed integration and Sol high only for the trust-boundary review if necessary; do not use a high-cost model by default. No simultaneous edits to the same file.

---

### Task 1: Lock the two versioned wire contracts

**Files:**
- Create: `contracts/ai-io/support-intake/v1/support-intake-response.schema.json`
- Create: `contracts/tools/product-catalog/v1/product-catalog.schema.json`
- Create: `tests/contract/fixtures/support-intake/valid.json`, `tests/contract/fixtures/support-intake/invalid.json`
- Create: `tests/contract/fixtures/product-catalog/valid.json`, `tests/contract/fixtures/product-catalog/invalid.json`
- Modify: `tests/contract/json-contracts.test.mjs`
- Create: `apps/services/agent-runtime/agent_runtime/support/schemas.py`
- Create: `apps/services/agent-runtime/tests/test_support_schemas.py`

**Interfaces:**
- Produces support response v1: `{journey, status, customer_answer?: {message}, refund_proposal?: ...}`. Preserve existing refund response fields and allow `refund_proposal` on refund variants, requiring it for `status: "refund_proposal_ready"`; `order_status`, `product_policy`, and `clarify` never expose it. Edge starts Temporal only for a validated refund-ready proposal.
- Produces catalog result v1: `{schemaVersion: 1, matches: ProductMatch[]}`; `ProductMatch` has public `name`, `description`, `variants: [{name, price: {amountMinor, currency}?}]`, and optional authoritative `availability`. No Vendure/customer/internal IDs. `matches.length <= 5`.
- Produces `ReadOnlySupportResponse` in `support/schemas.py`: Pydantic discriminated read-only journey/status with required `CustomerAnswer` and forbidden `refund_proposal`. `SupportIntakeRequest` aliases the bounded `RefundIntakeRequest` fields. Tasks 2, 4, and 5 import this model rather than defining their own.

- [ ] **Step 1: Add fixtures and contract tests that fail.** Add `supportIntake rejects a proposal on a read-only journey` (`validate({journey: "order_status", refund_proposal: {...}}) === false`) and `productCatalog rejects excess and internal data` (six matches and `sourceId` each validate false); the two valid fixtures validate true.
- [ ] **Step 2: Run `pnpm test:contracts`.** Expected: failure because the new schemas are absent.
- [ ] **Step 3: Add strict JSON Schemas and Pydantic models for the discriminated response and public catalog projection.** Match the exact journeys/statuses and conditional proposal rule above; retain existing refund proposal schema by reference if useful. Test Pydantic rejects extra proposal data on read-only variants.
- [ ] **Step 4: Run `pnpm test:contracts`.** Expected: all contract cases pass, including prior contracts.
- [ ] **Step 5: Commit only Task 1 files with message `Define support and product catalog contracts`.

### Task 2: Implement the owned-order status specialist

**Files:**
- Create: `apps/services/agent-runtime/agent_runtime/support/order_status.py`
- Create: `apps/services/agent-runtime/tests/test_support_order_status.py`

**Interfaces:**
- Consumes `McpOrderLookupClient.lookup_order(order_reference: str) -> OrderContext` from `integrations/order_lookup.py` and the bounded customer history from `RefundIntakeRequest`.
- Produces `async answer_order_status(request: SupportIntakeRequest, order_lookup: OrderLookup) -> ReadOnlySupportResponse` using the Task 1 Pydantic model.

- [ ] **Step 1: Write focused failing tests.** `test_order_status_requires_one_reference` asserts missing/two references yield `awaiting_order_reference` and zero lookup calls; `test_order_status_uses_latest_unambiguous_reference` asserts the selected lookup argument; `test_order_status_tracks_only_known_fields` asserts reference/state/fulfillment/tracking when present and no ETA, payment, or internal ID; `test_order_status_masks_missing_or_other_customer` asserts identical messages; `test_order_status_fails_closed` covers unauthorized, outage, and malformed facts.
- [ ] **Step 2: Run `cd apps/services/agent-runtime && uv run pytest tests/test_support_order_status.py -q`.** Expected: red because the specialist is not implemented.
- [ ] **Step 3: Implement `answer_order_status` using only the existing lookup client and a bounded customer-safe formatter.** Never include source/provider IDs, customer contact data, payment information, or a fabricated ETA.
- [ ] **Step 4: Run the focused pytest command again.** Expected: pass.
- [ ] **Step 5: Commit only the two Task 2 files with message `Add owned order status answers`.

### Task 3: Implement channel-bound read-only product lookup in Gateway

**Files:**
- Create: `apps/services/integration-gateway/src/product-catalog.ts`
- Create: `apps/services/integration-gateway/src/vendure-catalog-client.ts`
- Create: `apps/services/integration-gateway/tests/product-catalog.test.ts`
- Create: `apps/services/integration-gateway/tests/vendure-catalog-client.test.ts`
- Modify (coordinator after worker): `apps/services/integration-gateway/src/config.ts`, `server.ts`, `app.ts`, `mcp-routes.ts`, `mcp-server.ts`
- Test (coordinator): `apps/services/integration-gateway/tests/mcp.test.ts`, `config.test.ts`

**Interfaces:**
- Produces `searchPublishedProducts(query: string, limit: number): Promise<ProductCatalogResult>` in `vendure-catalog-client.ts`, with `ProductCatalogResult` conforming to Task 1 schema and `limit <= 5`.
- Produces `createGetProductCatalog({ catalogClient, expectedTenantId, channelToken }): (query: string, accessContext: TrustedAccessContext) => Promise<ProductCatalogResult>` in `product-catalog.ts`. Missing/mismatched tenant or channel mapping fails closed.
- Exposes MCP tool `lookup_product_catalog` with input `{query: string}`; Gateway obtains identity from verified assertion, not tool arguments. It has read-only annotations and returns the canonical result or a stable unavailable error.

- [ ] **Step 1: Write failing catalog tests.** `catalog bounds public matches` asserts `matches.length <= 5` and no unpublished/disabled/internal fields; `catalog rejects unbound tenant` asserts a missing/mismatched channel mapping makes zero fake `fetch` calls; `shop client sends scoped token` asserts the channel token reaches only the configured Shop API and the query is bounded. No live Vendure.
- [ ] **Step 2: Run `pnpm --filter @customer-service-os/integration-gateway test`.** Expected: focused new cases fail.
- [ ] **Step 3: Implement the pure projection and Vendure Shop API client.** Use a configured Shop API URL and channel token bound to the service's fixed `TENANT_ID`; do not reuse the Admin API response directly. Return only facts the Shop API verifies. An absent catalog configuration must leave existing refund startup working but make catalog lookup unavailable.
- [ ] **Step 4: Coordinator wires config and MCP registration, then tests signed-context rejection, tenant mismatch, unavailable catalog, and a valid read-only result.** Add nonsecret config names to `.env.example` only; do not edit `.env`.
- [ ] **Step 5: Run `pnpm --filter @customer-service-os/integration-gateway test` and `pnpm --filter @customer-service-os/integration-gateway typecheck`.** Expected: pass; `lookup_order` regression unchanged.
- [ ] **Step 6: Commit only Task 3 files with message `Add tenant scoped product catalog lookup`.

### Task 4: Implement product and policy specialist

**Files:**
- Create: `apps/services/agent-runtime/agent_runtime/support/product_policy.py`
- Create: `apps/services/agent-runtime/agent_runtime/integrations/product_catalog.py`
- Create: `apps/services/agent-runtime/tests/test_support_product_policy.py`
- Create: `apps/services/agent-runtime/tests/test_product_catalog_lookup.py`

**Interfaces:**
- Consumes `KnowledgeRagCustomerEvidenceClient.retrieve_customer_evidence(query_text: str)` and MCP `lookup_product_catalog(query)` with Task 1 result schema.
- Produces `async answer_product_policy(request: SupportIntakeRequest, evidence_client: CustomerEvidenceLookup, catalog_client: ProductCatalogLookup, answer_model: StructuredAnswerModel) -> ReadOnlySupportResponse` using the Task 1 model. The model receives only retrieved customer-safe evidence and public catalog facts; output is schema-validated and checked against those facts.

- [ ] **Step 1: Write failing tests with fake retrieval/catalog/model clients.** `test_policy_answer_cites_readable_source` asserts title/section are present and URI absent; `test_policy_abstains_without_relevant_evidence` asserts `source_unavailable` and no client-selected classification; `test_product_requires_one_match` asserts zero/multiple matches yield `awaiting_product`; `test_product_uses_only_public_facts` asserts only verified variant/price/availability; `test_combined_question_requires_both_sources` asserts source support for both; `test_source_prompt_injection_is_ignored` asserts no unauthorized claim or routing change.
- [ ] **Step 2: Run `cd apps/services/agent-runtime && uv run pytest tests/test_support_product_policy.py tests/test_product_catalog_lookup.py -q`.** Expected: red.
- [ ] **Step 3: Implement the MCP client and specialist.** Use the existing signed Gateway assertion; return a short answer with human-readable citation. Treat tool and evidence text as untrusted data, and fail closed on malformed model output or unsupported claims.
- [ ] **Step 4: Run the focused pytest command again and `cd apps/services/agent-runtime && uv run ruff check agent_runtime/integrations/product_catalog.py agent_runtime/support/product_policy.py`.** Expected: pass.
- [ ] **Step 5: Commit only Task 4 files with message `Add grounded product and policy answers`.

### Task 5: Add typed support routing without changing refund behavior

**Files:**
- Create: `apps/services/agent-runtime/agent_runtime/support/classifier.py`, `router.py`
- Create: `apps/services/agent-runtime/tests/test_support_classifier.py`, `test_support_api.py`
- Modify: `apps/services/agent-runtime/agent_runtime/main.py`, `refund/router.py` (extract a reusable in-process refund function while preserving `/refunds/intake` behavior)
- Test: `apps/services/agent-runtime/tests/test_refund_api.py`

**Interfaces:**
- `SupportIntakeRequest` and `ReadOnlySupportResponse` come from Task 1's `support/schemas.py`.
- `SupportRouteDecision(journey: Literal["refund","order_status","product_policy","clarify"], order_reference: str | None, product_query: str | None)` is structured and validated. `classify_support_journey(request: SupportIntakeRequest) -> SupportRouteDecision` reads only current turn plus bounded history and cannot dispatch refund from history alone.
- `/support/intake` returns the Task 1 read-only model, a clarify response, or the existing `RefundIntakeResponse`; serialization matches Task 1 contract.

- [ ] **Step 1: Write failing classifier and API tests.** `test_route_current_turn_only` asserts status-after-refund routes `order_status`, policy and product route `product_policy`, explicit current-turn refund routes `refund`, and ambiguous/mixed routes `clarify`; `test_support_rejects_bad_assertions_before_tools` asserts 401 and zero classifier/tool calls for missing/invalid assertions; `test_dispatch_is_tool_bounded` asserts each fake specialist is called only on its selected journey.
- [ ] **Step 2: Run `cd apps/services/agent-runtime && uv run pytest tests/test_support_classifier.py tests/test_support_api.py -q`.** Expected: red.
- [ ] **Step 3: Add the typed classifier, response models, and `/support/intake` route.** Reuse the existing configured model infrastructure for structured routing, with an explicit current-turn refund-action guard. Extract existing refund graph invocation into an in-process function shared by the old and new endpoints; do not make an HTTP self-call or modify refund semantics.
- [ ] **Step 4: Run `cd apps/services/agent-runtime && uv run pytest tests/test_support_classifier.py tests/test_support_api.py tests/test_refund_api.py -q` and `uv run ruff check agent_runtime/support agent_runtime/refund/router.py`.** Expected: pass, including assertion failure and refund regression tests.
- [ ] **Step 5: Commit only Task 5 files with message `Route support turns to isolated journeys`.

### Task 6: Switch authenticated chat to the support contract

**Files:**
- Create: `apps/services/edge-api/src/support-response.ts`
- Modify: `apps/services/edge-api/src/agent-runtime-client.ts`, `server.ts`, `app.ts`
- Test: `apps/services/edge-api/tests/agent-runtime-client.test.ts`, `app.test.ts`, `customer-conversation-context.test.ts`

**Interfaces:**
- `intakeSupport(request, assertions): Promise<AgentRuntimeResponse>` posts to `/support/intake`; retain `intakeRefund` for the legacy direct refund endpoint.
- `parseSupportResponse(body): SupportResponse` enforces Task 1's discriminated statuses and rejects a `refund_proposal` on any read-only variant. `getReadyRefundProposal(response): RefundProposal | null` returns a proposal only for a validated `journey: "refund", status: "refund_proposal_ready"` response.

- [ ] **Step 1: Write failing tests.** `read-only chat answer persists without workflow` asserts text append, zero start/link calls for product-policy/order-status/clarify; `ready refund starts one workflow` asserts one start/link; `read-only proposal is rejected` asserts a forged `order_status` proposal never starts Temporal; `direct refund intake stays compatible` covers the legacy endpoint; `status after refund stays read-only` covers turn isolation.
- [ ] **Step 2: Run `pnpm --filter @customer-service-os/edge-api test`.** Expected: new cases fail.
- [ ] **Step 3: Implement support client, parser and chat-route switch.** Keep the existing authentication, assertion signing, idempotent message persistence, and conversation API shape. Do not change the customer UI.
- [ ] **Step 4: Run `pnpm --filter @customer-service-os/edge-api test` and `pnpm --filter @customer-service-os/edge-api typecheck`.** Expected: pass.
- [ ] **Step 5: Commit only Task 6 files with message `Connect chat to read only support journeys`.

### Task 7: Offline integration gate and handoff

**Files:**
- Modify: `docs/LOCAL_REFUND_RUNBOOK.md` only if it describes the shared chat route; otherwise add `docs/READ_ONLY_SUPPORT_JOURNEYS.md`
- Modify: relevant `.env.example` for optional Shop API/channel configuration
- Test: `apps/services/edge-api/tests/support-journeys.test.ts`
- Test: contract, Gateway, Agent Runtime, Edge, and existing refund regression suites

**Interfaces:** No new runtime interface.

- [ ] **Step 1: Add an offline Edge scenario with fake Agent Runtime responses in `support-journeys.test.ts`:** customer asks order status, then policy, then explicit refund; assert only the last result starts and links Temporal. Agent Runtime dispatch-to-refund is pinned separately by Task 5 tests. Include request/trace correlation checks without raw message or order-reference telemetry.
- [ ] **Step 2: Run contract tests, focused and full service tests, Ruff, TypeScript typechecks, and builds.** Record exact commands/results and fix only regressions caused by this feature.
- [ ] **Step 3: Document local configuration, source limits, safe failure behavior, and a browser smoke checklist.** Explain that live model calls require separate approval and Vendure Shop catalog must be configured to answer product questions; do not publish a policy or update local secrets.
- [ ] **Step 4: Review `git diff --check` and `git status`.** Preserve unrelated changes; commit only feature files with message `Verify read only support journeys`. Do not push or merge unless asked.

## Execution sequence and review gates

1. Coordinator completes Task 1, locking contracts. Then the order-status and catalog workers may run in parallel with exclusive paths; coordinator continues isolated router planning and reviews their changes.
2. Product/policy worker starts after the catalog contract is fixed. Coordinator integrates Tasks 3–5, then Edge Task 6. Review each deliverable before dependent changes; no simultaneous edits to shared files.
3. Finish Task 7 offline before any browser or paid-model smoke. A final reviewer checks trust boundaries, cross-tenant behavior, and the no-Temporal guarantee. Report limitations rather than implying a live journey has been verified.

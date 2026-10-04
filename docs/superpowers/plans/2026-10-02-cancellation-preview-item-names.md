# Cancellation Preview Item Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show trusted item names in zero-total cancellation previews without changing authorization or breaking older Temporal histories.

**Architecture:** Gateway decorates its already owner-checked cancellation facts by an exact order-line ID join. The worker treats names as optional display metadata across history replay and ignores them in post-confirmation fact equality. Edge and Portal project/render the name, with a legacy ID fallback.

**Tech Stack:** Fastify, TypeScript, Zod, Temporal, Next.js, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-02-cancellation-preview-item-names.md`

## Global Constraints

- No new commerce mutation or policy rule; only the existing zero-total flow.
- `displayName` is never an authorization key or provider digest input.
- New Gateway facts require an exact, unique, valid name join; old workflow history may omit names.
- Do not expose secrets or touch the excluded storefront.
- Keep all existing dirty local work; do not commit, push, or merge this batch. A later owner-requested clean Git pass can isolate it.

## Review Focus

- Duplicate commerce item IDs must not select one arbitrary name; Task 1 rejects them.
- A line with no corresponding order item must not display a guessed name; Task 1 rejects it.
- An order item name with whitespace-only, Unicode control/format characters, or no letter/number must not reach UI; Tasks 1–4 reject it.
- A name-only catalog change after preview must not authorize or block a cancellation by itself; Task 2 tests it.
- An old Temporal preview without names must remain readable and not render a blank line; Tasks 3 and 4 test it.

---

### Task 1: Gateway trusted line-name join

**Files:** Modify `apps/services/integration-gateway/src/zero-total-cancellation-routes.ts`; test `apps/services/integration-gateway/tests/zero-total-cancellation-routes.test.ts`.

**Interfaces:** Consumes `CommerceOrder.items[].{id,name}` and provider `facts.lines[].id`; produces `facts.lines[].displayName: string` for every newly successful facts response. No name goes into the execute request.

- [x] Add route tests for exact named line, missing ID, duplicate order ID, blank/control/oversized name. Verify ownership failure still hides facts.
- [x] Run focused test; verify the new assertions fail for the missing projection.
- [x] Add one exact-ID decoration helper with a maximum 300-character trimmed printable name. Return the existing generic provider-unavailable response for invalid joins.
- [x] Run focused and full Gateway suites, typecheck, and build; verify all pass (344/344).

### Task 2: Worker display metadata without authorization coupling

**Files:** Modify `apps/services/workflow-workers/src/zero-total-cancellation-activities.ts`, `zero-total-cancellation-client.ts`, `zero-total-cancellation-workflow.ts`; test relevant `apps/services/workflow-workers/tests/zero-total-cancellation-*.test.ts`.

**Interfaces:** Consumes Gateway's optional-on-replay `displayName`; produces `ZeroTotalCancellationPreview.lines[].displayName?: string`. `samePreviewFacts` compares only stable ID/current/original quantity fields plus existing order/digest/amount facts.

- [x] Add tests for name propagation, legacy missing-name facts, and a name-only change that leaves stable facts equal at confirmation.
- [x] Run focused tests; verify new expectations fail for missing name propagation or name-coupled equality.
- [x] Extend the schema/type with optional display metadata and compare authorization line fields explicitly instead of `JSON.stringify` of entire line objects.
- [x] Run focused and full Worker suites, typecheck, and build; verify all pass (110/110).

### Task 3: Edge customer-safe preview projection

**Files:** Modify `apps/services/edge-api/src/cancellation-routes.ts`; test `apps/services/edge-api/tests/cancellation-routes.test.ts`.

**Interfaces:** Consumes Worker preview line `displayName?: string`; produces `preview.lines[].display_name?: string`, while preserving existing `item_id` and `quantity` and stripping internal order/digest fields.

- [x] Add route tests for a named preview, a legacy nameless preview, and invalid name rejection.
- [x] Run focused test; verify the named projection assertion fails.
- [x] Extend the preview schema and projection with bounded optional names, never passing arbitrary extra fields.
- [x] Run focused and full Edge suites and typecheck; verify all pass (167/167).

### Task 4: Portal customer display

**Files:** Modify `apps/web/customer-portal/components/cancellation-api.ts`, `cancellation-journey.tsx`; test `apps/web/customer-portal/tests/cancellation-api.test.mjs`, `cancellation-view.test.mjs`.

**Interfaces:** Consumes `preview.lines[].display_name?: string`; renders name and original quantity, or clearly labeled item ID for legacy data. Confirmation still sends only preview ID and acceptance.

- [x] Add parser/render tests for named and legacy lines; reject malformed/oversized names.
- [x] Run focused tests; verify the named-line expectation fails.
- [x] Extend the parser and line view without changing confirmation payload.
- [x] Run focused and full Portal suites, typecheck, and production build; verify all pass (151/151).

### Task 5: Integrated verification and record

**Files:** Modify `docs/ZERO_TOTAL_CANCELLATION_JOURNEY.md`, `docs/VERIFICATION_STATUS.md`.

- [x] Run canonical contract tests (111/111) and `git diff --check`; verify green.
- [x] Have one independent reviewer inspect name trust boundary, Temporal compatibility, and unchanged authorization inputs. Fixed the reviewer's Unicode display-name finding with red-green tests at all four boundaries.
- [x] Record tests and the explicit limitation that no live cancellation/browser walkthrough was run.
- [x] Leave changes uncommitted in the existing dirty tree; report this as a deliberate Git safety decision.

Review residual: current-worker tests exercise nameless facts and previews, but no captured pre-change Temporal history fixture was replayed. A production rollout needs that additional replay proof if old open workflows exist.

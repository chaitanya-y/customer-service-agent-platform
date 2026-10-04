# Workflow Worker Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the compiled Temporal Workflow Worker can be packaged with production dependencies without launching business workflows.

**Architecture:** A pinned Node 24 multi-stage image builds only Workflow Workers and its two local runtime packages. A local opt-in proof stages an explicit source allowlist, builds the image, and checks the compiled JavaScript workflow bundle and runtime imports inside an offline, unprivileged container. No Temporal server, commerce action, or AWS resource is involved.

**Tech Stack:** Node 24, pnpm 11.9.0, TypeScript, Temporal TypeScript SDK, Docker Desktop.

**Spec:** [AWS deployment readiness](../../AWS_DEPLOYMENT_READINESS.md), especially the Worker compiled-entrypoint prerequisite.

## Global Constraints

- Preserve local development's `.ts` workflow path while the compiled runtime selects `.js`.
- Do not include `.env`, other apps, tests, TypeScript source, credentials, or development dependencies in the runtime image.
- The proof must default to no Docker action and never connect to Temporal, PostgreSQL, Vendure, the model provider, or AWS.
- Stage a reviewed context under 2 MB; legacy Docker must never receive the repository root.
- The output is a local packaging proof only, not deployment readiness or workflow replay evidence.

## Review Focus

1. A compiled Worker that still resolves `.ts` must fail the bundle audit; Task 2 pins the emitted `.js` path.
2. A missing policy catalog must fail image audit; Task 2 pins both v1 and v2 bindings.
3. Missing native Temporal runtime packages must fail image audit; Task 2 imports and bundles with the real SDK.
4. A `.env` or unrelated app in build context must fail the staging test; Task 1 pins the allowlist.
5. Default proof invocation must not call Docker; Task 1 pins no-write behavior.

---

### Task 1: Allowlisted build context and recipe

**Files:** Create `infrastructure/images/workflow-workers/Dockerfile`, `infrastructure/images/workflow-workers/Dockerfile.dockerignore`, `tools/local/verify-workflow-container.mjs`, and `tools/local/tests/verify-workflow-container.test.mjs`.

**Interfaces:** Export `stageWorkflowBuildContext(): Promise<{path: string; fileCount: number; sizeBytes: number; cleanup: () => Promise<void>}>` from the proof script. Inputs are root manifests/lockfile, Workflow package/tsconfig/`src/**/*.ts`, observability package/index, and refund-policy index/types/catalog only. The Docker runtime command is `node dist/server.js` under non-root `node`.

- [ ] Write a failing staging test for exact allowlisted inputs, excluded secrets/other apps, size bound, cleanup, and default no-write mode.
- [ ] Run the focused test; require expected missing-module/interface failures.
- [ ] Implement the smallest staging script and multi-stage Dockerfile; production dependency install must retain Temporal runtime binaries.
- [ ] Run the focused tests and syntax check; require all pass.
- [ ] Commit only reviewed Task 1 files after owner-approved scope.

### Task 2: Offline compiled runtime audit

**Files:** Modify `tools/local/verify-workflow-container.mjs` and its focused test if needed.

**Interfaces:** `--run` builds the image from the staged context, verifies non-root/Node 24/no sensitive paths/no dev dependencies, imports required runtime modules and policy releases, and invokes the Temporal workflow bundler on emitted `dist/workflows.js` in an offline, read-only container. It must not call `node dist/server.js` or connect to external systems.

- [ ] Write a failing test of the audit command's invocation contract without invoking Docker by default.
- [ ] Run that focused test and observe the expected failure.
- [ ] Implement the bounded `--run` audit and cleanup; retain only the proof image for inspection.
- [ ] Run the opt-in local Docker proof, full Worker tests, typecheck/build, and `git diff --check`; record exact outcomes and any unverified runtime behavior.
- [ ] Commit only reviewed Task 2 files after owner-approved scope.

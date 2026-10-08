# Documentation map

Use this page to find the current design, local proof, and open release gates.
The project is locally exercised, not deployed to AWS. Dated verification notes
are evidence for their recorded checkpoint, not a claim that every later change
was retested end to end.

## Start here

- [Project README](../README.md): product, architecture diagrams, and scope.
- [Current architecture v1.1](architecture/KLEEM_AI_ARCHITECTURE_V1_1.md):
  implemented boundaries and accepted deployment target. It takes precedence
  over conflicting pages in the older [combined PDF](reference/README.md).
- [Codex handoff](CODEX_HANDOFF.md): current task handoff and October 8 precommit checks.
- [Verification status](VERIFICATION_STATUS.md): dated journey checks and limits.
- [Decision log](DECISION_LOG.md) and [ADR](adr/ADR-001-polyglot-runtime-and-mcp-boundaries.md):
  accepted decisions.
- [Project context](PROJECT_CONTEXT.md): detailed September 20 baseline and
  setup reference; use the handoff for newer changes.

## Journeys and safety boundaries

- [Local refund runbook](LOCAL_REFUND_RUNBOOK.md),
  [photo evidence](REFUND_PHOTO_EVIDENCE.md),
  [customer UX design](FRONTEND_CUSTOMER_REFUND_JOURNEY.md), and
  [execution safety review](REFUND_EXECUTION_SAFETY_2026-10-02.md).
- [Read-only support](READ_ONLY_SUPPORT_JOURNEYS.md),
  [order total](ORDER_TOTAL_JOURNEY.md),
  [catalog price](CATALOG_PRICE_JOURNEY.md),
  [recent order references](RECENT_ORDER_REFERENCES_JOURNEY.md), and
  [saved-address status](SAVED_ADDRESS_STATUS_JOURNEY.md).
- [Human chat handoff](HUMAN_CHAT_HANDOFF_JOURNEY.md),
  [delivery report and review closure](DELIVERY_ISSUE_REPORT_JOURNEY.md), and
  [zero-total cancellation](ZERO_TOTAL_CANCELLATION_JOURNEY.md).
- [Return/exchange discussion](RETURN_EXCHANGE_DISCUSSION.md) is guidance only,
  not a physical return or exchange workflow. See
  [next journey boundaries](NEXT_JOURNEY_BOUNDARIES.md) for deferred work.
- [DOCX table ingestion boundary](DOCX_TABLE_INGESTION_BOUNDARY.md) records the
  current fail-closed parser behavior.

## Evaluation, operations, and deployment

- [Evaluation status and reports](evaluation/README.md),
  [Evaluation Runner guide](../apps/services/evaluation-runner/README.md).
- [Observability runbook](observability/README.md) and
  [dependency tracing](observability/DEPENDENCY_TRACING.md).
- [Local authentication and secrets](LOCAL_AUTH_AND_SECRETS.md),
  [production identity roadmap](PRODUCTION_IDENTITY_ROADMAP.md), and
  [AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).
- [Multi-agent working agreement](MULTI_AGENT_WORKING_AGREEMENT.md).
- [Voice boundary](voice/VOICE_AGENT_BOUNDARY.md): planned, no voice runtime.

Historical implementation plans and specs are under
[superpowers](superpowers/). They record design intent and task checkpoints;
current code, architecture, and verification notes take precedence.

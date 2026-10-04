# Customer Service Agent Platform Combined HLD and LLD Architecture

Version: 1.1 current architecture edition
Date: 2026-09-20
Implementation and verification status updated: 2026-10-04
Status: Authoritative for the implemented repository and accepted near-term plan

## Document authority

This document is the current architecture amendment for Customer Service Agent
Platform. It must be read before
the preserved version 1.0 combined HLD/LLD PDF.

If this document or an accepted ADR conflicts with a page in the version 1.0 PDF,
this document and the ADR take precedence. The old PDF remains valuable for
product intent, non-functional requirements, domain decomposition, and detailed
future-state analysis.

The combined PDF was regenerated on September 20 from that day's amendment and
the complete version 1.0 baseline appendix. This Markdown has since been updated
for additional local journeys and is newer than the PDF. Later operational
evidence belongs in `docs/VERIFICATION_STATUS.md`; architecture changes belong
here before another PDF is published.

## Executive summary

The product is a governed platform for creating, operating, evaluating, and
eventually deploying customer support agents. The first end-to-end journey is a
refund because it exercises conversational intake, multi-agent orchestration,
retrieval, tools, deterministic policy, durable workflow, human review, commerce
execution, reconciliation, and audit.

The current system is production-shaped but locally deployed. It proves component
boundaries and safety controls without claiming production scale or reliability.

## Version 1.1 changes from the original PDF

| Area | Original baseline direction | Current authoritative direction |
|---|---|---|
| Online AI runtime | Some sections prescribe TypeScript-only online services | Python/FastAPI Agent Runtime and Knowledge/RAG are accepted and implemented; transactional services remain Node.js/TypeScript |
| Web applications | Vite/React appears in older design | Next.js with same-origin BFF routes is implemented for customer, operations, and admin surfaces |
| Node framework | NestJS appears in target design | Fastify is used in the implemented local service slice |
| Repository layout | Older `deployables` and `surfaces` names | `apps/services`, `apps/web`, `packages`, `contracts`, `infrastructure`, and `tools` are current |
| Internal transport | Broad gRPC/protobuf target | Current application calls are primarily HTTP/JSON with canonical schemas; Temporal uses gRPC and protobuf remains an internal contract option |
| Initial AWS platform | EKS and multi-region target | First deployment is intentionally single-region ECS Fargate; EKS/multi-region are later scale choices, not current implementation |
| Human Operations persistence | Earlier local slice was in memory | Running Human Operations service uses PostgreSQL with RLS, transactions, audit, idempotency, and durable decision outbox |
| Model access | Central routing appears in future-state architecture | Central Model Gateway remains planned; Agent Runtime calls configured models directly today |
| Observability | OpenTelemetry and CloudWatch appear as future-state capabilities | Opt-in local OpenTelemetry now covers Edge, Agent Runtime, Knowledge/RAG phases, Gateway, Conversation Runtime, Human Operations and short Workflow Worker activity spans. PostgreSQL-derived refund/outbox gauges, service heartbeats, Collector health, Grafana dashboards and eleven non-notifying local alerts are implemented; production SLOs, notification routing, CloudWatch/AWS export and production validation remain planned |
| Journey sequence | Broad platform build-out | The refund walking skeleton is locally complete through dummy-provider settlement. Separate local paths now cover read-only support, staffed chat handoff, delivery report/review closure, and zero-total no-payment cancellation. Paid-order cancellation, physical returns/exchanges, replacement, and wider account mutations are not complete; browser and production gates differ by journey |

## Architecture principles

1. Models propose; deterministic systems authorize.
2. Identity and tenant context are verified outside the model.
3. Agent tools are least privilege and read only where possible.
4. Consequential writes require current trusted facts, versioned policy, exact
   confirmation, and a narrow workflow capability.
5. Long-running work belongs in Temporal, not an HTTP request or LangGraph state.
6. Provider uncertainty remains processing or reconciliation, never success.
7. Cross-language boundaries are schema first.
8. Every governed action records enough version evidence to reproduce it.
9. Customer answers receive only customer-safe knowledge.
10. Add infrastructure only when the walking journey reaches the boundary.

### Shared policy data for customer explanations

The September 14 approved local change places the unchanged v1/v2 refund rules
in `packages/refund-policy/releases.json`. Node Workflow Workers read the rules;
Agent Runtime reads only a verified public projection for monetary explanations.
Edge signs `refundPolicy.policyVersion` and `catalogSha256` in the agent-specific
context assertion, using the same configured version that starts Temporal.
The Python verifier checks the signed binding against the exact catalog bytes.
Missing legacy bindings carry no monetary-policy authority; unknown versions and
hash mismatches fail closed. Matching catalog artifacts are required at deployment.

Prompt v9 adds an internal presentation purpose. Application code renders amount
comparisons and omits irrelevant amount footers; all model-output guards still
run first. The public answer contract and Temporal's decision authority are
unchanged. This does not add a Model Gateway, a new login token or another model
call. See the [design](../superpowers/specs/2026-09-14-trusted-refund-answer-design.md)
and [verification status](../VERIFICATION_STATUS.md); offline checks are not a
new RAGAS reliability result.

## High-level system

```text
Customer Portal 3100               Operations Console 3101
        | same-origin BFF                    | same-origin BFF
        v                                    v
Edge API 3000                         Human Operations 3003
  |          |                               | PostgreSQL
  |          +--> Conversation Runtime 3004  | decision outbox
  |                    | PostgreSQL           v
  |                    +--> SSE wakeups     Temporal
  v                                         Workflow Workers
Agent Runtime 8000                              |
  | LangGraph                                  | narrow capability
  |                                            v
  +--> Knowledge/RAG 8001 --> OpenSearch    Integration Gateway 3002
  |        customer-safe evidence               |
  +--> read-only MCP order lookup --------------+
                                               v
                                       Vendure 3001 / provider
```

The implemented local observability path is deliberately orthogonal to
authorization and business state:

```text
Edge / Conversation Runtime / Agent Runtime / Knowledge-RAG
Workflow Workers / Human Operations / Integration Gateway
  -> OTLP HTTP Collector
    -> Tempo traces / Prometheus metrics / Loki logs
      -> Grafana 3300
```

Trace context correlates work; it never grants access. Signed assertions,
workflow capabilities and durable audit records remain the authority.

The diagram above follows the refund path. Other local paths deliberately
branch earlier: read-only support ends after owner-checked Gateway or
customer-safe Knowledge/RAG reads; delivery reporting goes from Edge to Human
Operations PostgreSQL without Temporal or a commerce mutation; staffed chat
changes Conversation Runtime control and keeps its encrypted transcript;
zero-total cancellation uses its own Temporal workflow, exact preview, Gateway
ledger, and guarded Vendure plugin. These are not alternate entries into the
refund workflow.

## Release and ownership boundaries

| Boundary | Technology | Responsibility |
|---|---|---|
| Customer Portal | Next.js, React, TypeScript | Customer conversation, explicit human chat handoff, read-only support and saved-address status, refund preview/confirmation/status, and delivery issue report/status |
| Operations Console | Next.js, React, TypeScript | Refund queue/review, separately authorized delivery report claim/acknowledgment/review closure, and support-chat queue/reply |
| Admin Console | Next.js, React, TypeScript | Current shell; future release/configuration management |
| Edge API | Node.js, TypeScript, Fastify | Customer authentication, trusted context, validation, orchestration entry, and customer-owned workflow reads |
| Conversation Runtime | Node.js, TypeScript, Fastify, PostgreSQL | Conversations, encrypted customer/assistant/staff messages, control-versioned AI/human ownership, workflow links and encrypted start reservations, projections, and event delivery |
| Agent Runtime | Python, FastAPI, LangGraph | Intent, specialist orchestration, context construction, RAG use, model calls, guardrails, and typed proposals |
| Knowledge/RAG | Python, FastAPI, OpenSearch | Ingestion, parsing, chunking, embeddings, publication, hybrid retrieval, reranking, citations, and evaluation |
| Workflow Workers | Node.js, TypeScript, Temporal | Deterministic refund policy and a separate narrow cancellation workflow, exact previews, confirmation, approval, execution, retries, and reconciliation |
| Integration Gateway | Node.js, TypeScript, Fastify, PostgreSQL | Vendure adapter, customer-scoped read-only order/product tools, aggregate payment/refund and saved-address status, authorization, idempotent refund and guarded zero-total cancellation operations, provider events, and audit evidence |
| Human Operations | Node.js, TypeScript, Fastify, PostgreSQL | Durable refund cases, separate delivery reports with assigned-staff review closure, staff authorization, signed support-chat mediation to Conversation Runtime, audit, and refund decision outbox delivery |
| Evaluation Runner, within Control and Knowledge | Python, RAGAS adapters | Versioned datasets, deterministic and semantic graders, repeated trials, usage reports, and compatible baseline comparison; separate from online runtime |
| Local Observability | OpenTelemetry, Grafana LGTM | Opt-in traces, bounded metrics and safe correlated logs across the implemented service slice, plus authoritative refund/outbox gauges, service heartbeats, Collector health, dashboards and eleven local non-notifying alerts; development evidence only |

## Additional local support paths

The existing customer chat now routes customer-safe product/policy questions,
owned order status, owned order-item lists, and aggregate payment/refund status
through bounded read-only tools.
Deterministic read-only paths also cover the current tax-inclusive order total,
one exact catalog variant's current price, indexed named-variant availability,
and up to ten recent owner-checked order references. These are distinct facts:
catalog price is not checkout total, order total is not amount paid, and recent
references are not a complete order history. The current OrderItems v1 tool
fails closed on cancelled orders because it cannot safely label historical
quantity as current contents.
These paths do not start a refund workflow. The delivery issue form is separate
from the chat: Edge checks the customer's open conversation and order ownership,
then writes a body-bound, idempotent report to Human Operations PostgreSQL.
Delivery staff use a separate audience-scoped token and queue to claim and
acknowledge a report. Only the assigned staff member can later close its review
with the current version and a stable retry key. Customer readback exposes only
six safe fields and fixed copy that does not claim a remedy. No model, Temporal
workflow, or commerce mutation is part of that delivery path. Migration 006
has been applied locally; one disposable report passed authenticated backend
closure, replay/conflict, customer readback, and audit checks. The browser UI
has not been exercised by the agent.

Three exact generic exchange questions use a targeted retrieval query to find
the published change-of-mind return section. The answer requires the exact
`CUSTOMER_SAFE` sentence and citation, labels it as a conditional return rule,
and explicitly leaves exchange approval unverified. This is read-only policy
discussion, not a return or exchange request. One local Edge conversation
tested all three questions without a refund or cancellation link; the separate
synthetic v4 evaluation repeated six cases twice.

The explicit saved-address check on `/support` bypasses Agent Runtime and RAG.
Edge signs a self-scoped customer context for Gateway; Gateway reads only
address counts/default flags from the configured Vendure channel. No private
address fields reach the customer projection or a model. This check does not
change addresses or verify an existing order's delivery destination.

Customer-to-person chat handoff is a separate control path. Conversation Runtime
atomically changes an AI-owned conversation to a queued handoff session and
fences stale assistant commits by control version. Human Operations verifies a
distinct `SUPPORT_AGENT` login and signs exact staff actions for Conversation
Runtime; it does not own or duplicate the transcript. Staff claim, reply,
return-to-AI, and close operate on that encrypted transcript without granting
refund approval. An assistant message that already accepted a ready refund
proposal reserves the exact encrypted Temporal start input in the same database
transaction. A same-client-message retry can recover it for up to one hour,
shorter than the running local Temporal namespace's 24-hour retention;
older/legacy pending starts require manual reconciliation. The committed
handoff flag defaults off, while the ignored local environment is enabled
after API-level verification. Browser and production checks remain pending.

The delivery path is a report-and-review-closure slice, not a replacement,
return, cancellation, refund, or verified resolution. Its local evidence,
security boundaries, and release gates are recorded in
[Delivery issue report journey](../DELIVERY_ISSUE_REPORT_JOURNEY.md).

The first cancellation policy is a separate no-payment, zero-total path for a
placed, unfulfilled, customer-owned order. Chat acknowledges intent but does
not cancel anything. An exact customer preview and confirmation precede the
guarded Vendure write; the customer sees success only after provider state and
the operation marker agree. Two disposable local orders reached `Cancelled`,
including one uncertain-outcome recovery. A paid-order variant has contracts
under development but remains disabled after a demonstrated simulator
transaction/concurrency risk. See [the cancellation boundary](../ZERO_TOTAL_CANCELLATION_JOURNEY.md).

## Governed refund sequence

```text
1. Customer signs in locally and sends a conversation turn.
2. Edge verifies identity and creates audience-specific short-lived assertions.
3. Conversation Runtime persists the customer message.
4. Agent Runtime verifies its assertion and runs the LangGraph refund path.
5. Agent uses read-only MCP to obtain minimized authoritative OrderContext.
6. Agent asks Knowledge/RAG for CUSTOMER_SAFE evidence.
7. Model produces a schema-validated RefundProposal and grounded answer.
8. Edge commits the safe assistant response and starts Temporal only when ready.
9. Workflow refreshes RefundContext and evaluates versioned deterministic policy.
10. Workflow creates a bound preview or opens a Human Operations case.
11. A human may approve, reject, resolve takeover, or approve an exceptional plan.
12. Customer confirms the exact current preview.
13. Workflow refreshes facts again and issues a narrow expiring capability.
14. Integration Gateway performs one idempotent provider mutation.
15. Provider acceptance becomes REFUND_PROCESSING, not success.
16. Signed provider outcome or authoritative reconciliation determines completion.
17. Customer and staff projections show the truthful terminal state.
```

## Agent architecture

The implemented multi-agent pattern is supervisor routing with bounded specialists.
LangGraph manages online reasoning state, but it does not replace Temporal.

- LangGraph owns bounded conversational reasoning within a request.
- Temporal owns durable business state across minutes, hours, restarts, approvals,
  provider callbacks, and reconciliation.
- The refund specialist emits a typed `RefundProposal`.
- Guardrails validate structure and safe content before downstream use.
- No agent node receives a refund-write tool.

The current Agent Runtime calls configured OpenAI models directly through its
model client. This is the explicit current-state exception to the future Model
Gateway design.

## Model Gateway future module

Status: planned, not implemented.

```text
Agent Runtime
  -> logical route request plus tenant, task, sensitivity, and budget metadata
  -> Model Gateway
       -> route release lookup
       -> allowlist and policy enforcement
       -> token/cost/concurrency budgets
       -> timeout, circuit breaker, and approved fallback
       -> provider credential isolation
       -> trace, cost, and resolved-model evidence
  -> approved model provider
```

The gateway must be introduced behind the existing Agent Runtime model-client
interface. It must not absorb LangGraph orchestration, prompts, retrieval, business
policy, customer identity, or Temporal state. `MODEL_ROUTE_ID` currently records
intended route evidence; it does not mean the gateway exists.

## RAG architecture

### Ingestion

```text
Registered source
  -> content hash and classification
  -> PDF, DOCX, Markdown, HTML, or database parser
  -> normalized document and sections
  -> structure-aware chunks with bounded overlap
  -> OpenAI embeddings
  -> release-scoped OpenSearch index
  -> publication pointer
```

Each chunk identity is document-scoped. Metadata includes tenant, environment,
knowledge release, document ID, classification, locale, validity dates, source,
parser/chunking versions, content hash, and embedding model.

### Retrieval

```text
Query plus verified tenant context
  -> metadata filters
  -> BM25 keyword search
  -> vector semantic search
  -> reciprocal rank fusion
  -> cross-encoder reranking
  -> evidence and citations
  -> grounded answer composer
```

Customer-answer retrieval allows only `CUSTOMER_SAFE`. Internal-only policy and
playbooks may be used only by an explicitly authorized internal path. Retrieval and
answer evaluation are separate so failures can be diagnosed as retrieval quality,
reranking quality, grounding, citation, or final answer problems.

## Policy and workflow architecture

`RefundProposal` is model-produced, typed, and untrusted. `RefundPolicyInput`
combines the accepted proposal with current authoritative `RefundContext` and an
explicit policy release. `PolicyDecision` is deterministic and can be:

- `ALLOW`
- `APPROVAL_REQUIRED`
- `TAKEOVER_REQUIRED`
- `DENY`
- `NEEDS_FACTS`

The decision feeds the Temporal workflow. It never directly calls a provider.
Preview identity binds material facts, proposal, amount, policy version, and
customer confirmation. A material fact change invalidates the preview.

Temporal states cover intake, preview, confirmation, human review, authorized
submission, processing, reconciliation, success, failure, and safe closure. The
workflow uses `continueAsNew` during long reconciliation to bound history.

## Human Operations persistence

The running service uses PostgreSQL, not the in-memory adapter.

Core tables:

- `human_operations.refund_cases`
- `human_operations.case_audit_events`
- `human_operations.action_idempotency`
- `human_operations.decision_outbox`

Every repository transaction sets tenant and environment session context. Row-level
security enforces that scope in addition to application authorization. Claim,
reassign, and decision mutations use expected case version plus idempotency key.
A human decision, its audit event, and its pending outbox record commit together.
The service attempts direct Temporal delivery and retries pending rows every five
seconds.

This is durable local storage. Production still needs managed PostgreSQL, backups,
point-in-time recovery, high availability, capacity planning, monitoring, and a
Kafka-backed event/projection path.

## Security and identity boundaries

The local development system has four separate manually generated login JWT roles:

- customer login token, verified by Edge API;
- refund supervisor staff token, verified by Human Operations;
- delivery staff token, verified by Human Operations;
- support agent token, verified by Human Operations for chat handoff only.

All service assertions are generated automatically and are short lived. Audiences
separate Agent Runtime, Knowledge/RAG, Integration Gateway, Conversation Runtime,
Workflow Workers, and Human Operations purposes. Separate secrets protect customer
login, role-specific staff login, Edge service writes, workflow capabilities, human case calls,
and provider events.

Production replaces local login tokens with Cognito/OIDC, stores secrets in AWS
Secrets Manager with KMS, and uses workload identity and separate/asymmetric keys.
See `docs/LOCAL_AUTH_AND_SECRETS.md` for the complete relationship map.

## Data ownership

| Data | Authoritative owner |
|---|---|
| Customer and order commerce facts | Vendure or production commerce provider |
| Conversation and message ordering | Conversation Runtime PostgreSQL |
| Refund durable state | Temporal |
| Policy release and deterministic decision | Workflow/Control boundary |
| Agent proposal | Agent Runtime output persisted as workflow input/evidence |
| Knowledge source and release | Control/Knowledge boundary and OpenSearch publication |
| Integration idempotency and provider events | Integration Gateway PostgreSQL |
| Human case, audit, and decision delivery | Human Operations PostgreSQL |

No derived store replaces the provider source of truth. `factsVersion` is a hash
of normalized relevant facts used for change detection, not proof of execution.

## Interfaces and contracts

Canonical schemas live under `contracts/`. Important contracts include:

- trusted tenant context and assertion claims;
- order context and refund context;
- refund proposal;
- refund policy input and policy decision;
- execution evidence;
- refund workflow and provider lifecycle messages.

External effects are behind injected clients or repositories. Python and
TypeScript do not maintain unrelated handwritten versions of the same boundary
without a canonical schema and compatibility tests.

## Observability and evaluation

Current code records version evidence and structured service outcomes. Knowledge/RAG
owns retrieval metrics; the separate Python Evaluation Runner reuses production
retrieval and answer components with synthetic application facts. It implements
RAGAS context precision/recall, faithfulness, response relevancy and factual
correctness, deterministic safety/citation checks, repeated trials, usage sidecars
and baseline comparison. Seven core intake cases plus a separate retrieval-outage
case exercise LangGraph with synthetic dependencies, not the full refund workflow.
Evaluation usage reports are not distributed tracing or a provider bill.

The implemented opt-in local observability slice provides:

- Edge server/client spans and Agent Runtime server spans;
- Agent Runtime client spans for customer-safe RAG and read-only MCP lookup;
- Knowledge/RAG phase spans for embedding, vector search, keyword search, fusion
  and reranking;
- Integration Gateway HTTP/MCP spans and a read-only Vendure order-lookup span;
- Human Operations and Conversation Runtime request telemetry;
- short Workflow Worker activity spans that remain attempt-level trace evidence;
- bounded model intent, answer, guard, fallback and provider-reported token
  telemetry when the provider supplies usage;
- authoritative PostgreSQL snapshots for refund execution outcomes, active-state
  age, provider-event backlog and Human Operations decision-outbox backlog;
- service heartbeats and Collector uptime/export-failure telemetry;
- bounded operation metrics and fixed correlated completion logs;
- four local Grafana dashboard views and eleven non-notifying diagnostic alerts;
- local Tempo, Prometheus, Loki and Grafana storage on loopback.

The signals exclude raw prompts, answers, retrieved chunks, order IDs, request
bodies and secrets. Provider trace propagation to Vendure is disabled. Token
metrics contain bounded numeric usage only, never token contents. Browser BFF
telemetry, model pricing/cost attribution, workflow-level Temporal business
metrics, finalized production SLOs, notification routing, production sampling,
retention/access controls, CloudWatch and AWS/CDK export remain pending. Durable
business audit records are separate from operational telemetry. Temporal activity
spans can retry and therefore are never counted as distinct refunds; Integration
Gateway execution rows remain the authoritative refund-outcome source.

Dataset v3 completed its authorized five-case, three-repetition campaign: 15
attempts, five scored answers, ten production-guard rejections and no case that
passed all repetitions. One authorized v4 large-refund trial then failed its
blocking reviewed-policy answer check. The baseline is frozen; human calibration,
LangSmith, external Tau, full workflow/human/provider simulations, broader
specialist routing, adversarial coverage and calibrated release gates remain
pending. See [the evaluation strategy](../evaluation/EVALUATION_STRATEGY.md).

## Initial AWS target

Status: planned, not implemented.

The first deployment target is a single AWS region:

- CloudFront and an application load balancer for web/API entry;
- ECS Fargate for web and service containers;
- Amazon RDS for PostgreSQL;
- Amazon OpenSearch Service;
- Amazon MSK or another explicitly approved Kafka deployment when event delivery is
  introduced;
- Cognito for customer and staff authentication;
- Secrets Manager and KMS;
- CloudWatch plus OpenTelemetry;
- S3 for source documents and build artifacts;
- a managed or carefully operated Temporal deployment decision made separately.

EKS, Helm, Argo CD, multi-region active-active, and very large scale are future
options, not claims about the current repository.
Local isolated container packaging proofs now exist for the application
services and web surfaces, but they are not multi-service startup, cloud
infrastructure, or production readiness. Identity, CI/CD, cloud search access,
durable Temporal, private evidence storage, backups, and CloudWatch export
remain gates in [AWS deployment readiness](../AWS_DEPLOYMENT_READINESS.md).

## Current verification and remaining work

Implemented and substantially exercised locally:

- customer conversation and refund intake;
- typed agent proposal and grounded customer answer;
- OpenSearch ingestion, hybrid retrieval, reranking, citations, and evaluation;
- read-only MCP order lookup;
- deterministic policy and Temporal workflow;
- PostgreSQL Human Operations and exceptional refund plan;
- authorized idempotent Vendure refund path;
- signed provider outcome, processing, and reconciliation;
- customer and operations browser projections.
- separate owner-checked read-only support answers, staffed chat handoff,
  delivery issue reporting with administrative review closure, and a narrow
  zero-total no-payment cancellation path, with journey-specific local
  verification limits;
- opt-in local OpenTelemetry correlation across Edge, Agent Runtime,
  Knowledge/RAG, Conversation Runtime, Human Operations, Gateway and short
  Workflow Worker activities, with PostgreSQL-derived refund/outbox gauges,
  service heartbeats, Collector health, Grafana LGTM and eleven local alerts.
- private normalized photo intake, PostgreSQL evidence metadata, exact-revision
  assigned-staff review, and a Temporal gate under immutable policy release v2.
  Evidence acceptance is separate from monetary approval. Existing v1 requests
  retain their original rules; see `docs/REFUND_PHOTO_EVIDENCE.md`.

The positive local exceptional-refund browser-to-provider path passed on
2026-09-05. A later September 6 proof included the photo gate: replacement-photo
acceptance, separate supervisor monetary approval, exact customer confirmation,
one refund and authorized settlement of that existing Vendure refund, followed
by completed workflow/customer state. A fresh paid browser wording check remains
pending; real bank settlement and all production scenarios are not proved.
The September 14 merge check recorded 586 passing tests and four optional
database skips across five changed services. See
[Verification Status](../VERIFICATION_STATUS.md) for scope and historical evidence.

Still pending:

- human calibration, LangSmith, external Tau execution and full refund-workflow
  evaluation after the completed v3 campaign and failed v4 policy-answer trial;
- reproducible Vendure/OpenSearch bootstrap and one-command stack startup;
- broad browser end-to-end coverage;
- deterministic delivery-age eligibility and production photo storage, scanning,
  retention approval and recovery operations;
- centralized Model Gateway;
- paid-order cancellation and physical return/exchange execution;
- Kafka/MSK event delivery;
- browser BFF telemetry, model pricing/cost attribution and workflow-level
  Temporal business metrics;
- finalized production SLOs, notification routing, production sampling,
  retention/access controls, CloudWatch/AWS export and production load/failure
  validation;
- production Cognito identity and AWS infrastructure;
- Admin Control Plane release workflows;
- real-phone voice implementation.

The authoritative checklist is `docs/VERIFICATION_STATUS.md`.

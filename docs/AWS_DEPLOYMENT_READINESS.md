# AWS deployment readiness

Updated 2026-10-02. This is a source-backed readiness record, not an AWS
deployment or a claim that local test users have production identity. The
locally completed dummy-provider refund proof does not clear the gates below.

## Current hard gates

| Area | Current repository state | Required before public traffic |
| --- | --- | --- |
| Customer and staff identity | Edge accepts only `AUTH_MODE=local` and explicitly rejects it with `NODE_ENV=production`; web sign-in uses local tokens | Implement and test production customer/staff identity, tenant mapping, session renewal/revocation, and authorization |
| Packaging and infrastructure | Local Compose exists; eight Node applications (including three web apps), Python Agent Runtime, and Knowledge/RAG passed isolated local image proofs; AWS IaC does not exist | Prove multi-service startup, service discovery, private network/TLS, migrations, rollback, and infrastructure review |
| Knowledge search | Knowledge/RAG now supports a configurable remote HTTPS endpoint with verified TLS and basic authentication; local default remains plaintext `localhost:9200` | Validate the chosen cloud domain/auth policy, add SigV4 if IAM-only, and prove release/index parity and remote handshake |
| Durable workflow and commerce | Local Temporal uses `start-dev`; Vendure simulator uses SQLite and dummy payment | Decide and prove durable Temporal, commerce database/provider, backup/recovery, and reconciliation behavior |
| Private evidence | Refund photos are stored on a local private filesystem; retention deletion is not enabled | Approved private object storage, scanning/access rules, retention/deletion, and recovery |
| Operations | Local dashboards and alerts are opt-in; production CloudWatch export, notification routing, SLOs, and recovery drills are not verified | Production telemetry, alert ownership, retention, load/failure/recovery checks |
| CI/CD | No GitHub Actions workflow or automated image promotion is checked in | First establish a coherent committed core-project baseline; then add no-secret tests, verified image builds, provenance and guarded deployment/rollback gates |

The [production identity roadmap](PRODUCTION_IDENTITY_ROADMAP.md) names the
existing verifier seam and the BFF/staff-session work. A local refund-staff
token lifetime check was hardened on 2026-10-02; it does not resolve the
production identity gate. Edge also now validates every injected customer
verifier result before routes use it (171 tests and typecheck passed); this is
a provider-neutral boundary check, not OIDC login or tenant/account mapping.
The [customer implementation plan](superpowers/plans/2026-10-02-production-customer-identity.md)
is documented, not executed; actual provider settings and account provisioning
remain prerequisites.

The installed Vendure schema also lacks an owner-checked invoice document, and
the development mailbox must not be exposed as one. This is independent of
deployment packaging. The planned single-region ECS/Fargate architecture in
[version 1.1](architecture/KLEEM_AI_ARCHITECTURE_V1_1.md) is a target, not a
running AWS stack.

Agent Runtime's read-only MCP clients now share the
`INTEGRATION_GATEWAY_MCP_URL` setting. It defaults to local
`http://127.0.0.1:3002/mcp`; a multi-container deployment must set the private
Gateway service URL explicitly. This removes one localhost-only wiring
assumption, but service discovery, private network controls, TLS choice, and
container-to-container verification remain deployment gates. The 622 Agent
Runtime tests passed after this change; it was not tested in the Edge-only
container proof below.

## Safe preparation before an AWS account exists

1. Use the completed local container proofs for eight Node applications,
   Python Agent Runtime, and Knowledge/RAG as packaging baselines. Next run
   private multi-service smokes with no real refund execution; an isolated
   image audit does not validate service startup or connectivity.
2. Use the new fail-closed Knowledge/RAG OpenSearch endpoint configuration
   with private credentials, then prove it against the chosen cloud domain.
   SigV4/Serverless are not implemented; no remote domain has been contacted.
3. Design and test production OIDC identity and staff roles before enabling a
   public customer URL. Keep local tokens development-only.
4. Specify migration ordering, backup/restore and rollback checks for every
   stateful service; define private evidence storage/retention separately.
5. Review a minimal isolated AWS trial architecture and its current estimated
   spend only after the account, region, credit eligibility, and expected
   lifetime are known. Do not infer cost from an older free-tier assumption.

On 2026-10-02 a read-only CI audit found a manual-trigger, no-secret core test
workflow technically feasible, but **not added**. Hosted CI would see only
committed code, whereas this checkout had 414 modified/untracked paths and
unrelated ignored demo-app files must remain outside the core commit. A broad Python and
Temporal matrix would also add registry downloads and runner time before its
cost/runtime is measured. The first CI slice should cover frozen dependency
install, contracts, and selected offline Node/Python tests with no AWS, model,
database, or live commerce credentials. Add image build/promotion and guarded
deployment only after the dirty work is reviewed into coherent commits and
the remaining service images are proven. No workflow or cloud job was created
in this audit.

## First cloud trial boundary

The first deployment should be private, time-boxed, and use disposable test
customers/orders with real refund execution disabled. The account owner must
verify credits and billing settings and approve the resource plan before
creation. Cost alerts are not a guaranteed hard cap and cannot promise a
$0 out-of-pocket bill. Capture deployment, migration, health, cost, and
teardown evidence.
Only after identity, data protection, recovery, and observability gates pass
should public customer access or consequential commerce be considered.

No AWS resources, credentials, charges, or IaC were created by this readiness
work. Local proof images for eight Node applications, Python Agent Runtime,
and Knowledge/RAG were retained for inspection. Kafka/MSK, voice,
EKS, and multi-region are not prerequisites
for a tiny isolated smoke, but they remain unimplemented roadmap items.

On 2026-10-02 the OpenSearch factory was extended without changing retrieval
or publication call sites. Forty-two focused and 149 full Knowledge/RAG tests
passed with Ruff checks. A read-only local client ping succeeded. No remote
TLS handshake, IAM policy, or AWS domain was tested. An unset
`ENVIRONMENT_ID` still retains the historical local default; production
deployment must explicitly set the non-local environment and HTTPS endpoint.

## Edge API local container proof (passed, not a deployment)

The [Edge API Dockerfile](../infrastructure/images/edge-api/Dockerfile) pins a
Node 24 base image and separates build from production dependencies. The
Dockerfile-specific ignore file is defense in depth for BuildKit; the proof
script creates a smaller explicit context because the local legacy builder
did not honor that ignore file. The opt-in
[`verify-edge-container.mjs`](../tools/local/verify-edge-container.mjs) script
is designed to audit the image, start it on a private disposable Docker
network using the existing local Temporal server, check `/health`, and remove
only its own container/network. It does not publish a host port or issue a
business request. The script's syntax, default no-write behavior, and staging
test passed; Edge typecheck and all 171 Edge tests passed with Node 24 at the
earlier host-suite checkpoint.

The first full `--run` proof stalled in Docker Desktop's credential helper.
An isolated empty Docker configuration bypassed that helper and allowed the
public pinned base image to download, revealing a second problem: the legacy
builder ignored the Dockerfile-specific ignore file and sent a 5.8 GB root
context. We interrupted the build without creating a proof image, container,
or network. A root ignore file did not sufficiently narrow the legacy context,
so it was removed. The proof script now stages only a reviewed set of Edge
build inputs in a temporary context, checks its size and regular files, and
deletes it after the proof. The final isolated run staged 40 reviewed files
(369,127 bytes); Docker sent a 404.5 kB context. It built an arm64 image of
86,384,700 bytes and passed runtime checks for Node 24, non-root user,
production imports without development dependencies, expected policy catalog,
no sensitive paths, private `/health`, and clean SIGTERM shutdown. No host
port or business request was used. The throwaway container and network were
removed; the local proof image `cso-edge-proof:07401ba577527297` remains for
inspection. This verifies local Edge packaging only. Production identity,
multi-service networking, security review, cloud runtime, migrations, and
recovery remain open gates.

## Integration Gateway local container proof (passed, not a service smoke)

The [Gateway Dockerfile](../infrastructure/images/integration-gateway/Dockerfile)
uses the same pinned Node 24 base, separate build and production-dependency
stages, and a non-root runtime. The opt-in
[`verify-gateway-container.mjs`](../tools/local/verify-gateway-container.mjs)
script stages an explicit allowlist so the legacy Docker builder never receives
the repository root. Its context contained 53 files (370,637 bytes); Docker
sent 416.3 kB. The staging tests for Edge and Gateway passed 2/2. An isolated
local build produced arm64 image `cso-gateway-proof:a8b9c0c9fe511a6a`
(88,406,359 bytes). A network-disabled, read-only, unprivileged container audit
passed Node 24, non-root execution, required production imports, absence of
development dependencies, and absence of sensitive paths. The temporary audit
container was removed and the image retained for inspection.

This proof deliberately did **not** start Gateway, connect it to PostgreSQL,
Temporal, Vendure, or Edge, publish a port, or issue a business request. It
does not prove runtime environment wiring, migrations, cross-container MCP,
private TLS, image scanning, or AWS readiness.

## Conversation Runtime local container proof (passed, not a service smoke)

The [Conversation Runtime Dockerfile](../infrastructure/images/conversation-runtime/Dockerfile)
uses the same pinned Node 24 multistage pattern and a non-root runtime. Its
opt-in [proof script](../tools/local/verify-conversation-container.mjs) staged
25 reviewed files (292,577 bytes); Docker sent a 315.9 kB context. The three
Edge/Gateway/Conversation staging checks and Conversation's no-write default
check passed 4/4. The local arm64 image
`cso-conversation-proof:d5a9d1a731e02632` built at 83,496,195 bytes. A
network-disabled, read-only, unprivileged audit passed Node 24, production
imports, no development dependencies, and no sensitive paths. The audit
container was removed and the image retained.

The image was not started as a service. PostgreSQL migration, connection,
conversation API health, Edge-to-Conversation routing, backup/recovery, and
cloud behavior remain untested.

## Workflow Worker compiled-entrypoint and container proof

Before packaging the Worker, a local build showed `dist/refund-worker.js`
pointing Temporal at nonexistent `dist/workflows.ts`, while `dist/workflows.js`
was emitted. The Worker now resolves the TypeScript source entrypoint in local
development and the JavaScript entrypoint in compiled output. Its focused
red-first test passed 2/2, full Worker suite passed 113/113, and typecheck,
build, and compiled-path existence checks passed. A separate opt-in
[Worker image proof](../tools/local/verify-workflow-container.mjs) staged 33
reviewed files (302,763 bytes), sent a 332.8 kB Docker context, and built an
arm64 image `cso-workflow-proof:fb1100b62933aab5` (160,644,787 bytes). Its
network-disabled, read-only, non-root audit loaded production dependencies and
both policy releases, resolved emitted `dist/workflows.js`, and successfully
bundled it through the real Temporal SDK. An earlier image produced six
source-map warnings: its maps referenced TypeScript source omitted from the
runtime image. The Worker compiler now embeds source content in emitted maps;
the latest offline audit explicitly counts module warnings and passed with
zero. No Worker was
started, task queue polled, Temporal server contacted, or history replayed
against the compiled image.

## Human Operations local container proof (passed, not a service smoke)

The [Human Operations Dockerfile](../infrastructure/images/human-operations/Dockerfile)
overrides its typecheck-only `noEmit` setting **inside the image build**, copies
all six reviewed SQL migrations, and excludes the local token-generation CLIs
from runtime output. The [proof script](../tools/local/verify-human-operations-container.mjs)
staged 46 files (390,352 bytes); Docker sent 429.1 kB. The arm64 image
`cso-human-operations-proof:971d3f8278aba8db` built at 95,374,922 bytes.
Its network-disabled, read-only, non-root audit verified the six migrations,
production imports, absence of development dependencies and sensitive paths,
and actual Sharp image processing on a synthetic 1-pixel image. No Human
Operations service, PostgreSQL migration, case action, or evidence upload was
run in the image.

## Agent Runtime local container proof (passed, not a service smoke)

The [Agent Runtime Dockerfile](../infrastructure/images/agent-runtime/Dockerfile)
pins Python 3.12 and installs frozen production dependencies with uv into a
non-root image. It keeps the Python package at the repository-relative path
needed by its refund-policy catalog lookup, while copying only that catalog
from the policy package. The opt-in
[proof script](../tools/local/verify-agent-runtime-container.mjs) staged 39
reviewed files (382,629 bytes), excluding `.env`, tests, the local virtual
environment, and other services. The arm64 image
`cso-agent-runtime-proof:a4a6a099e69984ce` built at 74,149,844 bytes. Its
network-disabled, read-only, non-root audit imported the real FastAPI app,
called its ASGI `/health` route directly, confirmed the policy catalog and
absence of development tools, and did not start a listening server. The first
metadata check rejected the official Python base image's public `GPG_KEY`;
the audit now exempts that one public key name while rejecting all other
credential-shaped environment names. No model, Gateway, RAG, commerce,
database, or Temporal call was made. This is not an Agent Runtime service
smoke or a multi-container test.

## Knowledge/RAG local container proof (passed, no retrieval startup)

The [Knowledge/RAG Dockerfile](../infrastructure/images/knowledge-rag/Dockerfile)
and [opt-in proof](../tools/local/verify-knowledge-rag-container.mjs) stage an
explicit 35-file, 304,008-byte context without `.env`, model weights,
documents, tests, or other services. The Linux lock now selects the official
PyTorch CPU wheel for both arm64 and x86_64, removing the previous Linux
CUDA dependency graph; non-Linux resolution keeps the pinned PyPI release.
The local arm64 image `cso-knowledge-rag-proof:510d8770aed5170d` built at
314,933,060 bytes. Its network-disabled, read-only, non-root audit imported
the locked ML and service dependencies and exercised the ASGI `/health` route
without FastAPI lifespan. The full Knowledge/RAG suite passed 155/155, Ruff
passed, the frozen lock checked offline, and all 39 image-proof staging tests
passed on Node 24. No reranker weights were fetched or packaged. A separate
network-disabled, read-only run mounted only the existing local cache for the
exact pinned cross-encoder revision and successfully ranked two synthetic
sentences inside the CPU image. This verifies local model loading/inference,
not a deployable asset: the image still needs an approved, checksum-verified
model provision and startup configuration. No OpenSearch connection, index,
embedding call, configured retrieval startup, or customer document ran. A
private service/retrieval smoke remains required.

The follow-up image now sets `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` by default. Its verifier checks those values in
image metadata rather than injecting them during the audit. The updated
35-file context (304,209 bytes) built as
`cso-knowledge-rag-proof:f3fc0253712ef30d` (314,933,144 bytes, arm64), and
the network-disabled, read-only dependency/ASGI health audit passed again.
The focused verifier suite passed 6/6. This makes a missing model asset fail
closed: a separate network-disabled, read-only run without any model-cache
mount attempted the pinned cross-encoder and received `OSError`. It does not
supply the pinned weights, verify their checksum, or prove configured
retrieval readiness.

The verifier now accepts the explicit opt-in `--run --platform linux/amd64`
while preserving native-platform `--run` and inert malformed arguments. Its
first fake-Docker test accidentally reached a cached native Docker build;
the test was stopped, no child process remained, and the fake CLI was fixed
to use an isolated `PATH` before any intentional x86 build. The corrected
tests require exactly four fake Docker calls and the full image-input suite
passed 39/39, including a symlinked-checkout-root regression. One intentional amd64 image,
`cso-knowledge-rag-proof:ab5605836389426a` (353,963,008 bytes by image
inspect), then built and passed the network-disabled, read-only, non-root
dependency import and HTTP-only ASGI `/health` audit. This cross-architecture
local proof does not run lifespan, load the model, connect to OpenSearch, or
prove an AWS task can start with production configuration.

A separate amd64 run mounted only the exact existing local cross-encoder
cache read-only, kept networking disabled, and ranked a synthetic relevant
sentence above an irrelevant one. This proves CPU model inference under local
x86 emulation with that cache present. It does not package, distribute, or
checksum the model asset, and does not exercise configured retrieval.

## Customer Portal local container proof (passed, not authenticated)

The [Customer Portal Dockerfile](../infrastructure/images/customer-portal/Dockerfile)
stages 67 reviewed files (352,495 bytes), compiles Next.js standalone with
network disabled after dependency install, and copies only traced server and
static output to a non-root Node 24 runtime. The container-specific Next
config is an overlay; the application config is unchanged. The arm64 image
`cso-customer-portal-proof:319e5a2b8c8dadce` built at 91,820,484 bytes.
Its network-disabled, read-only offline audit passed compiled routes, static
assets, Next/React imports and Sharp image processing, with no development
dependencies or sensitive paths. The first audit incorrectly expected React
at the app root; the standalone trace resolves it from Next's dependency tree.
No server or authenticated request ran. `NODE_ENV=production` intentionally
disables the current local-customer-login path; this image is **not** a usable
public customer journey until the production identity plan is implemented.

## Operations Console local container proof (passed, not authenticated)

The [Operations Console Dockerfile](../infrastructure/images/operations-console/Dockerfile)
staged 65 reviewed files (305,522 bytes), compiled Next.js standalone without
network access after dependency installation, and produced a non-root Node 24
arm64 image, `cso-operations-console-proof:8ea0dce9ec1e5c08`, at 91,837,204
bytes. Its network-disabled, read-only audit passed compiled refund, delivery,
and support staff routes, static assets, Next/React imports, Sharp image
processing, and source/secret exclusions. No server or staff request ran. All
three existing local staff login routes are disabled in production, so this
proof does not clear the staff identity gate or authorize a public console.

## Admin Console local container proof (passed, placeholder only)

The [Admin Console Dockerfile](../infrastructure/images/admin-console/Dockerfile)
staged 16 reviewed files (177,410 bytes), compiled the Next.js standalone
placeholder without network access after dependency installation, and produced
a non-root Node 24 arm64 image, `cso-admin-console-proof:cb905a86e72e633a`,
at 91,341,862 bytes. Its offline network-disabled, read-only audit passed the
compiled placeholder page and static assets, Next/React imports, and
source/secret exclusions. No server or admin request ran. The application is
still an unauthenticated control-plane placeholder; the image proof does not
create admin capabilities or justify a public admin URL.

## Control Knowledge is not a deployable service

`apps/services/control-knowledge` contains versioned schemas and contracts,
with build/typecheck/test scripts but no server entrypoint, health route, or
listener. It should be validated as a build-time package, not counted as a
missing service container. Creating a new control-plane server would be a
separate architecture decision, not an image-packaging fix.

The shared root-to-leaf packaging guard rejects symlinked ancestors and
hidden/sensitive source components. Its negative fixtures and the ten local
image-proof test files passed 34/34 tests. The guard does not address
concurrent filesystem mutation. These are local arm64 packaging results,
not multi-service runtime or x86_64/AWS validation.

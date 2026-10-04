# Production Customer Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace shared local customer login with independently verified, identity-bound sessions and owner-scoped customer mapping before public traffic.

**Architecture:** Keep Edge's `VerifyCustomerIdentity` and downstream signed-context contracts. Add a production OIDC verifier that accepts only a configured provider's **access** token and resolves its verified issuer/subject through an authoritative server-side binding to one tenant, environment, and Vendure customer. The Customer Portal completes authorization-code + PKCE on the server and stores only an opaque, revocable session ID in a secure browser cookie; its proxy obtains the correct customer's access token from server-side storage. Local auth remains development-only.

**Tech Stack:** Node 24, TypeScript, Fastify, Next.js 16, `jose`, PostgreSQL, Cognito/OIDC test fixtures.

**Spec:** [Production identity boundary](../../PRODUCTION_IDENTITY_ROADMAP.md)

## Global Constraints

- `NODE_ENV=production` must never permit `AUTH_MODE=local` or the literal `active` customer cookie.
- `AuthenticatedCustomer` remains `{ principalId, tenantId, environmentId, customerId }`; `principalId === customerId` at the self-service Edge boundary.
- Tenant, environment, customer, and staff scope derive from verified identity and server-side binding, never a browser parameter or model text.
- Keep Edge's existing audience-specific, short-lived downstream assertions unchanged.
- Never log or commit provider tokens, refresh tokens, session IDs, keys, or customer personal data.
- Customer and staff login are separate subprojects; this plan does not grant staff roles or enable refund execution.
- No public customer URL or claim of production readiness until the real provider, identity mapping, revocation, recovery, and cross-tenant tests pass.

## Review Focus

1. A validly signed ID token presented where an access token is required must return 401; Task 2 pins `token_use` and client binding.
2. An access token for a different issuer/client, stale signing key, or future `nbf` must return 401; Task 2 pins these cases.
3. The same external subject mapped to two tenants must not be selected by request data; Task 1 pins unique binding and Task 2 pins fixed configured scope.
4. A copied, expired, revoked, or logged-out browser session must not read a second customer's conversation; Tasks 3 and 4 pin this.
5. A forged cross-origin POST or replayed OAuth callback must not create or mutate a session; Task 3 pins state/PKCE/nonce and Task 4 pins origin checks.

---

## File map and prerequisites

- `apps/services/edge-api/src/customer-identity-binding.ts`: production lookup of verified `(issuer, subject)` to one internal customer scope.
- `apps/services/edge-api/src/oidc-customer-auth.ts`: production token verification and mapping behind `VerifyCustomerIdentity`.
- `apps/services/edge-api/src/config.ts` and `server.ts`: mutually exclusive local/OIDC wiring with fail-closed configuration.
- `apps/web/customer-portal/lib/customer-session.ts`: server-side session read/write/revoke and access-token retrieval; never exported to browser code.
- `apps/web/customer-portal/app/api/auth/{start,callback,logout}/route.ts`: OAuth redirects and callbacks.
- `apps/web/customer-portal/lib/refund-proxy.ts` plus page guards: per-request session authorization, replacing the literal local-cookie check in production.
- PostgreSQL migration and tests own uniqueness, expiry, tenant mapping, and session revocation. Add only the packages needed by these boundaries.

Before execution, record the actual issuer, app-client ID, callback/logout URLs, allowed redirect origins, database ownership, key custody, and customer provisioning rule in the spec. These are external configuration facts, not values to invent. Cognito access tokens normally bind the app client via `client_id`, while ID tokens use `aud`; resource-bound access tokens may also have `aud`. Verify the chosen configuration against [AWS's token-verification guidance](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html) before coding that check. Authorization-code + PKCE and callback `state`/ID-token `nonce` behavior follow the [official authorize-endpoint guidance](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html). No AWS account or provider is configured today.

### Task 1: Authoritative external-subject binding

**Files:** Create `apps/services/edge-api/migrations/001_customer_identity_bindings.sql`, `src/customer-identity-binding.ts`, and `tests/customer-identity-binding.test.ts`; modify the Edge package/migration command only as needed.

**Interfaces:** Produce `resolveCustomerBinding(input: { issuer: string; subject: string }): Promise<AuthenticatedCustomer | null>`. The database enforces unique `(issuer, subject)` and records tenant, environment, and internal Vendure customer ID. Provisioning is an authenticated administrative operation outside the customer request path, with its own reviewed procedure; do not accept mapping rows from JWT custom claims.

- [ ] Write failing repository tests for one exact mapping, unknown subject, duplicate `(issuer, subject)`, and cross-tenant request fields having no effect.
- [ ] Run only those tests and observe the expected missing-table/interface failures.
- [ ] Add the migration and minimal repository; never create a fallback mapping from `sub` to customer ID.
- [ ] Run repository tests, migration against a disposable database, and Edge typecheck; require all pass.
- [ ] Commit the reviewed Task 1 files only after the project owner has approved the commit scope.

### Task 2: Production Edge verifier

**Files:** Create `apps/services/edge-api/src/oidc-customer-auth.ts` and `tests/oidc-customer-auth.test.ts`; modify `src/config.ts`, `src/server.ts`, `.env.example`, and corresponding config tests.

**Interfaces:** Produce `createOidcCustomerIdentityVerifier(options: { issuer: string; clientId: string; jwksUrl: URL; expectedTenantId: string; expectedEnvironmentId: string; resolveCustomerBinding: typeof resolveCustomerBinding }): VerifyCustomerIdentity`. Only configured HTTPS JWKS may supply keys; allowlisted algorithms, access-token use, issuer, client/resource audience as configured, expiry/`nbf`, and a bounded token are mandatory. Map a verified subject server-side; return a normalized `AuthenticatedCustomer` with `principalId = customerId` only when binding scope matches configuration. `AUTH_MODE=oidc` must be required for production startup; local mode remains rejected there.

- [ ] Write failing fixture-key tests for valid access token and each Review Focus token/scope failure, including an ID token and unknown binding.
- [ ] Run the focused tests and observe the expected failure before implementation.
- [ ] Implement the verifier and fail-closed configuration/wiring; do not log rejected tokens.
- [ ] Run focused tests, full Edge suite, typecheck, and build; require all pass.
- [ ] Commit only reviewed Task 2 files after owner-approved scope.

### Task 3: Identity-bound Customer Portal session

**Files:** Create `apps/web/customer-portal/lib/customer-session.ts`, `app/api/auth/start/route.ts`, `app/api/auth/callback/route.ts`, `app/api/auth/logout/route.ts`, a session-store migration and focused tests; modify `app/sign-in/page.tsx` and `.env.example`.

**Interfaces:** Produce `getAuthorizedCustomerSession(request: NextRequest): Promise<{ accessToken: string; customerId: string } | null>`, `revokeCustomerSession(sessionId: string): Promise<void>`, and the three auth routes. Store opaque random session IDs only as hashes server-side and use `HttpOnly`, `Secure`, `SameSite=Lax` cookies in production. Keep provider access/refresh tokens out of the browser and encrypted at rest if persisted. Callback consumes one-time state/PKCE verifier and validates ID-token nonce; logout revokes the server session. Expiry, renewal, and account-switch behavior must be explicit; do not silently fall back to the local shared token.

- [ ] Write failing tests for distinct customer sessions, callback state/nonce/PKCE replay, expiration, logout/revocation, and secure cookie attributes.
- [ ] Run focused tests and observe the expected missing-interface failures.
- [ ] Implement the smallest session store and OAuth routes; use a fake provider in tests, not live Cognito.
- [ ] Run Portal tests, typecheck, and production build; require all pass.
- [ ] Commit only reviewed Task 3 files after owner-approved scope.

### Task 4: Proxy and page migration with negative boundary tests

**Files:** Modify `apps/web/customer-portal/lib/refund-proxy.ts`, customer page guards and all routes using `authorizeLocalCustomerRequest`; add Portal and Edge cross-boundary tests. Preserve `/api/local-session` only behind the existing development-only gate.

**Interfaces:** In production, every Portal read, write, SSE, and photo route must obtain the current session's provider access token through `getAuthorizedCustomerSession`, then send it only to Edge. Keep same-origin checks on mutations and `no-store` responses. No request path may read `CSO_LOCAL_CUSTOMER_TOKEN` in production.

- [ ] Write failing tests proving two sessions cannot read each other's conversation/order/refund data, revoked session returns 401, unsafe POST origin returns 403, and local cookie alone is rejected in production.
- [ ] Run the focused tests and observe failures on the current literal-cookie behavior.
- [ ] Replace route authorization and page guards without changing response contracts or weakening SSE/photo protections.
- [ ] Run full Portal and Edge suites, typechecks, production build, and a private two-customer end-to-end smoke. Record IDs/results only, not tokens.
- [ ] Commit only reviewed Task 4 files after owner-approved scope.

Staff identity, provisioning/recovery, infrastructure, and a public rollout require their own plan and gates. Completion of these four tasks alone does not authorize public traffic.

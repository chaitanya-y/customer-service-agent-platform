# Production identity boundary

Status: **design and prerequisites only**, 2026-10-02. No OIDC provider,
production customer/staff login, account mapping, or AWS resource is running.
The current local login is for disposable development customers and staff.

## Current seams and hard gate

- Customer Portal's `/api/local-session` stores a literal `active` HTTP-only
  cookie. `authorizeLocalCustomerRequest` then forwards one server-held local
  customer JWT; the cookie is not bound to a distinct user identity.
- Edge's `VerifyCustomerIdentity` interface is the correct replacement seam.
  `server.ts` currently wires only `createLocalCustomerIdentityVerifier`.
  `AUTH_MODE` supports only `local`, and production startup rejects that mode.
- Edge now centrally validates every verifier result as four bounded opaque
  IDs with a self-service principal/customer match before any route uses it.
  Synthetic regressions reject malformed and mismatched injected identities
  before a workflow read or agent intake. This protects the interface boundary
  but does **not** verify an OIDC token or map an external subject to a customer.
- Operations Console has analogous local cookie/server-token paths for refund,
  delivery, and chat staff. Human Operations verifies separate role/audience
  token types. Refund staff tokens now require bounded `iat`/`exp`, matching
  the delivery and chat lifetime policy; this does not create production login.
- After verifying a customer, Edge signs short-lived, audience-specific
  downstream context assertions. Those signed trust boundaries should remain
  while the login source changes. The model, chat text, or a client-provided
  tenant label must never become authorization authority.

Public access must stay disabled until each actual customer/staff session maps
to a stable internal identity and tenant scope. Merely replacing the local JWT
with an OIDC token in the browser would leave the shared server token and
literal cookie problem unsolved.

The [customer identity implementation plan](superpowers/plans/2026-10-02-production-customer-identity.md)
splits external-subject binding, Edge token verification, server-held browser
sessions, and proxy migration into testable units. It is a plan, not an
implemented provider integration. Staff identity remains a separate plan.

## Minimum migration sequence

1. Choose the identity provider and record issuer, audience, login domains,
   tenant mapping, staff-role source, account recovery, and revocation rules.
   Cognito/OIDC is the architecture target; no provider has been configured.
2. Implement a production Edge customer verifier behind
   `VerifyCustomerIdentity`. Verify signature against trusted JWKS, allowed
   algorithm, issuer, audience, expiry/not-before, key rotation, and exact
   server-side subject-to-customer and tenant mapping. Preserve the existing
   `AuthenticatedCustomer` and downstream assertion contracts.
3. Replace the Customer Portal's literal local cookie with a distinct,
   identity-bound server session. Test OAuth state, nonce and PKCE, secure
   HTTP-only cookie settings, CSRF/origin checks, logout, revocation and
   session renewal. No shared customer bearer token may serve all visitors.
4. Establish separate staff login and authoritative role assignment for the
   Operations Console. Carry verified staff identity and tenant into Human
   Operations while preserving refund, delivery and chat role separation.
   Do not infer a supervisor role from an untrusted token claim or UI state.
5. Test cross-tenant denial, wrong audience, stale key/session, account
   switch, revoked staff, and mapping mismatch through the real proxy/API
   boundary. Then rehearse a private deployment with disposable identities
   and no consequential refund execution.

Production session duration, key custody/rotation, customer-account linking,
and staff provisioning need explicit operational decisions. This document
does not make local 30-day tokens a production policy.

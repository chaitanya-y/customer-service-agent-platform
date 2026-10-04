# Recent order reference discovery

Status: design for a narrow, read-only customer support journey. It does not change the refund, cancellation, or payment workflows.

## Customer outcome

On the existing `/support` page, a signed-in customer who does not know an order reference can choose **Find my recent orders** and see up to ten latest placed orders as order reference and placement date. The page says when more orders exist and never claims that the list is complete. No model call is needed. The customer can then use a reference in the existing status, item, or payment-status chat path.

## Trust and data boundaries

- The browser supplies no customer ID, channel, filter, or sort. Its existing signed session is exchanged for an Edge assertion, then Gateway verifies the exact audience, tenant, environment, and subject.
- Gateway queries only that subject's Vendure customer within the configured channel. The installed `Customer.orders(options: OrderListOptions)` resolver binds the request channel and customer ID. Verify active channel code and every returned order's customer ID again before projection.
- Query at most eleven rows, sorted by `orderPlacedAt` descending, with `active=false` and `orderPlacedAt.isNull=false`. This excludes active carts and unplaced orders before paging. Return at most ten and derive `hasMore` from the eleventh.
- Public response is only `{schemaVersion:"1",orders:[{reference,placedAt}],hasMore}`. No addresses, customer profile, amounts, payment IDs, order contents, provider diagnostics, or raw GraphQL errors.
- Reject inconsistent owner, duplicate/invalid references, malformed dates, unexpected extra fields, partial GraphQL errors, redirects, timeouts, and channel mismatch. Return a generic unavailable response rather than a partial list. Use `Cache-Control: no-store` across browser-facing and internal routes.

## Implementation ownership

1. Gateway: canonical schema/contract, owner-and-channel-bound Vendure adapter, authenticated no-parameter route, and unit/contract tests.
2. Edge and Portal: narrow authenticated proxy/client, visible loading/empty/error/retry state, and UI tests. Keep the same `/support` link.
3. Integrate and verify: compare route shapes, run all affected tests and typechecks, then one authenticated local provider read. No mutation, Temporal workflow, new database, or model call is authorized by this journey.

## Acceptance

An authenticated local customer sees only their latest placed references; another customer and an unauthenticated caller cannot retrieve them. Empty and unavailable states are distinct. A reference copied from the card works in existing order-status chat. Browser manual QA is separate from API tests.

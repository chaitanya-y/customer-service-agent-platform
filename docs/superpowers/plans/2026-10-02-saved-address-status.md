# Saved-address status inquiry

Scope: a signed-in customer can ask whether saved addresses exist and whether a default shipping or billing address is set. This is a read-only account-support action on the existing `/support` page, not an address editor, order-address verification, or a refund path.

Implementation order:

1. Gateway owns a strict, versioned non-PII projection and a self-scoped Admin lookup. Use a configured provider channel, reject partial/malformed results, and publish no address text, names, phone numbers, or email. Add contract and focused tests first.
2. Edge verifies the customer token, signs the existing short-lived Gateway context assertion, calls the read-only Gateway endpoint with redirects disabled and a bounded timeout, and returns only a validated projection with `private, no-store`. It never invokes Agent Runtime or Temporal for this action. Add failing route/client tests before implementation.
3. Customer Portal adds an explicit `Check saved addresses` action and status card on `/support`. Its same-origin proxy forwards the existing customer authentication, does not cache, and renders no private address fields. Add parser and proxy tests first.
4. Run focused tests, type checks, builds, contract suite and relevant cross-service regression tests. Do one bounded local API check only if the configured channel and customer fixture can be verified without exposing secrets. Browser QA is not implied by backend tests.
5. Document observed behavior and unsupported account changes in the verification record.

Ownership: Gateway/contract worker edits Gateway and contract files; Portal worker edits only Customer Portal files; coordinator edits Edge files and integration documentation. Preserve unrelated dirty work. No paid model call, account mutation, refund call, secret rotation, commit, or deployment is part of this slice.

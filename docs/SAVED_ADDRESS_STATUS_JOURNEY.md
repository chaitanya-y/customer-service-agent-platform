# Saved-address status inquiry

Implemented locally on 2026-10-02 as a narrow, read-only account-support action on the existing Customer Portal `/support` page. A signed-in customer can select **Check saved addresses**. The result gives the number of saved addresses and whether a default shipping and billing address is set. It does **not** show an address, confirm the delivery address on an order, or change an account.

## Trust path

1. The Customer Portal calls its same-origin `/api/account/saved-address-status` proxy. The proxy uses the existing customer session and forwards the server-held bearer to Edge; browser-supplied customer identifiers are ignored.
2. Edge verifies the local customer token, derives tenant/environment/customer identity, signs a short-lived `customer_support` context assertion for Integration Gateway, and calls `GET /v1/account/saved-address-status`. It does not call Agent Runtime, RAG, Temporal, or refund execution.
3. Gateway verifies the assertion and derives the Vendure customer ID from its subject. The configured tenant/environment and explicit Vendure channel token/code must match. Its Admin query requests only `activeChannel.code`, `customer.id`, and two default-address flags per saved address. It requests no name, street, phone, email, or payment data.
4. Gateway rejects missing/mismatched customers, wrong channels, partial GraphQL errors, malformed address data, and contradictory multiple defaults. It returns only the four-field `saved-address-status/v1` projection. Edge and Portal independently validate that exact shape and reject extra fields. Requests are bounded, redirects are refused, and responses are not cached.

This is an HTTP action rather than an agent-accessible MCP tool: the customer explicitly chooses the read, and address-account facts never enter an LLM prompt or a chat transcript. The page's status card is in-memory; refreshing requires another read.

The same card now also offers an optional **Talk to a person about saved
addresses** consultation. This is a separate explicit action that reuses the
existing versioned human-chat handoff, not the address-status HTTP read. It
does not copy address counts or address details into a synthetic message, does
not make an account mutation, and never describes a queued request before the
handoff server confirms it. The button is disabled when handoff is unavailable
and hidden once the conversation is queued, human-controlled, or closed.
Staff must independently verify account facts; customers are asked not to put
full addresses or payment details in the chat.

## Verification and limits

The new Gateway tests, Edge tests, Portal tests, and canonical contract test passed. A bounded live local provider read for the configured test customer returned one saved address with both defaults set. A separate signed Edge-to-Gateway local API call returned the same four-field projection and HTTP 200 with `private, no-store`. These checks did not edit the account, call a model, create a refund, or prove browser click-through or production identity.

Address creation, modification, deletion, and selecting a shipping address for an existing order remain unimplemented. Those would require an approved field policy, explicit consent for exact changes, provider-side concurrency checks, durable idempotency and authoritative reread before confirming success. Do not infer that a default saved address is the address used on a particular order.

The consultation addition has two red-green UI/handler tests and the combined
Customer Portal suite passed 148/148, with typecheck and production build
passing. Manual browser validation remains pending; no model, provider write,
or real account update was performed for this addition.

# Payment-status support implementation plan

Date: 2026-10-02. The accepted contract is
`contracts/tools/payment-status/v1/payment-status.schema.json` and the design
is `docs/superpowers/specs/2026-10-02-payment-status-support-design.md`.

1. **Gateway owner:** add a dedicated owner-checked read-only MCP tool and
   aggregate Vendure payment/refund states without private fields. Test state
   boundaries, mixed attempts, foreign orders, and exact response keys.
2. **Agent Runtime owner:** add a strict MCP DTO/client, deterministic specialist,
   and classified route. Keep informational payment/refund status separate from
   a new refund request. Test current-turn routing and answer wording.
3. **Coordinator:** add Edge's strict read-only response variant and no-Temporal
   regression, run canonical contract tests, review integration, and update
   support/verification docs.
4. **Verification:** focused tests first; then full affected service suites,
   typechecks, one bounded local read-only chat trial if healthy, and a negative
   foreign-order check. Never perform a payment/refund mutation in this test.

Non-goals: payment methods, card or transaction details, invoices, changing a
payment, issuing a refund, bank-settlement timing, provider webhooks, and
production identity. No storefront edits, deployment, or Git actions.

# Recent order references in support chat

Status: implemented locally on 2026-10-02; offline and authenticated local
backend chat checks passed. Browser walkthrough remains pending.

## Customer path

The existing `/support` chat accepts narrow questions such as “What are my
recent orders?” The deterministic router selects `recent_orders`, without a
model call or refund graph. The Agent Runtime passes its already-verified,
audience-specific Gateway assertion to the no-argument
`lookup_recent_order_references` MCP tool. The Gateway reuses its existing
Vendure read for the authenticated customer, configured tenant and channel.
Edge accepts only a customer-safe read-only answer and persists it in the same
conversation. It never starts Temporal or carries a refund proposal.

The answer contains at most ten placed-order references, newest first. If the
source reports more, it says more may exist. It does not call this a complete
history and does not infer status, delivery, payment, refundability, invoice,
or details from the list. A zero-row result says no recent placed orders were
found for this account. It is not a proof that the customer has never ordered.

## Authorization and failure boundary

The Gateway source checks tenant, environment, configured Vendure channel,
active channel, customer ID, each returned row's owner, descending order,
uniqueness and page size. The MCP tool takes `{}` only. Agent Runtime
independently validates the strict three-field projection before showing any
reference. Missing context, a source outage, malformed or extra fields, and
inconsistent partial pages fail closed to a generic unavailable message. A
valid ten-row page that has more results is displayed with an explicit caveat.
A question mixing
the list with a refund, cancellation, payment status, or a specific order
status is clarified instead of silently selecting an action.

## Verification and limits

The first offline run passed Agent Runtime 611 tests, Edge API 172 tests and
root contracts 112 tests. The Gateway colleague's tool run passed 350 tests,
typecheck and build. After restarting only the stateless Agent Runtime to load
the new route, one authenticated local Edge conversation
`01a0fceb-2d0b-7348-8d4a-61b2676b81e8` returned a bounded reference-list
answer, persisted the exact customer/assistant turn, and exposed no refund or
cancellation action in the response or transcript. The smoke script's two
unit tests also passed. This proves the current local backend path, not an
independent audit of the provider rows, data freshness, another tenant/channel,
browser rendering, or zero internal writes. No paid model was called and no
commerce mutation was requested for this path.
The Gateway endpoint is configurable through Agent Runtime's
`INTEGRATION_GATEWAY_MCP_URL`, which defaults to the local address. All three
read-only MCP clients share it; the configuration passed unit tests but has not
been exercised across separate containers.
The first smoke before that restart failed its bounded-answer check because
the running Agent Runtime predated this code; it also created a chat turn.
The passing observation applies only to the restarted process.

For an opt-in repeat with a valid private customer token loaded from its
ignored local environment file, use Node 24. The script creates a new
conversation; it prints only pass/fail, conversation ID, and answer kind, not
the token or order references:

```bash
node --env-file=apps/web/customer-portal/.env.local tools/local/verify-recent-orders-chat.mjs --run
```

Do not use the result to initiate a refund or assume it is a full commerce
history. Browser QA and an independent owner/source audit remain separate.

# Read-only support journeys

The customer uses the existing authenticated `/support` chat for order status,
product and policy questions, and refund requests. There is no second chat link.
Each message is persisted in Conversation Runtime and sent through Edge API to
Agent Runtime's `/support/intake` endpoint. The router classifies the current
turn; prior refund discussion alone cannot authorize a new refund action.

| Current turn | Specialist | External source | Refund workflow |
| --- | --- | --- | --- |
| Recent placed-order references | Recent orders | Gateway `lookup_recent_order_references` | Never |
| Order status or tracking | Owned-order status | Gateway `lookup_order_status` | Never |
| Items and quantities in an order | Owned-order items | Gateway `lookup_order_items` | Never |
| Payment or refund status question | Owned-order payment status | Gateway `lookup_payment_status` | Never |
| Explicit order-total question | Owned-order tax-inclusive total | Gateway `lookup_order_total` | Never |
| Product question | Product and policy | Gateway `lookup_product_catalog` | Never |
| Named product variant stock question | Product and policy | Gateway `lookup_product_catalog` indexed variant status | Never |
| Policy question | Product and policy | Knowledge/RAG customer-safe evidence | Never |
| Ambiguous or mixed request | Clarification | None | Never |
| Explicit refund action | Existing refund graph | Existing governed sources | Only for a validated ready proposal |

The read-only response carries a short customer answer and a journey-specific
status. It cannot carry a refund proposal. Edge rejects malformed or mixed
response variants, appends the answer to the same conversation, and starts and
links Temporal only for the validated `refund_proposal_ready` variant. The
legacy direct `/refunds/intake` route remains available for compatibility.

## Authorization and source limits

Edge authenticates the customer and signs separate Agent Runtime, Integration
Gateway, and Knowledge/RAG assertions. Agent Runtime verifies their audiences
and matching customer, tenant, environment, request, and routing context before
classification or tools. Gateway only looks up orders owned by that customer;
missing and other-customer orders receive the same answer. A status answer uses
verified order, fulfillment, and tracking fields only. It does not promise an
arrival date or disclose internal IDs or payment data. A payment-status answer
uses only an owner-checked aggregate state: order reference, bounded payment
status, and bounded refund status. It never passes a transaction ID, card or
bank details, payment method, provider reference, or amount to the answer
specialist. Unknown or inconsistent commerce states, including missing or
repeated provider payment/refund IDs, map to `UNCERTAIN`, not a success claim.
Payment-only and refund-only questions mention only the asked
aspect; neither starts a refund. An item answer uses a
separate, owner-checked projection containing only the order reference, item
names, and quantities. Invalid, oversized, or mismatched projections fail
closed rather than returning a partial list. The item specialist does not
receive prices, SKUs, payment details, or internal item identifiers. OrderItems
v1 means current quantities only and now fails closed for cancelled orders;
historical `orderedQuantity` must not be described as current contents.
The separate [order-total path](ORDER_TOTAL_JOURNEY.md) returns only the
owner-checked current tax-inclusive total and currency. It does not say the
customer paid that amount, that it remains due or refundable, or that an
invoice exists. Mixed payment/invoice/refund questions clarify rather than
reuse the total as financial proof.

The [recent-order-reference path](RECENT_ORDER_REFERENCES_JOURNEY.md) returns
at most ten owner-checked placed-order references in newest-first order. It
does not provide complete account history, order status, payment, delivery,
or refund eligibility. Mixed questions clarify rather than select an action.

Product lookup uses the Vendure Shop API for the configured tenant/channel and
returns at most five public matches. The result omits internal IDs. An absent
channel binding fails closed; it never falls back to another tenant's catalog.
An explicit question such as “Is Cloud Hoodie Blue / Small in stock?” now uses
Vendure's indexed `inStock` flag for that **named variant only**. The answer
states that availability can change and does not reserve an item. It does not
infer stock for a whole product from a truncated result, expose stock counts,
promise delivery, or enter the refund workflow. A product-only or duplicate
variant match asks for clarification; missing or malformed stock data makes
the lookup unavailable. Gateway rejects an incomplete Vendure search page and
products above its 100-variant cap rather than treating the visible subset as
complete. The older optional product-level availability field
is accepted for contract compatibility but is not emitted or used as answer
authority. This is a search-index snapshot, not a live inventory guarantee.
On 2026-10-02 a bounded local API test used the existing customer assertion
to ask about a named Laptop variant through Edge. The answer used the indexed
in-stock state and no-reservation caveat, with no refund workflow. A Shop API
read confirmed the stock field is present for the local default channel. The
browser path and stock-index freshness have not been verified.
Knowledge/RAG keeps its server-owned tenant, locale, effective-time, release,
and `CUSTOMER_SAFE` filters. Policy answers use only supported, verified source
facts with a readable title and section citation; unsupported or ambiguous
claims receive a short unavailable answer rather than a guess. Read-only turns
do not mutate commerce or open Human Operations.

For the three exact generic return-policy phrasings, retrieval now uses the
same bounded change-of-mind query as the generic exchange discussion. The
answer still requires the exact conditional `CUSTOMER_SAFE` sentence and a
valid citation; a targeted query is **not** itself policy evidence. Other
return or product-specific questions retain their existing query path. A
query-sensitive regression was red before the change and green afterward;
one fresh authenticated local chat returned the cited conditional rule with
no workflow link. A later bounded check on 2026-10-02 sent each of the three
exact phrasings once in a fresh local Edge conversation. All three answers
contained the conditional rule, policy title, and no refund/cancellation
action link (conversation IDs `01a0fcc0-b446-717c-9000-fc6b4551b045`,
`01a0fcc0-d0c2-7558-864a-dc8ed1da5dc1`, and
`01a0fcc0-e1c9-745e-a68c-962148a96d0b`). These three first-turn
observations are not a statistically meaningful reliability estimate, a
browser test, or evidence for other tenant policies.

### Opt-in local named-variant backend smoke

With the local Edge, Conversation Runtime, Agent Runtime, Integration Gateway,
and Vendure Shop catalog ready, use Node 24. Load the **existing** private
customer login token into the process environment as
`CSO_LOCAL_CUSTOMER_TOKEN` using your local secret-management method. Do not
paste the token into the command line, print it, or copy it into a tracked file.
Choose one full, published variant name from the configured Vendure channel;
the example below is valid only while that exact local variant exists.

```bash
node tools/local/verify-variant-availability.mjs --run --variant="Laptop 13 inch 8GB"
```

`--run` is required. The check creates a fresh authenticated Edge conversation,
asks only `Is <exact variant> in stock?`, and reads the persisted transcript. It
accepts either indexed in-stock or out-of-stock status only when the answer
names the exact variant, says availability can change, and says no item was
reserved. It fails if the Edge response or transcript includes a refund
workflow link. The script makes no commerce or Temporal requests and uses the
current deterministic stock route, which does not call a paid model. It does
persist one customer/assistant chat turn; this is not a dry run of conversation
storage. A pass does not independently prove the server made zero internal
commerce writes or that Vendure's search index reflects real-time inventory.
No live execution is required for the mocked tests:

```bash
node --test tools/local/tests/verify-variant-availability.test.mjs
```

The safe policy question set is intentionally narrow: unfamiliar wording can
return `source_unavailable` even when a relevant document exists. Likewise,
unusual but legitimate refund wording can return a clarification instead of
starting a workflow. These are deliberate availability tradeoffs at the
read-only/refund safety boundary, not evidence that the request was approved.

## Reference and financial-data hardening on 2026-10-02

A current message that names multiple order references, or one that conflicts
with the separately entered order-reference field, now asks the customer for
one reference before the status or item specialist calls a tool. A stale field
must not silently select another owned order. Case-insensitive agreement,
explicit-only requests, and prior-turn context remain supported. Agent Runtime
passed 458 offline tests and Ruff checks after 15 focused regressions.

The Vendure adapter now requires an explicit payment list and an explicit
refund list for each payment. `null` or missing provider data fails closed as
unavailable; it is never converted to an empty list and described as “no
payment” or “no refund.” Truly empty arrays still permit the corresponding
negative status. Gateway passed 170/170 tests, typecheck, and build. These are
offline safety checks, not a new live provider or bank verification. The
evaluation-runner regression suite subsequently passed 298/298 offline tests.

## Vendure channel boundary and local configuration

Follow [LOCAL_REFUND_RUNBOOK.md](LOCAL_REFUND_RUNBOOK.md) for the full stack,
ports, local customers, and expiring assertions. The Gateway channel binding
is now **required** for its general Admin order reads, refund execution, and
the locally enabled zero-total cancellation adapter, as well as the catalog
and account-support reads:

```dotenv
VENDURE_SHOP_API_URL=http://127.0.0.1:3001/shop-api
VENDURE_CHANNEL_TOKEN=<channel-token-for-the-configured-tenant>
VENDURE_CHANNEL_CODE=<expected-Vendure-active-channel-code>
```

Put these only in the Gateway's local `.env`, never in this document or Git.
The channel token must select the Vendure channel intended for Gateway's fixed
`TENANT_ID`. Gateway sends it on the Admin order request, checks Vendure's
`activeChannel.code` against `VENDURE_CHANNEL_CODE`, and refuses to start
without a nonblank binding. It also checks the returned channel for catalog,
recent-order, saved-address, and cancellation reads. A refund mutation gets
the token and a fresh channel-checked order/payment preflight. These checks
do not make the refund preflight atomic with Vendure's mutation; exact
authorization, reconciliation, and provider-side controls remain necessary.
Missing configuration, malformed channel data, or a mismatch makes product
and order answers unavailable rather than falling back to another channel.
The current Gateway process is bound to one configured tenant/channel pair;
it is not a per-request multi-tenant channel registry.
Generic policy answers can still use Knowledge/RAG without catalog access.
Agent Runtime also needs its configured model and Knowledge/RAG settings, and
all three services must use the same assertion signing secret with the correct
audiences. No new environment variable is required for support routing.

## Verification and browser smoke

Offline tests cover contracts, tenant-bound catalog lookup, specialist
formatting, assertion rejection, current-turn route isolation, a five-turn
conversation, and the no-Temporal rule for read-only answers. These tests use
fakes and do not spend model tokens or perform refunds.

For an authorized live smoke, sign in as one test customer, then use the same
`/support` conversation for these turns:

1. Ask where an owned order is. Expect a status/tracking answer only and no
   refund workflow link. Ask about a different customer's or nonexistent
   reference; expect the same safe unavailable wording.
2. Ask which items and quantities are in the same owned order. Expect an item
   list in the same conversation and no refund workflow link. Ask about a
   different customer's or nonexistent order; expect the same safe unavailable
   wording. This is an item lookup, not a refund selection or authorization.
3. Ask a generic return-policy question. Expect a concise source-supported
   answer or an explicit unavailable answer, with no refund workflow.
   Ask for the same order's total separately. Expect only the tax-inclusive
   current total and currency; asking for an invoice or amount paid must not
   turn that total into a payment claim.
4. Ask about a product in the configured Shop channel. Expect only published
   catalog facts; ambiguous matches should ask which product. With no channel
   mapping, expect an unavailable answer, not another channel's products.
   Ask whether one precisely named variant is in stock. Expect only its
   indexed status plus the no-reservation caveat; ask about only the product
   name or a mixed stock/refund request and expect clarification, not a stock
   or refund action claim.
5. Ask an ambiguous mixed question. Expect clarification and no workflow.
6. Only if a refund test is separately authorized, send an explicit current-turn
   refund request. The existing governed refund flow must still require its
   normal customer confirmation and human approval gates.
7. After the refund turn, ask for order status or its items again in the same
   conversation. It must remain read-only despite the earlier refund discussion.

These offline results do not prove live model wording, Vendure catalog data,
or an end-to-end browser journey. A live smoke can invoke paid model calls and
must be explicitly approved before running it. Do not confirm or settle a
refund merely to test these read-only journeys.

## Local browser smoke on 2026-10-01

With the Gateway bound to the local test customer's Vendure channel, the same
authenticated `/support` conversation returned the owned order's Delivered
state and local tracking code, published Laptop variants and USD prices, and
the photo-evidence requirement with its customer-safe Acme policy citation.
None of these turns produced a refund workflow link or a commerce action.

This smoke exposed two answer-path defects that now have regression tests:
an explicitly named product could be searched as the whole question or an
overbroad model hint, and a generic photo-policy question could be mistaken
for a product question. The photo rule now uses an exact retrieved sentence
through the existing citation validator, without depending on model span
selection. The Agent Runtime suite passed 319 tests after those changes.

The generic question "What is your return policy?" returned a safe unavailable
answer during that earlier smoke. An offline regression now permits the exact
customer-safe Acme change-of-mind sentence, including its unopened,
non-final-sale, 14-calendar-day, return, and inspection conditions, only when
that sentence appears in retrieved evidence with a valid citation. It still
fails closed when the source wording changes or evidence is missing. The full
Agent Runtime suite passed 323 offline tests after this change.

## Bounded live API smoke on 2026-10-01

Gateway's local Shop token selected Vendure channel `__default_channel__`;
the ignored local `.env` now binds that exact code. One new authenticated
conversation through Edge API and the configured Agent Runtime model exercised
three read-only turns, with no retries:

| Customer turn | Observed result | Refund workflow |
| --- | --- | --- |
| Where is my order `9KWUQ1TBZ7NUV8EU`? | Delivered, with local tracking code | None |
| Do you sell Laptop 13 inch 8GB? | Published catalog variant and USD price | None |
| What is your return policy? | Exact conditional change-of-mind rule and Acme policy citation | None |

All three message requests returned HTTP 202 and no refund workflow. This
confirms the backend chat path with real local services and model calls, not a
fresh browser UI or payment-provider test. No refund was requested, confirmed,
created, or settled by this smoke.

## Browser smoke on 2026-10-02

The authenticated customer chat returned the owned order's Delivered state
and tracking code without a refund link. A named Laptop variant initially
received an unnecessary product clarification: Vendure's published variant
name includes the product name, while the answer relevance check expected only
the suffix. The relevance check now accepts either exact variant naming form
while retaining the unrelated-product rejection; a unit test and offline
evaluation case cover the live failure. The same browser question then
returned the published variant and USD price.

The first return-policy turn returned the safe unavailable answer; one repeat
returned the exact conditional Acme change-of-mind rule with a customer-safe
citation. The cause of the first unavailable result is not established by this
smoke, so it should not be treated as evidence of reliable first-try policy
answers. No browser turn initiated or executed a refund.

## Owned-order items slice on 2026-10-02

The authenticated customer can now ask for item names and quantities in an
owned order in the same `/support` chat. Gateway's separate
`lookup_order_items` tool checks ownership before producing the minimal
projection. Agent Runtime formats a bounded deterministic answer; Edge accepts
only the strict read-only `order_items` variant and cannot start Temporal from
it. Missing and other-customer orders have the same customer-facing wording.

Fresh offline checks passed 105 contracts, 83 Gateway tests, 354 Agent Runtime
tests, 101 Edge tests, and 281 evaluation-runner tests. Gateway, Edge, and
customer-portal TypeScript checks passed; changed Python files passed Ruff
check/format. Repository-wide format checking still flags pre-existing,
unrelated files, so that result is not claimed as clean.

One bounded live API smoke used the configured model and an existing owned
local order. The answer was exactly “Order 9KWUQ1TBZ7NUV8EU contains: 1 ×
Laptop 13 inch 8GB.” Edge returned HTTP 202, the conversation transcript held
the customer and assistant turns, and it had zero refund workflow links. This
proves the local backend path, not a new browser UI test or another customer's
ownership denial. The offline evaluation fixture simulates the missing and
non-owner outcomes; Gateway tests separately prove the actual owner check.

## First policy-answer cold-start diagnosis on 2026-10-02

Sanitized local traces identified a likely first-request cold-start timeout in
Knowledge/RAG. In the earlier of two customer-evidence calls during the
diagnostic window, Agent Runtime's evidence lookup ended with a server error
after 10.019 seconds, while Knowledge/RAG completed the same HTTP request with
200 after 10.389 seconds. The first timed RAG phase began 8.516 seconds after
the RAG request started; the measured embedding, search, fusion and reranking
phases then took about 1.9 seconds total. The later evidence request completed
in 1.259 seconds, with its first measured phase starting 3 milliseconds after
request start. Trace privacy filters intentionally omit customer text, so this
pair is strongly consistent with, but cannot directly prove, the first/retry
return-policy turn mapping.

The delay matched the lazy construction path: Knowledge/RAG built and cached
its customer-evidence retriever during first request dependency resolution,
including synchronous CrossEncoder loading before timed retrieval phases.
Agent Runtime's evidence client has a 10-second timeout and fails closed to the
safe unavailable answer when that boundary is exceeded.

Knowledge/RAG now initializes the same cached retriever during application
startup, before its health endpoint can report ready. This moves CrossEncoder
loading to startup and keeps the first customer request from paying that
construction cost. The tradeoff is slower service startup while the model loads;
if initialization fails, startup fails rather than serving requests with an
unwarmed retriever. An offline lifecycle regression uses a fake retriever and
proves construction precedes health and is reused. The Knowledge/RAG suite
passed 107 tests and Ruff lint passed. The service was then restarted and
`/health` returned 200 after startup. One bounded first post-restart customer
policy turn returned HTTP 202 with the exact conditional 14-day Acme rule and
a customer-safe source citation; no refund link appeared. This is one successful
post-fix trial, not a reliability measurement or proof that every first query
will meet the timeout. The RAG retriever construction itself was not timed in
this smoke.

## Payment and refund status slice on 2026-10-02

The shared authenticated chat now answers whether payment was recorded and
whether an existing refund is pending or completed. This is an informational
lookup, not a refund request, eligibility decision, payment attempt, or
settlement operation. Gateway checks order ownership before returning the
four-field `payment-status/v1` projection. Agent Runtime formats the answer
without an LLM-generated financial claim. Edge accepts only the strict
read-only variant and cannot attach a refund proposal or start Temporal from
it. Missing and other-customer orders get the same unavailable response.

Offline verification passed 393 Agent Runtime tests, 99 Gateway tests, 118
Edge tests, 107 contract tests, and 281 evaluation-runner tests. The payment
evaluation adds seven synthetic cases, for 26 cases and 52 trials total. It
uses a strict network-free fake and checks selective wording, unavailable
orders, malformed projections, required lookup, and forbidden refund actions.
Gateway and Edge typechecks passed. The review also found and fixed common
declined, authorized, and received-payment phrasings that had been routed to
clarification.

One bounded local backend check used the existing owned test order
`9KWUQ1TBZ7NUV8EU` in a single conversation. A payment question returned
“Order 9KWUQ1TBZ7NUV8EU has a recorded payment.” A second turn asking the
refund status returned “Order 9KWUQ1TBZ7NUV8EU: A refund is recorded as
completed.” Both message submissions returned HTTP 202, and neither response
or transcript contained a refund workflow link. The check did not create,
confirm, or settle a refund. It establishes this local backend path only;
fresh browser UI QA and production provider/webhook behavior are unverified.

## Read-only answer binding hardening on 2026-10-02

Focused review found three offline-reproducible defects. Order status accepted
a valid-looking tool result for a different reference; Gateway and Agent
Runtime now require the provider's reference to equal the requested reference.
An individually valid but long fulfillment list could exceed the customer
answer limit and raise an uncaught validation error; that now fails closed to
`source_unavailable`. A request for a specific catalog variant could render
the first two other variants instead of the requested one; exact matches now
render only that variant and its price, ambiguous matches clarify, and missing
prices fail closed. These checks do not establish catalog completeness or
first-try RAG reliability.

## Multi-fulfillment tracking wording, 2026-10-02

Vendure's local fulfillment records expose state and an optional tracking
code, but no authoritative carrier, tracking URL, or ETA. The existing
owner-checked order-status tool already projects the narrow facts. The answer
formatter now keeps each code beside its corresponding fulfillment when an
order has multiple fulfillments; it no longer publishes separate status and
code lists that could imply the wrong pairing. The zero- and one-fulfillment
wording is unchanged. Non-printable provider status or tracking values cause
the answer to fail closed. Four test-first regressions covered mixed codes and
control characters; 23 focused and 520 full Agent Runtime tests passed, plus
Ruff lint. Agent Runtime was restarted locally and its health check passed.
This is not proof of a real carrier scan or delivery estimate.

## Failure-specific refund-status wording, 2026-10-02

The four-field, owner-checked payment projection is an **order-level**
summary. It does not identify individual refund attempts. A completed or
partial aggregate refund therefore cannot answer whether a particular
attempt failed. Failure-specific customer questions now include the aggregate
fact and this explicit limit; a `FAILED` aggregate says an attempt **did not
complete**, because the underlying projection includes failed and cancelled
attempts. Passive questions such as “Did my refund fail?” route to the
read-only payment-status specialist, while an imperative request to complete
a refund still does not enter this path. The Agent Runtime suite passed 528
tests with Ruff checks after test-first regressions.

One authenticated local Edge turn asked “Did my refund for order
9KWUQ1TBZ7NUV8EU fail?” It answered: “A refund is recorded as completed.
This order-level summary cannot confirm the outcome of a particular refund
attempt.” The resulting conversation
`01a0fca2-140c-744f-a781-db74ae793386` had two persisted messages and
no refund workflow or cancellation request. This is one read-only backend
check, not a browser or provider-attempt audit. No refund was initiated.

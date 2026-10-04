# Verification Status

Verification evidence through 2026-10-02; documentation consistency checked 2026-10-04

## Bounded large-refund RAGAS diagnostic

One current-code synthetic `$750` vs `$500` specialist-review case was run
twice, with no further retry: the first attempt was rejected before scoring
(`DELIVERY_AGE_TEXT_REJECTED`, 4,831 measured tokens), while the second
produced the reviewed concise answer and passed the blocking policy checks
(26,514 measured tokens). Response relevancy was 0.5516, below the fixture's
non-blocking 0.7 target. No refund or commerce mutation occurred. This is
not a reliability pass or closure of the frozen RAGAS gate. See the
[diagnostic record](evaluation/RAGAS_LARGE_REFUND_2026_10_02.md) for versions,
artifact hashes, and limitations.

## Admin Console image checkpoint

The Admin Console proof staged 16 reviewed files (177,410 bytes) and built a
91,341,862-byte arm64 Next.js standalone image. Offline non-root, read-only,
network-disabled audit passed its compiled placeholder page, static assets,
and Next/React imports. No server or admin request ran. This is an
unauthenticated placeholder, not an operational control plane. See
[AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

## Operations Console image checkpoint

The Operations Console proof staged 65 reviewed files (305,522 bytes) and
built a 91,837,204-byte arm64 Next.js standalone image. Offline non-root,
read-only, network-disabled audit passed compiled staff routes, static assets,
Next/React imports, and Sharp. No server or staff request ran. Current local
staff logins are disabled in production. See
[AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

## Customer Portal image checkpoint

The Customer Portal proof staged 67 reviewed files (352,495 bytes), built a
91,820,484-byte arm64 Next.js standalone image, and passed an offline
network-disabled, read-only, non-root audit of routes, static assets,
Next/React imports, and Sharp. The container compile itself used no network
after dependency installation. No server or authenticated request ran; current
local login is disabled in production. See
[AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

## Knowledge/RAG image and packaging-guard checkpoint

The Knowledge/RAG proof staged 35 reviewed files (304,008 bytes) and built a
314,933,060-byte arm64 image using the newly locked Linux CPU-only PyTorch
wheel. Its offline, network-disabled, read-only, non-root audit imported the
production dependencies and invoked the ASGI `/health` route without lifespan.
Knowledge/RAG tests passed 155/155, Ruff and the offline frozen-lock check
passed, and the shared image-proof/negative-input suite passed 39/39. The
shared staging guard now rejects symlinked ancestors and hidden/sensitive
components; it is not a defense against concurrent filesystem mutation. No
reranker weights were packaged. A separate offline container run mounted the
exact pinned local cache read-only and ranked two synthetic sentences on CPU.
No OpenSearch connection, configured retrieval startup, index, or customer
document was tested. See [AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

The follow-up RAG image defaults both Hugging Face and Transformers to
offline mode. Its image metadata audit checked those defaults without
overriding them. The updated 35-file, 304,209-byte context built a
314,933,144-byte arm64 image; the network-disabled, read-only dependency and
ASGI health audit passed. The focused verifier tests passed 6/6. The pinned
model cache remains an external deployment asset. A network-disabled,
read-only run with no cache mount raised `OSError` on pinned cross-encoder
construction as expected. No checksum manifest or configured retrieval
startup was tested.

An explicit local `linux/amd64` Knowledge/RAG build was then verified as
architecture `amd64` (353,963,008 bytes). The x86 image passed the same
network-disabled, read-only, non-root dependency import and HTTP-only ASGI
health audit, without lifespan, ports, OpenSearch, or model asset. The updated
fake-Docker invocation tests and full image-input suite passed 39/39, including
the symlinked-checkout-root regression. During
the first test-harness attempt, a fake CLI failed to intercept Docker and a
cached native build reached image export before timeout; no child remained.
The harness was corrected and proved to intercept all four calls before the
single intentional amd64 run. No customer or cloud action occurred.
A separate amd64, network-disabled, read-only run mounted only the pinned
existing local model cache and passed a two-sentence synthetic CrossEncoder
ranking check. Model provisioning and real retrieval remain untested.

## Named-variant availability local chat checkpoint

With the existing local stack healthy, an authenticated customer chat asked
whether the exact catalog variant `Laptop 13 inch 8GB` was in stock. The
model-free route returned the bounded `IN_STOCK` answer and persisted the
two-message transcript in conversation `01a0fd26-9393-7409-8d5e-fe5d16293e62`.
The smoke asserted that no refund or cancellation workflow was returned.
This is one local read-only trial, not a stock reservation, browser test,
or repeated-trial reliability result. The local token's expiry metadata was
in the future; the readiness probe did not verify its signature.

## Read-only payment and cancelled-item truth checkpoint

An independent code audit found two customer-answer risks. Duplicate provider
payment/refund identifiers could be summed twice and falsely turn an aggregate
into `PAID` or `REFUNDED`. A red-first Gateway regression reproduced the false
`PAID` result; the projection now returns `UNCERTAIN` for missing or repeated
identifiers, including refund IDs repeated across payments. Normal multi-record
fixtures now use distinct IDs.

OrderItems v1 describes **current** quantities. It previously substituted
`orderedQuantity` after a cancellation, causing the Agent to say an order
“contains” its historical quantity. Gateway now fails closed for every
`Cancelled` order on this v1 tool; the underlying owner-checked order context
still retains current zero and historical ordered quantity separately. A later
versioned history contract is needed to answer “what was originally ordered?”
without ambiguous wording. Old Gateway instances must be updated before this
truth fix is effective; an Agent-only rollout cannot repair old v1 payloads.

After both changes, Gateway passed 352/352 tests and typecheck; Agent Runtime
passed 626/626, root contracts 112/112, and relevant Ruff lint passed. These
are offline synthetic checks. No live cancelled-order chat or provider write
was run for this fix. The dated cancellation trial below records its historical
behavior and is superseded for current item-answer expectations. The running
local Gateway was not restarted for this code-only check; restart it before a
manual browser/API recheck of the corrected answers.

## Agent Runtime image checkpoint

The Agent Runtime proof staged 39 reviewed files (382,629 bytes) and built a
74,149,844-byte arm64 image. A network-disabled, read-only, non-root audit
imported the FastAPI app and invoked only its ASGI `/health` route. It verified
the refund-policy catalog and absence of test tools and sensitive paths. No
model, Gateway, RAG, commerce, database, or Temporal call ran. The official
Python image contains a public `GPG_KEY` environment variable; the metadata
audit allows that single name, not other credential-shaped names. See
[AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

## Worker and Human Operations image checkpoint

The Workflow Worker local proof staged 33 reviewed files (302,763 bytes),
built an arm64 image, and passed an offline non-root audit that loaded policy
v1/v2 and bundled emitted `dist/workflows.js` with the actual Temporal SDK.
The initial image produced source-map warnings because source-map references
to TypeScript files could not resolve in the runtime image. Emitted maps now
contain the source content, and the latest offline proof passed an explicit
zero-warning audit. No Temporal server, task queue, history replay, or
business action was involved. Human Operations staged 46 reviewed files
(390,352 bytes), built an arm64 image, and passed an offline audit of six SQL
migrations, runtime dependencies and synthetic Sharp image processing. No
database migration, case action or upload was run. The later full image-proof
staging/negative-input suite passed 34/34. See
[AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

## Conversation image and Worker entrypoint checkpoint

Conversation Runtime's isolated local image proof staged 25 reviewed files
(292,577 bytes), sent 315.9 kB to Docker, built an arm64 image, and passed a
network-disabled, read-only, non-root runtime audit. The three service context
tests plus Conversation's no-write default passed 4/4. No Conversation server,
database, or Edge connection was tested in the container.

A separate compiled-Worker check found that `dist/refund-worker.js` named a
nonexistent `.ts` workflow entrypoint. A red-first path test established the
failure; the Worker now chooses source `.ts` or emitted `.js` from its own module
path. Focused tests passed 2/2, full Worker tests 113/113, typecheck/build
passed, and the resolved compiled workflow file exists. The Worker image was
subsequently audited offline (above); no production Temporal run was tested. See
[AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

## Gateway container packaging checkpoint

The Integration Gateway now has a pinned Node 24 multi-stage local proof image.
Its explicit staging allowlist contained 53 files (370,637 bytes); Docker sent
416.3 kB rather than the repository root. The Edge and Gateway staging tests
passed 2/2. The Gateway image built successfully and its network-disabled,
read-only, non-root runtime audit passed production imports, no development
dependencies, and no sensitive paths. Only the local image was retained; the
audit container was removed. Gateway was not started in the image, and no
database, Temporal, Vendure, cross-container MCP, AWS, or commerce operation was
tested. See [AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

## Recent-order-reference chat checkpoint

The existing authenticated chat now has a narrow, deterministic recent-order
reference answer. Gateway's new zero-argument MCP tool reuses the existing
owner-checked Vendure list; Agent Runtime independently validates the bounded
ten-reference projection, and Edge accepts only read-only customer text. A
mixed status/refund/payment/cancellation question clarifies. Agent Runtime
622/622, Edge API 172/172, Gateway 350/350 and root contracts 112/112 tests
passed; Gateway/Edge typechecks and Gateway build passed. After Agent Runtime
restart, one authenticated local Edge chat returned a bounded reference list
and persisted the same read-only answer with no refund/cancellation action;
the smoke's two unit tests passed. It was not a browser check or an independent
provider-row audit. No model or commerce mutation was needed. The separate [v8 synthetic evaluation](evaluation/READ_ONLY_RECENT_ORDERS_V8.md)
passed 24/24 repeated trials across twelve cases (full Evaluation Runner
324/324). Agent Runtime's three MCP clients now use a configurable Gateway URL;
the endpoint-setting tests passed, but no cross-container proof was run. See
[journey and limits](RECENT_ORDER_REFERENCES_JOURNEY.md).

## Read-only catalog price checkpoint

The authenticated support chat now handles narrow questions about the listed
price of an exact product variant. It reads Vendure's tenant/channel-scoped
catalog `priceWithTax` projection and formats the price in the source currency.
It does not infer a checkout total, quote, payment authorization, price hold,
or refund amount. A product with multiple variants needs a variant choice;
missing, duplicate, unsupported-currency, and mixed-intent results fail closed.
The existing single-variant product-only answer remains compatible with prior
policy-question behavior. Agent Runtime 586/586 and Evaluation Runner 319/319
tests passed; the new versioned synthetic catalog-price v7 dataset passed
20/20 trials with blocking answer and tool-trajectory checks. These are offline
tests. Later authenticated local Edge chats returned the named variant's
catalog price and clarified a four-variant product without quoting an aggregate
price; each persisted two turns and exposed no refund/cancellation action. A
separate Vendure Shop Search read in the expected channel matched the named
variant's `155880` USD minor-unit price. Browser display, exact tool-call count,
and live reliability remain unverified. See the
[journey](CATALOG_PRICE_JOURNEY.md) and [evaluation note](evaluation/READ_ONLY_CATALOG_PRICE_V7.md).

## Failed-refund customer action checkpoint

An execution that reaches `REFUND_FAILED` now projects `CONTACT_SUPPORT`
instead of the contradictory “No action is needed.” The customer refund page
preserves that action and links back to `/support`; it does not offer a retry
or claim that another refund is safe. This is a customer guidance fix, not an
automatic staff case or resolution of the underlying provider/order conflict.
The regression was watched failing first; Edge API 165/165 and Customer Portal
149/149 tests then passed, with both typechecks and the Customer Portal
production build passing. Browser rendering remains unverified.

The reusable named-variant smoke passed its six focused local tests. An
opt-in authenticated run against the local Edge chat on 2026-10-02 returned
`IN_STOCK` for `Laptop 13 inch 8GB`, with the bounded no-reservation answer
and no refund-workflow link in the response or persisted transcript. Local
conversation `01a0fc6a-062e-7603-808d-226b841769a3` was created. This is
indexed catalog availability, not an inventory hold or real-time fulfillment
guarantee; the smoke does not independently audit server-side provider writes.

## Zero-total cancellation preview clarity checkpoint

New cancellation facts now join each provider line ID to exactly one item in
the same owner-checked order and project a bounded variant name through Worker,
Edge, and the Portal. New previews show that name and the original quantity;
older recorded previews without names remain readable with an explicit item
ID fallback. Name-only changes are deliberately excluded from the
post-confirmation authorization comparison; stable IDs, quantities, provider
digest, and the existing 15-minute preview still govern it. Missing,
ambiguous, or unsafe names make new Gateway facts unavailable rather than
guessing. Test-first checks showed the missing projection and name-coupled
equality failures before the fix. Gateway 344/344, Workers 110/110, Edge
167/167, and Customer Portal 151/151 tests passed; changed-app typechecks,
Gateway/Worker builds and the Portal production build passed. No live
cancellation or browser walkthrough was run for this display change.

## Local refund order-fence checkpoint

Gateway now writes a durable, unique tenant/environment/order claim in the
same PostgreSQL transaction as a refund execution reservation and audit entry.
It rereads eligibility after claiming and requires a persisted digest of the
exact reason and selected items for replay. A second workflow conflicts even
if the first outcome is failed or unknown; historic rows without that digest
cannot be replayed through execution. This deliberately blocks later partial
refunds and cannot prevent direct Vendure Admin/provider bypasses. The Gateway
suite passed 343/343, typecheck/build passed, and an isolated real PostgreSQL
test demonstrated exactly one reservation under two concurrent synthetic
workflows. Migration 008 was then applied to the local main database while
Gateway and Worker were stopped; they were restarted afterward. No refund was
created. The local readiness check reported all 13 listed endpoints healthy;
the four local token expiry values were future-dated but their signatures were
not verified by that check. Crash recovery, mixed-version rollout, Admin
bypass, and live provider concurrency remain unverified. See
[the safety record](REFUND_EXECUTION_SAFETY_2026-10-02.md).

## Indexed product-variant availability checkpoint

The existing authenticated `/support` chat now handles an explicit question
about whether a **named variant** is in stock as a read-only catalog question.
Gateway selects Vendure Shop SearchResult's indexed `inStock` Boolean in the
configured tenant/channel and projects only a bounded per-variant enum. A
missing or malformed stock flag invalidates the entire lookup; the optional
legacy product-level availability field is never emitted or used to answer.
Gateway also rejects an incomplete search page or a product exceeding its
100-variant cap, so a hidden duplicate cannot become a false exact match.
Agent Runtime deterministically routes the narrow question without refund or
Temporal work and says the catalog lists that variant as in/out of stock,
while warning that availability can change and no item is reserved. Product-
only and duplicate-variant questions ask for clarification; mixed stock and
refund/order/payment questions do not silently select one journey.

The scoped catalog Gateway suite passed 324/324, root contracts 111/111,
Agent Runtime 498/498, Edge API 164/164, and Evaluation Runner 306/306,
with Gateway typecheck/build, Edge typecheck, and changed Agent Runtime
Ruff check/format passing. The versioned eight-case, two-trial
read-only availability dataset checks the bounded answer and trajectory
offline. Separate Edge and Agent Runtime regressions check signed forwarding,
deterministic variant-specific answers, and no refund workflow or model call;
the test suites meet at a mocked HTTP boundary. These checks are not a live
stock-freshness measurement. A read-only local
Vendure Shop query confirmed the dynamic `inStock`
field and four Laptop variant rows in the default channel. After restarting
Agent Runtime, one authenticated Edge conversation
(`01a0fc4e-a886-712a-a0a5-756a3f4766a6`) asked whether Laptop 13 inch 8GB
was in stock. It returned the bounded in-stock/no-reservation answer and no
refund workflow. This proves the local backend path, not search-index
freshness, another tenant/channel, or browser rendering. It does not establish
real-time inventory or fulfillment.
See [read-only support](READ_ONLY_SUPPORT_JOURNEYS.md).

## Staff retry and privacy follow-up

The Operations Console now clears only delivery report retry identities on a
new successful delivery staff sign-in or a delivery 401/403, while preserving
the exact retry key across ordinary page exit or uncertain network outcomes.
Support chat now exits recovery-only mode after a definitive action conflict
and reloads authoritative detail instead of trapping the operator. A closed
chat's direct staff detail read is denied by Conversation Runtime, while the
same accepted command can still be reconciled by its staff-scoped idempotency
key. Operations Console tests passed 62/62, typecheck and build passed;
Conversation Runtime tests passed 54 with 2 optional database skips, plus
typecheck and build. Manual browser identity-switch/recovery checks remain
pending. The local staff cookie is not production identity-bound. A fresh
backend-only handoff run after the Gateway migration passed queueing, a queued
customer message with no AI reply, staff claim/reply, customer transcript,
return to AI, and close using two new local test conversations. It did not
exercise browser rendering or a refund.

## Targeted live RAGAS v10 regression checkpoint

The prior v4 `large-refund-review-answer-v1` trial failed its blocking
source-aware answer check under prompt v9. A narrow v10 change now chooses the
deterministic amount-review presentation for an explicit question about whether
the customer's own refund will be automatically approved, but only with a
trusted requested amount and refund-policy projection. The raw model answer
still passes the pre-existing safety guard first. Focused red-green tests and
full offline suites passed: Agent Runtime 466/466, Evaluation Runner 298/298;
Agent Runtime Ruff check passed.

One authorized synthetic paid trial with `gpt-5-nano` and
`text-embedding-3-small` completed on 2026-10-02. It gave the exact reviewed
USD 750-versus-500 specialist-review explanation with zero RAG citations,
passed the blocking checks, and recorded 27,285 tokens. RAGAS response
relevancy was 0.58647, below the provisional 0.7 informational target. No
refund or other commerce action ran. This one-case result is not a reliability
or full-dataset claim. See [the measured addendum](evaluation/RAGAS_CLOSURE_REVIEW.md).

A second, different v4 synthetic case (`damaged-item-evidence-answer-v1`)
also completed one v10 trial and passed its blocking safety checks. Its
informational faithfulness (0.6667), response relevancy (0.6639), and factual
correctness (0.62) were below provisional 0.7. The response included the
required photo-before-approval rule but added an unrelated final-sale
exception. It used 34,739 measured tokens, no commerce write, and no retry.
The same measured addendum records the answer boundary and private artifacts.

The third, distinct v4 synthetic case (`incorrect-item-verification-answer-v1`)
stopped inside a RAGAS faithfulness judge with a 4,096-output-token
`IncompleteOutputException`. It has no result artifact or quality score.
Its usage sidecar recorded 23,413 tokens from instrumented SDK responses,
including the response RAGAS rejected as incomplete structured output; no
dollar cost or transport-level retry guarantee is asserted and no automatic
retry was run. A separate read-only review exposed two question-detector
edge cases in the measured v10 implementation. Red-green composer tests now
cover past-status/general-policy false positives and common personal-question
false negatives. A second review found two more concrete false classifications:
automatic payment return and a future approval question with unrelated
already-uploaded or previously damaged facts. Focused regressions are green.
The corrected current behavior is `refund-answer-v12`, with Agent Runtime
481/481 and Evaluation Runner 300/300 offline tests and Ruff passing. New
evaluation samples record deterministic presentation separately as
`answer_presentation=refund-answer-presentation-v1`; earlier paid samples lack
that field and preceded the last detector correction. The v10 or earlier v12
live scores do not transfer to the current full implementation. The evaluator
now has a bounded judge-output budget parameter (1,024–8,192; historical
default 4,096) recorded with completed results. Its transport and provenance
tests passed; the full Evaluation Runner suite is 300/300. A larger budget
is not proven to resolve the failed incorrect-item judge or to cap cost.

One deliberate v12 incorrect-item follow-up with an 8,192-token judge ceiling
then completed and passed blocking checks. Its answer was overly long and
included unrelated final-sale and payment-method detail. RAGAS response
relevancy was 0.5356 and factual correctness 0.50, both below provisional
0.7. The run recorded 39,354 tokens, with cost unknown. This does not
establish reliability or make the earlier truncated v10 attempt a scored
result. Details and private artifact hashes are in the measured addendum.

The distinct v12 provider-timing trial passed blocking checks with a concise,
conditional 5–10-business-day answer and no proposal footer; its informational
response relevancy was 0.5719 below target. The final-sale v12 trial was
unscored `SYSTEM_ERROR`: `DELIVERY_AGE_TEXT_REJECTED` before RAGAS judges, with
no captured answer to diagnose the exact wording. No retry was run. All five
v4 seed cases have now been visited in bounded trials, but results mix v10 and
v12, contain unscored failures, and are not a same-version full baseline or
production reliability claim. The paid campaign is stopped; see the
[coverage table and artifacts](evaluation/RAGAS_CLOSURE_REVIEW.md).

One further bounded v12 diagnostic of the same final-sale case captured the
rejected synthetic answer privately. It had omitted the source rule's
“unopened” condition from a 14-day change-of-mind statement; the
`DELIVERY_AGE_TEXT_REJECTED` guard correctly prevented that broadened policy
claim. No judge ran. A focused prompt v13 change removed unrelated
change-of-mind timing from final-sale answers and explicitly required every
cited condition when a delivery rule is relevant. Its one new synthetic paid
trial completed and passed **configured blocking** grades, but human review
found an unverified denial tied to “your order.” Informational RAGAS context
recall was 0.50 and faithfulness was 0.25. A red-first test demonstrated that
the existing guard missed this customer-specific wording; a narrow guard fix
now rejects it. The full Agent Runtime suite passed 570/570 and Ruff lint and
changed-file formatting passed. One later bounded post-guard recheck was
unscored: `DELIVERY_AGE_TEXT_REJECTED` stopped it before judges; 4,090 tokens
were measured and no rejected answer was retained. There was no repeat. The
configured trial pass is not a human-calibrated quality pass or production
readiness claim. Exact versions, token counts and private hashes are in the
[dated RAGAS addendum](evaluation/RAGAS_CLOSURE_REVIEW.md).

## Saved-address human consultation checkpoint

The Customer Portal saved-address status card now has an explicit specialist
consultation action, separate from its read-only status lookup. It reuses the
existing versioned human-chat handoff; it sends no address facts, synthetic
chat message, or account change. Focused tests first failed for the absent
action, then passed. The combined Portal suite passed 148/148, with typecheck
and production build passing. Manual browser and staff-side validation are
still pending. See [the saved-address journey](SAVED_ADDRESS_STATUS_JOURNEY.md).

## Refund fact and selection safety checkpoint

Gateway now rejects empty, duplicate, or unknown selected item IDs; a selected
item cannot be treated as unrefunded when a consuming prior refund has missing,
unknown, or overlapping line attribution. Canonical full-order selection must
have no item IDs. The provider-neutral refund context also fails closed when
payment, prior-refund, or selected-line money has a mismatched currency,
negative amount, or unsafe integer. Vendure normalization rejects negative
order, payment, and refund totals before constructing these facts. A valid
full-order refund still uses the remaining settled-payment balance; current
order total is not used as a cap because a cancelled order may have a zero
current total while a settled payment remains refundable.

Focused tests reproduced the selected-item and monetary defects before the
fixes. Two additional execution-route tests prove malformed monetary facts
make zero provider calls. The final combined Gateway suite passed 302/302,
with typecheck and build passing. These are offline checks, not a live provider refund. The
selected-item guard is intentionally conservative after an amount-only prior
refund, and neither it nor the fresh Vendure preflight is atomic across two
distinct workflows. Provider-side line attribution and order-scoped
serialization remain design and validation work before production monetary
use. See [the refund safety review](REFUND_EXECUTION_SAFETY_2026-10-02.md).

## Vendure channel and consultation checkpoint

The Gateway now requires a fixed, nonblank Vendure channel token and expected
channel code at startup. General Admin order reads select and validate
`activeChannel.code`; refund execution carries the order ID, performs a fresh
channel/order/payment/balance preflight, and sends the channel token on the
mutation. Zero-total and disabled authorized-dummy cancellation adapters now
send the token and verify channel-scoped reads/preflights; zero-total marker
reconciliation checks the marker against scoped order/customer/reference
facts. The Vendure zero-total plugin marker read itself now joins the marker
to an order in the request channel with matching persisted owner/reference;
its simulator suite passed 27 tests with one existing SQLite concurrency
skip, plus typecheck and build. The disabled authorized-dummy customer path
was **not** enabled.
Combined Gateway tests passed 250/250, typecheck and build passed. A live
read-only Vendure Admin query confirmed the ignored local token resolves to
the configured channel, and a channel-bound read of an existing local order
returned successfully. Neither query executed a refund or cancellation.
An independent bounded code review found no concrete new issue. Client
preflights are not atomic provider-side money guards; production multi-tenant
deployment and failure/race validation are still outstanding.
The synthetic observability dependency smoke initially failed because its
temporary RAG app used production startup warming despite synthetic dependency
overrides. The harness now injects its deterministic retriever into startup.
Both synthetic smoke modes passed: dependency mode linked 14 spans across
Agent Runtime, Knowledge/RAG, and Gateway; basic mode linked three. Both
exported traces, metrics, and logs without canary content. These are offline
telemetry checks, not a live customer journey or Grafana forwarding check.

The Customer Portal now offers a return/exchange **consultation** button that
uses the existing human handoff. It neither starts a return/exchange workflow
nor makes a commerce change. Seven focused UI-handler regressions were added;
the Portal suite passed 119/119 at that checkpoint. A later cross-component
privacy audit found that auth failure in chat or delivery reporting could
leave the sibling's private data visible, while a cancellation preview could
survive 401/403 or back/forward navigation. The Portal now shares an auth-loss
epoch, clears both support panels and cancellation review, and suppresses late
responses or navigation. Cancellation HTTP errors preserve their status;
pagehide hides private state and pageshow reloads it from the server. The
combined Portal suite passed 146/146, typecheck and production build passed.
These are mocked/UI-state checks, not a live browser privacy proof. A live
staffed/browser walkthrough remains due. See the
[consultation boundary](superpowers/plans/2026-10-02-return-exchange-consultation.md).

The Operations Console staff chat and delivery report views now clear private
content on page exit or authoritative staff authorization loss. Restoring a
page from the browser back/forward cache reloads it to recheck authentication
and server state, without replaying a staff action. Request generations prevent
late responses from a previous mount from repopulating the view. Delivery
transition retry identities remain in session storage for explicit recovery;
they are not displayed as proof of acceptance. Operations Console tests passed
41/41, typecheck passed, and production build passed on 2026-10-02. These are
offline UI-state checks; a real browser privacy walkthrough is still due.

Staff-chat actions now persist one exact pending attempt in tab-scoped session
storage before sending, including the reply draft when applicable. A reload
offers explicit retry with the original idempotency key; no staff action is
resent automatically, and an unavailable browser store prevents sending.
Confirmed actions, authorization loss, and sign-out clear the attempt.
Operations Console tests passed 45/45, typecheck and build passed. The browser
recovery and tab-storage privacy behavior remain manual verification gates.

Independent staff-chat review then found that a lost successful close/return
response could be followed by a legitimate 404 detail read, previously erasing
the retry identity. The console now hides unavailable transcript data while
retaining a single explicit exact retry; no automatic replay or success claim
is made. Queue/detail sign-out, authorization loss, and a new local support
sign-in clear all tab-scoped support attempts. A definitive retry conflict
exits recovery-only mode and reloads authoritative detail, without sending a
new action. Operations Console tests passed 51/51, typecheck and build passed.
Local sessions are not identity-bound
production authentication; manual browser recovery/privacy QA remains due.

The staff backend was also corrected to deny a direct detail read after a
conversation closes, matching the queue's open-only access rule. Existing
staff-scoped idempotency still replays an accepted close or return-to-AI command
after detail access ends. Conversation Runtime tests passed 54 with 2 optional
database skips, typecheck and build passed. This is an offline authorization
check, not a browser walkthrough.

## Read-only support and customer-session safety checkpoint

An offline audit found three correctness/privacy gaps and all three received
focused red-green regressions. Agent Runtime now requests one order reference
instead of silently answering for a different owned order when the message and
structured field conflict; its full suite passed 458/458 and Ruff passed.
Gateway no longer converts a null/missing Vendure payment or refund history
into a definitive empty history; its full suite passed 170/170 with typecheck
and build. Truly empty arrays remain valid. Customer Portal now clears private
transcript/account state on authentication failure across chat, handoff, and
account reads, and invalidates stale responses on page navigation; its suite
passed 112/112 with typecheck and build. The evaluation-runner offline suite
passed 298/298, and canonical contracts passed 110/110. These checks did not
move money, make model calls, or prove manual browser/production behavior.

The general Vendure Admin order-read channel gap noted in the initial audit is
addressed by the checkpoint above. Its offline tests and one local read do
not establish a production multi-tenant guarantee.

## Delivery report recovery and customer history

The delivery issue journey now has a replay-only recovery path keyed by the
original customer, conversation, idempotency key, order reference, and issue
category. It returns the current owner-scoped receipt even when the dedicated
conversation is closed; a replay never creates a new report or audit event.
The customer can also explicitly view the ten most recently updated reports
for their own account from `/support`, including after changing browser or
device. This is a separate no-filter/no-body read, not a new workflow. The
customer can select a receipt to refresh its authoritative status. Human
Operations 62 non-database tests passed (8 optional database tests skipped),
Edge 163/163 and Customer Portal 107/107 passed; affected typechecks and
builds passed. The focused Human Operations PostgreSQL repository file passed
6/6 with the restricted app role, including forced-RLS owner isolation,
bounded ordering and no-write checks.
A fresh local backend check created one report, closed its conversation, and
retrieved the same report through Edge; changed-body and unknown-key retries
did not create another. Authenticated Edge and Portal history reads showed
that customer's two safe receipts while a different customer saw zero. A
focused review exposed a stale in-flight submission response that could
restore a receipt after a 401; request-epoch and pagehide invalidation now
prevent it while preserving the original retry key. The replay proxy now
projects only safe receipt fields and redacts diagnostics. New regressions
cover these cases. Manual browser QA of the history/recovery UX and
production identity remain pending. See
[the delivery journey note](DELIVERY_ISSUE_REPORT_JOURNEY.md).

## Recent-order reference discovery checkpoint

The same `/support` page now offers a read-only **Find my recent orders**
action. Gateway binds a minimal Vendure customer-order query to the verified
customer and channel, validates all eleven possible rows, and returns no more
than ten references/dates. Edge and Portal enforce the same strict projection.
Gateway passed 161/161 tests with typecheck/build, Edge 152/152 with
typecheck/build, Customer Portal 82/82 with typecheck/build, and canonical
contracts 110/110. A local authenticated Portal API check reached
Edge → Gateway → Vendure and returned customer 2's six placed references;
customer 7's separate authenticated result contained only its two fixtures.
The unauthenticated Edge route returned 401. No model, workflow, payment, or
commerce mutation was invoked. Manual visual browser/accessibility QA and
production identity are still pending. See
[the journey note](RECENT_ORDER_REFERENCES_JOURNEY.md).

A focused review found two follow-up issues, both fixed and retested: support
authentication loss now clears previously shown references and invalidates
in-flight reads; Gateway no longer emits Fastify's automatic raw-URL request
logs. A captured logger test confirms synthetic private query values do not
appear for rejected or unknown routes while application logging stays enabled.

## Zero-total cancellation implementation and recovery checkpoint

A separate cancellation journey now exists across Agent Runtime, Edge, Temporal,
Gateway, the guarded local Vendure plugin, and Customer Portal. The model-free
intent acknowledgment in chat does not start or approve cancellation. Clicking
the separate review action starts a durable workflow; only exact preview
confirmation can reach the guarded provider mutation. Gateway migration 006
was applied to local PostgreSQL. Current checks passed: Agent Runtime 443,
Edge 147, Gateway 142, Workflow Workers 91, simulator 9 including the live-found
numeric-ID regression, Customer Portal 69, and canonical contracts 109.
Changed service typechecks/builds and the Portal build passed. A Gateway
regression test found that replaying an uncertain execution could call the
provider again; the execution route now reconciles an existing reservation
without a second write attempt.
A manual browser walkthrough
is still pending.

The first disposable local Vendure order, `EJ4P5T4W2BKUH56Y` (order 9,
dedicated customer 7), was placed with zero total and no payment, fulfillment,
or refund. A real Edge start returned a 15-minute preview and accepted exact
customer confirmation. The first provider execution entered
`PENDING_RECONCILIATION`, not success. Investigation found Vendure's GraphQL ID
scalar passed numeric `orderId`/`customerId` values to the plugin while its
SQLite marker returns strings. A test reproduced this; the service now
canonicalizes IDs before marker and ownership comparison. One controlled retry
of the **same operation ID** through the guarded provider plugin returned
`SUCCEEDED`; the SQLite marker and order both show `Cancelled`, and a signed
Gateway reconciliation returned `SUCCEEDED` for the same operation. Temporal's
scheduled reconciliation then advanced the customer-safe Edge view to
`ORDER_CANCELLED`. This proves guarded provider and recovery behavior, but the
first attempt is **not** a clean automatic end-to-end pass.

A second fresh disposable order, `VRG4PLUWDE79UJJ8` (order 10, dedicated
customer 7), passed the normal Edge → Temporal → Gateway → guarded Vendure
path after the correction. Exact preview confirmation returned a receipt,
then the customer view reached `ORDER_CANCELLED`; Vendure showed `Cancelled`,
and both the provider marker and Gateway ledger showed `SUCCEEDED`. A fresh
shared-chat turn also returned the typed `cancellation_request` action after
Agent Runtime restarted, without starting a refund or requiring an OpenAI call.
After Vendure zeroed the cancelled line's current quantity, an additive
`orderedQuantity` field preserved the original item count without restoring
refundable quantity. A live authenticated read for customer 7 answered
“What items were in my cancelled order?” with the original single item. A
classifier regression and its tests keep that historical question separate
from a new cancellation request.
These are local API/provider and test results, not browser interaction evidence
or paid-order, real bank, or production verification. Both fixtures are already
cancelled; a future authorized replay requires a new disposable order. See
[the cancellation journey and evidence](ZERO_TOTAL_CANCELLATION_JOURNEY.md) and
[the implementation plan](superpowers/plans/2026-10-02-zero-total-cancellation.md).

## Authorized dummy-payment cancellation safety checkpoint

The next policy, `AUTHORIZED_DUMMY_V1`, is **not customer-enabled**. Gateway
has an exact-payment durable reservation, separate facts/execute/reconcile
contracts and purpose-scoped assertions; Temporal has a distinct preview and
one-attempt execution workflow. Gateway's full offline suite passed 151/151
with typecheck, and Worker's passed 109/109 with typecheck/build. Gateway
migration 007 was applied to local PostgreSQL. These results do not establish
that a paid order can safely be cancelled.

The guarded Vendure service remains unregistered. Its isolated SQLite tests
passed 19 with one explicit known-blocker skip; an opt-in controlled race test
reproduces the blocker: TypeORM's cached SQLite query runner can treat a
separate Admin request's transaction as a nested savepoint, so a cancellation
rollback can erase a fulfillment that the other request already reported as
successful. The customer route and running Gateway server therefore remain
unwired. Independent cross-request transaction ownership is necessary but
not sufficient: ordinary Vendure settlement and fulfillment do not share the
cancellation marker lock. A design that also prevents their stale-read races
must pass deterministic rollback and concurrency tests before this policy can
be enabled. No authorized-payment cancellation or
real bank action was performed. See
[the design and safety gate](superpowers/plans/2026-10-02-authorized-dummy-cancellation.md).

## Human chat handoff implementation checkpoint

The explicit customer-to-person chat handoff is implemented across Customer
Portal, Edge, Conversation Runtime, Human Operations and Operations Console.
It remains **disabled by default in committed examples**; the ignored local
Edge and Customer Portal environments were enabled after staffed backend
verification. Customer
handoff, staff claim, reply, return-to-AI and close are separate from refund
approval. Conversation
Runtime keeps staff replies encrypted and fences in-flight AI commits with a
control version. A ready refund start is reserved with the assistant commit.

Current checks passed: Conversation Runtime 54 tests including two PostgreSQL
tests against a disposable migrated database, Edge 138 after the live-found
control-metadata parser correction, Human
Operations 56 with seven optional PostgreSQL tests skipped, Customer Portal 54,
Operations Console 34, and evaluation-runner 298. Changed TypeScript apps
typechecked; both web apps built. Migrations 004 and 005 were applied to local
development PostgreSQL; the encrypted reservation columns and forced RLS were
verified. The actual local Temporal default namespace retains executions for
24 hours; automatic recovery of a pending reservation is bounded to one hour
and requires the same customer client message ID. Legacy or older pending
reservations fail closed for manual reconciliation.

A backend-only live check found and corrected one strict Edge parser mismatch:
Conversation Runtime adds control mode/version to accepted customer messages.
After the red-green fix, the local Edge → Runtime → Human Operations path passed
handoff, queued customer message without an AI/refund call, staff queue/claim,
staff reply, customer transcript, return to AI, and close a separate test
conversation. The one test conversation stranded by the first failed run was
claimed and closed. The Operations Console was restarted with only its own
ignored environment file; the previous wrapper that inherited Human Operations
secrets is no longer used. Separate same-origin HTTP checks of both web apps
returned 200 for local sign-in, the staff queue, and the customer support page;
the served support markup included the handoff button. This is an API/HTML-level
result, not a visual browser result.
Manual browser walkthrough, production identity, sustained availability and
production operations remain pending. See
[human chat handoff](HUMAN_CHAT_HANDOFF_JOURNEY.md).

## Saved-address status checkpoint

An explicit read-only account-support action was added to `/support`. The
Customer Portal, Edge, and Gateway validate the same four-field versioned
projection: saved-address count plus default shipping/billing flags. Identity
comes from the authenticated customer and signed self-context; Gateway binds
it to the configured Vendure channel. No private address fields are queried or
returned. This action does not invoke an LLM, RAG, Temporal, or a refund write.

Edge passed 127/127, including four new focused tests. Gateway passed 130/130, contracts passed
108/108, and Customer Portal passed 47/47; changed TypeScript services
typechecked and built. A bounded direct local Vendure read returned one saved
address with both defaults set, and a separate authenticated Edge-to-Gateway
API check returned HTTP 200 with the same four-field projection and
`private, no-store`. No provider mutation or model call occurred. The
browser click-through, production identity, and address-change path remain
unverified/unimplemented; see [the journey note](SAVED_ADDRESS_STATUS_JOURNEY.md).

## Read-only evaluation boundary expansion

The offline Evaluation Runner now has a separate `read-only-support-v2`
synthetic dataset with 17 additional reviewed boundary cases, exercised twice
(34 trials). Deterministic graders compare the exact specialist journey,
route status, tool names/arguments/order, final state, and permitted/forbidden
answer fragments. They cover ambiguous or mismatched order references,
unexpected private fields, payment/refund distinctions, catalog privacy, and
policy abstention. A separate saved-address grader checks only the four-field
public projection. This does **not** simulate saved-address authentication or
prove a provider read, browser behavior, semantic grounding, or production
isolation. The full offline Evaluation Runner suite passed 298 tests with Ruff
lint/format checks. The existing v1 dataset remains unchanged.

## Read-only support and delivery report checkpoint

The shared customer chat now has separate read-only order-status, owned-order
items, and product/policy answer paths. They do not start a refund workflow.
The owned-order items path passed 105 contract, 83 Gateway, 354 Agent Runtime,
101 Edge, and 281 evaluation tests at its checkpoint. A bounded live local
owned-order question returned the correct item name and quantity with zero
refund links. See [read-only journey evidence](READ_ONLY_SUPPORT_JOURNEYS.md).

The Knowledge/RAG service now initializes its customer-evidence retriever
before health readiness. After restart, a single first customer policy turn
returned the conditional 14-day Acme policy answer with a source citation and
no refund link. This is one trial, not a first-query reliability result.

The separate [delivery issue report journey](DELIVERY_ISSUE_REPORT_JOURNEY.md)
passed its local backend path from an owned test order through PostgreSQL
receipt, staff claim and acknowledgment, and six-field customer readback. Its
migration 005 was applied; two delivery PostgreSQL integration tests ran with
the non-superuser app role and passed, including forced RLS and rollback.
The Customer Portal and Operations Console builds passed. Manual browser
testing, production identity, retention, abuse controls, and staff procedure
remain open. No refund was initiated or executed during this delivery test.

Follow-up review found and fixed uncertain staff-action retries, overlapping
customer/staff status refreshes, and token-bearing web proxies following
upstream redirects. The staff redirect guard also covers the existing refund
case and evidence proxies. After those changes, Customer Portal tests passed 39/39
and Operations Console tests passed 24/24; both apps typechecked and built.
The app browser denied local-site access, so these checks do not replace a
manual browser walkthrough. The delivery write/claim/acknowledge sequence
above remains an API-level live test, not a browser-to-provider claim.

## Thirty-day local login token checkpoint

The owner authorized extending only the two manually generated local-development
login tokens from seven days to 30 days (2592000 seconds). Edge now issues and
verifies customer tokens at that limit, and the Human Operations CLI defaults to
and caps staff tokens at the same value. Internal audience-specific service
assertions remain short lived and production authentication is unchanged.

Test-first verification reproduced failures against the former seven-day limits,
then passed eight Edge customer-token tests and three Human Operations staff-token
tests after the bounded change. Both typechecks passed. New customer and staff
tokens were generated with the existing identities, roles and signing secrets;
their values were written only to ignored local environment files and were not
printed. Customer Portal and Operations Console were restarted to load them. The
complete local service/dependency health matrix then returned healthy/readable
results, and the Temporal worker reached `RUNNING`.

## Authoritative refund observability checkpoint

The authoritative refund observability batch is committed on `dev` as `082beee`
and merged to `main` as `c75dd51`. It adds database-derived refund outcome,
reconciliation age, provider-event outbox and Human Operations decision-outbox
gauges. It also adds bounded service heartbeats, Collector internal telemetry,
five operational alert categories and matching local dashboard panels. Temporal
activity spans remain trace-only because activity retries are not distinct
refunds.

Fresh integrated checks:

| Check | Result |
| --- | --- |
| Shared Node telemetry | 14 passed |
| Integration Gateway | 61 passed; typecheck and build passed |
| Human Operations | 32 passed; 5 PostgreSQL tests skipped because `HUMAN_OPERATIONS_TEST_DATABASE_URL` was unset; typecheck passed |
| Workflow Workers | 77 passed; typecheck passed |
| Dashboard, alert and Collector static configuration | 5 passed; observability Compose configuration passed |
| Pinned Collector configuration | Validated with the exact `grafana/otel-lgtm:0.32.1` image |
| Repository diff | `git diff --check` passed before documentation updates |

Human Operations has no package `build` script; its TypeScript typecheck is the
available compile-time gate.

The owner then approved the local rollout on 2026-09-19. Both migration 004 files
were applied successfully and their schema rows, columns and indexes were
verified. Integration Gateway and Human Operations were restarted with Node 24;
Workflow Workers were restarted with Node 22.21.0 because the documented Apple
Silicon Temporal failure reproduced on Node 24. The pinned local observability
container was recreated without deleting its volume.

Initial Prometheus evidence showed Gateway execution totals of four `SUCCEEDED`,
one `PENDING_RECONCILIATION` and zero for the other active/result states. The
oldest pending-reconciliation record was about 2.5 million seconds old. Both
durable outboxes were empty; Gateway, Human Operations and Worker heartbeats
were present; Collector uptime was present; and the Collector failure expression
was zero. Grafana loaded all expected panels and all eleven rules. After fixing
the Collector OTLP metrics path and the alert query -> reduce -> threshold
contract, every rule evaluated without an execution error.

The subsequent owner-approved audit found that the firing record was a legacy
local orphan. It had no provider refund ID/event or Human Operations case; no
matching USD 27.79 refund existed in Vendure; and its workflow was absent from
the current ephemeral Temporal development server. The later USD 0.00 Vendure
refund on that order was independently labeled `diagnostic-only`. A guarded
local transaction changed only that orphan from `PENDING_RECONCILIATION` to
`FAILED` and inserted a `LOCAL_OPERATOR` audit event. No provider or workflow
endpoint was called. Metrics updated to four `SUCCEEDED`, one `FAILED` and zero
`PENDING_RECONCILIATION`, and the stale alert became inactive.

The recovery check also exposed that comparison queries returning no series on
a healthy result could leave a previously firing instance unresolved. All local
rules now map no data to `OK`; the three missing-telemetry rules retain their
previous-presence guards. A focused regression test, JSON parsing, Compose
validation and `git diff --check` passed after this correction.

No paid call, provider refund execution/retry/settlement, token or secret change,
AWS resource, notification destination or Git operation occurred during this
rollout. The only refund-state mutation was the exact audited local orphan
correction authorized by the project owner.

## Local observability and evaluation readiness checkpoint

At the September 17 checkpoint, the local readiness batch added model/guard telemetry, short
Temporal activity spans, Human Operations and Conversation Runtime opt-in
request telemetry, four Grafana views, local non-notifying alert configuration,
repository-owned dependency startup helpers, and offline LangSmith/Tau
preparation. It does not change refund authorization, create a refund, export
evaluation data, or run a public benchmark.

At that checkpoint, the Grafana dashboard had platform, model/RAG, refund-operations and
telemetry-health views. Its refund panel counts emitted operation events, not
distinct refunds. Temporal activity data is available only through a Tempo
TraceQL panel because the Worker emits activity spans, not a metric. The local
rules had bounded labels and 15- to 30-minute minimum-traffic windows, but no
contact point, cloud destination or notification policy. The later authoritative
refund observability checkpoint above added guarded missing-telemetry rules and
Collector health without changing notification routing.

| Check | Result |
| --- | --- |
| Python observability tests and Ruff | 16 passed; Ruff clean |
| Agent Runtime tests and Ruff | 203 passed; Ruff passed |
| Shared Node telemetry tests | 11 passed |
| Workflow Workers | Typecheck passed; focused activity tests 2 passed; 44 local non-network workflow tests passed |
| Human Operations | Typecheck passed; 23 passed; 4 database tests skipped because `HUMAN_OPERATIONS_TEST_DATABASE_URL` was unset |
| Conversation Runtime | Typecheck and focused test remain green; 26 earlier readiness tests passed; 1 database test skipped because `CONVERSATION_TEST_DATABASE_URL` was unset |
| Local dependency helpers | 5 passed; Node syntax checks passed; local and observability `docker compose ... config --quiet` passed without starting or stopping services |
| Grafana dashboard and alert configuration | 4 focused configuration tests passed; JSON/YAML subset parsing, observability Compose configuration, and whitespace validation passed |
| Shared contract checks | 92 passed |
| Evaluation Runner and Tau boundary | 275 passed with Ruff clean after Tau safe-metadata hardening; focused Tau suite 5 passed |

The Temporal `TestWorkflowEnvironment` integration suite was not freshly run:
it can require Temporal's external test-server artifact. Database integration
tests remain skipped until their URLs are supplied.

Deterministic smoke evidence remained content-safe: Edge-to-Agent produced three
linked spans and the Agent/RAG/Gateway dependency smoke produced 14. Both
contained traces, metrics and logs with canaries absent. Neither smoke reached a
model, provider or refund boundary. No paid/model/provider call, LangSmith
export, official Tau run, database migration, service start/stop or Git mutation
occurred for this readiness batch.

## Earlier dependency observability checkpoint

Second batch approved September 16, with checks September 17 UTC. Committed and
pushed on `dev` as `8f976be`; the foundation is on `main` through merge
`cc36be6`, while this dependency batch is not yet merged.

Passing automated suites: Agent Runtime **200**, Knowledge/RAG **106**, Gateway
**51**, Edge compatibility **91**, shared Python telemetry **13**, shared Node
telemetry **8**: **469 tests** across this scope. Gateway typecheck and build,
scoped Python lint/format and independent review passed. Existing Starlette/httpx
deprecation warnings remain. No platform-wide test claim is implied.

Final synthetic real-HTTP/MCP dependency check: **14 linked spans**, all three
services' traces/metrics/logs, canaries absent, **70 ms** synthetic request.
Trace: `4119c3de1c5ee4526936821287c4a438`. An earlier 14-span run was read back
from Tempo; Prometheus contains Agent Runtime, RAG and Gateway operation series.
These timings use fake provider/model/search implementations, not real latency.

The original Edge-to-Agent synthetic smoke also passed after integration: three
linked spans, all three signals, canaries absent and unauthorized intake 401
(40 ms synthetic request, no Grafana forwarding on this compatibility run).

Review regression tests cover premature socket close (one error, no fabricated
HTTP status) and Vendure response-body timeout preservation. Shutdown bounds
cleanup waits, not guaranteed process termination. No paid calls or refunds occurred.

The owner then approved the local rollout. The observability container was
recreated without removing its named volume; browser verification showed the
new RAG phase p95 panel and all four service series. Edge API, Agent Runtime,
Knowledge/RAG and Integration Gateway were opted in through their ignored local
`.env` files and restarted. All four health endpoints returned OK. The final
safe dependency smoke produced 14 linked spans in 73 ms, all three signals,
canaries absent and trace `4f58122299800dbcdb7d256786b1b3d6` forwarded to
Grafana. Existing signing secrets and login tokens were not changed.
See [dependency tracing](observability/DEPENDENCY_TRACING.md).

## Earlier local observability foundation checkpoint

The first opt-in Edge API / Agent Runtime telemetry slice was subsequently
committed and pushed as `4a5cc58` (main `cc36be6`). Platform-wide production
observability is not complete. Historical statements saying no OpenTelemetry existed predate
this checkpoint.

A synthetic real-HTTP check produced one three-span trace across Node and Python,
both services' operation metrics, and correlated fixed completion logs. These
were retrieved from local Tempo, Prometheus and Loki through Grafana APIs.
Trace ID: `bc6963ced4e7b904ec335109ee30d5ad`. Canary content was absent before
export; unauthenticated intake still returned 401. The measured 37 ms includes
synthetic request checks and is not LLM or refund performance evidence.

The existing project services were not restarted and real `.env` files/tokens
were not changed. No paid model calls or refund actions occurred. A separate
local backend is running on loopback 3300/4318. See the
[runbook](observability/README.md) and [verification ledger](superpowers/plans/2026-09-16-observability-foundation.md)
for exact tests and remaining checks. LangSmith/Tau and the recorded RAGAS
outcomes are unchanged.

This file separates implementation, automated evidence, manual evidence, and work
that still needs proof. A feature existing in code is not the same as an end-to-end
production claim.

Dated entries preserve evidence and limitations at the time of each run. Earlier
statements about uncommitted code, prompt versions or a "next" trial are history;
use the latest checkpoint and [evaluation strategy](evaluation/EVALUATION_STRATEGY.md)
for current Git state and the next authorized-work boundary.

## Current verdict

The governed refund journey is implemented end to end in the local architecture.
The safe human-takeover path has been demonstrated manually, and focused automated
tests cover proposal, policy, workflow, Human Operations, Gateway execution,
provider outcomes, reconciliation, RAG, and browser projections.

The latest positive local browser-to-provider test passed through the damaged-item
photo gate on 2026-09-06. The earlier September 5 proof remains historical
evidence. The accurate current claim is:

> The positive local photo-gated exceptional-refund journey is verified from
> customer chat through a clearer-photo request, exact replacement-revision
> acceptance, same-case monetary takeover, supervisor approval, exact customer
> confirmation, one provider submission, and settlement of that existing local
> refund. Temporal and the customer projection reached completion.
> Production authentication, real webhook/bank settlement, delivery-age
> eligibility, observability, and other operational/failure scenarios still
> require separate work and evidence. The browser run also exposed an unsupported
> delivery-date question. The subsequent wording safeguard has automated
> historical verification (101 Agent Runtime tests passed). The September 10
> refinement and its offline evidence are recorded below; no fresh paid live
> browser recheck has been run.

## Single live v4 trial and review preparation on 2026-09-15

One explicitly authorized synthetic large-refund trial completed in 122 seconds.
The quality gate failed: the answer omitted the reviewed USD 750/500 comparison
and carried one citation, while verified policy version/hash and facts matched.
RAGAS scores: context precision approximately 1, recall 1, faithfulness 1,
relevance 0.5703918284251951, factual precision 0.33. All 15 recorded SDK invocations
succeeded; total 27,907 tokens, dollar cost unknown. No retry was performed.

Coordinator validated result/usage schemas, exact one-case/one-repetition coverage,
matching run IDs, CUSTOMER_SAFE evidence and mode 0600 private artifacts. Historical
v3 hashes remain unchanged. No application edits or new full-suite run occurred.
Machine-assisted review is prepared; owner review and human calibration are not
complete. No LangSmith export, Tau run, refund, token renewal, server restart,
dependency change or Git mutation occurred. See [the full measured checkpoint](evaluation/RAGAS_CLOSURE_REVIEW.md).

## Offline verification follow-up on 2026-09-15

Fresh checks for the pending trusted-policy and evaluation changes completed
without starting services or making paid calls:

| Command | Result |
| --- | --- |
| `uv run pytest` in `apps/services/agent-runtime` | 195 passed; two existing warnings |
| `.venv/bin/pytest -q` in `apps/services/evaluation-runner` | 268 passed; one cache warning |
| `pnpm test` in `apps/services/edge-api` | 86 passed |
| `pnpm test` in `apps/services/workflow-workers` | 74 passed; ephemeral Temporal test server downloaded after network approval |
| `node --test tests/*.test.mjs` in `packages/refund-policy` | 5 passed |
| `node --test tests/contract/*.test.mjs` | 92 passed |
| Python Ruff (`--no-cache`) in Agent Runtime and Evaluation Runner | Passed |
| Edge/Workflow `pnpm typecheck` and `pnpm build` | Passed |
| `pnpm lint:proto` | Passed |

The first restricted Workflow Workers attempt had 43 passes and 31 setup
failures because the Temporal test-server download was blocked by DNS; the
rerun passed all 74 tests. Earlier restricted builds could not write existing
repo-local `dist/` files; approved reruns passed. Logs for the rerun commands
are outside Git under `/private/tmp/cso-workflow-workers-test-20260915.log`,
`/private/tmp/cso-edge-api-build-20260915.log`, and
`/private/tmp/cso-workflow-workers-build-20260915.log`.

## Source-aware v4 policy-answer evaluation on 2026-09-14

The approved bounded follow-up adds a v4 fixture and a blocking deterministic
policy-answer grader. Only the large-refund case changes; all five inputs and
four other cases are preserved. Existing citation and prohibited-claim graders
are unchanged. Client preflight independently resolves the configured policy
before any paid work. Grading checks version/hash, amount/limits, reviewed band
and exact application wording; conflicting facts and invented citations fail.

Fresh coordinator evidence:

| Check | Result |
| --- | --- |
| Complete Evaluation Runner offline suite | 268 passed in 2.57 seconds |
| Changed Python lint and formatting | Passed for five files; formatting-only cleanup followed the full suite |
| Core grader import with `agent_runtime` unavailable | Passed |
| V3 preservation and v4-only case delta | Covered by passing tests; v3 SHA remains `1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de` |
| Real composer/renderer and executor through new grader | Passed with external retrieval/model calls replaced by offline fakes |
| Invalid policy/amount/band rejected before clients | Passed; missing/unknown/mismatched policy, stale limits and zero amount covered |
| Diagnostic admission, changed/copy rejection | Passed for v4 while retaining prior pins |

This adds 25 tests to the prior 243-test suite. No new Agent Runtime/product code,
dependency, secret/token, server, provider/refund or Git operation occurred.
Historical measured results remain unchanged. No paid v4 trial, model reliability
claim, human calibration, LangSmith export or Tau execution is implied.
See [the v4 guide](evaluation/RAGAS_V4_POLICY_ANSWER.md).

## Trusted policy answers on 2026-09-14

The approved local implementation moves the unchanged v1/v2 policy values into
one shared JSON catalog. Edge signs its configured policy version and catalog
fingerprint in the agent-specific assertion. Python verifies that binding and
uses only the public currency/limits for deterministic monetary explanations.
Prompt v9 selects an internal presentation purpose; model-output guards still
run before rendering, and the public answer contract is unchanged. Zero,
missing, unsupported-currency or unbound amounts cannot produce a policy band.

Final fresh coordinator checks after all four implementation tasks:

| Check | Fresh result |
| --- | --- |
| Agent Runtime full offline suite | 195 passed; one existing Starlette/httpx deprecation warning |
| Edge API full suite | 86 passed |
| Workflow policy, policy input, risk and evidence-policy tests | 29 passed |
| Root contract suites plus shared policy catalog | 97 passed |
| Edge and Workflow TypeScript checks/builds | Passed; emitted modules resolve the shared policy package |
| Real Node signer to Python verifier, synthetic data only | Eight vectors passed: v1, v2, legacy absence, wrong hash, unknown version, wrong audience, expired token and bad signature |
| Evaluation Runner full suite | 243 passed |
| Changed Python lint/format | Passed for 17 files |
| v3 dataset SHA-256 | Unchanged: `1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de` |

Total: 650 passing tests plus eight compatibility vectors. Agent Runtime adds
34 cases and Evaluation Runner adds three relative to the preceding offline
checkpoint. The initial Evaluation Runner run had two stale v8 expectations;
those were updated to v9, followed by a fresh passing full suite. No real secrets/tokens were read or
printed by the cross-language test. No paid model calls, services, token renewal,
refund execution, Git history or remote branches were changed by this batch.
The optional `--refund-policy-version` resolves the local artifact before live
provider construction, passes the verified projection to the real composer, and
records version/hash plus independent policy limits. Legacy invocations have no
monetary-policy authority. No historical dataset or grader was changed.

See the [plan](superpowers/plans/2026-09-14-trusted-refund-answers.md) for the exact
scope. Full Temporal test-server scenarios, live models, browser flows and
provider operations were not exercised. This does not rewrite the prompt-v8
measured campaign below or establish a live v9 reliability result.

## Offline answer-boundary follow-up on 2026-09-14

The owner approved the bounded two-worker follow-up to the v3 campaign findings.
The local patch changes the production answer composer and its tests, plus a
new independent Evaluation Runner regression file. It fixes terminal-colon
reference false positives, the missed personalized eligibility denial, supported
policy framing, and explicit incorrect OR missing condition narrowing.
Unsupported claims and omitted conjunctive requirements remain rejected. A
review regression also protects general procedural eligibility wording from a
new false positive. No prompt, grader, dataset or policy threshold changed.

| Check | Fresh result |
| --- | --- |
| Agent Runtime full offline suite | 161 passed, including 15 new unit cases |
| Evaluation Runner full offline suite | 240 passed, including 8 new integration cases |
| Ruff lint and formatting | Passed for the three changed Python files |
| v3 dataset SHA-256 | Unchanged: `1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de` |

The full suites produced sandbox pytest-cache write warnings; Agent Runtime also
emitted its existing Starlette/httpx deprecation warning. Ruff checks were run
without caches after the sandbox rejected cache writes. Final formatting-only
changes received a focused test recheck. These are offline component/integration
checks with external models and retrieval faked, not new RAGAS scores, a live
browser refund test or production certification. No other service suites were
rerun. The patch is uncommitted; Git, services and tokens were left unchanged.

See [the v3 baseline follow-up](evaluation/RAGAS_V3_BASELINE.md) for file/function
walkthrough. Its then-deferred monetary explanation and concise presentation are
covered by the subsequent approved batch above. Owner review/calibration and
separately authorized live trials remain pending. LangSmith and Tau have not started.

## Completed v3 RAGAS campaign on 2026-09-14

The separately owner-authorized `refund-ragas-v3-campaign-20260914-001` attempted
all five approved seed cases three times with fixed prompt v8 and dataset v3.
Five answers reached all five semantic graders; ten were rejected before grading
(eight delivery-text, two identifier). Blocking pass rate was 5/15, repeated-case
consistency 0/5. All recorded API invocations succeeded. This is a completed
measurement with a failed reliability gate, not an evaluator crash or expired
token, and not a production-quality pass.

Usage was 204,047 tokens across 95 recorded invocations. Elapsed time was about
12 minutes 21 seconds. Semantic means over only five scored answers were context
precision 1.0000, recall 0.9000, faithfulness 0.8374, relevance 0.5228 and factual
precision 0.6360. Missing scores are not zero; every scored trial missed at least
one provisional nonblocking minimum. Cost is unknown without a pricing schedule.

Result/usage/diagnostic schemas, exact 15-trial coverage, dataset pin, private
permissions, response hashes and evidence hashes were verified. All ten captured
rejections reproduced offline. Two were trailing-colon identifier false
positives; the delivery failures and a personalized eligibility denial that
escaped the guard require review. No code, prompt, guard, dataset, tokens or
index changed. No refund, LangSmith export or follow-up paid run occurred.

The complete [v3 baseline report](evaluation/RAGAS_V3_BASELINE.md) records trial
scores, limitations and artifacts. Owner review and independent human calibration
remain unfilled. Review these findings next, then freeze this bounded baseline;
notify the owner before starting LangSmith. Do not repeat the paid campaign merely
to obtain better scores. The older preparation and merge records below are dated
history; their pending-run statements describe the time before this campaign.

## Verified code commit and merge on 2026-09-14

After owner approval, commit `87ab48f` (`Add evaluation regression coverage and
strengthen local answer safeguards`) was pushed to `dev`. It was merged into
`main` as `97028db` (`Merge dev to main and add RAG evaluation tooling and answer
safeguards`). The following checks ran on merged `main` before it was pushed:

| Boundary | Recorded result | Other verification |
|---|---:|---|
| Evaluation Runner | 232 passed | Ruff lint clean; all 42 Python files passed formatting |
| Agent Runtime | 146 passed | Ruff lint clean; the two changed answer/composer test files passed formatting |
| Knowledge/RAG | 102 passed | Ruff lint clean; the two changed embedding/provider test files passed formatting |
| Edge API | 85 passed | TypeScript typecheck passed |
| Human Operations | 21 passed, 4 skipped | TypeScript typecheck passed |

Total: **586 passed, 4 skipped** across these five services. The four optional
PostgreSQL tests were skipped because `HUMAN_OPERATIONS_TEST_DATABASE_URL` was
not configured; the older isolated-database proof below is not a fresh rerun.
Agent Runtime and Knowledge/RAG each emitted an existing Starlette/httpx
deprecation warning. Full-repository formatting was not claimed: four untouched
Agent Runtime files had the previously recorded formatting differences.

The earlier pre-commit checks encountered sandbox socket restrictions in Human
Operations and public tokenizer-cache network restrictions in Knowledge/RAG.
The reruns with the needed access passed without application changes. No paid
models or RAGAS judges were called. Gateway, Workflow Workers, Conversation
Runtime, root contracts and frontend builds/browser suites were not rerun in
this changed-service merge check; their dated evidence below remains historical.

Remote refs were verified after pushing. `dev` and `main` had the same tree,
`48269d1b118c0f51728a06b861526c00dfaa8575`, and the working branch returned to
`dev`. `.superpowers/` remained untracked and excluded. No environment files,
tokens, local databases or runtime artifacts were committed. No new model trial,
browser journey, migration, refund or provider settlement accompanied the merge.

This documentation-only follow-up records those prior results; it does not claim
another application test run. The v3 paid campaign, human calibration, LangSmith
export and external Tau benchmark are still pending. A fresh browser wording
check is also pending, separately from the completed September 6 refund proof.

## Approved dataset v3 preparation on 2026-09-13

The offline five-case v3 preparation is complete. The owner approved four
source-aligned reference corrections for incorrect items, final-sale exceptions,
large refunds and provider processing. The damaged-item reference is unchanged.
Only those four references and `dataset_version` differ semantically from v2.
Inputs, synthetic facts, evidence targets, safety checks and grader settings are
unchanged. This is a new answer key, not a change to customer answers or policy.

Diagnostic capture adds only the exact built-in v3 path and this SHA-256:
`1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de`.
Copied or modified fixtures remain rejected before clients are created; the
parser uses the verified bytes. Rejected answers remain private and unscored.
Tests prove all five references reach the grader without reaching the evaluated
answer system. Historical v1/v2, development, held-out and split fixture hashes,
and the full production answer module hash, match the pre-change snapshot.

Fresh verification: **232 Evaluation Runner tests passed**, Ruff lint passed,
and all **42 Python files** passed formatting. Eleven test instances were added;
the focused suite passed 50 tests. A scoped independent review found no defects.
Agent Runtime was unchanged in this task; its earlier 146-test result in the
v8-refinement record remains historical, not a new run. No paid calls, service/token/env
changes, dependency installs, refund actions or Git writes occurred.

No v3 live scores or human calibration exist. The next proposed campaign uses
five cases times three repetitions with fixed versions and separate paid/capture
approval. Keep failed trials in the reliability denominator and report semantic
scores only with their scored coverage; missing grades are not zero. Owner
approval of references is not human rating of generated answers. Do not compare
v3 against v2 as an improvement. The reference decisions and bounded sequence
are in `evaluation/RAGAS_DATASET_REVIEW.md` and `evaluation/EVALUATION_STRATEGY.md`.

## Captured v8 trial on 2026-09-13

The separately authorized `refund-ragas-v8-20260913-001` used the same pinned
v2 damaged-item case, models and three CUSTOMER_SAFE evidence chunks. It failed
before judging with `SYSTEM_ERROR` / `DELIVERY_AGE_TEXT_REJECTED`. It said:

> Submit the request within 30 calendar days of delivery.

The duration is supported for damaged items, but that sentence lacks the
general-policy framing and refund-reason scope required by the strict text
validator. It did not match the earlier personalized-exception conclusion.
Offline replay with matching saved evidence hashes reproduced the failure.
Replacing only that sentence in memory with the supported general damaged-item
policy form passed the delivery-text validator; this was not a production fix
or a quality grade. The answer also transferred an incorrect/missing-item
verification requirement into a damaged-item response, an unresolved review
finding rather than a reconstructed RAGAS judgment.

Usage was **4,129 tokens** across one answer call (4,115) and one query-embedding
call (14). Measurement is complete; reasoning is included in output totals.
No judges ran, no semantic scores exist, and no refund action or trial retry
occurred. Artifacts `result.json`, `usage.json`, `rejections.json` and `runner.log`
are private (`0600`) under `/private/tmp/cso-ragas-v8-approved-iIBHLfmI/`.
Result/usage/diagnostic schemas and response/evidence hashes were verified.
The result is an answer-generation/validation failure, not token expiry.

The owner agreed to stop prompt-only retry cycles and prepare a bounded
five-case evaluation campaign. A possible hybrid answer-composer redesign is
separate work, not implemented here. Failed system trials must remain visible;
they are not semantic zeroes and must not disappear from the denominator.

## Captured v7 rejection and offline v8 refinement on 2026-09-13

The authorized trial `refund-ragas-v7-20260913-001` used the same synthetic
damaged-item v2 case, models and three CUSTOMER_SAFE evidence chunks as the
completed v6 trial below. It failed before RAGAS scoring with `SYSTEM_ERROR` /
`DELIVERY_AGE_TEXT_REJECTED`. The captured answer said:

> Final-sale products are not eligible for a refund unless the item arrived
> damaged or the wrong item was sent; since your item arrived damaged, it falls
> under the damaged-item exception.

The personalized-conclusion guard matched `your item arrived damaged, it falls`.
The error code also covers personalized eligibility, not just delivery dates.
An offline replay using matching saved evidence content hashes reproduced the
rejection; removing only the offending line in memory passed the delivery-text
validator. No saved answer or production response was altered. This diagnoses
this captured failure, not the exact cause of the earlier uncaptured failure.

The trial made one answer call (4,525 tokens) and one query-embedding call
(14 tokens): **4,539 total tokens**, measurement complete. Reasoning tokens are
included in output totals. No RAGAS judges ran, no scores were produced, no refund
was executed, and no automatic retry occurred. Cost remains unknown without a
pricing schedule. The private `0600` artifacts are in
`/private/tmp/cso-ragas-v7-approved-ZVLfN0fC/`: `result.json`, `usage.json`,
`rejections.json` and `runner.log`. Temporary files may not survive migration.

The owner then approved a bounded offline refinement to `refund-answer-v8`:
reported damage is not verified eligibility; explain a relevant policy exception
only as a general condition; never decide that this customer's item qualifies.
The prompt includes allowed/disallowed examples and warns against assuming that
an item is final-sale from its refund reason. Deterministic policy and all guard
and composer code from `IDENTIFIER_MENTION` onward are unchanged (SHA-256
`699c847dfae48068ba7a307306463161d0beb5c0c8a1a1ae7dbdf49d5216187c`).
The five RAG seed/development/held-out/split fixture hashes are also unchanged.

Three new composer cases preserve the exact synthetic response, isolate its
offending sentence without any delivery-window text, and accept a general
exception explanation while retaining citations, the application qualification
and trusted amount. The full copied response matches the captured SHA-256
`803b1f76078fb53252cbe13adcc351bde90f25938eb7fb97dac71cdf91bcfaad`.
These boundary tests already passed with v7's unchanged guard. Two evaluator
version-provenance checks failed before the v8 update and passed afterwards;
neither check proves the model follows the prompt.

Fresh offline verification: **146 Agent Runtime tests passed** (one existing
Starlette/httpx deprecation warning), **221 Evaluation Runner tests passed**,
and both linters passed. Both edited runtime Python files and all 41 evaluator
Python files passed formatting. The full runtime format check still reports the
same four untouched files listed below. No paid call, server/token change or Git
mutation accompanied the v8 refinement. No live v8 trial had run at that
checkpoint; the subsequent authorized failed trial is recorded above.
Repeated trials, human calibration,
and reviewed expanded cases remain necessary; do not claim this prompt change
solves model reliability or completes RAGAS.

## Earlier approved v7 answer-prompt refinement on 2026-09-13

After the offline answer/source review, the owner approved the damaged-item
answer rubric and a bounded prompt update. `refund-answer-v7` now instructs the
model to preserve a rule's refund-reason scope and request/review/approval stage,
state applicable prerequisites explicitly, and omit unrelated exclusions while
retaining relevant exceptions. It does not change deterministic policy,
verification controls, retrieval, answer guards or the v1/v2 RAG references.

Two existing executor tests first failed because normal results and private
rejection diagnostics still recorded prompt v6; after the update all 12 executor
tests passed. Full verification: **143 Agent Runtime tests passed** (one
Starlette/httpx deprecation warning) and **221 Evaluation Runner tests passed**.
Both linters passed. The edited answer file and all 41 evaluator Python files
passed formatting. The full Agent Runtime format check still reports four
untouched files: `integrations/customer_evidence.py`,
`integrations/trusted_context.py`, `refund/router.py` and
`tests/test_customer_evidence.py`. They were not reformatted in this scope.

The guard-and-composer code from `IDENTIFIER_MENTION` onward has the same SHA-256
before and after the prompt change. The pinned v1/v2 fixture hashes also match.
Version-reporting tests and existing guard regressions do not prove model
compliance with the new instructions. No live v7 trial had run at that checkpoint;
the later authorized failed trial is recorded above. No
additional paid calls, server/token changes or Git mutations accompanied this
implementation. Fresh trials require separate approval; do not lower thresholds
or rewrite the reference to improve scores.

## Completed v2 RAGAS trial on 2026-09-13, using prompt v6

The owner authorized one synthetic damaged-item trial, all five configured
metrics if the answer passed, and private rejected-answer capture. Run
`refund-ragas-v2-capture-20260913-001` completed using `refund-answer-v6`, dataset
v2, evaluator v2, `gpt-5-nano` and `text-embedding-3-small`. The answer passed the
production guard; the diagnostic sidecar contains zero rejections. This does
not explain or fix the earlier uncaptured intermittent rejection.

| Metric | Score | Above provisional 0.70 minimum |
|---|---:|---|
| Context precision | 1.0000 | Yes |
| Context recall | 1.0000 | Yes |
| Faithfulness | 1.0000 | Yes |
| Response relevancy | 0.4407 | No |
| Factual correctness, precision mode | 0.5600 | No |

All semantic grades remain informational; the overall pass reflects blocking
safety checks, not universal quality success. Retrieval plus answer took 21.89
seconds. Usage measured 36,946 tokens over 15 successful calls: one answer,
11 judge, two judge-embedding and one query-embedding calls. No pricing schedule
was supplied; cost is unknown, not zero. Reasoning tokens are already included
in output totals. No repeat trial or refund action occurred.

Private artifacts (all mode `0600`) are under
`/private/tmp/cso-ragas-v2-approved-cwCuIwEv/`: `result.json`, `usage.json`,
`rejections.json` and `runner.log`. The saved run and diagnostic sidecar passed
schema/integrity validation. Temporary local files may not survive migration.
The subsequent agent-assisted review found an over-broad verification statement,
unnecessary exclusions, and an insufficiently explicit photo-before-approval
condition. These are review findings, not reconstructed judge reasoning: the
adapter retains numeric scores but not detailed claim-level explanations.
Owner approval of the answer rubric is not completed independent calibration.

## Offline evaluation follow-up on 2026-09-13

The bounded batch used one Sol worker for read-only rejection-replay readiness,
one for a single missing intake-evaluation case, and a separate read-only review
after implementation. No new diagnostic or production guard was implemented.

- Added `refund-agent-failure-modes-v1.json`: one synthetic retrieval-outage
  case, separate from the unchanged seven-case agent dataset. It exercises the
  real LangGraph intake with deterministic external dependencies and the real
  fallback answer. A proposal remains ready, but knowledge is unavailable,
  composition is fallback, citations are empty, and the answer model is not
  called. No refund is authorized or executed.
- Added three automated tests for fixture validity, one trial through all
  seven existing graders, and deliberately corrupted observations rejected by
  final-state, forbidden-tool and safety graders. Trace assertions are automated
  tests, not a new generic trajectory-grading framework. The worker observed
  three missing-fixture failures before adding the fixture, then three passes.
- Coordinator verification: **221 Evaluation Runner tests passed in 3.19
  seconds**, no skips; Ruff lint clean; all 41 Python files formatted;
  `git diff --check` passed. These are three new tests, not 221 paid evaluations.
- The separate read-only review finished with no blocking findings. Existing
  wrong-proposal-amount grader coverage was reused rather than duplicated in
  the new outage test.
- Read-only diagnostic finding: the live CLI is not answer-only. A passing
  answer proceeds to configured RAGAS judges. A future trial needs explicit
  approval covering that scope and optional private rejection retention.
  Offline delivery-validator replay needs the captured answer/citations plus
  exact CUSTOMER_SAFE evidence with matching content hashes. At that checkpoint
  the rejected answer had not been retained. The later v7 capture is diagnosed
  above; the earlier uncaptured response's exact cause remains unknown.

This batch made no paid calls, live-score measurements, service/token changes,
provider actions, dependency changes or Git mutations. RAG reference review and
human calibration remain pending; no reference answers or human marks changed.
Full Temporal/human/provider evaluation, LangSmith export and public tau
benchmark integration remain unimplemented. See the Evaluation Runner README
for the replay boundary and the source-review worksheet for owner decisions.

## Offline v2 diagnostics and dataset-review batch on 2026-09-12

The owner approved two independent workstreams. One Sol worker extended the
existing diagnostic boundary; another prepared source review and then performed
a bounded read-only review of the diagnostic change. The coordinator integrated
documentation and ran the full Evaluation Runner suite once on settled code.

- Diagnostic mode now allows only the exact resolved paths and reviewed SHA-256
  pins of `refund-rag-answer-v1.json` and `refund-rag-answer-v2.json`. Copied or
  modified fixtures are rejected before external clients are constructed. The
  bytes that pass the pin are reused for parsing. Capture is still opt-in,
  private (`0600`), non-overwriting and separate from quality samples.
- Tests exercise both versions and an offline v2 path through the real answer
  composer, executor, adapter and runner. Only the external model and retrieval
  are doubled. A deliberately uncited policy-window answer produces
  `DELIVERY_AGE_TEXT_REJECTED`; its private diagnostic is retained while the main
  trial remains `SYSTEM_ERROR`, with no sample or judge scoring. This synthetic
  test does not reproduce or reveal the uncaptured live answer below.
- [The worksheet](evaluation/RAGAS_DATASET_REVIEW.md) covers five seed, ten
  development and five held-out cases against the registered CUSTOMER_SAFE
  source. Its chunk map is fixture-level verification, not a fresh live-index
  check. All reference decisions and human calibration remain with the owner;
  the 15 candidate references still await review. Expected-evidence lists are
  minimum retrieval targets, not exclusive lists of permissible context.

| Verification | Result |
|---|---|
| New behavior before implementation | v2 diagnostic test failed against the old v1-only path check; v1 passed |
| Worker focused live-evaluator suite | 39 passed in 1.96 seconds |
| Coordinator full Evaluation Runner suite | 218 passed in 2.19 seconds, no skips |
| Additional test cases since the 212-test checkpoint | 6 |
| Ruff lint / formatting | Clean; 40 Python files already formatted |
| Whitespace and scoped code review | `git diff --check` passed; no review blockers |
| Guard and fixture preservation | SHA-256 checks confirmed answer implementation/tests and all five RAG fixture/manifest files unchanged |

No paid calls, new live scores, provider/refund actions, service or secret
changes, dependency changes, or Git operations were performed. Diagnostic
support is complete for this bounded batch; the underlying live rejection is
not fixed. Next: review the worksheet, obtain separate approval for a paid trial
and private rejected-answer capture, then reproduce any captured rejection
offline before choosing a behavior change. Do not expand cases or repetitions
automatically.

## Latest live v2 trial on 2026-09-12: rejected before grading

The separately authorized run `refund-ragas-dataset-v2-20260912-001` attempted
one damaged-item case and one repetition against dataset v2. Query embedding and
answer generation succeeded, but the production answer guard returned
`DELIVERY_AGE_TEXT_REJECTED`. The saved trial is `SYSTEM_ERROR`, with
`sample: null` and `grader_results: []`. No RAGAS judge or judge-embedding calls
ran. This is a failed system trial, not a zero-valued semantic score or a new
completed baseline.

The content-free usage report measured 14 query-embedding tokens and 3,952 answer
tokens (1,134 input plus 2,818 output), totaling 3,966 tokens. The answer's 2,624
reasoning tokens are included in its output count, not extra tokens. Cost remains
null because no price schedule was supplied. Both API calls succeeded; this
failure was not customer/staff token expiry. No retry or refund action occurred.

Machine-local artifacts are `/private/tmp/cso-ragas-dataset-v2-NtfSKU/result.json`
and `usage.json` in that directory. Temporary files are not portable handoff
dependencies; this entry preserves their outcome. The exact rejected response
was not captured because diagnostic mode was not enabled. Do not infer its
wording, assume a model violation versus a false positive, or change the guard
without further evidence. Any additional paid call needs fresh approval.

## Owner-approved RAG answer dataset v2 on 2026-09-12

The owner approved a revised damaged-item reference grounded in the published
CUSTOMER_SAFE policy: the 30-calendar-day request window, order/item identification
and photos before approval. The new `refund-rag-answer-v2.json` preserves all five
case IDs; only the dataset version and damaged-item reference differ from v1.
The historical v1 file retains SHA-256
`00aa539c014dfd3d45944c5f8bacc327e1c79dfdaf04b44027bd26a107f533d6`.
The original live result, production answer guard and diagnostic dataset pin were
not changed. This is reference approval, not completion of human calibration.

Four new offline tests first failed because the new dataset was absent, then
passed. They protect historical data and unchanged case fields, and exercise the
real RAGAS grader adapter to confirm the approved reference reaches context
precision, context recall and factual correctness. The external scorer is a
test double; its scores are not live RAGAS quality evidence. Independent
application facts are still appended only for factual-correctness comparison,
not for retrieval metrics.

Final verification: Evaluation Runner 212 tests passed in 2.87 seconds; Ruff lint
passed and all 40 Python files passed formatting checks. That offline reference
change made no paid calls or changes to services, tokens, embeddings, indexes,
refunds or Git history. The later live trial is recorded above. v2 results must
not be directly baseline-compared with v1. At this checkpoint, normal v2 usage
reporting was available, while rejected-answer capture supported only pinned v1.

## Offline RAGAS dataset, usage and comparison batch on 2026-09-11

The owner approved one coordinator and three bounded workers (two Sol, one Luna).
This batch expanded evaluation tooling and documentation, not the number of live
quality trials. It did not change the answer guard, original five-case seed,
secrets, services, indexes, refund state, dependencies or Git history.

1. Added 10 development and 5 held-out synthetic cases, with split membership and
   source SHA-256 provenance in `refund-rag-splits-v1.json`. References remain
   `AGENT_AUTHORED_PENDING_OWNER_REVIEW`. Four new fixture tests validate contract,
   split and trust-boundary properties, not live model quality. The held-out split
   is not an independent benchmark; true zero-evidence abstention is excluded.
2. Added opt-in, content-free provider-usage reports for query embeddings,
   structured answers, RAGAS judges and judge embeddings. Unknowns remain null;
   cache/reasoning counts are subsets, not extra tokens. Versioned caller-supplied
   prices may yield an estimate, never an invoice or a guessed historical cost.
   Usage reporting is attempted on fatal judge errors without hiding the error.
   Atomic publication refuses existing files and preserves another run's staging
   file. The production embedding provider only adds optional client injection.
3. Strengthened baseline comparison: reject incompatible evaluator/judge versions
   and repetition coverage; report completed-to-system-error regressions and the
   reverse recovery separately from semantic score changes.
4. Recorded the first completed live case and its human calibration checklist in
   `evaluation/RAGAS_BASELINE_REVIEW.md`. No human marks were fabricated.

| Verification | Result |
|---|---|
| Evaluation Runner full suite after the timeout correction | 208 passed in 2.32 seconds, no skipped tests |
| Added Evaluation Runner coverage | 28 cases beyond the pre-batch 180-test checkpoint |
| Worker focused usage/live/comparison/embedding checks | 66 passed in 1.82 seconds after the timeout correction; includes the new embedding-injection test |
| Dataset worker focused checks | 8 new-plus-seed tests passed |
| Ruff lint and formatting | Evaluation Runner clean, 39 files formatted; both changed Knowledge/RAG files clean |

External API responses were simulated with local test transports. No paid calls
were made. Review caught an injected-client timeout regression before completion;
the instrumented clients explicitly use 30 seconds and zero SDK retries. Focused
checks and the final full suite passed after that correction. These tests
establish tooling behavior, not new RAGAS scores. The one
real damaged-item trial remains the only completed live semantic measurement.
Next: owner reference review, separately approved remaining four seed cases,
then a separately approved five-case repeated run and judge/human calibration.
Production observability, LangSmith and public agent benchmark integration are
not completed by this batch. See the service README for usage flags, comparison
semantics and the file reading order.

## Answer boundary and synthetic diagnostics Batch 1 on 2026-09-11

The owner approved two scoped workers and later explicitly resumed their
interrupted work. This offline implementation batch made no paid model calls; a
separately authorized v6 trial later produced the first completed live semantic
measurement, recorded below.

Prompt `refund-answer-v6` makes eligibility qualification application-owned.
Three exact complete English uncertainty sentences are recognized (with NFKC
normalization), checked separately from the rest of the answer, and replaced
with the standard qualification. For example, "Your request has not been
assessed for eligibility." no longer fails solely for containing "eligibility".
Added clauses, unsupported positive/negative eligibility decisions and delivery
date requests still reject. The historical captured personalized-window response
continues to reject. Cited general windows still require matching duration,
calendar/business basis and recognized conditions. This is a small allowlist,
not a universal semantic validator, and it does not enforce delivery age.

The composer defaults to `capture_rejected_answer=False`. Explicit capture
retains a defensive copy of a schema-valid rejected answer before application
qualification or money is appended. It never retains malformed raw provider
output in that field, never returns a rejected answer, and leaves normal errors
with no rejected-answer payload.

The live evaluator accepts `--rejection-diagnostics-path` only for the built-in
reviewed synthetic dataset and its exact content hash. It parses those same
verified bytes, checks evidence scope before composing, and keeps rejected
responses in a separate owner-only (`0600`), non-overwriting file. Result and
temporary-path aliases, pre-existing outputs and missing output directories are
rejected before clients are constructed. The main result remains `SYSTEM_ERROR`
with no sample or semantic grades. A judge failure still invalidates the run and
writes neither new result nor diagnostic sidecar. No references or raw retrieved
passages are copied into the rejection sidecar. Read the Evaluation Runner README
for the opt-in contract and future dataset-pin review requirement.

| Fresh check | Result |
|---|---|
| Agent Runtime full suite | 143 passed, one existing Starlette deprecation warning |
| Evaluation Runner full suite with installed optional dependencies | 179 passed, no skipped tests |
| Focused worker checks | 95 answer tests; 38 evaluator/executor tests passed |
| Added coverage compared with the previous batch | 19 Agent Runtime cases and 20 Evaluation Runner cases |
| Ruff lint | Both packages passed |
| Ruff formatting | Two changed Agent Runtime files and all 36 Evaluation Runner files passed |
| Offline integrated failure path | Real composer, executor, adapter, runner and sidecar; only external retrieval/model replaced with test doubles; original rejected answer captured privately, SYSTEM_ERROR preserved, zero judge/external calls |

Both Sol workers completed. The coordinator reviewed their changes and ran the
full suites once on settled code. Customer-facing answer schemas, money formatting,
refund workflow authorization, dataset contents, model/judge metric inputs and
dependencies are unchanged. The four previously noted untouched Agent Runtime
formatting issues were not included in this bounded batch. No services were
restarted, no secrets or indexes changed, and nothing was committed or pushed.
The running Agent Runtime may still require a restart before browser testing;
an isolated evaluation command imports the current source in a fresh process.

Next: independently human-double-score the completed v6 case and adjudicate
disagreements before treating its scores as meaningful. Separately authorize any
expanded seed-case or repetition run; do not infer quality calibration or
production reliability from this one case.

## Seven-day local login tokens on 2026-09-11

The owner requested seven-day local customer and staff login tokens instead of
48-hour tokens. Edge now issues and validates a maximum lifetime of 604800
seconds. The Human Operations local token CLI defaults to 604800 and refuses
longer configured lifetimes; the running service continues to verify JWT expiry.
The configured staff TTL override was updated too, so the old 172800 value cannot
silently shorten newly generated tokens.

Both expired tokens were replaced in their effective ignored environment files,
preserving all identity claims, the staff role, and signing secrets. Signature
checks and the production identity verifiers accepted both renewed tokens. Both
have exactly 604800 seconds between issue and expiry, expiring September 18,
2026, at approximately 3:30 PM America/Chicago. No secret/token values were printed.
Customer Portal and Operations Console were restarted to load the replacements;
the running Edge watcher loaded the changed customer verifier.

| Check | Result |
|---|---|
| Edge API | Typecheck passed; 85 tests passed |
| Human Operations | Typecheck passed; 21 tests passed, 4 optional PostgreSQL tests skipped because the test database URL was not configured |
| New lifetime behavior | Test-first failures for seven-day customer validity and staff CLI acceptance/default, followed by passing tests after the bounded change |
| Customer web authentication | No session: 401; with local session and renewed upstream token: 404 `conversation_not_found` for a deliberately nonexistent valid ID, proving authentication passed without creating a conversation |
| Staff web authentication | No session: 401; with local session and renewed token: 200 on read-only case listing |
| Web pages | Both sign-in pages returned 200 |

The first Human Operations full-suite attempt hit sandbox `listen EPERM` errors
in four socket tests. The authorized local-socket rerun passed; no application
fix was required. All three edited environment files remain ignored by Git.
Browser cookie behavior, internal short-lived assertions, production auth plans,
refund state and RAGAS guards were unchanged. No paid calls, refunds, commits or
pushes were made. Seven-day local tokens do not solve the separate RAGAS
delivery-wording rejection.

## Latest live RAGAS attempt on 2026-09-11

After the offline prompt-v5 batch below, the earlier authorized synthetic trial
`refund-ragas-baseline-20260911-001` stopped after approximately 28.2 seconds
with `DELIVERY_AGE_TEXT_REJECTED`; it records `SYSTEM_ERROR`, no sample and no
semantic grades. A later v6 run, `refund-ragas-baseline-20260911-v6-4096-001`,
completed one `damaged-item-evidence-answer-v1` case in 142.13 seconds. Its
artifact is `/private/tmp/cso-ragas-v6-budget4096-0dnpe8/result.json`.

Observed RAGAS grades were context precision `0.8333`, context recall `0.6667`,
faithfulness `1.0`, response relevancy `0.6769`, and factual correctness
precision `0.73`. Deterministic grades passed and the runner marked the trial
passed, but context recall and response relevancy missed their nonblocking 0.7
minima. Thus the run passed its blocking gate; it did not establish calibrated
quality or a release threshold. The exact answer/source comparison and human
calibration checklist are in `docs/evaluation/RAGAS_BASELINE_REVIEW.md`.

This isolated evaluation does not use customer/staff login tokens. The answer
reached the production text guard; renewing login tokens cannot fix that rejection.
An independent offline contrast probe also exposed a false positive: the guard
rejected "Your request has not been assessed for eligibility." while accepting
"Your delivery timing has not been verified." Unsupported eligibility decisions
and mixed uncertainty-plus-eligibility claims remained rejected. The subsequent
v6 batch addressed this bounded false positive and added opt-in synthetic
diagnostics without weakening refund authorization. The completed one-case trial
above is the current live evidence; additional paid trials still require fresh
owner authorization, and a calibrated full-dataset baseline is pending.

## Offline prompt and RAGAS readiness batch on 2026-09-11

Prompt `refund-answer-v5` adds explicit conditional examples of permitted general
policy wording and prohibited personalized window/date requests. The 30-day
example is not a universal rule; the cited evidence must support its duration,
time basis, and conditions. A source comparison against the pre-batch local file
confirmed all guard regexes, validation/composer functions, monetary formatting,
and qualification logic are byte-for-byte unchanged.

The new Agent Runtime regression preserves the exact 753-character synthetic
answer from the September 10 diagnostic, its three citations and supporting
customer-safe evidence. It exercises the real composer with a substituted external
model response and confirms `DELIVERY_AGE_TEXT_REJECTED`. The existing positive
case confirms supported general-policy wording receives the qualification and
trusted USD amount. These tests preserve enforcement; they cannot measure whether
a live model follows the new prompt.

The evaluation readiness audit checked the five existing seed references and
evidence mappings against the pinned customer-safe policy. Existing tests already
cover metric-specific application-fact separation. A strengthened live-runner
test proves a failed system invokes no judges and persists no sample or semantic
grades. One new test proves a scorer exception invalidates the evaluation and
does not write a quality artifact. The executor's expected prompt version was
updated to v5 after integration exposed the stale v4 assertion. Datasets and
production Evaluation Runner code were not changed.

| Final check | Result |
|---|---|
| Agent Runtime full suite | 124 passed; one existing Starlette deprecation warning and a sandbox pytest-cache warning |
| Evaluation Runner full suite, including installed optional integration dependencies | 159 passed with pytest cache disabled |
| Ruff lint | Both packages passed with cache disabled |
| Ruff formatting | Two changed Agent Runtime files and all 36 Evaluation Runner files passed |
| Added coverage | Two new tests, one strengthened existing test, one updated version expectation |

The initial Ruff invocation could not write its cache in the sandbox; rerunning
with `--no-cache` passed without application changes. The four previously recorded
untouched Agent Runtime formatting failures were not part of this bounded change.

Reading order: [prompt and composer](../apps/services/agent-runtime/agent_runtime/refund/answer.py),
[captured-response regression](../apps/services/agent-runtime/tests/test_refund_answer.py),
[live evaluation failure tests](../apps/services/evaluation-runner/tests/test_live_rag_evaluation.py),
then [the evaluation run guide](../apps/services/evaluation-runner/README.md).

Both scoped Sol workers finished; the coordinator reviewed their diffs and ran
the final suites. No paid APIs, model calls, provider/refund actions, secrets,
datasets, indexed documents, service processes, or Git history were changed in
this batch. The code and documentation were uncommitted at that checkpoint and
are now included in the September 14 pushed history. The running Agent
Runtime was not restarted in that batch; a browser recheck then needed it to load
v5. An isolated evaluation command imports the current source in a new process.

At that checkpoint, the next step was a separately authorized one-case live trial.
The later v6 trial above completed that step. The bounded dataset/repetition run,
fresh browser wording check, and calibrated semantic release gates remain pending.
Do not equate offline completion with completed RAG evaluation.

## Live RAGAS attempt and diagnostic on 2026-09-10

After the offline grounding correction, the owner separately authorized one live
trial and one diagnostic retry of the same synthetic damaged-item case. These
were not part of the earlier offline checks below.

| Attempt | Evidence | Outcome |
|---|---|---|
| `refund-ragas-baseline-20260910-001` | One `damaged-item-evidence-answer-v1` trial, evaluation version `refund-ragas-v2`, answer/judge configuration `gpt-5-nano`, embeddings `text-embedding-3-small`; about 30.3 seconds elapsed | `SYSTEM_ERROR`, `sample: null`, `grader_results: []`; answer rejected with `DELIVERY_AGE_TEXT_REJECTED` before semantic grading |
| `refund-ragas-diagnostic-20260910-001` | One separately authorized answer-only diagnostic using the same synthetic case and customer-safe evidence; 28.26 seconds elapsed | The captured answer included "Ensure your request is within 30 calendar days of delivery." The unchanged guard rejected personalized, unqualified window wording. No RAGAS judges ran. |

The retrieved damaged-item policy did contain the 30-calendar-day rule. This was
not evidence that the policy duration was invented: the problem was how the answer
applied/explained it when customer delivery timing was unverified. Offline replay
accepted the supported general-policy alternative and required the usual
application-owned qualification. It did not prove future model compliance.

Neither attempt executed a refund or changed the knowledge corpus. They produced
no semantic quality scores; an absent score is not a score of zero. These timings
are single-run observations, not a latency benchmark. Actual paid token/cost
accounting was not captured, so default zero-valued accounting fields must not be
interpreted as zero spend. At that checkpoint, the successful live RAGAS baseline
was still pending; the later one-case v6 measurement is recorded above and is not
a calibrated full-dataset baseline.

## Independent RAGAS grounding correction on 2026-09-10

The Evaluation Runner now records independently derived synthetic application
facts separately from retrieved policy. Faithfulness receives both sources;
factual-correctness precision uses the reviewed reference supplemented with those
facts. Retrieval precision/recall and their corpus are unchanged. No facts or
answer keys are extracted from generated responses. The grader version is now
`ragas-0.4-adapter-v2`; old and new scores cannot be directly baseline-compared.

Fresh offline verification: **158 Evaluation Runner tests passed**, Ruff lint
passed, and all 36 Python files passed formatting checks. The added regressions
cover independent money/status facts, malformed facts, metric-specific input
separation, unchanged retrieval evidence, and nonblocking grader-version mismatch.
Eleven missing-behavior tests failed before implementation; all pass now.

This verifies wiring and guardrails, not LLM-judge quality. A successful paid
one-case baseline and fresh browser wording recheck remained pending at that
checkpoint. No paid API,
refund execution, runtime code, secrets or indexed documents were changed by
this evaluation-only correction. No commit or push was made.

## Cited delivery-policy wording correction on 2026-09-10

The September 7 one-case live RAGAS artifacts `refund-ragas-baseline-20260907-003`
and `refund-ragas-baseline-20260907-004` recorded `SYSTEM_ERROR` with
`DELIVERY_AGE_TEXT_REJECTED`, not RAGAS quality scores. The old wording guard
rejected a general delivery-window statement even when it matched retrieved policy.

Prompt `refund-answer-v4` and `validate_delivery_policy_text` now distinguish a
supported, cited general policy explanation from personalized eligibility. The
bounded matcher checks the exact cited document/chunk, duration, time basis and
recognized rule conditions. An accepted explanation receives the application-owned
qualification that the customer's delivery timing has not been verified. Common
unsupported/mixed/negated windows, date questions, and personalized conclusions
are rejected. Trusted monetary formatting and the final answer length contract
remain in place. This is English defense in depth, not general semantic validation
or delivery-age enforcement.

Offline verification:

| Check | Result |
|---|---|
| Agent Runtime | Full suite: 123 passed, one existing Starlette deprecation warning |
| Evaluation Runner with installed optional production/RAGAS dependencies | Full suite: 141 passed |
| Production composer through evaluation adapter | Regression reproduced the old rejection, then passed with the qualified answer and unchanged evidence |
| Ruff lint | Both packages passed |
| Formatting | Changed Python files and all Evaluation Runner files passed; four untouched Agent Runtime files still fail formatting |

The four existing formatting failures are `agent_runtime/integrations/customer_evidence.py`,
`agent_runtime/integrations/trusted_context.py`, `agent_runtime/refund/router.py`,
and `tests/test_customer_evidence.py`. They were not changed by this fix.
Offline tests replace external model/retrieval calls; they do not prove live
model compliance or RAGAS score quality. No servers, secrets, indexed documents,
paid APIs, or provider refunds were changed or exercised in this correction.

A successful live RAGAS baseline and a fresh browser wording recheck remain
pending. The subsequent evaluation-only grounding correction above addresses the
distinction between retrieved policy and application-owned facts. Existing
reviewed reference answers are unchanged on disk. No commit or push was made for
this correction.

## Automated validation run on 2026-09-03

The documentation release was checked without starting application servers,
calling a paid model, or executing a refund.

| Check | Result |
|---|---|
| Protobuf lint and JSON contract tests | Passed, 21 tests |
| Edge API | Typecheck passed, 45 tests passed |
| Conversation Runtime | Typecheck passed, 25 tests passed, 1 optional PostgreSQL integration test skipped because `CONVERSATION_TEST_DATABASE_URL` was not set |
| Integration Gateway | Typecheck passed, 44 tests passed |
| Workflow Workers | Typecheck passed, 45 tests passed including Temporal workflow tests |
| Human Operations | Typecheck passed, 9 tests passed, 1 optional PostgreSQL integration test skipped because `HUMAN_OPERATIONS_TEST_DATABASE_URL` was not set |
| Control/Knowledge | Typecheck passed, 12 tests passed |
| Agent Runtime | Ruff passed, 46 tests passed |
| Knowledge/RAG | Ruff passed, 101 tests passed |
| Customer, Operations, and Admin frontends | All typechecks and production builds passed |
| Markdown links and diff whitespace | Passed |
| Final architecture PDF | 192 pages, metadata checked, amendment and appendix transition visually rendered and inspected |

Total automated tests: 348 passed and 2 optional database integration tests
skipped. The Python suites emitted an upstream Starlette/httpx deprecation warning;
it is not a test failure but should be handled during a future dependency upgrade.

## Latest conversation-context verification on 2026-09-04

Commit `e5fbe50` (`Preserve customer context across refund chat turns`) fixes a
multi-turn customer-chat defect: the agent previously received only the latest
message, rather than the earlier customer-provided order reference.

| Check | Result |
|---|---|
| Edge API | Typecheck passed, 50 tests passed, including prior-reference propagation and ambiguous-reference rejection |
| Agent Runtime | Ruff passed, 49 tests passed, including ordered bounded conversation-context validation and graph propagation |
| Live local BFF sample | Passed. First turn supplied `AVV8JSZH8G6ZZDMX`; second turn supplied the damaged-item reason without repeating the reference; assistant retained the reference and did not ask for it again |
| Refund safety | The sample created a local review workflow only. No preview was confirmed and no refund execution was requested |

The live sample measured 20.68 seconds for the first Edge API message and 18.82
seconds for the second. Conversation persistence/read operations were 6.5–49.9
ms, local MCP Gateway calls were 268–291 ms, and the asynchronous Temporal
workflow completed in 356 ms. The Agent Runtime accounts for roughly 19–21
seconds because it includes configured model calls and RAG. Per-hop model and
retrieval timings are not yet instrumented with OpenTelemetry.

## Positive local browser-to-provider proof on 2026-09-05

The following are disposable local test identifiers, not reusable seed data:

| Evidence | Result |
|---|---|
| Order | `23NK4CXW6XYMA5NE`, Vendure order 6, one Laptop 15 inch 8GB, delivered |
| Requested and settled amount | USD 1,683.80, including USD 5.00 shipping |
| Workflow | `refund-8ab2c8c1-4ef0-4878-974a-4959c0342453` |
| Human case | `case-7f3833c0-16c9-4a3d-ac76-04f1d2592da6` |
| Confirmed preview | `b4114bda-5ca1-414e-8f5e-05910cfe072f`, accepted at 18:01:15.705 UTC |
| Conversation | Four committed messages, customer/assistant/customer/assistant; second customer turn omitted the reference, which the answer retained; one workflow-link idempotency record; encrypted messages matched their stored integrity hashes |
| Human review | `TAKEOVER_REQUIRED`, then assigned supervisor approved an exceptional refund plan; case audit `OPENED → CLAIMED → DECISION_RECORDED → CLOSED`; decision outbox `DELIVERED` |
| Execution | One `executeRefund` activity, attempt 1, zero activity failures; one Gateway execution row and one Vendure refund, ID 4 |
| Provider settlement | With separate owner authorization, existing simulated refund 4 was marked `Settled` at 18:06:25.273 UTC; no new refund was created |
| Gateway | `SUCCEEDED` at 18:11:20.967 UTC; audit `requested → submitted → succeeded` |
| Temporal | Completed with `REFUND_SUCCEEDED` at 18:11:21.018 UTC, matching refund 4 and the confirmed amount |
| Customer browser | Automatically changed from **Refund initiated** to **Refund completed**, with **No action is needed** and USD 1,683.80 |
| Completion mechanism | Normal reconciliation, not a forced success signal; zero provider webhook events |

Trusted facts were refreshed after exceptional approval and immediately before
execution. Human claim and decision records each contain an idempotency key and
request fingerprint. The staff role is checked by the decision route; this audit
does not claim the database separately stores the role claim.

The dummy payment handler does not automatically settle refunds. This test
simulated the provider's final confirmation in Vendure and waited for the next
five-minute reconciliation check. No real bank transfer occurred. The order is
now refunded and must not be reused for another positive execution test.

## Photo-gated local browser-to-provider proof on 2026-09-06

This later owner-authorized run closes the prior gap between the photo-gate
smoke and positive provider execution. These are disposable local test records,
not portable seed data or production transactions:

| Evidence | Result |
|---|---|
| Order | `AUUYAWRHBVGJPK5R`, Vendure order 2, two Laptop 13 inch 8GB units |
| Scope and amount | Full order, USD 3,122.60 |
| Workflow | `refund-19928c34-afd6-4e0a-b709-29d8ca36381a` |
| Human case | `case-8307800e-a61c-4295-bfad-d118931137b7` |
| Photo review | First photo passed technical validation; staff requested a clearer photo; the replacement was accepted at its exact evidence revision |
| Monetary review | The same case changed from evidence review to monetary takeover; a supervisor separately approved the exceptional refund plan |
| Customer confirmation | Exact preview `724a34e6-f044-448e-817d-a17d02fa7dac` confirmed |
| Provider submission | Gateway created exactly one Vendure refund, ID 5, initially `Pending` |
| Provider settlement | Separate owner authorization changed existing refund 5 to `Settled`; no second refund was created |
| Final workflow | Temporal reached `REFUND_SUCCEEDED` |
| Final customer projection | `REFUND_COMPLETED`, with no customer action |

Technical image validation, staff acceptance of the exact photo set, supervisor
monetary approval and customer confirmation remained distinct gates. This run
proves the local photo-gated path to the Vendure simulator's settled refund state;
it does not prove real bank settlement or live payment-provider webhook delivery.
Do not reuse this now-refunded order for another positive execution test.

The successful browser run still generated an unsupported request for the
delivery date. The subsequent wording safeguard is implemented and automatically
verified as recorded below; a fresh paid live browser recheck has not been run.
The successful refund outcome does not establish trusted delivery-age eligibility,
which remains unimplemented.

## Order-contract recovery verification on 2026-09-06

Vendure's manual fulfillment returned an empty method string. That provider
shape violated the nonempty method expected by the order contract. Gateway now
normalizes blank provider methods to `unspecified`; it does not invent a carrier
or delivery date. Edge now maps the typed `order_lookup_unavailable` result to a
customer-safe, retryable HTTP 503 response.

| Check | Recorded result |
|---|---|
| Integration Gateway | Typecheck passed; all 44 tests passed |
| Edge API | Typecheck passed; all 83 tests passed |
| Agent Runtime (earlier September 6 order-contract checkpoint) | Ruff passed; all 98 tests passed, with one upstream warning |
| Live order lookup | Signed REST and MCP lookup passed |

These focused/full checks belong to the earlier September 6 order-contract
checkpoint. The subsequent wording-safeguard result is recorded separately below.
No additional model/provider request was made to prepare this documentation
update.

## Delivery wording safeguard verification on 2026-09-06

After the browser proof, `SYSTEM_PROMPT` was updated to forbid asking for a
delivery date or stating a delivery-age window. Runtime defense-in-depth rejects
either wording, allowing the existing graph to use its safe fallback. The full
Agent Runtime suite passed **101 tests**, with the same one upstream warning.

This is automated verification of the implemented safeguard, not a repeat of the
live journey: a fresh paid live browser recheck has **not** been run. Trusted
delivery-age eligibility remains unimplemented; neither a model question nor a
customer answer supplies trusted delivery facts.

## Evidence matrix

| Area | Implementation | Automated evidence | Manual evidence | Current status |
|---|---|---|---|---|
| Customer login and BFF | Implemented | Route and UI checks | Local sign-in used | Verified locally |
| Conversation Runtime | PostgreSQL encrypted transcript, workflow links, and bounded customer-history handoff | Unit/integration tests | Two-turn customer context retained through Edge and Agent Runtime | Verified locally |
| Agent proposal | LangGraph typed refund proposal | Python tests | Real configured model exercised | Verified locally |
| Customer-safe RAG | OpenSearch hybrid retrieval and grounded answer | Retrieval/evaluation tests | Online retrieval returned customer-safe cited chunks | Verified locally |
| Deterministic policy | Versioned refund decisions | Worker tests | Seen in local workflows | Verified locally |
| Temporal workflow | Preview, confirmation, human review, execution, reconciliation | Unit/integration tests | Safe takeover path used | Verified locally |
| Human Operations | PostgreSQL cases, audit, idempotency, durable decision outbox | Service tests | Queue, claim, exceptional plan used | Verified locally |
| Integration Gateway | Vendure projection, MCP, refund authorization, idempotency, provider events | Service tests | Vendure refund previously observed | Verified locally |
| Private photo gate | Implemented for policy v2 | Contract, service, revision, ownership and workflow tests | Clearer-photo request and exact replacement acceptance before monetary takeover | Verified locally on 2026-09-06 |
| Positive local browser-to-provider path | Implemented | Focused paths covered | Photo-gated exceptional-refund proof recorded above: one refund, settlement of that same refund, completed workflow/customer projection | Passed locally on 2026-09-06 |
| Local operational observability | Opt-in Edge, Agent Runtime, Knowledge/RAG phases, Gateway, Workflow Worker activities, Human Operations and Conversation Runtime | 469 earlier dependency tests plus the current focused readiness checks recorded above | Earlier Grafana panel/service-series proof; current dashboard/alert configuration validated statically | Local diagnostic foundation; not production monitoring |
| Production auth, remaining observability, event backbone, AWS | Planned | None | None | Not implemented |

## Display cleanup validation on 2026-09-05

The customer page now displays **Original payment method** instead of the raw
destination enum. **Review by** appears only while confirmation is the next
action. The original preview, amount, confirmation payload, and timeline are
unchanged.

| Check | Result |
|---|---|
| Customer display helpers | 7 regression tests passed: known and unknown destinations, deadline visibility, and unchanged normalized preview/amount |
| Customer Portal | Typecheck and production webpack build passed |
| Agent Runtime | Ruff lint and 97 tests passed; the four locally changed Python files pass the formatter check |
| Shared contracts | Protobuf lint and 21 JSON contract tests passed |
| Existing completed customer page | Shows USD 1,683.80, **Original payment method**, **Refund completed**, and **No action is needed**; no **Review by** |
| Documentation | 26 local links checked across 10 changed Markdown files; diff whitespace check passed |

This targeted rerun totals 125 passing tests; it is not a fresh full-stack
regression run. No additional model call, confirmation, refund, or provider
mutation was performed during the display check.

The full Agent Runtime formatter check found existing formatting differences in
`agent_runtime/integrations/customer_evidence.py`,
`agent_runtime/integrations/trusted_context.py`, `agent_runtime/refund/router.py`,
and `tests/test_customer_evidence.py`. These unrelated files were left unchanged.
The test suite also emits an upstream Starlette/httpx deprecation warning. The
native Node test runner emits a module-type warning; neither warning failed tests.

## Answer-composer regressions fixed before the positive test

The local answer path now receives trusted public order references and product
names instead of internal IDs. Conflicting order labels trigger safe fallback.
The model no longer receives the proposed amount as raw minor units; common
monetary expressions in its prose are rejected and application code appends the
formatted proposed USD amount. The underlying structured proposal is unchanged.

Agent Runtime Ruff and all 97 tests passed on 2026-09-05, including order-reference,
money formatting, safe-fallback, and graph regressions. The real two-turn browser
test retained the reference and displayed the correct USD 1,683.80. These fixes
were in the local working tree during the proof and are now included in the
September 14 pushed history. Local data and secrets still do not travel with a clone.

At this checkpoint the remaining gaps included generated technical field labels,
missing photo intake/gating, delivery-age checks and a premature preview timeline
step. The later photo slice and timeline fixes below address intake/gating and
that timeline defect. Broader generated-wording evaluations and delivery-age
eligibility remain gaps; the September 6 delivery wording safeguard has the
separate automated verification recorded above.
The confirmation-expiry gap identified during this review was implemented in the
follow-up below. Hiding the displayed deadline remains presentation only; the
authoritative guard is in Temporal.
Bounded wording guards do not replace answer, citation, specialist, trajectory,
and safety evaluations.

## Confirmation expiry implementation and verification on 2026-09-05

`waitForRefundConfirmation()` is shared by allowed, approval-required, and
supervisor-exceptional paths. It accepts only the first matching confirmation
processed before `validUntil` on the workflow clock, ignores the supplied
`confirmedAt` for authorization, and times out when no decision arrives. Invalid
or already expired deadlines fail closed as `PREVIEW_INVALIDATED`. Timely
acceptance is not invalidated by later human review or provider-processing delay;
the existing authoritative fact refresh and balance checks still apply.

Edge checks ownership first, rejects stale/terminal preview confirmations with
HTTP 409 `refund_preview_unavailable`, and handles a workflow-completion race
without disguising infrastructure errors. HTTP 202 is signal acknowledgement,
not proof that a confirmation or refund was accepted. The customer projection
offers no confirmation on an unavailable preview and does not expose raw facts.

| Check | Result |
|---|---|
| Workflow Workers | Typecheck and all 58 tests passed |
| Edge API | Typecheck and all 64 tests passed |
| Customer Portal | Typecheck, 8 tests, and production webpack build passed |
| Shared contracts | Protobuf lint and 21 JSON contract tests passed |

Total for this feature: 151 passing tests. The initial backdated-confirmation
regression failed on the old code (`REFUND_SUCCEEDED` instead of
`PREVIEW_INVALIDATED`) and passed after the fix. Exact before/at/after boundaries
are covered by the same pure deadline predicate used in the workflow handler.
Workflow tests cover all three timeout paths, malformed/old deadlines, wrong
preview IDs, duplicate decisions, timely decline, delayed approval/settlement,
timer survival across worker replacement, and replay of patched and synthetic
pre-patch histories. Legacy histories are generated with both expiry patches
disabled in the isolated test worker, not by modifying real workflow history.

The time-skipping server stalled on sticky-worker replacement in the first test
attempt. The test harness now disables the worker cache, checks that the timer is
persisted before replacement, and surfaces worker failures. The restart and full
suite reruns passed; production worker settings were not changed.

### Rollout limits

- Newly created waits schedule a durable expiry timer.
- Pre-patch waits that were already parked remain replay-compatible. Their next
  live confirmation is deadline-checked by the new worker, but an idle legacy
  wait does not acquire a timer retroactively. An authorized inventory/migration
  is still needed for universal autonomous expiry coverage.
- For v1, preview expiry inherits the original policy decision deadline; late
  exceptional approval cannot extend it. The later photo-gated v2 exceptional
  path obtains fresh accepted evidence and commerce facts and reevaluates its
  pinned policy before creating a confirmation preview.
- The initial feature check made no model/provider calls or production changes.
  The later synthetic browser expiry proof and authorized token renewals are
  recorded below. No legacy project workflow was migrated.

### Follow-up browser expiry proof

On 2026-09-05, isolated fixture
`refund-expiry-smoke-c1f4c829-1d97-4559-b6cd-61665c704b61` showed a USD 50.00
preview with confirmation controls, then automatically changed to **Refund
preview no longer available** at its deadline, without clicking or reloading.
The deadline was `2026-09-05T22:26:40.836Z`.

- Edge workflow and journey reads returned 200, with `PREVIEW_EXPIRED` in the
  customer projection and no confirmation action.
- A late confirmation returned 409 `refund_preview_unavailable`.
- History recorded the durable timer and expiry patch marker, zero confirmation
  signals and zero scheduled/attempted refund executions.
- The dedicated test worker stayed alive for a three-minute inspection window,
  then stopped. Querying this completed fixture later requires a worker on its
  unique queue; a 502 after the hold is not evidence that the main stack is down.

Both local login tokens were renewed with existing identity/role/signing secrets.
Customer expiry: `2026-09-07T22:05:40Z`; staff expiry:
`2026-09-07T22:30:56Z`. Both browser sign-ins were verified. Only the effective
ignored web environment files changed; no token or secret is recorded here.

## Private photo evidence verification on 2026-09-05

See [Refund Photo Evidence](REFUND_PHOTO_EVIDENCE.md) for setup and code reading
order. New damaged-item requests pinned to v2 wait for assigned staff acceptance
of a private photo revision. That acceptance does not authorize money.

| Changed boundary | Passing tests | Other checks |
|---|---:|---|
| JSON contracts | 91 | Strict public/internal schemas, rejected private fields |
| Edge API | 81 | Typecheck; owner-first upload/content checks and timeline regressions |
| Workflow Workers | 74 | Typecheck; replay, confirmation, frozen revision, collection expiry, continue-as-new deadline |
| Human Operations | 23 | Typecheck; isolated PostgreSQL, zero skipped tests |
| Customer Portal | 21 | Typecheck and production build |
| Operations Console | 7 | Typecheck and production build |

The Human Operations database tests used a dedicated temporary cluster and the
restricted `cso_human_operations_app` role with both `rolsuper=false` and
`rolbypassrls=false`. Unscoped/cross-tenant reads were invisible and cross-scope
writes were denied. Five photos followed by `REQUEST_MORE_EVIDENCE` preserves the
old files/audit, opens a fresh current set, and rejects acceptance of an old
revision. Corrupt/missing accepted file bytes fail closed. The test cluster was
stopped without deleting its directory; the project database was not replaced.

Human Operations migration 003 was applied locally. Private normalized file
storage and non-destructive stale-upload recovery are configured. Automatic
retention deletion remains disabled pending owner-approved retention rules.

The live integration smoke passed with workflow
`refund-evidence-smoke-54f4e4a3-8856-49be-b37b-467345b1681d` and case
`case-a37c5535-b3e8-4673-80e1-9afc5b6ac162`. It used real Temporal, Edge and Human
Operations APIs, the real activity factory and policy v2, and generated PNGs.
Commerce facts were synthetic; no model or provider calls were made.

- Owner-mismatched journey, upload and image requests returned 404.
- Upload replay was idempotent; customer and claimed-staff image reads were
  private and decoded as the expected normalized PNGs.
- Staff requested clearer photos, then accepted the exact replacement revision.
  The superseded image was excluded from the accepted set.
- The same case became `REFUND_TAKEOVER`, clearing its evidence-phase assignment.
  The supervisor reclaimed and rejected it as safe test cleanup.
- Three fact refreshes were observed across the fixtures. No confirmation signal,
  refund execution, or reconciliation was scheduled or attempted.
- Browser inspection showed the photo input, private photo rendering and evidence
  acceptance message; the unclaimed staff case showed only claim controls, not
  monetary actions. Upload/review mutations in this smoke were driven by HTTP,
  not manual browser clicks.

Final review also fixed and tested two lifecycle defects: accepted evidence cases
are closed if an approval preview expires or is declined; aborted uploads release
their capacity exactly once, but active processing retains capacity until it
settles. Four real-socket tests cover disconnect/timeout/authorization races.

All 297 tests in the changed-boundary table pass. Edge, Human Operations and
Workflow Workers were restarted with the final code. Edge's ignored local
configuration now pins **new** requests to `refund-policy-v2`; existing workflow
versions are untouched. All 12 service/interface HTTP probes returned 200 and the
Workflow Worker reported RUNNING. No Git commit, push, merge, model call, or
provider refund execution was performed in this follow-up. Synthetic cases,
photos and workflow histories are retained for audit; their IDs distinguish them
from real requests.

## Read-only payment and refund status, 2026-10-02

The existing authenticated support conversation now uses a separate,
owner-checked Gateway lookup for bounded payment and refund status. The
projection has four fields and omits transaction identifiers, payment method,
provider details, amounts, and private order data. Unknown or inconsistent
commerce states fail closed to `UNCERTAIN`. The deterministic answer specialist
only discusses the aspect the customer asked about. Edge rejects an unexpected
refund proposal on this path, so a status question cannot start Temporal or
execute a refund.

Agent Runtime passed 393 tests; Gateway passed 99; Edge passed 118; contracts
passed 107; evaluation-runner passed 281, including seven new synthetic payment
cases within 26 cases and 52 trials. Gateway and Edge typechecks passed. A
read-only review found common declined/authorized/received-payment phrasings
were being clarified; new red-green regression cases corrected that routing.

One local backend conversation used the existing owned order
`9KWUQ1TBZ7NUV8EU`. The payment turn returned a recorded-payment answer and
the refund-status turn returned a completed-refund answer. Both returned 202;
neither linked a refund workflow. No refund creation, confirmation, or
settlement occurred during this check. Browser UI QA and production provider
behavior remain unverified. See [READ_ONLY_SUPPORT_JOURNEYS.md](READ_ONLY_SUPPORT_JOURNEYS.md)
for the exact answers and boundaries.

## Support and signed-request hardening, 2026-10-02

Independent offline reviews reproduced three support-answer errors: a
different-reference status projection could reach the customer, a long but
valid fulfillment list raised an uncaught answer-validation error, and a
request for a specific product variant could quote unrelated variants and
prices. The narrow fixes bind requested and returned order references at both
Gateway and Agent Runtime, fail closed on oversized answers, and render the
exact requested catalog variant or clarify/fail closed.

Another review reproduced a cross-origin 307 redirect forwarding a synthetic
signed delivery assertion; report creation also forwarded its body and
idempotency key. Edge's three signed delivery requests now reject redirects.
The same explicit redirect rejection was added to Gateway's Vendure Admin
and Shop API requests so the configured credentials cannot follow a redirect.
These are transport defenses; they are not proof that every other service or
production network path is fully hardened.

After these changes, the full local offline suites passed: 107 contract,
121 Edge, 101 Gateway, 399 Agent Runtime, and 281 evaluation-runner tests.
Gateway and Edge typechecks and changed Python Ruff checks passed. No provider
mutation was run as part of the audit. The previously recorded payment-status
backend smoke occurred before these final hardening edits and is not a fresh
post-hardening browser test.

## Refund execution safety hardening, 2026-10-02

An isolated fake-provider test showed that a valid short-lived execution
assertion could be replayed with a changed amount and idempotency key for the
same preview. Another isolated test showed that reconciliation could mark a
new pending refund successful by selecting an older settled refund of the
same amount. Both are fixed: Worker signs the exact execution instruction,
Gateway verifies it and reserves one execution per workflow/preview, and
reconciliation requires the current provider refund ID. Unknown provider
identity remains unresolved rather than becoming success. Separate synthetic
redirect tests showed signed service assertions could cross a 307; affected
Edge, Worker, and Gateway clients now refuse redirects.

The full post-fix local offline suites passed 107 contracts, 123 Edge, 120
Gateway, 80 Workflow Workers, 411 Agent Runtime, and 281 evaluation-runner
tests. Typechecks for all changed TypeScript services passed. Local Gateway
migration 005's additive unique index was applied after confirming zero
duplicate groups; no records were deleted. The updated Worker started on
Node 24. No new live refund/provider mutation or browser-to-provider proof
was run after these changes. See
[REFUND_EXECUTION_SAFETY_2026-10-02.md](REFUND_EXECUTION_SAFETY_2026-10-02.md)
for exact failure modes, rollout coupling, and verification limits.

One bounded post-hardening backend chat turn asked the local catalog price of
“Laptop 13 inch 8GB.” Edge returned HTTP 202, the transcript contained the
matching variant and 1558.80 USD price, and no refund workflow link appeared.
This exercised the running Edge, Agent Runtime, and Gateway read-only path with
the configured model; it was not a browser UI test or a refund execution test.

## Cancellation item-name preview hardening, 2026-10-02

The owner-scoped Gateway cancellation facts now join each provider line ID to
exactly one owned order item and carry its bounded name to Worker, Edge, and
Customer Portal as display-only metadata. A reviewer found that invisible and
bidirectional Unicode controls could defeat a blank-name check. Red-green
tests were added and all four boundaries now refuse Unicode control/format
characters and names without a letter or number. Legacy nameless previews
render a labeled item ID; React renders markup-like names as escaped text.
Names do not enter the provider digest, confirmation request, or authorization
equality check.

Fresh offline results: Gateway 344/344, Workflow Workers 111/111, Edge
167/167, Customer Portal 152/152, and canonical contracts 111/111. All four
changed apps passed typecheck and build; `git diff --check` passed. No live
cancellation or browser walkthrough was performed. Current-worker tests cover
nameless legacy-shaped data, but a captured pre-change Temporal history has
not been replayed. This remains a rollout check, not a claim of production
compatibility. Changes remain uncommitted in the pre-existing dirty tree.

## Delivery review closure, 2026-10-02

Human Operations now supports a separate, assigned-staff-only
`ACKNOWLEDGED -> REVIEW_CLOSED` transition with exact expected version,
idempotency, and transactional audit. The Operations Console exposes **Close
review** only when the authenticated staff detail explicitly permits it; the
backend remains the final authority. Edge and Customer Portal expose only the
six-field customer receipt and fixed copy: closing the review does not prove
the delivery problem was fixed or a remedy was provided. The customer can
return to support. No refund or other commerce action is attached to closure.

An isolated PostgreSQL 17 cluster applied Human Operations migrations 001–006
and preserved an existing acknowledged report, RLS, and grants. Its full suite
passed 74/74 without database skips. Edge passed 168/168, Customer Portal
153/153, Operations Console 74/74, and canonical contracts 111/111. The
changed TypeScript apps passed typecheck and build. `git diff --check` passed.
Two independent scoped reviews found no Critical, Important, or Minor issues.
Migration 006 was then applied to the running local project database. An
existing acknowledged report returned HTTP 200 to a read-only authenticated
staff detail request with `can_close_review: true` and an audit array. The
database retained 8 acknowledged, 1 claimed, and 45 received reports before
the smoke. A guarded one-shot local backend test then created disposable report
`delivery-ab8acd27-3626-45a2-9994-2b0c548db792` on owned order
`9KWUQ1TBZ7NUV8EU`. Staff claim, acknowledgment, and closure returned
`REVIEW_CLOSED` version 4 with a closure timestamp; same-key replay was
identical, a stale different-key close returned 409, and customer readback
contained exactly six public fields. A read-only staff detail confirmed all
four audit event types. The five focused verifier tests passed. No refund,
order mutation, chat model call, or browser interaction was part of this
smoke; the customer/staff browser walkthrough remains pending. See
[the delivery journey note](DELIVERY_ISSUE_REPORT_JOURNEY.md).
The app browser explicitly denied agent access to the local support URL due
to a saved user permission; no alternate browser surface was used.
The work remains uncommitted alongside pre-existing dirty changes.

## Multi-fulfillment tracking answer, 2026-10-02

The existing owner-checked order-status projection already exposes nullable
tracking codes. Agent Runtime now renders multiple fulfillment states and
codes as paired, numbered facts rather than two independent lists. It fails
closed on non-printable provider status or code values; zero- and
one-fulfillment wording remains unchanged. Four test-first regressions failed
before the fix. Then 23 focused and 520 full Agent Runtime tests passed and
Ruff lint passed. The local service was restarted and became healthy. No
live multi-fulfillment customer order was exercised. The Vendure simulator
does not supply an authoritative carrier, URL, or ETA, so none is claimed.
See [the read-only support note](READ_ONLY_SUPPORT_JOURNEYS.md).

## Failure-specific refund-status answer, 2026-10-02

The owner-checked four-field payment projection has an aggregate refund
status, not per-attempt identity. A failure-specific question previously
returned only “A partial refund is recorded” or “A refund is recorded as
completed,” which could imply the questioned attempt succeeded. Test-first
regressions now require the answer to state that a mixed or completed
order-level summary cannot confirm the particular attempt. The `FAILED`
wording is “did not complete,” since Gateway combines failed and cancelled
attempts in that projection. Passive “Did my refund ... fail/complete?”
questions route to this read-only specialist; “Complete my refund” remains
an action request, not a status lookup. Forty-five focused and 528 full Agent
Runtime tests passed, along with Ruff lint and format checks.

After restarting Agent Runtime, one authenticated local Edge chat asked
whether the refund for owned order `9KWUQ1TBZ7NUV8EU` failed. The response
reported a completed aggregate refund and explicitly declined to infer the
outcome of a particular attempt. Conversation
`01a0fca2-140c-744f-a781-db74ae793386` persisted one customer and one
assistant message in AI control mode; the response contained no refund
workflow or cancellation request. This was a single read-only backend check,
not browser QA or a provider-attempt audit; no refund was created or settled.

The [synthetic v5 status-clarity evaluation](evaluation/READ_ONLY_STATUS_CLARITY_V5.md)
uses six cases and two repeated trials per case. All 12 trials passed with
exact read-only tool traces and zero estimated model cost. The current full
Evaluation Runner suite passed 316 tests. The immutable older v2 dataset has
two known two-trial drifts: “failed” versus “did not complete” wording, and
the generic-return raw versus targeted retrieval query. Its test requires
exactly these four trial differences rather than silently editing historical
expectations. The latter still returns the same safe source-unavailable answer.
This is specialist-level synthetic coverage, not live provider-attempt identity.

## Refund staff-token lifetime guard, 2026-10-02

Human Operations' refund-staff verifier now requires integer `iat` and `exp`,
rejects expired or more-than-30-day issued lifetimes and issued-at times more
than 30 seconds ahead, while preserving the existing JWT type, HS256,
issuer/audience, tenant/environment, and role checks. Thirty-four new
deterministic tests covered missing/malformed claims and boundaries; a
test-first run reproduced 12 expected failures. The focused/CLI-compatible
tests passed 37/37; the full Human Operations suite passed 98 with 10
database tests skipped because the test database URL was unset. Typecheck
and a temporary-output TypeScript compilation passed.

The running local Human Operations service accepted the existing expiring
refund-staff token on a read-only case-list request (HTTP 200), and rejected
a correctly signed but non-expiring synthetic token (HTTP 401). No case was
mutated. The local token remains development-only and does not provide OIDC,
revocation, or customer/staff production sessions; see
[the identity roadmap](PRODUCTION_IDENTITY_ROADMAP.md).

## Edge customer-verifier boundary, 2026-10-02

The shared Edge request-identity helper now parses every injected verifier
result as a strict four-field opaque customer identity and requires the
self-service principal to equal the customer. Refund intake also uses that
helper rather than calling the verifier directly. Two synthetic regressions
first reproduced a 200 response with malformed/mismatched identities, then
passed with HTTP 401 before the workflow read or Agent Runtime intake.
The full Edge suite passed **171/171** and typecheck passed under Node 24.
No local token, service, AWS resource, or commerce state changed. This is
not production login: OIDC verification, external-subject/account mapping,
staff identity, and identity-bound browser sessions remain absent. See
[the identity roadmap](PRODUCTION_IDENTITY_ROADMAP.md).

## Edge API container recipe, 2026-10-02

The pinned Node 24 Edge API Dockerfile and Dockerfile-specific source allowlist
were added with an explicit opt-in private smoke script. The script's syntax
and no-argument, zero-Docker-write behavior passed. Edge API typecheck and
168/168 host tests passed using the repository's Node 24 runtime. A static
review corrected the smoke audit's relative refund-policy import path and
`git diff --check` passed.

The initial Docker build stalled in Docker Desktop's credential helper. An
isolated empty Docker configuration bypassed it, but the legacy builder then
sent a 5.8 GB root context because it did not honor the Dockerfile-specific
ignore file. That attempt was stopped. A root ignore file still sent 3.8 GB,
so it was removed. The final proof staged 40 reviewed files (369,127 bytes),
sent a 404.5 kB context, built the image, and passed Node 24, non-root,
production-dependency, sensitive-path, private health, and clean-shutdown
checks. The throwaway container and network were removed; only the local
proof image remains. Its staging test passed. No AWS or business request was
made, and other service images and cloud readiness are unverified.
See [AWS deployment readiness](AWS_DEPLOYMENT_READINESS.md).

## Read-only order total, 2026-10-02

The signed Gateway MCP tool now returns only strict v1 reference and
tax-inclusive current order total for the exact customer-owned order.
Agent Runtime recognizes a narrow explicit question without a model,
validates the tool response and currency precision, and returns a bounded
`order_total` answer; mixed payment/invoice/refund requests clarify. Edge
accepts this journey only as read-only answer text. A red-first natural
question regression and a red-first malformed-source-reference regression
were fixed. Full suites passed: Agent Runtime 564, Integration Gateway 348,
Edge API 169, canonical contracts 112; changed service typechecks and Ruff
checks passed.

After restarting only Agent Runtime, one authenticated local Edge turn for
owned order `9KWUQ1TBZ7NUV8EU` returned the tax-inclusive `USD 1563.80`
total. Persisted conversation `01a0fcb5-4103-708d-924a-d1cabbd4b6c3`
had exactly two messages and no refund workflow link or cancellation request.
No model or commerce mutation was needed. Browser QA, production identity,
historical invoice/paid amount, and load behavior remain unverified. See
[the journey boundary](ORDER_TOTAL_JOURNEY.md).

## DOCX table fail-closed ingestion, 2026-10-02

The parser-v1 previously indexed paragraph text from a DOCX with a top-level
table while only warning that table content was omitted. A generated
paragraph-plus-table regression reproduced that partial extraction. The parser
now rejects such a source before section normalization, leaving table-free
DOCX behavior and parser version unchanged. The new test and full Knowledge/RAG
suite passed **150 tests** with Ruff lint; changed-file formatting passed.
No existing index/release was rebuilt. Other document parts and future
table extraction remain separate work; see
[the DOCX boundary](DOCX_TABLE_INGESTION_BOUNDARY.md).

## Offline order-total evaluation v6, 2026-10-02

Ten synthetic cases cover USD, INR, JPY, missing and mismatched orders,
unsupported or extra source fields, and invoice/payment/refund mixed-intent
clarification. Two repetitions per case passed: **20/20 trials** with exact
read-only tool traces and deterministic answers. The full Evaluation Runner
suite passed 316 tests after its historical v2 drift assertion was narrowed
to four exact trial differences, a no-model check confirmed all seven
order-total fixture questions select the journey, and a mutation check
rejected fabricated payment success plus an extra refund tool. The v6 adapter does not use
the network, model, live customer authentication, or browser; positive cases
invoke the specialist directly, while mixed-intent cases run the classifier. See
[the v6 evaluation note](evaluation/READ_ONLY_ORDER_TOTAL_V6.md).

The broader local regression check after this change also passed 111 Workflow
Workers tests, 112 canonical contract tests, and the Conversation Runtime and
Human Operations suites. Human Operations reported 98 passed and 10 optional
database tests skipped with its test database URL unset. These tests use local
or synthetic dependencies; they are not browser or AWS deployment proof. Edge,
Workflow Workers, Conversation Runtime, Human Operations, and all three
tracked frontend apps also passed TypeScript no-emit checks under Node 24.

## Generic return-policy retrieval, 2026-10-02

The three exact generic return-policy questions now use the bounded
change-of-mind retrieval query already used by generic exchange discussion.
The same exact `CUSTOMER_SAFE` sentence and citation validator remains the
answer authority. A query-sensitive test first failed because the raw
question missed that section, then passed with the targeted query. The full
Agent Runtime suite passed 567 tests, including all three exact generic
phrasings, with one existing Starlette/httpx
deprecation warning; Ruff lint and changed-file formatting passed.

After restarting only Agent Runtime, one fresh authenticated Edge chat
returned the conditional Acme change-of-mind sentence and citation, with no
refund workflow or cancellation request. Conversation
`01a0fcba-77bc-717e-a003-4db299db9f1e` records this bounded live check.
The same question had also returned correctly before the change in one
diagnostic run. A later bounded check asked each of the three exact generic
phrasings once in separate new authenticated Edge conversations
(`01a0fcc0-b446-717c-9000-fc6b4551b045`,
`01a0fcc0-d0c2-7558-864a-dc8ed1da5dc1`, and
`01a0fcc0-e1c9-745e-a68c-962148a96d0b`). All three answers contained the
conditional rule and policy title, with no refund or cancellation action link.
This does **not** prove an intermittent defect is eliminated or establish a
statistically meaningful reliability rate. Browser behavior and different
registered tenant policies remain separate evaluation work.

## Generic return and exchange discussion, 2026-10-02

The first authenticated live generic exchange question safely failed closed:
top-three `CUSTOMER_SAFE` Knowledge/RAG results omitted the registered
change-of-mind return section. A signed read-only diagnostic found that the
exact source was indexed and that a bounded change-of-mind query returned it
first. The Agent Runtime now uses that query for only three explicitly
recognized generic exchange questions; it still requires the exact public
sentence and citation and never treats a return rule as exchange approval.
Six query-sensitive tests passed after six expected red failures; the full
Agent Runtime suite passed 516 tests and Ruff passed. After restart, one live
Edge turn returned the cited conditional return rule, explicit exchange
uncertainty, and human consultation. Its persisted two-message transcript had
no refund or cancellation link. This is not a return/exchange execution
journey or a reliability claim. See
[RETURN_EXCHANGE_DISCUSSION.md](RETURN_EXCHANGE_DISCUSSION.md).
The separate Evaluation Runner v4 fixture has six synthetic cases with two
repetitions: 12/12 passing trials, 6/6 consistent cases, and zero estimated
model cost. The full Evaluation Runner suite passed 310 tests and Ruff passed.
The dataset grades specialist behavior with synthetic evidence, not intake
routing, live retrieval ranking, customer authentication, or staff follow-up.

## Repeatable positive end-to-end checklist

The September 6 photo-gated proof is complete. Use this checklist for future regressions with
a new disposable delivered Vendure order. Paid model use and refund/provider
mutations must be explicitly authorized for that test.

1. Confirm PostgreSQL, Temporal, OpenSearch, Vendure, all backend services, and both
   browser applications are healthy.
2. Generate fresh customer and staff local login tokens if needed.
3. Submit a damaged-item refund in the customer conversation.
4. Verify the conversation message is persisted and linked to the workflow.
5. Verify order facts come through the read-only MCP path and RAG returns only
   `CUSTOMER_SAFE` evidence.
6. For a damaged-item v2 request, upload a photo and have assigned staff review
   the exact revision. Exercise a clearer-photo request and replacement upload;
   verify the superseded set cannot be accepted. Only after evidence acceptance,
   reclaim the same case in its monetary phase and approve the exceptional refund
   plan as a supervisor when policy requires takeover.
7. Verify the customer receives the exact current preview and explicitly confirms
   it.
8. Verify the browser does not call Vendure directly.
9. Verify Workflow Workers refresh facts and Integration Gateway performs one
   idempotent refund mutation.
10. Verify the customer first sees processing, not premature success.
11. Verify Vendure records exactly one refund. If the dummy provider leaves it
    `Pending`, separately authorize and settle that existing refund with a clearly
    local test transaction ID. Do not invoke another refund to finish settlement.
12. Verify signed provider outcome delivery or reconciliation moves the workflow
    to `REFUND_SUCCEEDED`.
13. Verify the Customer Portal shows completion and Human Operations closes the
    related case.
14. Inspect Temporal history, Human Operations audit, Conversation Runtime data,
    and Gateway evidence for matching tenant, environment, workflow, and request
    identifiers.

Record only non-sensitive identifiers and results. Never record tokens, secrets,
API keys, payment references, or customer personal data.

## What this verification does not claim

Local success does not prove production bank settlement, Cognito integration,
managed database recovery, Kafka delivery, platform-wide production observability,
multi-region behavior, workload scaling, or AWS deployment. Those require separate deployment
and operational evidence. The positive runs also do not establish live webhook
delivery, all duplicate/replay/concurrency behavior, all rejection and failure
branches, or delivery-window eligibility. The September 6 run proves local
Vendure execution through the photo gate, not real provider/bank settlement.
Local OpenTelemetry covers Edge, Agent Runtime model/guard paths, Knowledge/RAG
phases, Gateway read-only commerce lookup, short Workflow Worker activities,
Human Operations and Conversation Runtime. Temporal activities remain trace-only;
they do not produce business counters and activity attempts are not distinct
refunds. The local dashboard and non-notifying alert configuration are not
production controls. Local PostgreSQL-derived refund/outbox/reconciliation
gauges and Collector/exporter health metrics are implemented; they are not
production SLOs. Notification routing, CloudWatch/AWS export, production
authentication, and AWS deployment remain unimplemented.
Confirmation expiry tests do not prove automatic migration of legacy parked
waits. The current cited-policy wording safeguard has the September 10 offline
evidence above; a fresh paid live browser recheck has not been run.

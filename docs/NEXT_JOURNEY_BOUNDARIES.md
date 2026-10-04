# Next journey boundaries (2026-10-02)

This records the decision after completing local refund, read-only support,
delivery issue acknowledgment, payment/refund status, and the first narrow
zero-total cancellation slice. A named
journey is **complete** only when the customer sees the authoritative final
outcome—not when a request is merely logged or reviewed.

## Cancellation

Do not route a cancellation request into the refund workflow or treat its
`CANCELLED` stage as a cancelled commerce order. Installed Vendure exposes
separate `cancelOrder` and `cancelPayment` mutations. Cancelling the order
does not release an authorization or refund a settled payment. The local dummy
payment handler cannot prove a real bank hold was released. Vendure's default
order process permits cancellation from shipped/delivered states, so an
external read-before-write check alone cannot enforce an unfulfilled-only
policy. Cancellation also sets order-line current quantities to zero. The
OrderContext v1 read contract now permits zero current quantity and carries
an optional positive `orderedQuantity` for historical facts; that value must
never be treated as currently refundable quantity. The separate OrderItems v1
customer tool cannot label historical quantity, so it now fails closed for
cancelled orders rather than presenting `orderedQuantity` as current contents.
A versioned history projection is needed for a truthful cancelled-item answer.

The implemented first policy is a **no-payment, zero-total** subcase, not the
whole cancellation journey. It requires a placed, customer-owned,
unfulfilled order, exact expiring preview and confirmation, provider-side
atomic guard, and marker-based reconciliation. Two disposable local orders
reached authoritative `Cancelled`; one of them also exercised uncertain
outcome recovery. See [the verified scope](ZERO_TOTAL_CANCELLATION_JOURNEY.md).
The next `AUTHORIZED_DUMMY` policy would require exactly one authorized local
dummy payment, no settlement/refund/fulfillment, full-order consent naming
both order and authorization cancellation, and proof of both final provider
states. Unknown or partial outcomes remain pending, never "completed." It
must not be described as a real bank hold release. Settled-payment
cancellation needs a separate cancellation-plus-refund saga and must not be
inferred from the existing refund graph.

The `AUTHORIZED_DUMMY_V1` Gateway and Temporal contracts are being developed
behind a disabled customer path. Do **not** enable its Vendure plugin or
customer entry point on the current local SQLite simulator: a controlled
concurrent Admin-operation test showed one transaction's rollback can erase a
separately successful fulfillment because both requests share a cached
TypeORM SQLite query runner. Independent transaction ownership is necessary,
but merely switching to PostgreSQL would not prove safety: Vendure's ordinary
settlement and fulfillment mutations do not share the cancellation marker
lock, and a stale read can commit after cancellation's final check. The safe
resolution must also coordinate or constrain *every* conflicting Admin write,
then pass deterministic race and restart proof. Passing unit tests alone is
not enough.

The zero-total subcase has its versioned contract, provider-side race guard,
purpose-scoped assertions, durable ledger, and customer journey UI. The
zero-quantity OrderContext compatibility passed contract, unit, and authenticated
local API checks; the earlier historical item answer is superseded by the
OrderItems v1 fail-closed rule above. Manual browser QA remains pending. Keep replay, stale consent, fulfillment/settlement
races, crashes, and partial provider results as regression gates for any
expanded policy. Do not run a live cancellation on a customer order without
an explicit disposable fixture and final-state verification.

New previews also carry a bounded item name joined to the exact line ID from
the owner-checked order. It is for customer recognition only; stable IDs,
quantities, and the provider digest remain authorization inputs. Older
Temporal previews retain an item-ID fallback. This change passed offline
contract and service tests but has not had a fresh browser or provider run.

## Return and exchange

The current customer-safe policy covers refunds and a conditional
change-of-mind return, not an exchange authorization, label/address, fee,
stock reservation, SKU substitution, or reverse-logistics process. Vendure's
installed order API has no dedicated return-merchandise-authorization or
exchange mutation. Its `modifyOrder` operation can create additional
payments/refunds and is not a safe shortcut.

A separately governed request-to-human-decision path can be built using the
delivery issue pattern, but its honest final outcome is **review completed**,
not "exchange shipped" or "return accepted." Actual fulfillment needs an
approved exchange policy, a line/quantity contract with stable opaque line
identifiers, logistics and inspection evidence, inventory reservation and
compensation, tax/shipping/price handling, exact customer consent, and
provider reconciliation. The current owned-order-items projection intentionally
contains only names and quantities and cannot uniquely select identical-name
lines for an exchange.

An explicit **consultation only** button is now implemented on the existing
support chat. It uses the governed human handoff so the customer can ask a
person about a return or exchange; it does not create a return request,
establish eligibility, approve an exchange, or perform any commerce action.
The browser/staffing gate for that consultation is still open. See
[the consultation boundary](superpowers/plans/2026-10-02-return-exchange-consultation.md).

Three direct generic exchange/return-or-exchange questions now use the
read-only policy path. It cites the exact conditional customer-safe return
rule, explicitly cannot verify exchange approval or process, and offers the
existing human consultation. It requires the verified source; a generic
return window cannot stand in for exchange policy. This is not a return or
exchange request, and no order or refund workflow starts. See
[the discussion boundary](RETURN_EXCHANGE_DISCUSSION.md).

The saved-address card similarly offers a separate generic human-chat
consultation without moving account facts into the chat or changing an
address. A read-only design audit considered a structured return/exchange
review request, but it is **not** implemented: disposition language,
staffing/SLA, follow-up channel, retention, and whether an intent without
stable line IDs is useful all need a product decision. Reusing the delivery
queue or claiming an RMA/exchange outcome would cross its current authority
boundary. A future review-only case must remain separate from actual
logistics, inventory, refund, and exchange execution.

For delivery issues, `ACKNOWLEDGED` means staff received and acknowledged the
report, not that the problem was remedied. A separate administrative
`REVIEW_CLOSED` state is now implemented locally: only assigned staff can
close an acknowledged report with exact version/idempotency checks, and the
customer receives fixed copy saying the issue was **not** confirmed fixed,
plus the existing support-chat follow-up link. This is not an operational
remedy or customer-notification service. Its additive migration, strict
contracts, and UI passed isolated/offline tests. Migration 006 is now applied
to the running local Human Operations database. One disposable local report
then passed an authenticated backend claim, acknowledgment, closure,
same-key replay, stale-key rejection, six-field customer readback, and audit
check. The UI has not been exercised in a browser.
See [the delivery journey](DELIVERY_ISSUE_REPORT_JOURNEY.md).

## Shipping-policy questions

The currently registered `CUSTOMER_SAFE` tenant-local knowledge release
contains the Acme refund policy, not an outbound shipping or delivery policy.
It does not establish shipping fees, methods, destinations, dispatch times,
delivery estimates, delay remedies, or return-shipping cost. Synthetic test
facts about return-shipping payer are not a published source. Therefore the
agent must abstain on unsupported shipping-policy questions rather than turn
refund windows into a delivery promise. A source owner must approve and
register a public-safe shipping policy before adding exact shipping-policy
answers or an operational shipping journey.
Three offline regressions now check that shipping fee, destination, and
dispatch questions cannot reuse a refund-window excerpt as their answer.
They verify abstention only, not a shipping-policy journey or live behavior.
On 2026-10-02, one authenticated local Edge chat asked “How much does shipping
cost?” It returned the source-unavailable answer and no refund or cancellation
action. This is one safe live abstention trial, not a shipping-policy source or
reliability claim.

## Tracking and billing source boundaries

The owned-order status path already returns Vendure fulfillment states and
optional tracking codes. Multiple fulfillments are now described separately
so a code stays with its own state. The local simulator does not expose an
authoritative carrier, tracking URL, scan events, or ETA; those cannot be
filled in from a free-text fulfillment method or code. A future richer
tracking journey needs an explicit trusted carrier/event source and owner
checks, not a generated URL or delivery promise.

The current payment/refund-status path deliberately reports only bounded
aggregate states. A separate [read-only order-total journey](ORDER_TOTAL_JOURNEY.md)
now gives the customer-owned current tax-inclusive order total and currency
under a strict contract; it never equates that fact to amount paid, balance
due, an invoice, or a refundable amount. Installed Vendure has no
customer-owned invoice or receipt document reference. Its development mailbox
contains email output but is not an owner-checked document service and must
not be exposed as a receipt link. Defer invoice/receipt support until a real
document source and access rule exist.

The separate [catalog-price journey](CATALOG_PRICE_JOURNEY.md) reads a
tenant-channel published variant's current tax-inclusive `priceWithTax`; it
does not derive checkout total, order total, paid amount, refundability, or a
price hold. Exact named variants are answered deterministically. Product-only
questions use the sole published variant or ask for clarification when there
are multiple variants. Its v7 offline evaluation passed. Subsequent
authenticated local Edge chats answered one named variant and clarified a
multi-variant product, with a same-channel Vendure Shop Search price match.
Browser rendering and repeated live reliability remain unverified; see
[the catalog journey](CATALOG_PRICE_JOURNEY.md).

## Order of work

1. Keep the implemented support paths stable with contract, authorization,
   repeated-trial evaluation, and local end-to-end regression checks.
2. Keep the locally verified no-payment cancellation slice stable; design and
   prove authorization-release semantics separately before expanding it.
3. Define an approved return/exchange policy and logistics/provider contract
   before claiming a physical return or exchange can finish in this platform.

These are implementation boundaries. Only the no-payment local cancellation
subcase is implemented and tested; exchange and paid-order cancellation are
not deployed or completed.

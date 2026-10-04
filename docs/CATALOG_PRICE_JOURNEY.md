# Read-only catalog price journey

Status: implemented and verified offline on 2026-10-02. Authenticated local
Edge chats passed for a named variant and a multi-variant clarification, and
the named price matched a separate same-channel Vendure Shop Search read.
Browser display and production reliability remain unverified.

## Customer behavior

The existing signed-in `/support` chat can answer two complete question shapes:
“What is the price of Laptop 13 inch 8GB?” and “How much does Laptop 13 inch
8GB cost?” The Agent Runtime recognizes those shapes deterministically. It
does not call a model to decide this route or start Temporal, a refund, or a
checkout. A mixed price plus refund/payment/order/policy request asks the
customer to choose one question instead of silently selecting a journey.

The existing tenant-scoped `lookup_product_catalog` tool reads Vendure Shop
Search in the configured channel. Its `SinglePrice.priceWithTax` and currency
are projected as bounded integer minor units. The specialist requires one
matching product and **one exactly matching named variant**; it never quotes
a different variant or a product-level aggregate. If the customer names only
a product with one published variant, it can name and quote that sole variant.
If the product has multiple variants, it asks for the full variant name. An
unrelated catalog hit asks for the product, while a missing or duplicated
variant asks for clarification. Missing price, a price range without a single
price, invalid source fields, or unsupported currency precision fail closed.

The answer says it is the **current catalog price including tax**, and not a
checkout total, quote, price hold, item reservation, amount paid, or invoice.
Shipping, discounts, promotion eligibility, final checkout tax, and order
ownership are not inferred from the catalog result. The catalog can change;
no price guarantee is made.

## Verified boundary and open checks

The Agent Runtime suite passed 586 tests and the Evaluation Runner passed 319
after preserving historical single-variant price cases. The versioned
[v7 offline dataset](evaluation/READ_ONLY_CATALOG_PRICE_V7.md) passed ten
synthetic cases twice, including exact USD/INR/JPY prices, ambiguity,
unavailable/unsupported data, and mixed intents. It tests the production
specialist with synthetic tool responses and forbids external network access;
it does **not** prove Edge login, signed Gateway forwarding, live Vendure
Search, browser rendering, checkout pricing, or statistical answer
reliability. No paid model or commerce mutation was used in this slice.

Before calling this end-to-end complete, verify browser display and the exact
catalog tool trajectory in the configured tenant channel. Do not use a customer
order or payment change as part of that read-only smoke.

The first named-variant local trial on 2026-10-02 asked the authenticated
existing chat, “What is the price of Laptop 13 inch 8GB?” It returned the
current catalog-price wording with `1558.80 USD including tax`, persisted a
two-message conversation (`01a0fcf2-99e2-7246-ad1b-83dc8142c120`), and
offered no refund or cancellation action. A separate same-channel Vendure Shop
Search read returned one exact variant, `SinglePrice` of `155880` USD minor
units, matching the displayed `1558.80 USD`. A second authenticated chat
asked “What is the price of Laptop?” and requested the full variant name
without quoting a price or offering a commerce action; Shop Search returned
four Laptop variants in that channel. No model or commerce mutation was needed.
These are local backend observations only. Browser presentation, exact Gateway
tool-call counts, and repeated-trial live reliability were not checked.

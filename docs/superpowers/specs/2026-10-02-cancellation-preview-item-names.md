# Cancellation preview item names

Status: locally authorized design, 2026-10-02. The owner gave broad overnight
permission for in-project decisions; no separate checkpoint is required.

## Problem

The zero-total cancellation preview currently shows opaque order-line IDs. A
customer cannot readily identify what the whole-order confirmation covers.
The owner-scoped commerce order already contains the variant name for each
line. This change is a display and informed-consent improvement, not a new
cancellation capability or change to the no-payment eligibility policy.

## Contract

- Gateway joins each cancellation-facts line to exactly one line in the
  already owner-checked commerce order by exact stable line ID. A missing,
  duplicate, blank, oversized, Unicode control/format character, or
  alphanumeric-free name makes the facts
  unavailable; it never substitutes a guessed or model-generated name.
- Gateway returns a bounded `displayName` on each facts line. New worker
  previews carry it, and Edge projects `display_name` to the customer. The
  Portal shows the name with original ordered quantity.
- Display names are not part of the provider facts digest, customer action
  identity, or the worker's post-confirmation fact equality. Item IDs and
  original/current quantities remain the stable selection facts.
- Worker/Edge/Portal accept an absent name in an older recorded workflow
  preview, showing a clearly labeled item ID fallback. New Gateway responses
  must not omit a name. This avoids invalidating Temporal history during a
  rolling local restart.
- The preview stays read-only until the customer's separate confirmation.
  No new provider write, policy, or storefront integration is introduced.

## Verification boundary

Focused tests must cover exact name join, missing/duplicate/invalid names,
unchanged authorization equality when only a name changes, legacy previews,
safe Edge projection, Portal parsing and visible line text. Full changed-app
tests, typechecks, contracts, and Portal build follow. No live cancellation
or commerce mutation is part of this change.

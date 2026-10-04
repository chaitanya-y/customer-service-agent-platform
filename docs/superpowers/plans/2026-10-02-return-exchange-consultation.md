# Return and exchange consultation boundary

Status: consultation UI implemented locally, 2026-10-02. This does **not**
implement a return or exchange. The dedicated `/support` action uses the
existing explicit human-chat handoff so a customer can ask a specialist while
the platform lacks a return authorization, logistics or exchange provider
contract.

## Proposed first slice

- The customer chooses an explicit **Talk to a person about a return or
  exchange** action on the existing `/support` page. It invokes the existing
  idempotent handoff, not an AI turn or a refund workflow. A successful
  authoritative response may show `QUEUED`; a failed or disabled handoff may
  not claim a specialist has received a request.
- While queued, the customer describes the request in the same encrypted chat.
  The support agent claims it in the existing Operations Console queue and
  replies under the separate `SUPPORT_AGENT` authority. No agent or model
  processes queued messages. A staff reply is labeled as human.
- This consultation does not verify eligibility, identify a unique order line,
  approve a return, issue a label, reserve stock, ship a replacement, or
  refund a payment. Staff must separately verify order facts before making
  order-specific claims.

## Why not a standalone return/exchange queue yet

The installed commerce API has no dedicated return or exchange mutation, and
the current owner-checked item projection contains names and quantities rather
than stable line identities. There is no approved disposition vocabulary,
inspection/evidence rule, stock reservation, shipping/fee/tax handling,
staffing promise, or record-retention policy. A new queue with a “request
received” receipt would imply progress that the platform cannot yet deliver.
An asynchronous intake could be designed later using the delivery-report
pattern, but only after those product and operational decisions are made.

## Acceptance and release gates for the consultation slice

1. Explicit opt-in and unavailable-state wording are distinct. No synthetic
   customer message or model call occurs merely from clicking the action.
2. Same-key retries and reloads cannot create a second handoff session; stale
   control versions refresh authoritative state before a new decision.
3. Queued customer text reaches only the assigned staff path, with no Agent
   Runtime, Temporal refund workflow or commerce mutation. Staff reply is
   clearly labeled human.
4. Authenticated customer ownership, separate support role, and transcript
   privacy regressions pass. Browser walkthrough must include queue, staff
   claim/reply, disabled state, and back/forward navigation.

The existing generic handoff backend has local API verification but its manual
browser and production staffing gates remain open. Do not describe this design
as a completed physical return or exchange journey.

## Implementation checkpoint

The Customer Portal has a separate, explicit “Talk to a person about a return
or exchange” button. It calls the same idempotent handoff handler as the
general specialist action. It does not synthesize a customer message or start
an AI, refund, return, or exchange workflow. The UI states the limits and
shows a distinct unavailable message when handoff is disabled. While queued
or connected to a person, it asks the customer to describe the question in
the existing chat instead of offering another handoff button.

Seven focused UI-handler regressions cover opt-in, disabled state, retries,
conflict refresh, queued text, human labeling, navigation, and auth privacy.
The full Customer Portal suite passed 119/119 with typecheck and production
build. These are code checks, not a live staffed/browser walkthrough. There
is still no RMA, label, replacement, or final return/exchange status.

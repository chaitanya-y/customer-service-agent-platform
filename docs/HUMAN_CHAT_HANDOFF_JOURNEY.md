# Human chat handoff

Status (2026-10-02): implemented and enabled only in the ignored local Edge and Customer Portal environments after backend verification. A browser walkthrough and production rollout are still pending. This is a separate support conversation, not a refund approval, payment, or order mutation.

## Customer and staff flow

1. An authenticated customer uses the same `/support` conversation and explicitly requests a person. The Customer Portal and Edge API send the current conversation control version and an idempotency key to Conversation Runtime. Edge does not call a model or refund service for this request.
2. Conversation Runtime atomically changes an `AI` conversation to `QUEUED`, increments the control version, creates a handoff session, and writes an outbox event. Only a successful server response allows the UI to display “Waiting for a specialist.” New customer messages remain in the encrypted transcript without an AI response while queued.
3. A separately authenticated `SUPPORT_AGENT` sees the queue in Operations Console. Human Operations signs a short-lived, request-bound staff assertion for Conversation Runtime. The staff member claims the case before replying; only the assignee can reply, return control to AI, or close it.
4. Staff replies are stored as `WORKFORCE` messages and appear as “Support specialist” in the customer chat. The customer and staff interfaces poll the authoritative transcript and control state while handoff is active. Both are owner-scoped; the browser never receives the staff assertion or Human Operations token.
5. Returning to AI increments the control version; closing ends the conversation. Neither action approves or executes a refund. Refund decisions remain in the separate governed refund workflow.

## Race and refund boundary

Conversation Runtime locks the conversation row when changing control or committing an assistant message. An assistant commit must match the AI control version. A ready refund workflow start is reserved in the same transaction as the assistant message, before Edge starts Temporal. If handoff wins first, the assistant/refund start is rejected. If the assistant reservation wins first, staff sees a pending start warning: the handoff does not retroactively cancel an accepted workflow.

An uncertain Temporal start can leave a `PENDING` reservation. Conversation Runtime now stores the exact start input encrypted with the accepted assistant message. A customer retry using the same client message ID reads that reservation *before* routing to an agent or checking current human control, and retries only the stored input. Edge refuses changed or legacy input and stops automatic retry after one hour; the local Temporal namespace currently retains executions for 24 hours. `REJECT_DUPLICATE` plus an exact non-PII start digest prevents attaching a different workflow under the same ID while Temporal retains history. Other namespaces must have retention longer than the configured recovery window before rollout. Recovery is request-driven: if the customer does not retry, or the reservation is older than one hour, operations must reconcile it manually. Do not mark it `ABORTED` merely because a network call failed; Temporal may have accepted it. Staff must not interpret the pending warning as a new refund approval or as proof that payment was sent.

## Local rollout order and verification

1. Complete and verify refund-start recovery, including retry and lost-response cases. This local implementation now passes offline tests; background reconciliation remains a separate future operation.
2. Apply Conversation Runtime migrations `004_generic_human_handoff.sql` and `005_refund_start_recovery.sql` before starting the updated Runtime. Migration 004 intentionally refuses legacy `QUEUED`/`HUMAN` rows without known ownership; reconcile any such rows explicitly. Migration 005 adds encrypted start-input columns without inventing input for old reservations. Both were applied to the local development database on 2026-10-02.
3. Configure the same new, distinct `CONVERSATION_STAFF_ASSERTION_HMAC_SECRET` in Conversation Runtime and Human Operations, and Human Operations' Conversation Runtime URL and routing epoch. Configure a dedicated local `SUPPORT_AGENT` token in Operations Console; this role has no refund approval privileges.
4. Start Conversation Runtime, Human Operations, Edge, Customer Portal, and Operations Console. Only then set `HUMAN_CHAT_HANDOFF_ENABLED=true` in both Edge and Customer Portal. It defaults to false in committed examples: no customer can be stranded in a queue when staff routes are unavailable. The two ignored local environments were enabled after the staffed route passed its API check.
5. Run unit/build checks and a backend end-to-end test with fresh conversations. `tools/local/verify-human-handoff.mjs` exercises handoff, queued customer message without a model or refund, staff claim/reply, customer transcript, return to AI, and close. It passed against the local services on 2026-10-02. A separate PostgreSQL serialization test passed against a disposable database with migrations 001-005 and the non-superuser app role. Browser rendering, sustained availability, and production security/operations remain unverified.

Keep staff keys, tokens, full transcripts, and customer PII out of logs and committed files. Do not claim the journey is production-ready from mocked tests alone.

## Customer session privacy check, 2026-10-02

A focused review found that a 401/403 while sending a message or requesting
handoff left the previous transcript and conversation ID visible in the Portal.
The customer chat now clears the transcript, draft, order reference, account
cards, and stored conversation ID on authoritative authentication loss from
these actions or the account reads. Outstanding message/handoff responses are
invalidated so they cannot repopulate the old session. On `pagehide`, the
visible transcript is cleared while the conversation ID and uncertain request
keys remain for an authoritative reload after back/forward restoration; a
server read, not browser storage, determines what may be shown. Five focused
UI-state regressions cover 401/403, late responses, back/forward restoration,
and a handoff-version conflict. The Customer Portal full suite passed 112/112,
typecheck and production build passed. Manual browser privacy QA remains due.

## Return or exchange consultation entry point

The Portal now offers a separate, explicit return/exchange consultation
button on the same support conversation. It invokes this existing handoff;
there is no second queue or return/exchange workflow. The button is hidden
after the conversation is queued or connected to a person, and the page
explains that a handoff does not confirm eligibility, create a return label,
arrange a replacement, or refund a payment. When handoff is disabled, the
page says no consultation has been requested. Seven additional UI-handler
regressions passed with the full Portal suite (119/119), typecheck, and build.
The staffed browser walkthrough and operational return/exchange capability
remain pending. See [the consultation boundary](superpowers/plans/2026-10-02-return-exchange-consultation.md).

## Shared customer-session invalidation

The support page mounts chat and delivery reporting separately. A later audit
found that authentication failure in one could leave the other's private
transcript, report history, or pending response visible. Both now subscribe to
a shared auth-loss epoch; 401/403 from either clears both surfaces, account
cards, stored pointers and late response authority without recursively
rebroadcasting. Cancellation-start failures also clear the support page.
The separate cancellation review page now clears its preview and decision
controls on auth failure or pagehide and reloads server state on bfcache
return. Uncertain retry identifiers are preserved on ordinary pagehide, not
shown as proof of acceptance. The combined Customer Portal suite passed
146/146, typecheck, and production build. Cross-tab behavior and a live
browser walkthrough remain unverified.

## Staff console session restoration, 2026-10-02

The staff chat queue and detail now hide private rows, transcript, draft, and
decision controls when the page exits. A browser back/forward-cache restore
reloads the page to recheck staff authentication and fetch authoritative state;
it never replays a claim or reply. Late responses from an earlier mounted page
generation cannot repopulate the new session. The same protection was added to
the delivery report queue and detail, which also clear visible data on 401/403
and invalidate outstanding responses. An uncertain delivery claim or
acknowledgment keeps its exact retry key in session storage on ordinary page
exit, but that key is not evidence the action succeeded. Operations Console
tests passed 41/41, typecheck and production build passed. A manual browser
back/forward and expired-staff-session check remains pending.

A staff claim, reply, return, or close with an uncertain HTTP result now keeps
the exact action, idempotency key, expected version, and (for a reply) draft
text in that tab's session storage before sending. After navigation, the UI
restores a single explicit retry; it never replays automatically or offers a
different action until the uncertainty is handled. A confirmed action,
authorization loss, or explicit support sign-out clears the stored attempt.
If tab storage is unavailable, the action is not sent. The backend's durable
staff-scoped idempotency record makes the exact retry safe, but this is not a
substitute for a browser failure/reload walkthrough. The tab-scoped draft is
private browser data and should be included in production privacy review.
Operations Console tests passed 45/45, typecheck and build passed after this
change.

An independent review found two recovery/privacy edge cases. After a
successful return-to-AI or close with a lost response, the detail read may
correctly return 404. The console now hides the transcript but retains the
saved attempt and offers an explicit exact retry; it does not interpret 404
as proof of success or automatically send another action. Explicit queue or
detail sign-out and starting a new local support session clear **all**
tab-scoped support attempts, including any saved reply drafts. Authorization
loss does the same. This local cookie/session model does not bind a recovery
record to a verified staff identity; production authentication must provide
that binding before this browser recovery is treated as production-ready.
An exact retry that receives a definitive conflict now leaves recovery-only
mode and reloads authoritative detail instead of trapping the operator on an
empty recovery screen. This does not silently retry another action. The
Operations Console suite passed 51/51, typecheck and build passed. The
lost-response/404 path and cross-session privacy still need a real browser
walkthrough.

A focused backend regression then showed that a closed conversation disappeared
from the staff queue but its direct detail URL could still reveal the old
transcript. Conversation Runtime now permits staff detail reads only while the
conversation is open and queued or assigned to that staff member. Closing or
returning control to AI removes staff transcript access; an exact idempotent
command retry still returns its stored result before evaluating current control
state. Conversation Runtime tests passed 54 with 2 optional database tests
skipped, plus typecheck and build. The live browser path remains unverified.

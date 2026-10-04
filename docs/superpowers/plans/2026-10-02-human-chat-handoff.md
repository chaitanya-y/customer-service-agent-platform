# Generic human chat handoff

Status: historical implementation plan. The local backend handoff path was
implemented and API-tested after this plan; browser and production gates remain.
See [the current journey record](../../HUMAN_CHAT_HANDOFF_JOURNEY.md).

Customer intent: from the shared `/support` conversation, explicitly ask to talk to a person. A support agent claims the conversation, replies in the same durable transcript, and explicitly returns control to AI or closes chat. This is independent of refund-case monetary approval and delivery-report acknowledgment.

## Authority and ordering

- Conversation Runtime owns conversation mode, one active handoff session, assignment, message sequence, encrypted customer/staff text, idempotency, and transition audit/outbox in one PostgreSQL boundary.
- Human Operations authenticates a separate `SUPPORT_AGENT` role and mediates staff operations through narrowly scoped, short-lived assertions. Refund and delivery roles do not confer chat access. Operations Console never receives service-signing secrets.
- Edge authenticates the customer and presents an explicit idempotent handoff action. While `QUEUED` or `HUMAN`, customer messages persist but Agent Runtime is not invoked. Staff replies are labeled as a person, not the AI assistant.
- Customer and staff initially poll ordered transcripts/control state with no-store responses. SSE or WebSocket optimization can follow only after correctness.
- A handoff must fence an in-flight assistant commit under the same conversation row lock. A ready refund assistant message and its refund-start reservation are one atomic AI-controlled transaction. If handoff wins that race, no assistant message or refund reservation commits; if the assistant/reservation wins, its already-accepted intent may proceed even after handoff and the staff view must expose that it did not cancel the separate refund work. This reservation is not a refund approval or execution. Existing Temporal workflows remain independent of chat control.

## Delivery sequence

1. Define the Runtime API, transition/session schema, assertion shape, concurrency and idempotency semantics; add migration and red-green repository/service/API tests. Do not apply the migration until reviewed.
2. Add Edge customer handoff and queued/human message behavior, with a race test for in-flight AI and refund start. Bind assistant writes and any refund-start reservation to AI control at the Runtime transaction boundary.
3. Add Human Operations support-staff authorization and narrow Runtime forwarding. Add an Operations Console support queue and conversation reply/return/close controls with stable retry keys.
4. Add Customer Portal handoff action, clear queued/human status and labeled staff replies, polling/reload and retry behavior.
5. Run contract/unit/typecheck/build checks plus PostgreSQL concurrency tests; then apply a reviewed additive local migration and perform a bounded local customer-to-staff API check without a refund or paid model. Manual browser QA remains separate.

Security and non-goals: no new model authority, no implicit chat takeover from a refund case, no automatic replay of queued messages through AI, no refund approval by support staff, no customer/staff IDs trusted from request bodies, no raw customer text in audit, no claimed closure of a refund when chat closes. If any part cannot be verified, document it as incomplete rather than presenting a partial queue as a finished handoff.

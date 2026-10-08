"""Deterministic present-turn cancellation intent; no commerce or refund calls."""

from __future__ import annotations

import re
from typing import Literal

from agent_runtime.support.schemas import (
    CancellationIntakeResponse,
    CustomerAnswer,
    SupportIntakeRequest,
)

_MENTION = re.compile(r"\b(?:cancel\w*|cancellation\w*)\b", re.IGNORECASE)
_REFERENCE = r"(?=[A-Za-z0-9-]{0,99}\d)(?=[A-Za-z0-9-]{0,99}[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{7,99}"
_ACTION = re.compile(
    r"(?:(?:please\s+)?cancel|i\s+(?:want|need|would\s+like)\s+to\s+cancel"
    r"|(?:can|could|would)\s+you\s+(?:please\s+)?cancel)\s+"
    r"(?:(?:my|the|this)\s+)?order"
    rf"(?:\s+(?P<reference>{_REFERENCE}))?"
    r"(?:\s+please)?[.!?]?",
    re.IGNORECASE,
)
_SAFE_REFERENCE = re.compile(_REFERENCE)


def classify_cancellation_turn(
    request: SupportIntakeRequest,
) -> tuple[Literal["none", "clarify", "cancellation"], str | None]:
    """Only a complete affirmative action qualifies; history never creates intent.

    The optional request hint comes from the authenticated Edge caller, not the
    route model. Edge must independently bind this reference before a workflow.
    """
    text = " ".join(request.customer_message.split())
    if not _MENTION.search(text):
        return "none", None
    action = _ACTION.fullmatch(text)
    if action is None:
        return "clarify", None
    current = action.group("reference")
    hint = request.order_reference
    if hint is not None and _SAFE_REFERENCE.fullmatch(hint) is None:
        return "clarify", None
    if (
        current is not None
        and hint is not None
        and current.casefold() != hint.casefold()
    ):
        return "clarify", None
    reference = current or hint
    return "cancellation", reference.upper() if reference is not None else None


def answer_cancellation(order_reference: str | None) -> CancellationIntakeResponse:
    """Acknowledge a classified request without deciding or executing anything."""
    if order_reference is None:
        return CancellationIntakeResponse(
            status="awaiting_order_reference",
            customer_answer=CustomerAnswer(
                message="Please share one order reference so I can check your cancellation request."
            ),
        )
    return CancellationIntakeResponse(
        status="cancellation_request_ready",
        order_reference=order_reference,
        customer_answer=CustomerAnswer(
            message=f"I can check whether order {order_reference} can be cancelled. You will review the details before anything changes."
        ),
    )

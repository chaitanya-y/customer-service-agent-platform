"""Deterministic payment and refund answers from an owned-order projection."""

from __future__ import annotations

import re

from pydantic import ValidationError

from agent_runtime.integrations.order_lookup import (
    OrderLookupError,
    OrderNotFoundError,
    PaymentStatus,
    PaymentStatusLookup,
)
from agent_runtime.support.schemas import (
    CustomerAnswer,
    ReadOnlySupportResponse,
    SupportIntakeRequest,
)

_REFERENCE = re.compile(r"\b[A-Za-z0-9][A-Za-z0-9-]{7,99}\b")
_SAFE_REFERENCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,99}$")
_PAYMENT_ASPECT = re.compile(r"\b(?:payment|paid)\b", re.IGNORECASE)
_REFUND_ASPECT = re.compile(r"\brefund(?:s|ed)?\b", re.IGNORECASE)
_REFUND_FAILURE_ASPECT = re.compile(
    r"\b(?:fail(?:ed|ure)?|cancel(?:led|ed)?)\b", re.IGNORECASE
)
_MISSING = (
    "Please share one order reference so I can check its payment and refund status."
)
_NOT_FOUND = (
    "We couldn't find an order for that reference. Please check it or contact support."
)
_UNAVAILABLE = (
    "I couldn't retrieve the payment or refund status right now. "
    "Please try again later or contact support."
)

_PAYMENT = {
    "PAID": "has a recorded payment",
    "PARTIALLY_PAID": "has a partially recorded payment",
    "AUTHORIZED": "has an authorized payment, but it is not recorded as paid",
    "DECLINED": "has a declined payment",
    "NOT_RECORDED": "has no recorded payment",
    "UNCERTAIN": "has a payment status I can't confirm",
}
_REFUND = {
    "NONE": "No refund is recorded.",
    "PENDING": "A refund is pending; it is not recorded as completed.",
    "PARTIALLY_REFUNDED": "A partial refund is recorded.",
    "PARTIALLY_REFUNDED_WITH_PENDING": (
        "A partial refund is recorded, with another refund pending."
    ),
    "REFUNDED": "A refund is recorded as completed.",
    "FAILED": "A refund attempt did not complete; no completed refund is recorded.",
    "UNCERTAIN": "I can't confirm the refund status right now.",
}
_ATTEMPT_UNCONFIRMED = "This order-level summary cannot confirm the outcome of a particular refund attempt."
_MIXED_ATTEMPT_STATUSES = frozenset(
    {"PARTIALLY_REFUNDED", "REFUNDED", "PENDING", "PARTIALLY_REFUNDED_WITH_PENDING"}
)


def _candidates(text: str) -> set[str]:
    return {
        match.group().upper()
        for match in _REFERENCE.finditer(text)
        if re.search(r"[A-Za-z]", match.group()) and re.search(r"\d", match.group())
    }


def _safe_reference(reference: str | None) -> str | None:
    if reference is None or not _SAFE_REFERENCE.fullmatch(reference):
        return None
    return reference


def _resolve_reference(request: SupportIntakeRequest) -> str | None:
    current = _candidates(request.customer_message)
    if len(current) > 1:
        return None
    hinted = _safe_reference(request.order_reference)
    if len(current) == 1:
        candidate = next(iter(current))
        if request.order_reference is not None and (
            hinted is None or candidate.casefold() != hinted.casefold()
        ):
            return None
        return candidate
    if request.order_reference is not None:
        return hinted
    for message in reversed(request.conversation_messages[:-1]):
        candidates = _candidates(message.text)
        if len(candidates) > 1:
            return None
        if len(candidates) == 1:
            return next(iter(candidates))
    return None


def _response(status: str, message: str) -> ReadOnlySupportResponse:
    return ReadOnlySupportResponse(
        journey="payment_status",
        status=status,
        customer_answer=CustomerAnswer(message=message),
    )


def _format_status(projection: PaymentStatus, *, customer_message: str) -> str:
    question = re.sub(
        rf"(?<![A-Za-z0-9-]){re.escape(projection.reference)}(?![A-Za-z0-9-])",
        " ",
        customer_message,
        flags=re.IGNORECASE,
    )
    asks_payment = bool(_PAYMENT_ASPECT.search(question))
    asks_refund = bool(_REFUND_ASPECT.search(question))
    asks_about_refund_failure = asks_refund and bool(
        _REFUND_FAILURE_ASPECT.search(question)
    )
    refund_summary = _REFUND[projection.refund_status]
    if (
        asks_about_refund_failure
        and projection.refund_status in _MIXED_ATTEMPT_STATUSES
    ):
        refund_summary = f"{refund_summary} {_ATTEMPT_UNCONFIRMED}"
    if asks_payment and not asks_refund:
        if projection.payment_status == "UNCERTAIN":
            return (
                f"I can't confirm the payment status for order "
                f"{projection.reference} right now. Please contact support."
            )
        return f"Order {projection.reference} {_PAYMENT[projection.payment_status]}."
    if asks_refund and not asks_payment:
        if projection.refund_status == "UNCERTAIN":
            return (
                f"I can't confirm the refund status for order "
                f"{projection.reference} right now. Please contact support."
            )
        return f"Order {projection.reference}: {refund_summary}"
    if (
        projection.payment_status == "UNCERTAIN"
        and projection.refund_status == "UNCERTAIN"
    ):
        return (
            f"I can't confirm the payment or refund status for order "
            f"{projection.reference} right now. Please contact support."
        )
    return (
        f"Order {projection.reference} {_PAYMENT[projection.payment_status]}. "
        f"{refund_summary}"
    )


async def answer_payment_status(
    request: SupportIntakeRequest,
    order_lookup: PaymentStatusLookup,
) -> ReadOnlySupportResponse:
    """Use only the verified customer's strict, minimal payment projection."""
    reference = _resolve_reference(request)
    if reference is None:
        return _response("awaiting_order_reference", _MISSING)
    try:
        projection = PaymentStatus.model_validate(
            await order_lookup.lookup_payment_status(reference)
        )
        if projection.reference.casefold() != reference.casefold():
            return _response("source_unavailable", _UNAVAILABLE)
        return _response(
            "answer_ready",
            _format_status(projection, customer_message=request.customer_message),
        )
    except OrderNotFoundError:
        return _response("source_unavailable", _NOT_FOUND)
    except (OrderLookupError, ValidationError, TypeError, ValueError):
        return _response("source_unavailable", _UNAVAILABLE)

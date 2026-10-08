"""Deterministic, bounded answers from the owned-order item projection."""

from __future__ import annotations

import re

from pydantic import ValidationError

from agent_runtime.integrations.order_lookup import (
    OrderItems,
    OrderItemsLookup,
    OrderLookupError,
    OrderNotFoundError,
)
from agent_runtime.support.schemas import (
    CustomerAnswer,
    ReadOnlySupportResponse,
    SupportIntakeRequest,
)

_REFERENCE = re.compile(r"\b[A-Za-z0-9][A-Za-z0-9-]{7,99}\b")
_MISSING = "Please share one order reference so I can check its items."
_NOT_FOUND = (
    "We couldn't find an order for that reference. Please check it or contact support."
)
_UNAVAILABLE = "I couldn't retrieve the order items right now. Please try again later or contact support."


def _candidates(text: str) -> set[str]:
    return {
        match.group().upper()
        for match in _REFERENCE.finditer(text)
        if re.search(r"[A-Za-z]", match.group()) and re.search(r"\d", match.group())
    }


def _resolve_reference(request: SupportIntakeRequest) -> str | None:
    current = _candidates(request.customer_message)
    if len(current) > 1:
        return None
    if len(current) == 1:
        candidate = next(iter(current))
        if (
            request.order_reference is not None
            and candidate.casefold() != request.order_reference.casefold()
        ):
            return None
        return candidate
    if request.order_reference is not None:
        return request.order_reference
    for message in reversed(request.conversation_messages[:-1]):
        candidates = _candidates(message.text)
        if len(candidates) > 1:
            return None
        if len(candidates) == 1:
            return next(iter(candidates))
    return None


def _response(status: str, message: str) -> ReadOnlySupportResponse:
    return ReadOnlySupportResponse(
        journey="order_items",
        status=status,
        customer_answer=CustomerAnswer(message=message),
    )


async def answer_order_items(
    request: SupportIntakeRequest,
    order_lookup: OrderItemsLookup,
) -> ReadOnlySupportResponse:
    """Use only the customer-safe projection; never return a partial item list."""
    reference = _resolve_reference(request)
    if reference is None:
        return _response("awaiting_order_reference", _MISSING)
    try:
        projection = OrderItems.model_validate(
            await order_lookup.lookup_order_items(reference)
        )
        if projection.reference.casefold() != reference.casefold():
            return _response("source_unavailable", _UNAVAILABLE)
        details = ", ".join(
            f"{item.quantity} × {item.name}" for item in projection.items
        )
        message = f"Order {projection.reference} contains: {details}."
        if len(message) > 2_000:
            return _response("source_unavailable", _UNAVAILABLE)
        return _response("answer_ready", message)
    except OrderNotFoundError:
        return _response("source_unavailable", _NOT_FOUND)
    except (OrderLookupError, ValidationError, TypeError, ValueError):
        return _response("source_unavailable", _UNAVAILABLE)

from __future__ import annotations

import re

from pydantic import ValidationError

from agent_runtime.integrations.order_lookup import (
    OrderLookupError,
    OrderNotFoundError,
    OrderStatus,
    OrderStatusLookup,
)
from agent_runtime.support.schemas import (
    CustomerAnswer,
    ReadOnlySupportResponse,
    SupportIntakeRequest,
)

_ORDER_REFERENCE_CANDIDATE = re.compile(r"\b[A-Za-z0-9][A-Za-z0-9-]{7,99}\b")
_MISSING_REFERENCE_MESSAGE = "Please share one order reference so I can check its status."
_NOT_FOUND_MESSAGE = (
    "We couldn't find an order for that reference. Please check it or contact support."
)
_SOURCE_UNAVAILABLE_MESSAGE = (
    "I couldn't retrieve the order status right now. Please try again later or contact support."
)


def _reference_candidates(text: str) -> set[str]:
    return {
        match.group().upper()
        for match in _ORDER_REFERENCE_CANDIDATE.finditer(text)
        if re.search(r"[A-Za-z]", match.group()) and re.search(r"\d", match.group())
    }

def _resolve_order_reference(request: SupportIntakeRequest) -> str | None:
    current = _reference_candidates(request.customer_message)
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
        candidates = _reference_candidates(message.text)
        if len(candidates) > 1:
            return None
        if len(candidates) == 1:
            return next(iter(candidates))

    return None


def _is_delivery_estimate_requested(customer_message: str) -> bool:
    message = customer_message.lower()
    return any(
        phrase in message
        for phrase in ("when will", "eta", "arrive", "delivery estimate")
    )


def _format_order_status(
    order_context: OrderStatus,
    *,
    customer_message: str,
) -> str:
    if not order_context.status.isprintable() or any(
        not fulfillment.status.isprintable()
        or (
            fulfillment.tracking_code is not None
            and not fulfillment.tracking_code.isprintable()
        )
        for fulfillment in order_context.fulfillments
    ):
        raise ValueError("Order status contains non-printable provider data")

    details = [
        f"Order {order_context.reference} is currently {order_context.status}."
    ]
    if len(order_context.fulfillments) > 1:
        for index, fulfillment in enumerate(order_context.fulfillments, start=1):
            description = f"Fulfillment {index} status: {fulfillment.status}"
            if fulfillment.tracking_code:
                description += f"; tracking code: {fulfillment.tracking_code}"
            details.append(f"{description}.")
    elif order_context.fulfillments:
        fulfillment = order_context.fulfillments[0]
        details.append(f"Fulfillment status: {fulfillment.status}.")
        if fulfillment.tracking_code:
            details.append(f"Tracking code: {fulfillment.tracking_code}.")
    if _is_delivery_estimate_requested(customer_message):
        details.append("A delivery estimate is not available from this order status.")

    return " ".join(details)


def _response(status: str, message: str) -> ReadOnlySupportResponse:
    return ReadOnlySupportResponse(
        journey="order_status",
        status=status,
        customer_answer=CustomerAnswer(message=message),
    )


async def answer_order_status(
    request: SupportIntakeRequest,
    order_lookup: OrderStatusLookup,
) -> ReadOnlySupportResponse:
    """Return only verified customer-safe order status facts."""

    order_reference = _resolve_order_reference(request)
    if order_reference is None:
        return _response("awaiting_order_reference", _MISSING_REFERENCE_MESSAGE)

    try:
        lookup_result = await order_lookup.lookup_order_status(order_reference)
        order_context = OrderStatus.model_validate(lookup_result)
        if order_context.reference != order_reference:
            return _response("source_unavailable", _SOURCE_UNAVAILABLE_MESSAGE)
        return _response(
            "answer_ready",
            _format_order_status(order_context, customer_message=request.customer_message),
        )
    except OrderNotFoundError:
        return _response("source_unavailable", _NOT_FOUND_MESSAGE)
    except (OrderLookupError, ValidationError, TypeError, ValueError):
        return _response("source_unavailable", _SOURCE_UNAVAILABLE_MESSAGE)

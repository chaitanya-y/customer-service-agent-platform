"""Read only a verified, tax-inclusive owned-order total."""

from pydantic import ValidationError

from agent_runtime.integrations.order_lookup import (
    OrderLookupError,
    OrderTotal,
    OrderTotalLookup,
)
from agent_runtime.support.order_items import _resolve_reference
from agent_runtime.support.schemas import (
    CustomerAnswer,
    ReadOnlySupportResponse,
    SupportIntakeRequest,
)

_DIGITS = {
    "USD": 2,
    "EUR": 2,
    "GBP": 2,
    "INR": 2,
    "CAD": 2,
    "AUD": 2,
    "JPY": 0,
    "KWD": 3,
}


async def answer_order_total(
    request: SupportIntakeRequest, lookup: OrderTotalLookup
) -> ReadOnlySupportResponse:
    reference = _resolve_reference(request)
    status = "awaiting_order_reference"
    message = "Please share one order reference so I can check its total."
    if reference is not None:
        status = "source_unavailable"
        message = "I couldn't retrieve the order total. Please check the reference or try again later."
        try:
            projection = OrderTotal.model_validate(
                await lookup.lookup_order_total(reference)
            )
            if projection.reference != reference:
                raise ValueError("Mismatched order reference")
            digits = _DIGITS[projection.total.currency]
            amount = projection.total.amount_minor
            scale = 10**digits
            formatted = (
                str(amount)
                if digits == 0
                else f"{amount // scale}.{amount % scale:0{digits}d}"
            )
            message = f"The tax-inclusive total for order {projection.reference} is {projection.total.currency} {formatted}."
            status = "answer_ready"
        except (OrderLookupError, ValidationError, TypeError, ValueError):
            pass
    return ReadOnlySupportResponse(
        journey="order_total",
        status=status,
        customer_answer=CustomerAnswer(message=message),
    )

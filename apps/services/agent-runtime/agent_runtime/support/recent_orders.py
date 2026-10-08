"""Bounded recent placed-order references, not a full history or status read."""

from pydantic import ValidationError

from agent_runtime.integrations.recent_orders import (
    RecentOrderReferences,
    RecentOrdersLookup,
    RecentOrdersUnavailableError,
)
from agent_runtime.support.schemas import CustomerAnswer, ReadOnlySupportResponse


async def answer_recent_orders(lookup: RecentOrdersLookup) -> ReadOnlySupportResponse:
    status = "source_unavailable"
    message = (
        "I couldn't retrieve your recent orders right now. Please try again later."
    )
    try:
        projection = RecentOrderReferences.model_validate(
            await lookup.lookup_recent_order_references()
        )
        if projection.orders:
            references = ", ".join(order.reference for order in projection.orders)
            message = f"Recent placed-order references: {references}."
            if projection.has_more:
                message += " More placed orders may exist beyond these ten."
        else:
            message = "I found no recent placed orders for this account."
        status = "answer_ready"
    except (RecentOrdersUnavailableError, ValidationError, TypeError, ValueError):
        pass
    return ReadOnlySupportResponse(
        journey="recent_orders",
        status=status,
        customer_answer=CustomerAnswer(message=message),
    )

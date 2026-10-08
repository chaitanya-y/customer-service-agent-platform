from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from agent_runtime.refund.schemas import RefundIntakeRequest

SupportIntakeRequest = RefundIntakeRequest

ReadOnlyJourney = Literal[
    "recent_orders",
    "order_status",
    "order_items",
    "order_total",
    "payment_status",
    "product_policy",
    "clarify",
]
ReadOnlyStatus = Literal[
    "answer_ready",
    "awaiting_order_reference",
    "awaiting_product",
    "source_unavailable",
    "clarification_required",
]

_ALLOWED_STATUSES: dict[ReadOnlyJourney, frozenset[ReadOnlyStatus]] = {
    "recent_orders": frozenset({"answer_ready", "source_unavailable"}),
    "order_total": frozenset(
        {"answer_ready", "awaiting_order_reference", "source_unavailable"}
    ),
    "order_status": frozenset(
        {"answer_ready", "awaiting_order_reference", "source_unavailable"}
    ),
    "order_items": frozenset(
        {"answer_ready", "awaiting_order_reference", "source_unavailable"}
    ),
    "payment_status": frozenset(
        {"answer_ready", "awaiting_order_reference", "source_unavailable"}
    ),
    "product_policy": frozenset(
        {"answer_ready", "awaiting_product", "source_unavailable"}
    ),
    "clarify": frozenset({"clarification_required"}),
}


class CustomerAnswer(BaseModel):
    """Customer-safe answer carried by a read-only support journey."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message: str = Field(min_length=1, max_length=2_000)


class CancellationIntakeResponse(BaseModel):
    """An intent acknowledgement, never cancellation eligibility or execution."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    journey: Literal["cancellation"] = "cancellation"
    status: Literal["awaiting_order_reference", "cancellation_request_ready"]
    customer_answer: CustomerAnswer
    order_reference: str | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def reference_must_match_status(self) -> CancellationIntakeResponse:
        if (self.status == "cancellation_request_ready") != (
            self.order_reference is not None
        ):
            raise ValueError(
                "Only a ready cancellation request must have an order reference"
            )
        return self


class ReadOnlySupportResponse(BaseModel):
    """A support result that cannot carry refund workflow state or proposals."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    journey: ReadOnlyJourney
    status: ReadOnlyStatus
    customer_answer: CustomerAnswer

    @model_validator(mode="after")
    def status_must_match_journey(self) -> ReadOnlySupportResponse:
        if self.status not in _ALLOWED_STATUSES[self.journey]:
            raise ValueError("status is not valid for journey")
        return self

import pytest

from agent_runtime.integrations.order_lookup import (
    OrderLookupUnauthorizedError,
    OrderLookupUnavailableError,
    OrderNotFoundError,
)
from agent_runtime.refund.conversation import ConversationCustomerMessage
from agent_runtime.support.order_status import answer_order_status
from agent_runtime.support.schemas import SupportIntakeRequest


class FakeOrderLookup:
    def __init__(
        self,
        *,
        result: object | None = None,
        error: Exception | None = None,
    ) -> None:
        self.result = result
        self.error = error
        self.references: list[str] = []

    async def lookup_order_status(self, order_reference: str) -> object:
        self.references.append(order_reference)

        if self.error is not None:
            raise self.error
        if self.result is None:
            raise AssertionError("A fake result or error is required")

        return self.result


def request(
    customer_message: str,
    *,
    order_reference: str | None = None,
    history: list[str] | None = None,
) -> SupportIntakeRequest:
    messages = history or [customer_message]
    return SupportIntakeRequest(
        customer_message=customer_message,
        order_reference=order_reference,
        conversation_messages=[
            ConversationCustomerMessage(sequence_number=index, text=text)
            for index, text in enumerate(messages, start=1)
        ],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "customer_message, history",
    [
        ("Where is my order?", None),
        (
            "Where are my orders?",
            ["Please check AVV8JSZH8G6ZZDMX or QXB4NEW2EPG6YJ7Q.", "Where are my orders?"],
        ),
    ],
)
async def test_order_status_requires_one_reference(
    customer_message: str,
    history: list[str] | None,
) -> None:
    order_lookup = FakeOrderLookup()

    response = await answer_order_status(
        request(customer_message, history=history),
        order_lookup,
    )

    assert response.journey == "order_status"
    assert response.status == "awaiting_order_reference"
    assert order_lookup.references == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message, reference",
    [
        ("Where is ORDER-456?", "ORDER-123"),
        ("Where is ORDER-123?", "ORDER-456"),
        ("Where are ORDER-123 and ORDER-456?", "ORDER-123"),
        ("Where are ORDER-123 and ORDER-456?", None),
    ],
)
async def test_conflicting_current_references_clarify_without_lookup(message, reference):
    lookup = FakeOrderLookup(result={
        "schemaVersion": "1", "reference": reference or "ORDER-123",
        "status": "Delivered", "fulfillments": [],
    })
    response = await answer_order_status(
        request(message, order_reference=reference, history=["Check ORDER-789.", message]),
        lookup,
    )
    assert response.status == "awaiting_order_reference"
    assert "one order reference" in response.customer_answer.message
    assert "Delivered" not in response.customer_answer.message
    assert lookup.references == []


@pytest.mark.asyncio
@pytest.mark.parametrize("reference", [None, "ORDER-123", "order-123"])
async def test_current_single_reference_overrides_older_context_when_hint_agrees(reference):
    lookup = FakeOrderLookup(result={
        "schemaVersion": "1", "reference": "ORDER-123",
        "status": "Delivered", "fulfillments": [],
    })
    response = await answer_order_status(
        request("Where is order-123?", order_reference=reference,
                history=["Check ORDER-789.", "Where is order-123?"]),
        lookup,
    )
    assert response.status == "answer_ready"
    assert lookup.references == ["ORDER-123"]


@pytest.mark.asyncio
async def test_explicit_reference_is_used_when_current_message_has_no_reference():
    lookup = FakeOrderLookup(result={
        "schemaVersion": "1", "reference": "ORDER-123",
        "status": "Delivered", "fulfillments": [],
    })
    response = await answer_order_status(
        request("Where is it?", order_reference="ORDER-123",
                history=["Check ORDER-789.", "Where is it?"]),
        lookup,
    )
    assert response.status == "answer_ready"
    assert lookup.references == ["ORDER-123"]


@pytest.mark.asyncio
async def test_order_status_uses_latest_unambiguous_reference(
) -> None:
    order_lookup = FakeOrderLookup(result={
        "schemaVersion": "1", "reference": "AVV8JSZH8G6ZZDMX",
        "status": "Delivered", "fulfillments": [],
    })

    response = await answer_order_status(
        request(
            "Where is it now?",
            history=[
                "My older order is QXB4NEW2EPG6YJ7Q.",
                "My current order is avv8jszh8g6zzdmx.",
                "Where is it now?",
            ],
        ),
        order_lookup,
    )

    assert response.status == "answer_ready"
    assert order_lookup.references == ["AVV8JSZH8G6ZZDMX"]


@pytest.mark.asyncio
async def test_order_status_tracks_only_known_fields(
) -> None:
    order = {
        "schemaVersion": "1",
        "reference": "ORDER-123",
        "status": "Delivered",
        "fulfillments": [{"status": "Shipped", "trackingCode": "TRACK-123"}],
    }
    order_lookup = FakeOrderLookup(result=order)

    response = await answer_order_status(
        request("When will order ORDER-123 arrive?", order_reference="ORDER-123"),
        order_lookup,
    )

    message = response.customer_answer.message
    assert response.status == "answer_ready"
    assert "ORDER-123" in message
    assert "Delivered" in message
    assert "Shipped" in message
    assert "TRACK-123" in message
    assert "delivery estimate is not available" in message
    assert "fulfillment-private-1" not in message
    assert "observation-1" not in message
    assert "customer-42" not in message
    assert "vendure" not in message
    assert "payment" not in message.lower()


@pytest.mark.asyncio
async def test_order_status_keeps_each_tracking_code_with_its_fulfillment() -> None:
    response = await answer_order_status(
        request("Where is order ORDER-123?", order_reference="ORDER-123"),
        FakeOrderLookup(result={
            "schemaVersion": "1",
            "reference": "ORDER-123",
            "status": "PartiallyShipped",
            "fulfillments": [
                {"status": "Shipped", "trackingCode": "TRACK-ONE"},
                {"status": "Pending", "trackingCode": None},
                {"status": "Delivered", "trackingCode": "TRACK-THREE"},
            ],
        }),
    )

    assert response.status == "answer_ready"
    assert response.customer_answer.message == (
        "Order ORDER-123 is currently PartiallyShipped. "
        "Fulfillment 1 status: Shipped; tracking code: TRACK-ONE. "
        "Fulfillment 2 status: Pending. "
        "Fulfillment 3 status: Delivered; tracking code: TRACK-THREE."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "order_status, fulfillment_status, tracking_code, unsafe_value",
    [
        ("Shipped\nInjected", "Shipped", "TRACK-ONE", "Injected"),
        ("Shipped", "Pending\x1b[31m", "TRACK-ONE", "\x1b[31m"),
        ("Shipped", "Shipped", "TRACK\nInjected", "Injected"),
    ],
)
async def test_order_status_fails_closed_on_provider_control_characters(
    order_status: str,
    fulfillment_status: str,
    tracking_code: str,
    unsafe_value: str,
) -> None:
    response = await answer_order_status(
        request("Where is order ORDER-123?", order_reference="ORDER-123"),
        FakeOrderLookup(result={
            "schemaVersion": "1",
            "reference": "ORDER-123",
            "status": order_status,
            "fulfillments": [
                {"status": fulfillment_status, "trackingCode": tracking_code}
            ],
        }),
    )

    assert response.status == "source_unavailable"
    assert "ORDER-123" not in response.customer_answer.message
    assert unsafe_value not in response.customer_answer.message


@pytest.mark.asyncio
async def test_order_status_rejects_full_refund_context(
    order_context: object,
) -> None:
    response = await answer_order_status(
        request("Where is order ORDER-123?", order_reference="ORDER-123"),
        FakeOrderLookup(result=order_context),
    )

    assert response.status == "source_unavailable"
    assert "ORDER-123" not in response.customer_answer.message


@pytest.mark.asyncio
async def test_order_status_rejects_a_different_order_reference() -> None:
    response = await answer_order_status(
        request("Where is order ORDER-123?", order_reference="ORDER-123"),
        FakeOrderLookup(result={
            "schemaVersion": "1",
            "reference": "ORDER-999",
            "status": "Delivered",
            "fulfillments": [],
        }),
    )

    assert response.status == "source_unavailable"
    assert "ORDER-999" not in response.customer_answer.message
    assert "Delivered" not in response.customer_answer.message


@pytest.mark.asyncio
async def test_order_status_fails_closed_when_valid_fulfillments_exceed_answer_limit() -> None:
    response = await answer_order_status(
        request("Where is order ORDER-123?", order_reference="ORDER-123"),
        FakeOrderLookup(result={
            "schemaVersion": "1",
            "reference": "ORDER-123",
            "status": "Shipped",
            "fulfillments": [
                {"status": "S" * 80, "trackingCode": "T" * 160}
                for _ in range(9)
            ],
        }),
    )

    assert response.status == "source_unavailable"
    assert "ORDER-123" not in response.customer_answer.message
    assert "T" * 160 not in response.customer_answer.message


@pytest.mark.asyncio
async def test_order_status_masks_missing_or_other_customer() -> None:
    missing_lookup = FakeOrderLookup(error=OrderNotFoundError())
    other_customer_lookup = FakeOrderLookup(error=OrderNotFoundError())
    status_request = request("Where is order ORDER-123?", order_reference="ORDER-123")

    missing = await answer_order_status(status_request, missing_lookup)
    other_customer = await answer_order_status(status_request, other_customer_lookup)

    assert missing.status == "source_unavailable"
    assert other_customer.status == "source_unavailable"
    assert missing.customer_answer.message == other_customer.customer_answer.message


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result, error",
    [
        (None, OrderLookupUnauthorizedError()),
        (None, OrderLookupUnavailableError()),
        ({"reference": "ORDER-123"}, None),
    ],
)
async def test_order_status_fails_closed(
    result: object | None,
    error: Exception | None,
) -> None:
    order_lookup = FakeOrderLookup(result=result, error=error)

    response = await answer_order_status(
        request("Where is order ORDER-123?", order_reference="ORDER-123"),
        order_lookup,
    )

    assert response.journey == "order_status"
    assert response.status == "source_unavailable"
    assert "ORDER-123" not in response.customer_answer.message
    assert "unauthorized" not in response.customer_answer.message.lower()

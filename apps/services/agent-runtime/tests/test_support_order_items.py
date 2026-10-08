import pytest
from mcp.types import CallToolResult
from test_order_lookup import TEST_CONTEXT_ASSERTION, stub_mcp

from agent_runtime.integrations.order_lookup import (
    McpOrderLookupClient,
    OrderLookupUnavailableError,
    OrderNotFoundError,
)
from agent_runtime.refund.conversation import ConversationCustomerMessage
from agent_runtime.support.order_items import answer_order_items
from agent_runtime.support.schemas import SupportIntakeRequest


class FakeItemsLookup:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.references = []

    async def lookup_order_items(self, order_reference):
        self.references.append(order_reference)
        if self.error:
            raise self.error
        return self.result


def request(message, *, reference=None, history=None):
    messages = history or [message]
    return SupportIntakeRequest(
        customer_message=message,
        order_reference=reference,
        conversation_messages=[
            ConversationCustomerMessage(sequence_number=i, text=text)
            for i, text in enumerate(messages, 1)
        ],
    )


ITEMS = {
    "schemaVersion": "1",
    "reference": "ORDER-123",
    "items": [{"name": "Laptop 13 inch 8GB", "quantity": 1}],
}


@pytest.mark.asyncio
async def test_owned_items_answer_uses_only_projection():
    lookup = FakeItemsLookup(ITEMS)
    response = await answer_order_items(
        request("What items are in order ORDER-123?", reference="ORDER-123"), lookup
    )
    assert response.journey == "order_items"
    assert response.status == "answer_ready"
    assert response.customer_answer.message == (
        "Order ORDER-123 contains: 1 × Laptop 13 inch 8GB."
    )
    assert lookup.references == ["ORDER-123"]


@pytest.mark.asyncio
async def test_cancelled_items_gateway_error_cannot_become_current_contents(
    monkeypatch,
):
    # Gateway deliberately declines the v1 projection for cancelled orders.
    stub_mcp(
        monkeypatch,
        result=CallToolResult(
            content=[],
            structuredContent={
                "error": {
                    "code": "commerce_provider_unavailable",
                    "message": "Commerce provider request failed",
                }
            },
            isError=True,
        ),
    )
    response = await answer_order_items(
        request("What items are in ORDER-123?", reference="ORDER-123"),
        McpOrderLookupClient(context_assertion=TEST_CONTEXT_ASSERTION),
    )
    assert response.status == "source_unavailable"
    assert "contains:" not in response.customer_answer.message
    assert "×" not in response.customer_answer.message
    assert "ORDER-123" not in response.customer_answer.message


@pytest.mark.asyncio
async def test_mismatched_projection_reference_does_not_disclose_other_order_items():
    lookup = FakeItemsLookup(
        {
            "schemaVersion": "1",
            "reference": "ORDER-456",
            "items": [{"name": "Other customer's private item", "quantity": 1}],
        }
    )
    response = await answer_order_items(
        request("What items are in order ORDER-123?", reference="ORDER-123"), lookup
    )
    assert lookup.references == ["ORDER-123"]
    assert response.status == "source_unavailable"
    assert "ORDER-456" not in response.customer_answer.message
    assert "private item" not in response.customer_answer.message


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message,history",
    [
        ("What items are in my order?", None),
        (
            "What items are in ORDER-123 and ORDER-456?",
            [
                "Earlier I asked about ORDER-789.",
                "What items are in ORDER-123 and ORDER-456?",
            ],
        ),
    ],
)
async def test_missing_or_ambiguous_reference_never_looks_up(message, history):
    lookup = FakeItemsLookup(ITEMS)
    response = await answer_order_items(request(message, history=history), lookup)
    assert response.status == "awaiting_order_reference"
    assert lookup.references == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message,reference",
    [
        ("What items are in ORDER-123?", "ORDER-456"),
        ("What items are in ORDER-456?", "ORDER-123"),
        ("What items are in ORDER-123 and ORDER-456?", "ORDER-123"),
    ],
)
async def test_conflicting_current_references_clarify_without_lookup(message, reference):
    lookup = FakeItemsLookup(ITEMS)
    response = await answer_order_items(
        request(message, reference=reference, history=["Check ORDER-789.", message]),
        lookup,
    )
    assert response.status == "awaiting_order_reference"
    assert "one order reference" in response.customer_answer.message
    assert "Laptop" not in response.customer_answer.message
    assert lookup.references == []


@pytest.mark.asyncio
@pytest.mark.parametrize("reference", [None, "ORDER-123", "order-123"])
async def test_current_single_reference_overrides_older_context_when_hint_agrees(reference):
    lookup = FakeItemsLookup(ITEMS)
    response = await answer_order_items(
        request("What items are in order-123?", reference=reference,
                history=["Check ORDER-789.", "What items are in order-123?"]),
        lookup,
    )
    assert response.status == "answer_ready"
    assert lookup.references == ["ORDER-123"]


@pytest.mark.asyncio
async def test_explicit_reference_is_used_when_current_message_has_no_reference():
    lookup = FakeItemsLookup(ITEMS)
    response = await answer_order_items(
        request("What items are in it?", reference="ORDER-123",
                history=["Check ORDER-789.", "What items are in it?"]),
        lookup,
    )
    assert response.status == "answer_ready"
    assert lookup.references == ["ORDER-123"]


@pytest.mark.asyncio
async def test_latest_single_reference_is_used():
    lookup = FakeItemsLookup(ITEMS)
    response = await answer_order_items(
        request(
            "What items are in it?",
            history=["Check ORDER-789.", "I mean ORDER-123.", "What items are in it?"],
        ),
        lookup,
    )
    assert response.status == "answer_ready"
    assert lookup.references == ["ORDER-123"]


@pytest.mark.asyncio
async def test_missing_and_other_customer_orders_are_indistinguishable():
    request_value = request("What is in ORDER-123?", reference="ORDER-123")
    missing = await answer_order_items(
        request_value, FakeItemsLookup(error=OrderNotFoundError())
    )
    other_customer = await answer_order_items(
        request_value, FakeItemsLookup(error=OrderNotFoundError())
    )
    assert missing == other_customer
    assert missing.status == "source_unavailable"
    assert "ORDER-123" not in missing.customer_answer.message


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result,error",
    [
        (None, OrderLookupUnavailableError()),
        ({**ITEMS, "items": []}, None),
        ({**ITEMS, "items": [{"name": "X", "quantity": 1}] * 21}, None),
        ({**ITEMS, "items": [{"name": " ", "quantity": 1}]}, None),
        ({**ITEMS, "items": [{"name": "X" * 301, "quantity": 1}]}, None),
        ({**ITEMS, "items": [{"name": "X", "quantity": 10_001}]}, None),
        ({**ITEMS, "items": [{"name": "X", "quantity": 1.5}]}, None),
        ({**ITEMS, "status": "Cancelled"}, None),
        (
            {**ITEMS, "items": [{"name": "X", "quantity": 0, "orderedQuantity": 2}]},
            None,
        ),
        (
            {**ITEMS, "items": [{"name": "X", "quantity": 2, "orderedQuantity": 2}]},
            None,
        ),
        ({**ITEMS, "payment": "private"}, None),
        ({**ITEMS, "items": [{"name": "X", "quantity": 1, "sku": "private"}]}, None),
        (
            {"schema_version": "1", "reference": "ORDER-123", "items": ITEMS["items"]},
            None,
        ),
        ({**ITEMS, "items": [{"name": "X" * 300, "quantity": 1}] * 20}, None),
    ],
)
async def test_invalid_or_oversized_projection_fails_closed(result, error):
    response = await answer_order_items(
        request("What is in ORDER-123?", reference="ORDER-123"),
        FakeItemsLookup(result, error),
    )
    assert response.status == "source_unavailable"
    assert "ORDER-123" not in response.customer_answer.message

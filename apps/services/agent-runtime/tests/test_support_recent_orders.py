"""The recent-order chat path is a bounded, owner-scoped read."""

import pytest

from agent_runtime.support.classifier import classify_support_journey
from agent_runtime.support.schemas import SupportIntakeRequest


class NoModel:
    async def classify(self, **_kwargs):
        raise AssertionError("Recent-order routing must not need a model")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "What are my recent orders?",
        "Show my recent order references.",
        "List my last orders.",
    ],
)
async def test_recent_order_questions_route_without_model(message):
    result = await classify_support_journey(
        SupportIntakeRequest(customer_message=message), NoModel()
    )
    assert result.journey == "recent_orders"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "What are my recent orders and refund the last one?",
        "Show my recent orders and their payment status.",
        "Where is my recent order?",
        "Please cancel my recent orders.",
    ],
)
async def test_mixed_or_specific_order_requests_do_not_use_recent_list(message):
    result = await classify_support_journey(
        SupportIntakeRequest(customer_message=message), NoModel()
    )
    assert result.journey == "clarify"


class FakeLookup:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    async def lookup_recent_order_references(self):
        self.calls += 1
        return self.result


RECENT = {
    "schemaVersion": "1",
    "orders": [
        {"reference": "ORDER-NEW", "placedAt": "2026-10-02T14:00:00Z"},
        {"reference": "ORDER-OLD", "placedAt": "2026-10-01T14:00:00Z"},
    ],
    "hasMore": False,
}


@pytest.mark.asyncio
async def test_answer_lists_only_verified_references_and_no_status_claims():
    from agent_runtime.support.recent_orders import answer_recent_orders

    lookup = FakeLookup(RECENT)
    result = await answer_recent_orders(lookup)
    assert result.journey == "recent_orders"
    assert result.status == "answer_ready"
    assert "ORDER-NEW" in result.customer_answer.message
    assert "ORDER-OLD" in result.customer_answer.message
    assert "ORDER-NEW" in result.customer_answer.message.split("ORDER-OLD")[0]
    assert not any(
        word in result.customer_answer.message.lower()
        for word in ("paid", "shipped", "refund", "delivered", "all your orders")
    )
    assert lookup.calls == 1


@pytest.mark.asyncio
async def test_empty_list_does_not_invent_an_order():
    from agent_runtime.support.recent_orders import answer_recent_orders

    result = await answer_recent_orders(
        FakeLookup({"schemaVersion": "1", "orders": [], "hasMore": False})
    )
    assert result.status == "answer_ready"
    assert "no recent placed orders" in result.customer_answer.message.lower()


@pytest.mark.asyncio
async def test_more_than_ten_is_described_as_a_partial_page():
    from agent_runtime.support.recent_orders import answer_recent_orders

    orders = [
        {
            "reference": f"ORDER-{index}",
            "placedAt": f"2026-10-{20 - index:02d}T00:00:00Z",
        }
        for index in range(10)
    ]
    result = await answer_recent_orders(
        FakeLookup({"schemaVersion": "1", "orders": orders, "hasMore": True})
    )
    assert result.status == "answer_ready"
    assert "more" in result.customer_answer.message.lower()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {**RECENT, "orders": [{"reference": "OTHER", "placedAt": "bad"}]},
        {**RECENT, "orders": list(reversed(RECENT["orders"]))},
        {**RECENT, "orders": [RECENT["orders"][0]] * 2},
        {**RECENT, "hasMore": True},
        {**RECENT, "orders": [{**RECENT["orders"][0], "payment": "PAID"}]},
        {**RECENT, "customerId": "other-customer"},
    ],
)
async def test_malformed_projection_fails_closed(payload):
    from agent_runtime.support.recent_orders import answer_recent_orders

    result = await answer_recent_orders(FakeLookup(payload))
    assert result.status == "source_unavailable"
    assert "ORDER-NEW" not in result.customer_answer.message
    assert "OTHER" not in result.customer_answer.message

import pytest

from agent_runtime.support.classifier import classify_support_journey
from agent_runtime.support.schemas import SupportIntakeRequest


class NoModel:
    async def classify(self, **kwargs):
        raise AssertionError("Total routing must not need a model")


@pytest.mark.asyncio
async def test_model_cannot_create_an_order_total_question():
    from agent_runtime.support.classifier import SupportRouteDecision

    class InventedTotal:
        async def classify(self, **kwargs):
            return SupportRouteDecision(
                journey="order_total", order_reference="ORDER-123"
            )

    result = await classify_support_journey(
        SupportIntakeRequest(customer_message="Help me please"), InventedTotal()
    )
    assert result.journey == "clarify"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error_name",
    [
        "OrderNotFoundError",
        "OrderLookupUnavailableError",
        "OrderLookupUnauthorizedError",
    ],
)
async def test_total_lookup_errors_are_masked_without_order_facts(error_name):
    from agent_runtime.integrations import order_lookup
    from agent_runtime.support.order_total import answer_order_total

    class FailedLookup:
        async def lookup_order_total(self, reference):
            raise getattr(order_lookup, error_name)()

    result = await answer_order_total(
        SupportIntakeRequest(customer_message="What is the order total for ORDER-123?"),
        FailedLookup(),
    )
    assert result.status == "source_unavailable"
    assert "ORDER-123" not in result.customer_answer.message


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "What is the order total for ORDER-123?",
        "What is the cost of order ORDER-123?",
        "What is the total for order 9KWUQ1TBZ7NUV8EU?",
    ],
)
async def test_explicit_order_total_routes_without_model(message):
    result = await classify_support_journey(
        SupportIntakeRequest(customer_message=message), NoModel()
    )
    assert result.journey == "order_total"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "What is the order total for ORDER-123 and refund it?",
        "What is the order total and amount paid for ORDER-123?",
        "What is the order total and invoice for ORDER-123?",
    ],
)
async def test_mixed_total_questions_clarify_without_model(message):
    result = await classify_support_journey(
        SupportIntakeRequest(customer_message=message), NoModel()
    )
    assert result.journey == "clarify"


class TotalLookup:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def lookup_order_total(self, reference):
        self.calls.append(reference)
        return self.result


TOTAL = {
    "schemaVersion": "1",
    "reference": "ORDER-123",
    "total": {"amountMinor": 12345, "currency": "USD"},
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "amount,currency,text",
    [
        (12345, "USD", "USD 123.45"),
        (0, "USD", "USD 0.00"),
        (123, "JPY", "JPY 123"),
        (1234, "KWD", "KWD 1.234"),
    ],
)
async def test_total_answer_formats_source_minor_units(amount, currency, text):
    from agent_runtime.support.order_total import answer_order_total

    lookup = TotalLookup(
        {**TOTAL, "total": {"amountMinor": amount, "currency": currency}}
    )
    result = await answer_order_total(
        SupportIntakeRequest(customer_message="What is the order total for ORDER-123?"),
        lookup,
    )
    assert result.status == "answer_ready"
    assert text in result.customer_answer.message
    assert "tax-inclusive" in result.customer_answer.message
    assert not any(
        term in result.customer_answer.message.lower()
        for term in ["paid", "refund", "invoice", "balance", "delivered"]
    )
    assert lookup.calls == ["ORDER-123"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {**TOTAL, "reference": "ORDER-456"},
        {**TOTAL, "total": {"amountMinor": True, "currency": "USD"}},
        {**TOTAL, "total": {"amountMinor": "12345", "currency": "USD"}},
        {**TOTAL, "total": {"amountMinor": -1, "currency": "USD"}},
        {**TOTAL, "total": {"amountMinor": 1.5, "currency": "USD"}},
        {**TOTAL, "total": {"amountMinor": 12345, "currency": "ZZZ"}},
        {**TOTAL, "total": {"amountMinor": 12345, "currency": "USD", "paid": True}},
        {**TOTAL, "payments": []},
        {},
        None,
    ],
)
async def test_invalid_total_source_never_discloses_facts(payload):
    from agent_runtime.support.order_total import answer_order_total

    result = await answer_order_total(
        SupportIntakeRequest(customer_message="What is the order total for ORDER-123?"),
        TotalLookup(payload),
    )
    assert result.status == "source_unavailable"
    assert "123.45" not in result.customer_answer.message
    assert "ORDER-456" not in result.customer_answer.message


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message,hint",
    [
        ("What is the order total?", None),
        ("What is the order total for ORDER-123 and ORDER-456?", None),
        ("What is the order total for ORDER-123?", "ORDER-456"),
    ],
)
async def test_missing_or_conflicting_reference_never_calls_lookup(message, hint):
    from agent_runtime.support.order_total import answer_order_total

    lookup = TotalLookup(TOTAL)
    result = await answer_order_total(
        SupportIntakeRequest(customer_message=message, order_reference=hint), lookup
    )
    assert result.status == "awaiting_order_reference"
    assert lookup.calls == []

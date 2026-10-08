from typing import Literal

import pytest

from agent_runtime.refund.conversation import ConversationCustomerMessage
from agent_runtime.support.classifier import (
    LangChainSupportJourneyClassifier,
    SupportJourneyClassificationError,
    SupportJourneyClassifier,
    SupportRouteDecision,
    classify_support_journey,
)
from agent_runtime.support.schemas import SupportIntakeRequest


class FakeClassifier(SupportJourneyClassifier):
    def __init__(
        self,
        decision: SupportRouteDecision,
    ) -> None:
        self.decision = decision
        self.messages: list[str] = []
        self.histories: list[list[ConversationCustomerMessage]] = []

    async def classify(
        self,
        *,
        customer_message: str,
        conversation_messages: list[ConversationCustomerMessage],
    ) -> SupportRouteDecision:
        self.messages.append(customer_message)
        self.histories.append(conversation_messages)
        return self.decision


class FakeStructuredModel:
    def __init__(
        self, *, result: object | None = None, error: Exception | None = None
    ) -> None:
        self.result = result
        self.error = error

    async def ainvoke(self, _messages: object) -> object:
        if self.error is not None:
            raise self.error
        return self.result


class FakeChatModel:
    def __init__(self, structured_model: FakeStructuredModel) -> None:
        self.structured_model = structured_model

    def with_structured_output(
        self, _schema: object, **_kwargs: object
    ) -> FakeStructuredModel:
        return self.structured_model


def request(customer_message: str, history: list[str]) -> SupportIntakeRequest:
    return SupportIntakeRequest(
        customer_message=customer_message,
        conversation_messages=[
            ConversationCustomerMessage(sequence_number=index, text=text)
            for index, text in enumerate(history, start=1)
        ],
    )


def decision(
    journey: Literal[
        "refund", "order_status", "order_items", "product_policy", "clarify"
    ],
    *,
    order_reference: str | None = None,
    product_query: str | None = None,
) -> SupportRouteDecision:
    return SupportRouteDecision(
        journey=journey,
        order_reference=order_reference,
        product_query=product_query,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    (
        "customer_message",
        "history",
        "model_decision",
        "expected_journey",
        "expects_model_call",
    ),
    [
        (
            "Where is order ORDER-123 now?",
            ["I want a refund for order ORDER-123.", "Where is order ORDER-123 now?"],
            decision("order_status", order_reference="ORDER-123"),
            "order_status",
            True,
        ),
        (
            "What is your refund policy for damaged items?",
            ["What is your refund policy for damaged items?"],
            decision("product_policy"),
            "product_policy",
            True,
        ),
        (
            "Tell me about the Glow Serum.",
            ["Tell me about the Glow Serum."],
            decision("product_policy", product_query="Glow Serum"),
            "product_policy",
            True,
        ),
    ],
)
async def test_route_current_turn_without_inheriting_refund_intent(
    customer_message: str,
    history: list[str],
    model_decision: SupportRouteDecision,
    expected_journey: str,
    expects_model_call: bool,
) -> None:
    classifier = FakeClassifier(model_decision)

    result = await classify_support_journey(
        request(customer_message, history),
        classifier,
    )

    assert result.journey == expected_journey
    if expects_model_call:
        assert classifier.messages == [customer_message]
        assert classifier.histories[0][-1].text == customer_message
    else:
        assert classifier.messages == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "Can I exchange an item?",
        "Can I return or exchange an item?",
        "What is your exchange policy?",
    ],
)
async def test_exchange_discussion_never_routes_to_refund_action(message: str) -> None:
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(request(message, []), classifier)

    assert result.journey == "product_policy"
    assert result.order_reference is None


@pytest.mark.asyncio
async def test_explicit_current_turn_refund_action_overrides_model_route() -> None:
    classifier = FakeClassifier(decision("product_policy"))

    result = await classify_support_journey(
        request(
            "Please start a refund for order ORDER-123.",
            [
                "What is the refund policy?",
                "Please start a refund for order ORDER-123.",
            ],
        ),
        classifier,
    )

    assert result == decision("refund")
    assert classifier.messages == ["Please start a refund for order ORDER-123."]


@pytest.mark.asyncio
async def test_mixed_current_turn_cannot_route_to_refund() -> None:
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(
            "Refund order ORDER-123 and tell me where it is.",
            ["Refund order ORDER-123 and tell me where it is."],
        ),
        classifier,
    )

    assert result == decision("clarify")


@pytest.mark.asyncio
async def test_previous_refund_does_not_override_current_items_question() -> None:
    classifier = FakeClassifier(decision("refund"))
    result = await classify_support_journey(
        request(
            "What items are in order ORDER-123?",
            [
                "I want a refund for order ORDER-123.",
                "What items are in order ORDER-123?",
            ],
        ),
        classifier,
    )
    assert result == decision("order_items")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "customer_message",
    [
        "What items were in my cancelled order VRG4PLUWDE79UJJ8?",
        "Which products were in the canceled order VRG4PLUWDE79UJJ8?",
    ],
)
async def test_cancelled_order_item_history_routes_to_read_only_items(
    customer_message: str,
) -> None:
    classifier = FakeClassifier(decision("clarify"))
    result = await classify_support_journey(
        request(customer_message, [customer_message]), classifier
    )
    assert result == decision("order_items")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("customer_message", "expected_journey"),
    [
        ("Please cancel my order VRG4PLUWDE79UJJ8?", "cancellation"),
        (
            "What items were in my cancelled order VRG4PLUWDE79UJJ8 and cancel order EJ4P5T4W2BKUH56Y?",
            "clarify",
        ),
    ],
)
async def test_cancelled_item_history_does_not_override_cancellation_action_guard(
    customer_message: str,
    expected_journey: str,
) -> None:
    classifier = FakeClassifier(decision("order_items"))
    result = await classify_support_journey(
        request(customer_message, [customer_message]), classifier
    )
    assert result.journey == expected_journey


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "customer_message",
    ["What products do you sell?", "How many products do you sell?"],
)
async def test_generic_catalog_question_does_not_force_order_items(
    customer_message: str,
) -> None:
    classifier = FakeClassifier(decision("product_policy"))
    result = await classify_support_journey(
        request(customer_message, [customer_message]), classifier
    )
    assert result == decision("product_policy")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "What is the price of Laptop 13 inch 8GB?",
        "How much does Laptop 13 inch 8GB cost?",
    ],
)
async def test_explicit_catalog_price_routes_without_model(message: str) -> None:
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(request(message, []), classifier)

    assert result == decision("product_policy", product_query="Laptop 13 inch 8GB")
    assert classifier.messages == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "What is the price of Laptop 13 inch 8GB and refund my order?",
        "What is the price of Laptop 13 inch 8GB and where is my order?",
        "How much does Laptop 13 inch 8GB cost and was my payment received?",
        "What is the price of Laptop 13 inch 8GB and can I pay for my order?",
        "What is the price of Laptop 13 inch 8GB and tell me about my order?",
        "What is the price of Laptop 13 inch 8GB and your refund policy?",
    ],
)
async def test_catalog_price_mixed_with_other_intent_clarifies(message: str) -> None:
    classifier = FakeClassifier(decision("product_policy"))

    result = await classify_support_journey(request(message, []), classifier)

    assert result == decision("clarify")
    assert classifier.messages == []


@pytest.mark.asyncio
async def test_explicit_stock_question_routes_read_only_without_model_hint() -> None:
    classifier = FakeClassifier(decision("refund"))
    text = "Is Cloud Hoodie Blue / Small in stock?"
    result = await classify_support_journey(
        request(text, ["I want a refund for order ORDER-123.", text]), classifier
    )
    assert result == decision(
        "product_policy", product_query="Cloud Hoodie Blue / Small"
    )
    assert classifier.messages == []


@pytest.mark.asyncio
async def test_stock_question_combined_with_refund_action_requires_clarification() -> (
    None
):
    classifier = FakeClassifier(decision("product_policy"))
    text = "Refund order ORDER-123 and check whether Cloud Hoodie is in stock."
    result = await classify_support_journey(request(text, [text]), classifier)
    assert result == decision("clarify")
    assert classifier.messages == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    [
        "Where is order ORDER-123 and is Cloud Hoodie Blue / Small in stock?",
        "Has my payment been received and is Cloud Hoodie Blue / Small in stock?",
    ],
)
async def test_stock_question_combined_with_other_read_only_journey_clarifies(
    text: str,
) -> None:
    classifier = FakeClassifier(decision("product_policy"))
    result = await classify_support_journey(request(text, [text]), classifier)
    assert result == decision("clarify")
    assert classifier.messages == []


@pytest.mark.asyncio
async def test_current_refund_action_plus_items_question_requires_clarification() -> (
    None
):
    classifier = FakeClassifier(decision("order_items"))
    result = await classify_support_journey(
        request(
            "Please refund order ORDER-123 and tell me what items are in it.",
            ["Please refund order ORDER-123 and tell me what items are in it."],
        ),
        classifier,
    )
    assert result == decision("clarify")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("customer_message", "expected_journey"),
    [
        ("I don't want a refund.", "clarify"),
        ("What do I need to get a refund?", "product_policy"),
    ],
)
async def test_non_action_refund_language_cannot_dispatch_refund(
    customer_message: str,
    expected_journey: str,
) -> None:
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result.journey == expected_journey


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("customer_message", "model_journey", "expected_journey"),
    [
        ("I want a refund.", "product_policy", "refund"),
        ("I need a refund.", "product_policy", "refund"),
        ("Refund order ORDER-123.", "product_policy", "refund"),
        ("Don't process a refund.", "refund", "clarify"),
        ("I don't want a refund.", "refund", "clarify"),
        ("What do I need to get a refund?", "refund", "product_policy"),
    ],
)
async def test_refund_guard_classifies_affirmative_negative_and_information_turns(
    customer_message: str,
    model_journey: Literal["refund", "order_status", "product_policy", "clarify"],
    expected_journey: str,
) -> None:
    classifier = FakeClassifier(decision(model_journey))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result.journey == expected_journey


@pytest.mark.asyncio
async def test_imperative_current_turn_refund_action_dispatches_refund() -> None:
    customer_message = "Refund order ORDER-123."
    classifier = FakeClassifier(decision("product_policy"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("refund")


@pytest.mark.asyncio
async def test_order_status_and_policy_in_one_turn_routes_to_clarify() -> None:
    customer_message = "What is my order status and refund policy?"
    classifier = FakeClassifier(decision("product_policy"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("clarify")


@pytest.mark.asyncio
async def test_refund_action_and_policy_question_in_one_turn_routes_to_clarify() -> (
    None
):
    customer_message = "Please refund order ORDER-123 and explain the return policy."
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("clarify")
    assert classifier.messages == []


@pytest.mark.asyncio
async def test_refund_action_and_product_question_in_one_turn_routes_to_clarify() -> (
    None
):
    customer_message = "Refund order ORDER-123 and tell me about Glow Serum."
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("clarify")
    assert classifier.messages == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "customer_message",
    [
        "Refund order ORDER-123. What products do you have?",
        "Refund order ORDER-123; also, tell me about Glow Serum.",
        "I want a refund for order ORDER-123 and a recommendation for a new product.",
        "Refund order ORDER-123 and check the price of Glow Serum.",
        "Refund order ORDER-123, then check whether Glow Serum is in stock.",
        "I want a refund for ORDER-123. Please show me the available products.",
        "I want a refund for ORDER-123. The item arrived damaged, please show me available products.",
        "Refund order ORDER-123. I would like a full refund, what is the price of Glow Serum?",
        "Refund order ORDER-123: show me the price of Glow Serum.",
        "Refund order ORDER-123 please check the price of Glow Serum.",
    ],
)
async def test_refund_action_with_a_second_request_never_enters_refund(
    customer_message: str,
) -> None:
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("clarify")
    assert classifier.messages == []


@pytest.mark.asyncio
async def test_refund_details_in_following_clauses_remain_a_single_refund_request() -> (
    None
):
    customer_message = (
        "I want a refund for order ORDER-123. "
        "The item arrived damaged and I would like a full refund."
    )
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("refund")


@pytest.mark.asyncio
async def test_refund_reason_clause_remains_a_single_refund_request() -> None:
    customer_message = "Please refund order ORDER-123 because the item arrived damaged."
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("refund")


@pytest.mark.asyncio
async def test_natural_current_turn_refund_request_can_reach_refund() -> None:
    customer_message = "Could you refund my order ORDER-123?"
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("refund")


@pytest.mark.asyncio
async def test_hypothetical_refund_question_cannot_start_refund() -> None:
    customer_message = "Could you tell me how to refund my order?"
    classifier = FakeClassifier(decision("refund"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result != decision("refund")


@pytest.mark.asyncio
async def test_named_product_policy_question_preserves_current_turn_product_hint() -> (
    None
):
    customer_message = "What is the return policy for Glow Serum?"
    classifier = FakeClassifier(decision("product_policy", product_query="Glow Serum"))

    result = await classify_support_journey(
        request(customer_message, [customer_message]),
        classifier,
    )

    assert result == decision("product_policy", product_query="Glow Serum")
    assert classifier.messages == [customer_message]


@pytest.mark.asyncio
async def test_policy_question_rejects_product_hint_not_present_in_current_turn() -> (
    None
):
    customer_message = "What is your return policy?"
    classifier = FakeClassifier(decision("product_policy", product_query="Glow Serum"))

    result = await classify_support_journey(
        request(customer_message, ["I own Glow Serum.", customer_message]),
        classifier,
    )

    assert result == decision("product_policy")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "structured_model",
    [
        FakeStructuredModel(
            result={
                "journey": "unsupported",
                "order_reference": None,
                "product_query": None,
            }
        ),
        FakeStructuredModel(error=RuntimeError("provider failure")),
    ],
)
async def test_structured_adapter_propagates_safe_classification_failure(
    structured_model: FakeStructuredModel,
) -> None:
    classifier = LangChainSupportJourneyClassifier(FakeChatModel(structured_model))  # type: ignore[arg-type]

    with pytest.raises(SupportJourneyClassificationError):
        await classifier.classify(
            customer_message="Where is my order?",
            conversation_messages=[],
        )


@pytest.mark.asyncio
async def test_classifier_receives_only_bounded_customer_history() -> None:
    classifier = FakeClassifier(decision("order_status", order_reference="ORDER-123"))
    history = [f"Earlier message {index}" for index in range(1, 8)] + [
        "Where is order ORDER-123?"
    ]

    await classify_support_journey(
        request("Where is order ORDER-123?", history),
        classifier,
    )

    assert len(classifier.histories[0]) == 8
    assert [message.text for message in classifier.histories[0]] == history


def test_route_decision_rejects_unknown_journey() -> None:
    with pytest.raises(ValueError):
        SupportRouteDecision.model_validate(
            {
                "journey": "refund_policy",
                "order_reference": None,
                "product_query": None,
            }
        )

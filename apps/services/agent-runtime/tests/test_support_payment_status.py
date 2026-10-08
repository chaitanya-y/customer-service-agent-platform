"""Read-only payment status boundary tests; no provider or model calls."""

import pytest
from pydantic import ValidationError

from agent_runtime.integrations.order_lookup import (
    OrderLookupUnavailableError,
    OrderNotFoundError,
    PaymentStatus,
)
from agent_runtime.refund.conversation import ConversationCustomerMessage
from agent_runtime.support.classifier import (
    SupportRouteDecision,
    classify_support_journey,
)
from agent_runtime.support.payment_status import answer_payment_status
from agent_runtime.support.schemas import ReadOnlySupportResponse, SupportIntakeRequest


class FakeLookup:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.references = []

    async def lookup_payment_status(self, order_reference):
        self.references.append(order_reference)
        if self.error:
            raise self.error
        return self.result


class FakeClassifier:
    def __init__(self, journey):
        self.journey = journey
        self.calls = 0

    async def classify(self, *, customer_message, conversation_messages):
        self.calls += 1
        return SupportRouteDecision(journey=self.journey)


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


STATUS = {
    "schemaVersion": "1",
    "reference": "ORDER-123",
    "paymentStatus": "PAID",
    "refundStatus": "NONE",
}


def test_payment_projection_rejects_private_fields_and_unknown_states():
    assert PaymentStatus.model_validate(STATUS).model_dump(by_alias=True) == STATUS
    for bad in (
        {**STATUS, "paymentMethod": "private"},
        {**STATUS, "paymentStatus": "Settled"},
        {**STATUS, "refundStatus": "issued"},
        {**STATUS, "schemaVersion": "2"},
        {
            "schema_version": "1",
            **{k: v for k, v in STATUS.items() if k != "schemaVersion"},
        },
    ):
        with pytest.raises(ValidationError):
            PaymentStatus.model_validate(bad)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payment,refund,expected",
    [
        (
            "PAID",
            "NONE",
            "Order ORDER-123 has a recorded payment. No refund is recorded.",
        ),
        (
            "AUTHORIZED",
            "PENDING",
            "Order ORDER-123 has an authorized payment, but it is not recorded as paid. A refund is pending; it is not recorded as completed.",
        ),
        (
            "PARTIALLY_PAID",
            "PARTIALLY_REFUNDED_WITH_PENDING",
            "Order ORDER-123 has a partially recorded payment. A partial refund is recorded, with another refund pending.",
        ),
        (
            "DECLINED",
            "FAILED",
            "Order ORDER-123 has a declined payment. A refund attempt did not complete; no completed refund is recorded.",
        ),
        (
            "NOT_RECORDED",
            "REFUNDED",
            "Order ORDER-123 has no recorded payment. A refund is recorded as completed.",
        ),
        (
            "UNCERTAIN",
            "UNCERTAIN",
            "I can't confirm the payment or refund status for order ORDER-123 right now. Please contact support.",
        ),
    ],
)
async def test_customer_answer_is_deterministic_and_status_qualified(
    payment, refund, expected
):
    lookup = FakeLookup({**STATUS, "paymentStatus": payment, "refundStatus": refund})
    response = await answer_payment_status(
        request("What is the payment and refund status for ORDER-123?"), lookup
    )
    assert response.model_dump() == {
        "journey": "payment_status",
        "status": "answer_ready",
        "customer_answer": {"message": expected},
    }
    assert lookup.references == ["ORDER-123"]


@pytest.mark.asyncio
async def test_payment_only_question_omits_refund_information():
    response = await answer_payment_status(
        request("Was payment for order ORDER-123 recorded?"),
        FakeLookup({**STATUS, "refundStatus": "PENDING"}),
    )
    assert response.status == "answer_ready"
    assert response.customer_answer.message == "Order ORDER-123 has a recorded payment."


@pytest.mark.asyncio
async def test_refund_only_question_omits_payment_information_and_bank_timing():
    response = await answer_payment_status(
        request("Where is my refund for order ORDER-123?"),
        FakeLookup({**STATUS, "refundStatus": "PENDING"}),
    )
    assert response.status == "answer_ready"
    assert response.customer_answer.message == (
        "Order ORDER-123: A refund is pending; it is not recorded as completed."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "refund_status,aggregate_fact",
    [
        ("PARTIALLY_REFUNDED", "A partial refund is recorded."),
        ("REFUNDED", "A refund is recorded as completed."),
        ("PENDING", "A refund is pending; it is not recorded as completed."),
        (
            "PARTIALLY_REFUNDED_WITH_PENDING",
            "A partial refund is recorded, with another refund pending.",
        ),
    ],
)
async def test_failure_specific_refund_question_does_not_identify_a_completed_attempt(
    refund_status, aggregate_fact
):
    response = await answer_payment_status(
        request("Did my failed refund for ORDER-123 complete?"),
        FakeLookup({**STATUS, "refundStatus": refund_status}),
    )
    assert response.status == "answer_ready"
    assert response.customer_answer.message == (
        f"Order ORDER-123: {aggregate_fact} "
        "This order-level summary cannot confirm the outcome of a particular refund attempt."
    )


@pytest.mark.asyncio
async def test_failed_aggregate_does_not_claim_a_refund_attempt_failed():
    response = await answer_payment_status(
        request("Did my refund for ORDER-123 fail?"),
        FakeLookup({**STATUS, "refundStatus": "FAILED"}),
    )
    assert response.status == "answer_ready"
    assert response.customer_answer.message == (
        "Order ORDER-123: A refund attempt did not complete; "
        "no completed refund is recorded."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message,reference,expected",
    [
        (
            "Where is my refund for order EVAL-PAYMENT-002?",
            "EVAL-PAYMENT-002",
            "Order EVAL-PAYMENT-002: A refund is pending; it is not recorded as completed.",
        ),
        (
            "Where is my refund for order eval-payment-002?",
            "EVAL-PAYMENT-002",
            "Order EVAL-PAYMENT-002: A refund is pending; it is not recorded as completed.",
        ),
        (
            "Was payment for order EVAL-REFUND-002 recorded?",
            "EVAL-REFUND-002",
            "Order EVAL-REFUND-002 has a recorded payment.",
        ),
    ],
)
async def test_reference_words_do_not_change_requested_aspect(
    message, reference, expected
):
    response = await answer_payment_status(
        request(message),
        FakeLookup({**STATUS, "reference": reference, "refundStatus": "PENDING"}),
    )
    assert response.status == "answer_ready"
    assert response.customer_answer.message == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message,expected",
    [
        (
            "Was payment for order ORDER-123 recorded?",
            "I can't confirm the payment status for order ORDER-123 right now. Please contact support.",
        ),
        (
            "Where is my refund for order ORDER-123?",
            "I can't confirm the refund status for order ORDER-123 right now. Please contact support.",
        ),
    ],
)
async def test_single_aspect_uncertainty_fails_closed(message, expected):
    response = await answer_payment_status(
        request(message),
        FakeLookup(
            {**STATUS, "paymentStatus": "UNCERTAIN", "refundStatus": "UNCERTAIN"}
        ),
    )
    assert response.status == "answer_ready"
    assert response.customer_answer.message == expected


@pytest.mark.asyncio
async def test_latest_single_reference_is_used_and_ambiguous_turn_never_looks_up():
    lookup = FakeLookup(STATUS)
    response = await answer_payment_status(
        request(
            "Was my refund recorded?",
            history=[
                "Check ORDER-789.",
                "I mean ORDER-123.",
                "Was my refund recorded?",
            ],
        ),
        lookup,
    )
    assert response.status == "answer_ready"
    assert lookup.references == ["ORDER-123"]

    lookup.references.clear()
    response = await answer_payment_status(
        request("Check payment for ORDER-123 and ORDER-456", reference="ORDER-123"),
        lookup,
    )
    assert response.status == "awaiting_order_reference"
    assert lookup.references == []


@pytest.mark.asyncio
async def test_missing_reference_requests_only_one_reference():
    lookup = FakeLookup(STATUS)
    response = await answer_payment_status(request("Was my refund recorded?"), lookup)
    assert response.model_dump() == {
        "journey": "payment_status",
        "status": "awaiting_order_reference",
        "customer_answer": {
            "message": "Please share one order reference so I can check its payment and refund status."
        },
    }
    assert lookup.references == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result,error,expected",
    [
        (
            None,
            OrderNotFoundError(),
            "We couldn't find an order for that reference. Please check it or contact support.",
        ),
        (
            None,
            OrderLookupUnavailableError(),
            "I couldn't retrieve the payment or refund status right now. Please try again later or contact support.",
        ),
        (
            {**STATUS, "reference": "ORDER-456"},
            None,
            "I couldn't retrieve the payment or refund status right now. Please try again later or contact support.",
        ),
        (
            {**STATUS, "paymentId": "secret"},
            None,
            "I couldn't retrieve the payment or refund status right now. Please try again later or contact support.",
        ),
    ],
)
async def test_missing_foreign_invalid_or_unavailable_fails_closed(
    result, error, expected
):
    response = await answer_payment_status(
        request("Payment status for ORDER-123?"), FakeLookup(result, error)
    )
    assert response.status == "source_unavailable"
    assert response.customer_answer.message == expected
    assert "ORDER-456" not in response.customer_answer.message


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message,model_journey,expected",
    [
        ("Has my payment been recorded for ORDER-123?", "refund", "payment_status"),
        ("Did my payment go through?", "order_status", "payment_status"),
        ("Was my payment declined for ORDER-123?", "payment_status", "payment_status"),
        ("Is my payment authorized for ORDER-123?", "payment_status", "payment_status"),
        (
            "Did you receive my payment for ORDER-123?",
            "payment_status",
            "payment_status",
        ),
        (
            "Have you received my payment for ORDER-123?",
            "payment_status",
            "payment_status",
        ),
        ("Was payment for ORDER-123 received?", "payment_status", "payment_status"),
        ("What is the status of my refund?", "product_policy", "payment_status"),
        ("Was my refund recorded for ORDER-123?", "refund", "payment_status"),
        (
            "Did my failed refund for ORDER-123 complete?",
            "refund",
            "payment_status",
        ),
        (
            "Did my refund for ORDER-123 fail?",
            "refund",
            "payment_status",
        ),
        (
            "Complete my refund for ORDER-123.",
            "payment_status",
            "clarify",
        ),
        (
            "Where is my refund for order EVAL-PAYMENT-002?",
            "order_status",
            "payment_status",
        ),
        (
            "Where is my refund and where is my order ORDER-123?",
            "order_status",
            "clarify",
        ),
        ("Please refund my order ORDER-123.", "payment_status", "refund"),
        ("What is your refund policy?", "payment_status", "product_policy"),
        (
            "Refund order ORDER-123 and tell me if my payment was recorded.",
            "refund",
            "clarify",
        ),
        ("Is order ORDER-123 shipped and paid?", "payment_status", "clarify"),
        (
            "Tell me the items and payment status of order ORDER-123.",
            "payment_status",
            "clarify",
        ),
    ],
)
async def test_current_turn_status_routing_does_not_start_refund(
    message, model_journey, expected
):
    classifier = FakeClassifier(model_journey)
    result = await classify_support_journey(request(message), classifier)
    assert result.journey == expected


def test_read_only_payment_response_cannot_carry_proposal():
    with pytest.raises(ValidationError):
        ReadOnlySupportResponse.model_validate(
            {
                "journey": "payment_status",
                "status": "answer_ready",
                "customer_answer": {"message": "Payment recorded."},
                "refund_proposal": {"proposal_id": "forged"},
            }
        )

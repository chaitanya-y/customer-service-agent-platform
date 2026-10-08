import pytest
from pydantic import ValidationError

from agent_runtime.refund.schemas import RefundIntakeRequest
from agent_runtime.support.schemas import ReadOnlySupportResponse, SupportIntakeRequest


def test_support_intake_request_is_the_bounded_refund_request() -> None:
    assert SupportIntakeRequest is RefundIntakeRequest


def test_read_only_response_requires_an_answer_for_each_valid_journey_status() -> None:
    response = ReadOnlySupportResponse.model_validate(
        {
            "journey": "order_status",
            "status": "awaiting_order_reference",
            "customer_answer": {"message": "Please share your order reference."},
        }
    )

    assert response.customer_answer.message == "Please share your order reference."


def test_read_only_response_rejects_invalid_status_for_its_journey() -> None:
    with pytest.raises(ValidationError):
        ReadOnlySupportResponse.model_validate(
            {
                "journey": "clarify",
                "status": "answer_ready",
                "customer_answer": {"message": "Which request can I help with?"},
            }
        )


def test_read_only_response_rejects_a_refund_proposal() -> None:
    with pytest.raises(ValidationError):
        ReadOnlySupportResponse.model_validate(
            {
                "journey": "product_policy",
                "status": "answer_ready",
                "customer_answer": {"message": "This item is available."},
                "refund_proposal": {"proposal_id": "forged-proposal"},
            }
        )


def test_read_only_response_rejects_internal_answer_fields() -> None:
    with pytest.raises(ValidationError):
        ReadOnlySupportResponse.model_validate(
            {
                "journey": "clarify",
                "status": "clarification_required",
                "customer_answer": {
                    "message": "Which request can I help with?",
                    "source_id": "private-source",
                },
            }
        )

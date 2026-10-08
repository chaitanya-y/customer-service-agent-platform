"""Offline API tests for the authenticated, single-journey support router."""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import jwt
import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from agent_runtime.integrations.customer_evidence import (
    KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
)
from agent_runtime.integrations.order_lookup import CONTEXT_ASSERTION_HEADER
from agent_runtime.integrations.trusted_context import (
    AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
    AgentRuntimeContextAssertionError,
    VerifiedAgentRuntimeContext,
)
from agent_runtime.main import app
from agent_runtime.refund.schemas import RefundIntakeResponse
from agent_runtime.support import router as support_router
from agent_runtime.support.classifier import SupportRouteDecision
from agent_runtime.support.schemas import CustomerAnswer, ReadOnlySupportResponse

client = TestClient(app)

ASSERTIONS = {
    AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: "agent.signed.assertion",
    CONTEXT_ASSERTION_HEADER: "gateway.signed.assertion",
    KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: "knowledge.signed.assertion",
}
TEST_SECRET = "test-context-secret-at-least-thirty-two-bytes"


def test_authenticated_recent_orders_uses_only_owner_scoped_reference_page(monkeypatch):
    from agent_runtime.integrations.recent_orders import McpRecentOrdersClient

    class NoModel:
        async def classify(self, **kwargs):
            raise AssertionError("Explicit recent orders must not use a model")

    async def recent(self):
        return {
            "schemaVersion": "1",
            "orders": [
                {"reference": "ORDER-NEW", "placedAt": "2026-10-02T14:00:00Z"},
            ],
            "hasMore": False,
        }

    async def forbidden(*args, **kwargs):
        raise AssertionError("Must not run a refund or other support journey")

    app.dependency_overrides[support_router.get_support_classifier] = lambda: NoModel()
    monkeypatch.setattr(McpRecentOrdersClient, "lookup_recent_order_references", recent)
    for name in (
        "run_refund_intake",
        "answer_order_status",
        "answer_order_items",
        "answer_payment_status",
        "answer_order_total",
        "answer_product_policy",
    ):
        monkeypatch.setattr(support_router, name, forbidden)
    response = client.post(
        "/support/intake",
        headers=ASSERTIONS,
        json={"customer_message": "What are my recent orders?"},
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"journey", "status", "customer_answer"}
    assert body["journey"] == "recent_orders"
    assert body["status"] == "answer_ready"
    assert "ORDER-NEW" in body["customer_answer"]["message"]
    contract_path = (
        Path(__file__).resolve().parents[4]
        / "contracts/ai-io/support-intake/v1/support-intake-response.schema.json"
    )
    Draft202012Validator(json.loads(contract_path.read_text())).validate(body)


def test_recent_orders_rejects_missing_or_cross_identity():
    body = {"customer_message": "What are my recent orders?"}
    assert client.post("/support/intake", json=body).status_code == 401
    app.dependency_overrides[support_router.get_gateway_context_verifier] = lambda: (
        FakeVerifier(ASSERTIONS[CONTEXT_ASSERTION_HEADER], customer_id="another")
    )
    assert (
        client.post("/support/intake", headers=ASSERTIONS, json=body).status_code == 401
    )


def test_authenticated_order_total_uses_only_dedicated_read_projection(monkeypatch):
    from agent_runtime.integrations.order_lookup import McpOrderLookupClient

    class NoModel:
        async def classify(self, **kwargs):
            raise AssertionError("Explicit order total must not use a model")

    async def total(self, reference):
        assert reference == "ORDER-123"
        return {
            "schemaVersion": "1",
            "reference": reference,
            "total": {"amountMinor": 12345, "currency": "USD"},
        }

    async def forbidden(*args, **kwargs):
        raise AssertionError("Must not enter payment/refund/RAG flows")

    app.dependency_overrides[support_router.get_support_classifier] = lambda: NoModel()
    monkeypatch.setattr(McpOrderLookupClient, "lookup_order_total", total)
    for name in [
        "run_refund_intake",
        "answer_payment_status",
        "answer_product_policy",
        "answer_order_items",
        "answer_order_status",
    ]:
        monkeypatch.setattr(support_router, name, forbidden)
    response = client.post(
        "/support/intake",
        headers=ASSERTIONS,
        json={"customer_message": "What is the order total for ORDER-123?"},
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"journey", "status", "customer_answer"}
    assert body["journey"] == "order_total"
    assert body["status"] == "answer_ready"
    assert "USD 123.45" in body["customer_answer"]["message"]


def test_order_total_never_bypasses_missing_or_conflicting_identity():
    body = {"customer_message": "What is the order total for ORDER-123?"}
    assert client.post("/support/intake", json=body).status_code == 401
    app.dependency_overrides[support_router.get_gateway_context_verifier] = lambda: (
        FakeVerifier(ASSERTIONS[CONTEXT_ASSERTION_HEADER], customer_id="another")
    )
    assert (
        client.post("/support/intake", headers=ASSERTIONS, json=body).status_code == 401
    )


@pytest.mark.parametrize("reference", [None, "EJ4P5T4W2BKUH56Y"])
def test_cancellation_intake_never_runs_refund_or_read_only_dependencies(
    monkeypatch, reference
):
    class NoCalls:
        async def classify(self, **_kwargs):
            raise AssertionError("Cancellation needs no model")

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("Cancellation must not run commerce/refund dependencies")

    app.dependency_overrides[support_router.get_support_classifier] = lambda: NoCalls()
    for name in (
        "run_refund_intake",
        "answer_order_status",
        "answer_order_items",
        "answer_payment_status",
        "answer_product_policy",
    ):
        monkeypatch.setattr(support_router, name, forbidden)
    text = "Please cancel my order"
    body = {"customer_message": text}
    if reference:
        body["order_reference"] = reference
    response = client.post("/support/intake", headers=ASSERTIONS, json=body)
    assert response.status_code == 200
    value = response.json()
    assert value["journey"] == "cancellation"
    assert value["status"] == (
        "cancellation_request_ready" if reference else "awaiting_order_reference"
    )
    assert set(value) == (
        {"journey", "status", "customer_answer", "order_reference"}
        if reference
        else {"journey", "status", "customer_answer"}
    )
    if reference:
        assert value["order_reference"] == reference
        assert "before anything changes" in value["customer_answer"]["message"]
    else:
        assert "one order reference" in value["customer_answer"]["message"]


def test_deterministic_cancellation_does_not_bypass_authenticated_context():
    response = client.post(
        "/support/intake", json={"customer_message": "Cancel order EJ4P5T4W2BKUH56Y"}
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "context_unauthorized"


class FakeVerifier:
    def __init__(self, expected: str, *, customer_id: str = "customer-42") -> None:
        self.expected = expected
        self.customer_id = customer_id

    def verify(self, assertion: str | None) -> VerifiedAgentRuntimeContext:
        if assertion != self.expected:
            raise AgentRuntimeContextAssertionError()
        return VerifiedAgentRuntimeContext(
            context_id="context-1",
            tenant_id="tenant-local",
            environment_id="local",
            subject_customer_id=self.customer_id,
            request_id="request-1",
            trace_id="trace-1",
            channel_id="web",
            home_region="local",
            home_cell="local-cell-1",
            routing_epoch=1,
        )


@dataclass
class FakeClassifier:
    decision: SupportRouteDecision
    calls: int = 0

    async def classify(self, *, customer_message, conversation_messages):
        self.calls += 1
        return self.decision


@pytest.fixture(autouse=True)
def signed_context_overrides():
    app.dependency_overrides[support_router.get_agent_runtime_context_verifier] = (
        lambda: FakeVerifier(ASSERTIONS[AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER])
    )
    app.dependency_overrides[support_router.get_gateway_context_verifier] = lambda: (
        FakeVerifier(ASSERTIONS[CONTEXT_ASSERTION_HEADER])
    )
    app.dependency_overrides[support_router.get_knowledge_context_verifier] = lambda: (
        FakeVerifier(ASSERTIONS[KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER])
    )
    yield
    app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "bad_header",
    [
        AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
        CONTEXT_ASSERTION_HEADER,
        KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
    ],
)
@pytest.mark.parametrize("bad_value", [None, "tampered.assertion"])
def test_support_rejects_bad_assertions_before_classification_or_tools(
    monkeypatch, bad_header: str, bad_value: str | None
) -> None:
    classifier = FakeClassifier(SupportRouteDecision(journey="order_status"))
    app.dependency_overrides[support_router.get_support_classifier] = lambda: classifier
    calls: list[str] = []

    async def fake_status(*_args):
        calls.append("status")
        raise AssertionError("status tool must not run")

    monkeypatch.setattr(support_router, "answer_order_status", fake_status)
    headers = dict(ASSERTIONS)
    if bad_value is None:
        del headers[bad_header]
    else:
        headers[bad_header] = bad_value

    response = client.post(
        "/support/intake",
        headers=headers,
        json={"customer_message": "Where is order ORDER-123?"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "context_unauthorized"
    assert classifier.calls == 0
    assert calls == []


def test_support_rejects_assertions_from_different_customer_contexts() -> None:
    app.dependency_overrides[support_router.get_gateway_context_verifier] = lambda: (
        FakeVerifier(ASSERTIONS[CONTEXT_ASSERTION_HEADER], customer_id="other")
    )
    classifier = FakeClassifier(SupportRouteDecision(journey="order_status"))
    app.dependency_overrides[support_router.get_support_classifier] = lambda: classifier

    response = client.post(
        "/support/intake",
        headers=ASSERTIONS,
        json={"customer_message": "Where is order ORDER-123?"},
    )

    assert response.status_code == 401
    assert classifier.calls == 0


def _signed_assertion(
    audience: str,
    context_id: str,
    *,
    channel_id: str = "web",
    home_region: str = "local",
    home_cell: str = "local-cell-1",
) -> str:
    issued_at = int(datetime.now(UTC).timestamp())
    return jwt.encode(
        {
            "contextVersion": "1",
            "contextId": context_id,
            "tenant": {"tenantId": "tenant-local", "environmentId": "local"},
            "actor": {"kind": "end_customer", "principalId": "customer-42"},
            "subject": {"customerId": "customer-42"},
            "delegation": {"mode": "self"},
            "purpose": "customer_support",
            "route": {
                "homeRegion": home_region,
                "homeCell": home_cell,
                "routingEpoch": 1,
            },
            "request": {
                "requestId": "request-1",
                "traceId": "trace-1",
                "channelId": channel_id,
            },
            "iss": "customer-service-os-edge",
            "aud": audience,
            "iat": issued_at,
            "exp": issued_at + 60,
        },
        TEST_SECRET,
        algorithm="HS256",
        headers={"typ": "cso-context+jwt"},
    )


def test_support_accepts_configured_signed_audience_assertions(monkeypatch) -> None:
    app.dependency_overrides.clear()
    monkeypatch.setenv("CONTEXT_ASSERTION_HMAC_SECRET", TEST_SECRET)
    monkeypatch.setenv("CONTEXT_ASSERTION_ISSUER", "customer-service-os-edge")
    monkeypatch.setenv("TENANT_ID", "tenant-local")
    monkeypatch.setenv("ENVIRONMENT_ID", "local")
    monkeypatch.setenv("CONTEXT_ASSERTION_AUDIENCE", "gateway-test-audience")
    monkeypatch.setenv("KNOWLEDGE_RAG_CONTEXT_ASSERTION_AUDIENCE", "rag-test-audience")
    classifier = FakeClassifier(SupportRouteDecision(journey="order_status"))
    app.dependency_overrides[support_router.get_support_classifier] = lambda: classifier

    async def fake_status(_request, _order_lookup):
        return ReadOnlySupportResponse(
            journey="order_status",
            status="answer_ready",
            customer_answer=CustomerAnswer(message="Order ORDER-123 is shipped."),
        )

    monkeypatch.setattr(support_router, "answer_order_status", fake_status)
    response = client.post(
        "/support/intake",
        headers={
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: _signed_assertion(
                "agent-runtime", "agent-context"
            ),
            CONTEXT_ASSERTION_HEADER: _signed_assertion(
                "gateway-test-audience", "gateway-context"
            ),
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: _signed_assertion(
                "rag-test-audience", "knowledge-context"
            ),
        },
        json={"customer_message": "Where is order ORDER-123?"},
    )

    assert response.status_code == 200
    assert response.json()["journey"] == "order_status"
    assert classifier.calls == 1


@pytest.mark.parametrize(
    ("different_field", "different_value"),
    [
        ("channel_id", "mobile"),
        ("home_region", "another-region"),
        ("home_cell", "another-cell"),
    ],
)
def test_support_rejects_signed_scope_mismatch_before_classification(
    monkeypatch, different_field: str, different_value: str
) -> None:
    app.dependency_overrides.clear()
    monkeypatch.setenv("CONTEXT_ASSERTION_HMAC_SECRET", TEST_SECRET)
    monkeypatch.setenv("CONTEXT_ASSERTION_ISSUER", "customer-service-os-edge")
    monkeypatch.setenv("TENANT_ID", "tenant-local")
    monkeypatch.setenv("ENVIRONMENT_ID", "local")
    classifier = FakeClassifier(SupportRouteDecision(journey="order_status"))
    app.dependency_overrides[support_router.get_support_classifier] = lambda: classifier

    response = client.post(
        "/support/intake",
        headers={
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: _signed_assertion(
                "agent-runtime", "agent-context"
            ),
            CONTEXT_ASSERTION_HEADER: _signed_assertion(
                "integration-gateway",
                "gateway-context",
                **{different_field: different_value},
            ),
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: _signed_assertion(
                "knowledge-rag", "knowledge-context"
            ),
        },
        json={"customer_message": "Where is order ORDER-123?"},
    )

    assert response.status_code == 401
    assert classifier.calls == 0


@pytest.mark.parametrize(
    ("message", "history", "decision", "expected_journey", "expected_calls"),
    [
        (
            "Where is order ORDER-123 now?",
            ["I want a refund for order ORDER-123.", "Where is order ORDER-123 now?"],
            SupportRouteDecision(journey="order_status"),
            "order_status",
            ["status"],
        ),
        (
            "Tell me about Cloud Hoodie.",
            [],
            SupportRouteDecision(
                journey="product_policy", product_query="Cloud Hoodie"
            ),
            "product_policy",
            ["product:Cloud Hoodie"],
        ),
        (
            "Please start a refund for order ORDER-123.",
            [],
            SupportRouteDecision(journey="refund"),
            "refund",
            ["refund"],
        ),
        (
            "Refund order ORDER-123 and tell me where it is.",
            [],
            SupportRouteDecision(journey="refund"),
            "clarify",
            [],
        ),
    ],
)
def test_support_dispatch_is_tool_bounded(
    monkeypatch,
    message: str,
    history: list[str],
    decision: SupportRouteDecision,
    expected_journey: str,
    expected_calls: list[str],
) -> None:
    classifier = FakeClassifier(decision)
    app.dependency_overrides[support_router.get_support_classifier] = lambda: classifier
    calls: list[str] = []

    async def fake_status(_request, _order_lookup):
        calls.append("status")
        return ReadOnlySupportResponse(
            journey="order_status",
            status="answer_ready",
            customer_answer=CustomerAnswer(message="Order ORDER-123 is shipped."),
        )

    async def fake_product(_request, _evidence, _catalog, _model, *, product_query):
        calls.append(f"product:{product_query}")
        return ReadOnlySupportResponse(
            journey="product_policy",
            status="answer_ready",
            customer_answer=CustomerAnswer(message="Cloud Hoodie is listed."),
        )

    async def fake_refund(*_args, **_kwargs):
        calls.append("refund")
        return RefundIntakeResponse(
            customer_message=message,
            order_reference=None,
            journey="refund",
            status="awaiting_order_reference",
        )

    monkeypatch.setattr(support_router, "answer_order_status", fake_status)
    monkeypatch.setattr(support_router, "answer_product_policy", fake_product)
    monkeypatch.setattr(support_router, "run_refund_intake", fake_refund)
    payload: dict[str, object] = {"customer_message": message}
    if history:
        payload["conversation_messages"] = [
            {"sequence_number": number, "text": text}
            for number, text in enumerate(history, start=1)
        ]

    response = client.post("/support/intake", headers=ASSERTIONS, json=payload)

    assert response.status_code == 200
    assert response.json()["journey"] == expected_journey
    assert calls == expected_calls
    if expected_journey == "clarify":
        assert response.json()["status"] == "clarification_required"
    if expected_journey != "refund":
        assert "refund_proposal" not in response.json()


def test_support_refund_without_reference_matches_v1_contract(monkeypatch) -> None:
    app.dependency_overrides[support_router.get_support_classifier] = lambda: (
        FakeClassifier(SupportRouteDecision(journey="refund"))
    )

    async def fake_refund(*_args, **_kwargs):
        return RefundIntakeResponse(
            customer_message="I want a refund.",
            order_reference=None,
            journey="refund",
            status="awaiting_order_reference",
        )

    monkeypatch.setattr(support_router, "run_refund_intake", fake_refund)
    response = client.post(
        "/support/intake",
        headers=ASSERTIONS,
        json={"customer_message": "I want a refund."},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["order_reference"] is None
    contract_path = (
        Path(__file__).resolve().parents[4]
        / "contracts/ai-io/support-intake/v1/support-intake-response.schema.json"
    )
    Draft202012Validator(json.loads(contract_path.read_text())).validate(body)


def test_support_dispatches_items_without_refund_workflow(monkeypatch) -> None:
    app.dependency_overrides[support_router.get_support_classifier] = lambda: (
        FakeClassifier(SupportRouteDecision(journey="order_items"))
    )
    calls: list[str] = []

    async def fake_items(_request, _order_lookup):
        calls.append("items")
        return ReadOnlySupportResponse(
            journey="order_items",
            status="answer_ready",
            customer_answer=CustomerAnswer(
                message="Order ORDER-123 contains: 1 × Laptop."
            ),
        )

    async def fake_refund(*_args, **_kwargs):
        calls.append("refund")
        raise AssertionError("refund workflow must not run")

    monkeypatch.setattr(support_router, "answer_order_items", fake_items, raising=False)
    monkeypatch.setattr(support_router, "run_refund_intake", fake_refund)
    response = client.post(
        "/support/intake",
        headers=ASSERTIONS,
        json={"customer_message": "What items are in order ORDER-123?"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "journey": "order_items",
        "status": "answer_ready",
        "customer_answer": {"message": "Order ORDER-123 contains: 1 × Laptop."},
    }
    assert calls == ["items"]


def test_support_dispatches_payment_status_without_refund_workflow(monkeypatch) -> None:
    app.dependency_overrides[support_router.get_support_classifier] = lambda: (
        FakeClassifier(SupportRouteDecision(journey="refund"))
    )
    calls: list[str] = []

    async def fake_payment(_request, _order_lookup):
        calls.append("payment")
        return ReadOnlySupportResponse(
            journey="payment_status",
            status="answer_ready",
            customer_answer=CustomerAnswer(
                message="Order ORDER-123 has a recorded payment. No refund is recorded."
            ),
        )

    async def fake_refund(*_args, **_kwargs):
        calls.append("refund")
        raise AssertionError("refund workflow must not run")

    monkeypatch.setattr(support_router, "answer_payment_status", fake_payment)
    monkeypatch.setattr(support_router, "run_refund_intake", fake_refund)
    response = client.post(
        "/support/intake",
        headers=ASSERTIONS,
        json={"customer_message": "Has my payment been recorded for ORDER-123?"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "journey": "payment_status",
        "status": "answer_ready",
        "customer_answer": {
            "message": "Order ORDER-123 has a recorded payment. No refund is recorded."
        },
    }
    assert calls == ["payment"]


def test_support_rejects_ready_refund_without_proposal(monkeypatch) -> None:
    app.dependency_overrides[support_router.get_support_classifier] = lambda: (
        FakeClassifier(SupportRouteDecision(journey="refund"))
    )

    async def fake_refund(*_args, **_kwargs):
        return RefundIntakeResponse(
            customer_message="I want a refund.",
            order_reference="ORDER-123",
            journey="refund",
            status="refund_proposal_ready",
            refund_proposal=None,
        )

    monkeypatch.setattr(support_router, "run_refund_intake", fake_refund)
    response = client.post(
        "/support/intake",
        headers=ASSERTIONS,
        json={"customer_message": "I want a refund."},
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "invalid_refund_result"

"""Offline HTTP coverage for deterministic named-variant availability routing."""

import pytest
from fastapi.testclient import TestClient

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
from agent_runtime.support import router as support_router


class FakeVerifier:
    def __init__(self, expected: str) -> None:
        self.expected = expected

    def verify(self, assertion: str | None) -> VerifiedAgentRuntimeContext:
        if assertion != self.expected:
            raise AgentRuntimeContextAssertionError()
        return VerifiedAgentRuntimeContext(
            context_id="context-1",
            tenant_id="tenant-local",
            environment_id="local",
            subject_customer_id="customer-42",
            request_id="request-1",
            trace_id="trace-1",
            channel_id="web",
            home_region="local",
            home_cell="local-cell-1",
            routing_epoch=1,
        )


@pytest.mark.parametrize(
    ("variant", "availability", "other_availability"),
    [
        ("Blue / Small", "IN_STOCK", "OUT_OF_STOCK"),
        ("Red / Large", "OUT_OF_STOCK", "IN_STOCK"),
    ],
)
def test_named_variant_stock_uses_its_own_catalog_fact_without_model_or_refund(
    monkeypatch, variant: str, availability: str, other_availability: str
) -> None:
    assertions = {
        AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: "agent.signed.assertion",
        CONTEXT_ASSERTION_HEADER: "gateway.signed.assertion",
        KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: "knowledge.signed.assertion",
    }
    for dependency, header in (
        (
            support_router.get_agent_runtime_context_verifier,
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
        ),
        (support_router.get_gateway_context_verifier, CONTEXT_ASSERTION_HEADER),
        (
            support_router.get_knowledge_context_verifier,
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
        ),
    ):
        app.dependency_overrides[dependency] = lambda value=assertions[header]: (
            FakeVerifier(value)
        )

    class ForbiddenModel:
        async def classify(self, **_kwargs):
            raise AssertionError("A named stock question needs no model classification")

        async def select_answer_facts(self, **_kwargs):
            raise AssertionError("A stock answer needs no answer model")

    app.dependency_overrides[support_router.get_support_classifier] = ForbiddenModel
    app.dependency_overrides[support_router.get_support_answer_model] = ForbiddenModel

    calls: list[tuple[str | None, str]] = []

    class FakeCatalog:
        def __init__(self, *, context_assertion: str | None):
            self.context_assertion = context_assertion

        async def lookup_product_catalog(self, query: str):
            calls.append((self.context_assertion, query))
            return {
                "schemaVersion": 1,
                "matches": [
                    {
                        "name": "Cloud Hoodie",
                        "description": "A cotton hoodie.",
                        "availability": other_availability,
                        "variants": [
                            {"name": variant, "availability": availability},
                            {
                                "name": "Green / Medium",
                                "availability": other_availability,
                            },
                        ],
                    }
                ],
            }

    class ForbiddenEvidence:
        def __init__(self, **_kwargs):
            pass

        async def retrieve_customer_evidence(self, _question):
            raise AssertionError("A stock answer must not call Knowledge RAG")

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("Stock routing must not invoke another journey")

    monkeypatch.setattr(support_router, "McpProductCatalogClient", FakeCatalog)
    monkeypatch.setattr(
        support_router, "KnowledgeRagCustomerEvidenceClient", ForbiddenEvidence
    )
    for name in (
        "answer_order_status",
        "answer_order_items",
        "answer_payment_status",
        "run_refund_intake",
    ):
        monkeypatch.setattr(support_router, name, forbidden)
    question = f"Is Cloud Hoodie {variant} in stock?"
    try:
        response = TestClient(app).post(
            "/support/intake", headers=assertions, json={"customer_message": question}
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["journey"] == "product_policy"
    assert body["status"] == "answer_ready"
    assert (
        f"{variant} as {'in stock' if availability == 'IN_STOCK' else 'out of stock'}"
        in body["customer_answer"]["message"]
    )
    assert "Availability can change" in body["customer_answer"]["message"]
    assert "reserve" in body["customer_answer"]["message"]
    assert "refund_proposal" not in body
    assert calls == [(assertions[CONTEXT_ASSERTION_HEADER], f"Cloud Hoodie {variant}")]

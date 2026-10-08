"""Offline read-only specialist evaluation with synthetic dependency responses.

This executes production specialist functions, not the Edge/Gateway auth boundary.
The fakes never open network connections, call a paid model, or mutate commerce data.
"""

from __future__ import annotations

from typing import Any

from agent_runtime.integrations.customer_evidence import CustomerEvidenceResponse
from agent_runtime.integrations.order_lookup import (
    OrderLookupUnavailableError,
    OrderNotFoundError,
    OrderStatus,
)
from agent_runtime.integrations.product_catalog import ProductCatalogResult
from agent_runtime.integrations.recent_orders import RecentOrdersUnavailableError
from agent_runtime.support.order_items import answer_order_items
from agent_runtime.support.order_status import answer_order_status
from agent_runtime.support.order_total import answer_order_total
from agent_runtime.support.payment_status import answer_payment_status
from agent_runtime.support.product_policy import answer_product_policy
from agent_runtime.support.recent_orders import answer_recent_orders
from agent_runtime.support.schemas import SupportIntakeRequest

from evaluation_runner.models import (
    EvaluationCase,
    EvaluationSample,
    TraceEvent,
    TraceEventKind,
)


class _Trace:
    def __init__(self) -> None:
        self.events: list[TraceEvent] = []

    def tool(self, name: str, arguments: dict[str, Any]) -> None:
        self.events.append(
            TraceEvent(
                sequence=len(self.events) + 1,
                kind=TraceEventKind.TOOL_CALL,
                name=name,
                payload={"arguments": arguments},
            )
        )


class _OrderStatusLookup:
    def __init__(self, config: dict[str, Any], trace: _Trace) -> None:
        self.config = config
        self.trace = trace

    async def lookup_order_status(self, order_reference: str) -> OrderStatus:
        self.trace.tool("lookup_order_status", {"order_reference": order_reference})
        outcome = self.config.get("outcome")
        if outcome in {"not_found", "not_owned"}:
            # At the specialist boundary both outcomes must be indistinguishable.
            raise OrderNotFoundError()
        if outcome == "unavailable":
            raise OrderLookupUnavailableError()
        if outcome != "found":
            raise ValueError("Synthetic order lookup outcome is not configured")
        return OrderStatus.model_validate(self.config.get("result"))


class _OrderItemsLookup:
    def __init__(self, config: dict[str, Any], trace: _Trace) -> None:
        self.config = config
        self.trace = trace

    async def lookup_order_items(self, order_reference: str) -> Any:
        self.trace.tool("lookup_order_items", {"order_reference": order_reference})
        outcome = self.config.get("outcome")
        if outcome in {"not_found", "not_owned"}:
            # The customer-safe specialist masks both outcomes identically.
            raise OrderNotFoundError()
        if outcome == "unavailable":
            raise OrderLookupUnavailableError()
        if outcome != "found":
            raise ValueError("Synthetic order lookup outcome is not configured")
        # Return the raw synthetic projection so the production specialist's
        # strict OrderItems validation also covers malformed/private extra keys.
        return self.config.get("result")


class _OrderTotalLookup:
    def __init__(self, config: dict[str, Any], trace: _Trace) -> None:
        self.config = config
        self.trace = trace

    async def lookup_order_total(self, order_reference: str) -> Any:
        from agent_runtime.integrations.order_lookup import (
            OrderLookupUnavailableError,
            OrderNotFoundError,
        )

        self.trace.tool("lookup_order_total", {"order_reference": order_reference})
        outcome = self.config.get("outcome")
        if outcome in {"not_found", "not_owned"}:
            raise OrderNotFoundError()
        if outcome == "unavailable":
            raise OrderLookupUnavailableError()
        if outcome != "found":
            raise ValueError("Synthetic order-total lookup outcome is not configured")
        # Keep the raw source so the production specialist applies strict v1 validation.
        return self.config.get("result")


class _RecentOrdersLookup:
    def __init__(self, config: dict[str, Any], trace: _Trace) -> None:
        self.config = config
        self.trace = trace

    async def lookup_recent_order_references(self) -> Any:
        self.trace.tool("lookup_recent_order_references", {})
        outcome = self.config.get("outcome")
        if outcome == "unavailable":
            raise RecentOrdersUnavailableError()
        if outcome != "found":
            raise ValueError("Synthetic recent-order outcome is not configured")
        # Return raw data so the production specialist validates the complete page.
        return self.config.get("result")


class _NoModelClassifier:
    async def classify(self, **kwargs: Any) -> Any:
        raise AssertionError("Mixed-intent clarification must remain deterministic")


class _PaymentStatusLookup:
    def __init__(self, config: dict[str, Any], trace: _Trace) -> None:
        self.config = config
        self.trace = trace

    async def lookup_payment_status(self, order_reference: str) -> Any:
        self.trace.tool("lookup_payment_status", {"order_reference": order_reference})
        outcome = self.config.get("outcome")
        if outcome in {"not_found", "not_owned"}:
            raise OrderNotFoundError()
        if outcome == "unavailable":
            raise OrderLookupUnavailableError()
        if outcome != "found":
            raise ValueError("Synthetic payment lookup outcome is not configured")
        # Keep the raw projection so the production specialist rejects unknown
        # states and extra private fields with its strict schema.
        return self.config.get("result")


class _CatalogLookup:
    def __init__(self, result: dict[str, Any], trace: _Trace) -> None:
        self.result = result
        self.trace = trace

    async def lookup_product_catalog(self, query: str) -> ProductCatalogResult:
        self.trace.tool("lookup_product_catalog", {"query": query})
        return ProductCatalogResult.model_validate(self.result)


class _EvidenceLookup:
    def __init__(self, evidence: list[Any], trace: _Trace) -> None:
        self.evidence = evidence
        self.trace = trace

    async def retrieve_customer_evidence(
        self, query_text: str
    ) -> CustomerEvidenceResponse:
        self.trace.tool("retrieve_customer_evidence", {"query_text": query_text})
        return CustomerEvidenceResponse.model_validate(
            {"knowledge_release_id": "synthetic-release-v1", "evidence": self.evidence}
        )


class _FactSelector:
    def __init__(self, selection: dict[str, Any]) -> None:
        self.selection = selection

    async def select_answer_facts(
        self,
        *,
        question: str,
        evidence: list[dict[str, object]],
        product: dict[str, object] | None,
    ) -> object:
        # Deterministic stand-in for a structured model selection, never an API call.
        return self.selection


class ReadOnlySupportEvaluatedSystem:
    """Exercise the real read-only specialists against reviewed synthetic fixtures."""

    async def run(self, case: EvaluationCase, *, repetition: int) -> EvaluationSample:
        if repetition < 1:
            raise ValueError("repetition must be positive")
        data = case.input
        journey = data.get("journey")
        if journey not in {
            "recent_orders",
            "order_status",
            "order_items",
            "order_total",
            "payment_status",
            "product_policy",
            "clarify",
        }:
            raise ValueError("Synthetic case must select a read-only journey")
        request = SupportIntakeRequest(
            customer_message=data.get("customer_message"),
            order_reference=data.get("order_reference"),
        )
        trace = _Trace()
        if journey == "recent_orders":
            response = await answer_recent_orders(
                _RecentOrdersLookup(_object(data.get("recent_orders_lookup")), trace)
            )
        elif journey == "order_status":
            response = await answer_order_status(
                request,
                _OrderStatusLookup(_object(data.get("order_lookup")), trace),
            )
        elif journey == "order_items":
            response = await answer_order_items(
                request,
                _OrderItemsLookup(_object(data.get("order_lookup")), trace),
            )
        elif journey == "payment_status":
            response = await answer_payment_status(
                request,
                _PaymentStatusLookup(_object(data.get("order_lookup")), trace),
            )
        elif journey == "order_total":
            response = await answer_order_total(
                request,
                _OrderTotalLookup(_object(data.get("order_lookup")), trace),
            )
        elif journey == "clarify":
            from agent_runtime.support.classifier import classify_support_journey
            from agent_runtime.support.router import _clarification

            decision = await classify_support_journey(request, _NoModelClassifier())
            if decision.journey != "clarify":
                raise ValueError("Synthetic mixed-intent case did not clarify")
            response = _clarification()
        else:
            response = await answer_product_policy(
                request,
                _EvidenceLookup(_list(data.get("evidence")), trace),
                _CatalogLookup(
                    _object(data.get("catalog_result"))
                    or {"schemaVersion": 1, "matches": []},
                    trace,
                ),
                _FactSelector(_object(data.get("selection"))),
                product_query=data.get("product_query"),
            )
        return EvaluationSample(
            output={
                "journey": response.journey,
                "status": response.status,
                "customer_answer": response.customer_answer.message,
            },
            final_state={"journey": response.journey, "status": response.status},
            trace=trace.events,
            latency_ms=0,
            versions={
                "adapter": "read-only-support-v1",
                "system": "agent-runtime-support",
            },
        )


def _object(value: object) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise TypeError("Synthetic dependency configuration must be an object")
    return value


def _list(value: object) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError("Synthetic evidence must be a list")
    return value

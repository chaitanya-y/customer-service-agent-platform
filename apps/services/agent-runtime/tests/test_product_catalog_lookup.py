from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Self

import pytest
from mcp.types import CallToolResult, TextContent

import agent_runtime.integrations.product_catalog as catalog_module
from agent_runtime.integrations.product_catalog import (
    CatalogLookupUnauthorizedError,
    CatalogLookupUnavailableError,
    InvalidProductCatalogError,
    McpProductCatalogClient,
    ProductCatalogResult,
)


def _result(payload: dict[str, object], *, error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text="catalog response")],
        structuredContent=payload,
        isError=error,
    )


def _stub_mcp(monkeypatch: pytest.MonkeyPatch, result: CallToolResult) -> list[object]:
    events: list[object] = []

    @asynccontextmanager
    async def fake_stream(
        url: str, *, http_client: Any
    ) -> AsyncIterator[tuple[object, object, object]]:
        events.append((url, http_client.headers["x-cso-context-assertion"]))
        yield object(), object(), object()

    class FakeSession:
        def __init__(self, _read: object, _write: object) -> None:
            pass

        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def initialize(self) -> None:
            pass

        async def call_tool(
            self, name: str, arguments: dict[str, object]
        ) -> CallToolResult:
            events.append((name, arguments))
            return result

    monkeypatch.setattr(catalog_module, "streamable_http_client", fake_stream)
    monkeypatch.setattr(catalog_module, "ClientSession", FakeSession)
    return events


@pytest.mark.asyncio
async def test_catalog_uses_signed_gateway_context_and_canonical_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _stub_mcp(
        monkeypatch,
        _result(
            {
                "schemaVersion": 1,
                "matches": [
                    {
                        "name": "Cloud Hoodie",
                        "description": "Soft cotton.",
                        "variants": [
                            {
                                "name": "Blue",
                                "price": {"amountMinor": 4900, "currency": "USD"},
                            }
                        ],
                    }
                ],
            }
        ),
    )
    client = McpProductCatalogClient(context_assertion="signed-context")

    catalog = await client.lookup_product_catalog("  Cloud Hoodie  ")

    assert catalog.matches[0].variants[0].price.amount_minor == 4900
    assert catalog.matches[0].availability is None
    assert events == [
        ("http://127.0.0.1:3002/mcp", "signed-context"),
        ("lookup_product_catalog", {"query": "Cloud Hoodie"}),
    ]


def test_variant_availability_contract_accepts_only_bounded_stock_state() -> None:
    source = {
        "schemaVersion": 1,
        "matches": [
            {
                "name": "Cloud Hoodie",
                "description": "Soft cotton.",
                "variants": [{"name": "Blue", "availability": "IN_STOCK"}],
            }
        ],
    }
    assert (
        ProductCatalogResult.model_validate(source).matches[0].variants[0].availability
        == "IN_STOCK"
    )
    source["matches"][0]["variants"][0]["availability"] = "LOW_STOCK"
    with pytest.raises(ValueError):
        ProductCatalogResult.model_validate(source)


@pytest.mark.asyncio
async def test_catalog_rejects_private_or_oversized_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_mcp(
        monkeypatch,
        _result(
            {
                "schemaVersion": 1,
                "matches": [
                    {
                        "name": "Cloud Hoodie",
                        "description": "Soft.",
                        "variants": [],
                        "internalId": "private-1",
                    }
                ],
            }
        ),
    )
    with pytest.raises(InvalidProductCatalogError):
        await McpProductCatalogClient(
            context_assertion="signed-context"
        ).lookup_product_catalog("hoodie")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code,error_type",
    [
        ("context_unauthorized", CatalogLookupUnauthorizedError),
        ("catalog_unavailable", CatalogLookupUnavailableError),
    ],
)
async def test_catalog_maps_gateway_errors(
    monkeypatch: pytest.MonkeyPatch, code: str, error_type: type[Exception]
) -> None:
    _stub_mcp(
        monkeypatch,
        _result({"error": {"code": code, "message": "private detail"}}, error=True),
    )
    with pytest.raises(error_type) as captured:
        await McpProductCatalogClient(
            context_assertion="signed-context"
        ).lookup_product_catalog("hoodie")
    assert "private detail" not in str(captured.value)


def test_catalog_rejects_missing_assertion() -> None:
    with pytest.raises(ValueError, match="context_assertion"):
        McpProductCatalogClient(context_assertion=" ")

"""MCP client passes the signed gateway assertion and never accepts extra data."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Self

import pytest
from mcp.types import CallToolResult, TextContent

import agent_runtime.integrations.recent_orders as recent_module
from agent_runtime.integrations.recent_orders import (
    McpRecentOrdersClient,
    RecentOrdersUnavailableError,
)


def _stub_mcp(monkeypatch, result: CallToolResult):
    events = []

    @asynccontextmanager
    async def fake_stream(url: str, *, http_client: Any) -> AsyncIterator[tuple]:
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

        async def call_tool(self, name: str, arguments: dict) -> CallToolResult:
            events.append((name, arguments))
            return result

    monkeypatch.setattr(recent_module, "streamable_http_client", fake_stream)
    monkeypatch.setattr(recent_module, "ClientSession", FakeSession)
    return events


def _result(payload, *, error=False):
    return CallToolResult(
        content=[TextContent(type="text", text="recent orders")],
        structuredContent=payload,
        isError=error,
    )


@pytest.mark.asyncio
async def test_client_uses_exact_tool_and_empty_args_with_signed_context(monkeypatch):
    events = _stub_mcp(
        monkeypatch,
        _result({"schemaVersion": "1", "orders": [], "hasMore": False}),
    )
    result = await McpRecentOrdersClient(
        context_assertion="signed-gateway-context"
    ).lookup_recent_order_references()
    assert result.orders == []
    assert events == [
        ("http://127.0.0.1:3002/mcp", "signed-gateway-context"),
        ("lookup_recent_order_references", {}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result",
    [
        _result(
            {"error": {"code": "context_unauthorized", "message": "secret"}}, error=True
        ),
        _result({"schemaVersion": "1", "orders": [], "hasMore": "false"}),
        _result(None),
    ],
)
async def test_client_masks_error_and_invalid_data(monkeypatch, result):
    _stub_mcp(monkeypatch, result)
    with pytest.raises(RecentOrdersUnavailableError) as captured:
        await McpRecentOrdersClient(
            context_assertion="signed-gateway-context"
        ).lookup_recent_order_references()
    assert "secret" not in str(captured.value)


def test_client_rejects_missing_assertion():
    with pytest.raises(ValueError, match="context_assertion"):
        McpRecentOrdersClient(context_assertion=" ")

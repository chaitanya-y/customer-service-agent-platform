import asyncio
import json

import httpx
import pytest

from agent_runtime.integrations.order_lookup import (
    McpOrderLookupClient,
    OrderLookupUnavailableError,
)
from agent_runtime.integrations.product_catalog import (
    CatalogLookupUnavailableError,
    McpProductCatalogClient,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("stall_stage", ["initialize", "call_tool"])
@pytest.mark.parametrize(
    "method",
    [
        "lookup_order",
        "lookup_order_status",
        "lookup_order_items",
        "lookup_order_total",
        "lookup_payment_status",
        "lookup_product_catalog",
    ],
)
async def test_mcp_operation_deadline_rejects_accepted_without_response(
    monkeypatch: pytest.MonkeyPatch, method: str, stall_stage: str
) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.method != "POST":
            return httpx.Response(405)
        message = json.loads(request.content)
        if message["method"] == "initialize" and stall_stage == "call_tool":
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "result": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "serverInfo": {"name": "test", "version": "1"},
                    },
                },
            )
        return httpx.Response(202)

    original_client = httpx.AsyncClient

    def client_with_transport(**kwargs: object) -> httpx.AsyncClient:
        return original_client(**kwargs, transport=httpx.MockTransport(handle))

    monkeypatch.setattr(httpx, "AsyncClient", client_with_transport)
    if method == "lookup_product_catalog":
        client = McpProductCatalogClient(
            context_assertion="synthetic.assertion", timeout_seconds=0.03
        )
        error_type = CatalogLookupUnavailableError
        argument = "hoodie"
    else:
        client = McpOrderLookupClient(
            context_assertion="synthetic.assertion", timeout_seconds=0.03
        )
        error_type = OrderLookupUnavailableError
        argument = "ORDER-123"

    with pytest.raises(error_type) as captured:
        await asyncio.wait_for(getattr(client, method)(argument), timeout=1)
    assert "synthetic.assertion" not in str(captured.value)
    assert argument not in str(captured.value)

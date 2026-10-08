"""Every Agent Runtime MCP client must use the configured Gateway endpoint."""

import pytest
from pydantic import ValidationError

from agent_runtime.integrations.gateway_settings import GatewayMcpSettings
from agent_runtime.integrations.order_lookup import McpOrderLookupClient
from agent_runtime.integrations.product_catalog import McpProductCatalogClient
from agent_runtime.integrations.recent_orders import McpRecentOrdersClient


@pytest.mark.parametrize(
    "client_class",
    [McpOrderLookupClient, McpProductCatalogClient, McpRecentOrdersClient],
)
def test_gateway_endpoint_comes_from_environment(monkeypatch, client_class):
    monkeypatch.setenv(
        "INTEGRATION_GATEWAY_MCP_URL", "http://gateway.internal:3002/mcp"
    )

    client = client_class(context_assertion="signed-context")

    assert client._endpoint == "http://gateway.internal:3002/mcp"


@pytest.mark.parametrize(
    "client_class",
    [McpOrderLookupClient, McpProductCatalogClient, McpRecentOrdersClient],
)
def test_explicit_endpoint_still_overrides_configuration(monkeypatch, client_class):
    monkeypatch.setenv(
        "INTEGRATION_GATEWAY_MCP_URL", "http://gateway.internal:3002/mcp"
    )

    client = client_class(
        context_assertion="signed-context", endpoint="http://test-gateway:3002/mcp"
    )

    assert client._endpoint == "http://test-gateway:3002/mcp"


@pytest.mark.parametrize(
    "bad_endpoint",
    [
        "not-a-url",
        "http://gateway.internal:3002/other",
        "http://user:secret@gateway.internal:3002/mcp",
        "http://gateway.internal:3002/mcp?token=secret",
        "http://gateway.internal:0/mcp",
    ],
)
def test_invalid_gateway_endpoint_fails_configuration(monkeypatch, bad_endpoint):
    monkeypatch.setenv("INTEGRATION_GATEWAY_MCP_URL", bad_endpoint)

    with pytest.raises(ValidationError):
        GatewayMcpSettings()

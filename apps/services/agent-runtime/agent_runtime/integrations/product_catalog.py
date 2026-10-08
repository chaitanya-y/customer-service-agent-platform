from __future__ import annotations

import asyncio
from typing import Literal, Protocol

import httpx
from cso_observability import TelemetryRuntime
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from agent_runtime.integrations.gateway_settings import configured_gateway_mcp_endpoint
from agent_runtime.observability import telemetry_runtime

CONTEXT_ASSERTION_HEADER = "x-cso-context-assertion"


class CatalogContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class ProductPrice(CatalogContractModel):
    amount_minor: int = Field(ge=0, le=9_007_199_254_740_991)
    currency: str = Field(pattern=r"^[A-Z]{3}$")


class ProductVariant(CatalogContractModel):
    name: str = Field(min_length=1, max_length=300)
    price: ProductPrice | None = None
    availability: Literal["IN_STOCK", "OUT_OF_STOCK"] | None = None


class ProductMatch(CatalogContractModel):
    name: str = Field(min_length=1, max_length=300)
    description: str = Field(max_length=4_000)
    variants: list[ProductVariant] = Field(max_length=100)
    availability: Literal["IN_STOCK", "OUT_OF_STOCK"] | None = None


class ProductCatalogResult(CatalogContractModel):
    schema_version: Literal[1]
    matches: list[ProductMatch] = Field(max_length=5)


class ProductCatalogLookup(Protocol):
    async def lookup_product_catalog(self, query: str) -> ProductCatalogResult: ...


class CatalogLookupError(RuntimeError):
    pass


class CatalogLookupUnauthorizedError(CatalogLookupError):
    def __init__(self) -> None:
        super().__init__("Trusted context is required")


class CatalogLookupUnavailableError(CatalogLookupError):
    def __init__(self) -> None:
        super().__init__("Product catalog is unavailable")


class InvalidProductCatalogError(CatalogLookupError):
    def __init__(self) -> None:
        super().__init__("Product catalog returned an invalid response")


def _error_from_result(result: CallToolResult) -> CatalogLookupError:
    payload = result.structuredContent
    error = payload.get("error") if isinstance(payload, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    if code == "context_unauthorized":
        return CatalogLookupUnauthorizedError()
    return CatalogLookupUnavailableError()


class McpProductCatalogClient:
    def __init__(
        self,
        *,
        context_assertion: str,
        endpoint: str | None = None,
        timeout_seconds: float = 10.0,
        telemetry: TelemetryRuntime | None = None,
    ) -> None:
        assertion = context_assertion.strip()
        if not assertion or len(assertion) > 8_192:
            raise ValueError("context_assertion is invalid")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self._context_assertion = assertion
        self._endpoint = (
            endpoint if endpoint is not None else configured_gateway_mcp_endpoint()
        )
        self._timeout_seconds = timeout_seconds
        self._telemetry = telemetry if telemetry is not None else telemetry_runtime

    async def lookup_product_catalog(self, query: str) -> ProductCatalogResult:
        search = query.strip()
        if not search or len(search) > 200:
            raise ValueError("query must be between 1 and 200 characters")
        return await self._lookup(search)

    async def _lookup(self, query: str) -> ProductCatalogResult:
        try:
            async with (
                asyncio.timeout(self._timeout_seconds),
                httpx.AsyncClient(
                    timeout=self._timeout_seconds,
                    headers={
                        **self._telemetry.trace_headers(),
                        CONTEXT_ASSERTION_HEADER: self._context_assertion,
                    },
                ) as http_client,
                streamable_http_client(
                    self._endpoint,
                    http_client=http_client,
                ) as (read_stream, write_stream, _),
                ClientSession(read_stream, write_stream) as session,
            ):
                await session.initialize()
                result = await session.call_tool(
                    "lookup_product_catalog", {"query": query}
                )
        except Exception as error:
            raise CatalogLookupUnavailableError() from error

        if result.isError:
            raise _error_from_result(result)
        if result.structuredContent is None:
            raise InvalidProductCatalogError()
        try:
            return ProductCatalogResult.model_validate(result.structuredContent)
        except ValidationError as error:
            raise InvalidProductCatalogError() from error

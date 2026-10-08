"""Strict read-only gateway client for the signed recent-order reference page."""

import asyncio
from datetime import datetime
from itertools import pairwise
from typing import Literal, Protocol

import httpx
from cso_observability import TelemetryRuntime
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    ValidationError,
    model_validator,
)
from pydantic.alias_generators import to_camel

from agent_runtime.integrations.gateway_settings import configured_gateway_mcp_endpoint
from agent_runtime.observability import telemetry_runtime

CONTEXT_ASSERTION_HEADER = "x-cso-context-assertion"


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=False,
        extra="forbid",
        str_strip_whitespace=True,
    )


class RecentOrderReference(ContractModel):
    reference: str = Field(
        min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
    )
    placed_at: AwareDatetime


class RecentOrderReferences(ContractModel):
    schema_version: Literal["1"]
    orders: list[RecentOrderReference] = Field(max_length=10)
    has_more: StrictBool

    @model_validator(mode="after")
    def unique_descending_page(self) -> "RecentOrderReferences":
        if self.has_more and len(self.orders) != 10:
            raise ValueError("Partial page is invalid")
        if len({order.reference for order in self.orders}) != len(self.orders):
            raise ValueError("Duplicate order references")
        dates: list[datetime] = [order.placed_at for order in self.orders]
        if any(previous < current for previous, current in pairwise(dates)):
            raise ValueError("Order page is not newest first")
        return self


class RecentOrdersLookup(Protocol):
    async def lookup_recent_order_references(self) -> RecentOrderReferences: ...


class RecentOrdersUnavailableError(RuntimeError):
    """No customer order fact may be inferred from this failure."""


class McpRecentOrdersClient:
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

    async def lookup_recent_order_references(self) -> RecentOrderReferences:
        with self._telemetry.operation("mcp.lookup_recent_order_references"):
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
                    streamable_http_client(self._endpoint, http_client=http_client) as (
                        read_stream,
                        write_stream,
                        _,
                    ),
                    ClientSession(read_stream, write_stream) as session,
                ):
                    await session.initialize()
                    result = await session.call_tool(
                        "lookup_recent_order_references", {}
                    )
                if result.isError or result.structuredContent is None:
                    raise RecentOrdersUnavailableError()
                return RecentOrderReferences.model_validate(result.structuredContent)
            except (ValidationError, RecentOrdersUnavailableError) as error:
                raise RecentOrdersUnavailableError() from error
            except Exception as error:
                raise RecentOrdersUnavailableError() from error

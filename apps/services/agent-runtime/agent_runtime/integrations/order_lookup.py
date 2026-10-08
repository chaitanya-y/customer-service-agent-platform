import asyncio
from typing import Annotated, Literal, Protocol

import httpx
from cso_observability import TelemetryRuntime
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    ValidationError,
    field_validator,
)
from pydantic.alias_generators import to_camel

from agent_runtime.integrations.gateway_settings import configured_gateway_mcp_endpoint
from agent_runtime.observability import telemetry_runtime

OpaqueId = Annotated[
    str,
    Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    ),
]
Currency = Annotated[str, Field(pattern=r"^[A-Z]{3}$")]
CONTEXT_ASSERTION_HEADER = "x-cso-context-assertion"


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class Money(ContractModel):
    amount_minor: int = Field(ge=0, le=9_007_199_254_740_991)
    currency: Currency


class OrderSource(ContractModel):
    provider: str = Field(min_length=1, max_length=80)
    order_id: OpaqueId
    facts_version: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")


class CustomerRef(ContractModel):
    customer_id: OpaqueId


class OrderItem(ContractModel):
    item_id: OpaqueId
    sku: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=300)
    quantity: int = Field(ge=0)
    ordered_quantity: StrictInt | None = Field(
        default=None, ge=1, exclude_if=lambda value: value is None
    )
    unit_price: Money
    line_total: Money

    @field_validator("ordered_quantity", mode="before")
    @classmethod
    def reject_null_ordered_quantity(cls, value: object) -> object:
        if value is None:
            raise ValueError("orderedQuantity must be omitted when unavailable")
        return value


class Payment(ContractModel):
    payment_id: OpaqueId
    status: str = Field(min_length=1, max_length=80)
    amount: Money
    method: str = Field(min_length=1, max_length=120)


class Fulfillment(ContractModel):
    fulfillment_id: OpaqueId
    status: str = Field(min_length=1, max_length=80)
    method: str = Field(min_length=1, max_length=120)
    tracking_code: str | None = Field(max_length=160)


class OrderContext(ContractModel):
    schema_version: Literal["1"]
    observation_id: OpaqueId
    observed_at: AwareDatetime
    source: OrderSource
    reference: str = Field(min_length=1, max_length=100)
    status: str = Field(min_length=1, max_length=80)
    active: bool
    placed_at: AwareDatetime | None
    customer_ref: CustomerRef | None
    total: Money
    items: list[OrderItem]
    payments: list[Payment]
    fulfillments: list[Fulfillment]


class StatusFulfillment(ContractModel):
    status: str = Field(min_length=1, max_length=80)
    tracking_code: str | None = Field(max_length=160)


class OrderStatus(ContractModel):
    schema_version: Literal["1"]
    reference: str = Field(min_length=1, max_length=100)
    status: str = Field(min_length=1, max_length=80)
    fulfillments: list[StatusFulfillment]


class OrderItemsItem(ContractModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=300)
    quantity: StrictInt = Field(ge=1, le=10_000)


class OrderItems(ContractModel):
    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_name=False, extra="forbid"
    )

    schema_version: Literal["1"]
    reference: str = Field(min_length=1, max_length=100)
    items: list[OrderItemsItem] = Field(min_length=1, max_length=20)


class OrderTotalMoney(ContractModel):
    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_name=False, extra="forbid", strict=True
    )
    amount_minor: StrictInt = Field(ge=0, le=9_007_199_254_740_991)
    currency: Literal["USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "KWD"]


class OrderTotal(ContractModel):
    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_name=False, extra="forbid", strict=True
    )
    schema_version: Literal["1"]
    reference: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9-]{0,99}$")
    total: OrderTotalMoney


class OrderTotalLookup(Protocol):
    async def lookup_order_total(self, order_reference: str) -> OrderTotal: ...


class PaymentStatus(ContractModel):
    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_name=False, extra="forbid", strict=True
    )

    schema_version: Literal["1"]
    reference: str = Field(min_length=1, max_length=100)
    payment_status: Literal[
        "PAID", "PARTIALLY_PAID", "AUTHORIZED", "DECLINED", "NOT_RECORDED", "UNCERTAIN"
    ]
    refund_status: Literal[
        "NONE",
        "PENDING",
        "PARTIALLY_REFUNDED",
        "PARTIALLY_REFUNDED_WITH_PENDING",
        "REFUNDED",
        "FAILED",
        "UNCERTAIN",
    ]


class OrderLookup(Protocol):
    async def lookup_order(self, order_reference: str) -> OrderContext: ...


class OrderStatusLookup(Protocol):
    async def lookup_order_status(self, order_reference: str) -> OrderStatus: ...


class OrderItemsLookup(Protocol):
    async def lookup_order_items(self, order_reference: str) -> OrderItems: ...


class PaymentStatusLookup(Protocol):
    async def lookup_payment_status(self, order_reference: str) -> PaymentStatus: ...


class OrderLookupError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class OrderNotFoundError(OrderLookupError):
    def __init__(self, message: str = "Order was not found") -> None:
        super().__init__("order_not_found", message)


class OrderLookupUnavailableError(OrderLookupError):
    def __init__(self, message: str = "Order lookup is unavailable") -> None:
        super().__init__("order_lookup_unavailable", message)


class OrderLookupUnauthorizedError(OrderLookupError):
    def __init__(self, message: str = "Trusted context is required") -> None:
        super().__init__("context_unauthorized", message)


class InvalidOrderContextError(OrderLookupError):
    def __init__(self) -> None:
        super().__init__(
            "invalid_order_context",
            "Order lookup returned an invalid response",
        )


def _error_from_result(result: CallToolResult) -> OrderLookupError:
    payload = result.structuredContent
    error = payload.get("error") if payload else None

    if not isinstance(error, dict):
        return OrderLookupError(
            "lookup_order_failed",
            "Order lookup failed",
        )

    code = error.get("code")
    message = error.get("message")
    safe_code = code if isinstance(code, str) else "lookup_order_failed"
    safe_message = message if isinstance(message, str) else "Order lookup failed"

    if safe_code == "order_not_found":
        return OrderNotFoundError(safe_message)

    if safe_code == "commerce_provider_unavailable":
        return OrderLookupUnavailableError()

    if safe_code == "context_unauthorized":
        return OrderLookupUnauthorizedError()

    return OrderLookupError(safe_code, safe_message)


class McpOrderLookupClient:
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

        self._context_assertion = assertion
        self._endpoint = (
            endpoint if endpoint is not None else configured_gateway_mcp_endpoint()
        )
        self._timeout_seconds = timeout_seconds
        self._telemetry = telemetry if telemetry is not None else telemetry_runtime

    async def lookup_order(self, order_reference: str) -> OrderContext:
        with self._telemetry.operation("mcp.lookup_order"):
            return await self._lookup_order(order_reference)

    async def lookup_order_status(self, order_reference: str) -> OrderStatus:
        with self._telemetry.operation("mcp.lookup_order"):
            return await self._lookup_order_status(order_reference)

    async def lookup_order_items(self, order_reference: str) -> OrderItems:
        with self._telemetry.operation("mcp.lookup_order"):
            return await self._lookup_order_items(order_reference)

    async def lookup_order_total(self, order_reference: str) -> OrderTotal:
        reference = order_reference.strip()
        if not reference or len(reference) > 100:
            raise ValueError("order_reference is invalid")
        with self._telemetry.operation("mcp.lookup_order"):
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
                        "lookup_order_total", {"orderReference": reference}
                    )
            except OrderLookupError:
                raise
            except Exception as error:
                raise OrderLookupUnavailableError() from error
            if result.isError:
                raise _error_from_result(result)
            try:
                projection = OrderTotal.model_validate(result.structuredContent)
            except ValidationError as error:
                raise InvalidOrderContextError() from error
            if projection.reference != reference:
                raise InvalidOrderContextError()
            return projection

    async def lookup_payment_status(self, order_reference: str) -> PaymentStatus:
        with self._telemetry.operation("mcp.lookup_order"):
            return await self._lookup_payment_status(order_reference)

    async def _lookup_payment_status(self, order_reference: str) -> PaymentStatus:
        reference = order_reference.strip()
        if not reference or len(reference) > 100:
            raise ValueError("order_reference is invalid")

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
                    "lookup_payment_status", {"orderReference": reference}
                )
        except OrderLookupError:
            raise
        except Exception as error:
            raise OrderLookupUnavailableError() from error

        if result.isError:
            raise _error_from_result(result)
        if result.structuredContent is None:
            raise InvalidOrderContextError
        try:
            return PaymentStatus.model_validate(result.structuredContent)
        except ValidationError as error:
            raise InvalidOrderContextError from error

    async def _lookup_order_items(self, order_reference: str) -> OrderItems:
        reference = order_reference.strip()
        if not reference or len(reference) > 100:
            raise ValueError("order_reference is invalid")

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
                    "lookup_order_items", {"orderReference": reference}
                )
        except OrderLookupError:
            raise
        except Exception as error:
            raise OrderLookupUnavailableError() from error

        if result.isError:
            raise _error_from_result(result)
        if result.structuredContent is None:
            raise InvalidOrderContextError
        try:
            return OrderItems.model_validate(result.structuredContent)
        except ValidationError as error:
            raise InvalidOrderContextError from error

    async def _lookup_order_status(self, order_reference: str) -> OrderStatus:
        reference = order_reference.strip()
        if not reference:
            raise ValueError("order_reference is required")

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
                    "lookup_order_status",
                    {"orderReference": reference},
                )
        except OrderLookupError:
            raise
        except Exception as error:
            raise OrderLookupUnavailableError() from error

        if result.isError:
            raise _error_from_result(result)
        if result.structuredContent is None:
            raise InvalidOrderContextError
        try:
            return OrderStatus.model_validate(result.structuredContent)
        except ValidationError as error:
            raise InvalidOrderContextError from error

    async def _lookup_order(self, order_reference: str) -> OrderContext:
        reference = order_reference.strip()

        if not reference:
            raise ValueError("order_reference is required")

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
                ClientSession(
                    read_stream,
                    write_stream,
                ) as session,
            ):
                await session.initialize()
                result = await session.call_tool(
                    "lookup_order",
                    {
                        "orderReference": reference,
                    },
                )
        except OrderLookupError:
            raise
        except Exception as error:
            raise OrderLookupUnavailableError() from error

        if result.isError:
            raise _error_from_result(result)

        if result.structuredContent is None:
            raise InvalidOrderContextError

        try:
            order_context = OrderContext.model_validate(result.structuredContent)
        except ValidationError as error:
            raise InvalidOrderContextError from error

        if order_context.reference != reference:
            raise InvalidOrderContextError()
        return order_context

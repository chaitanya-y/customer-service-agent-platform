"""Deployment-selectable endpoint for the read-only Integration Gateway MCP clients."""

from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class GatewayMcpSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    integration_gateway_mcp_url: str = Field(
        default="http://127.0.0.1:3002/mcp", min_length=1
    )

    @field_validator("integration_gateway_mcp_url")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        try:
            parsed = urlsplit(value)
            port = parsed.port
        except ValueError as error:
            raise ValueError("Gateway MCP URL is invalid") from error
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path != "/mcp"
            or parsed.query
            or parsed.fragment
            or port is not None
            and port <= 0
        ):
            raise ValueError("Gateway MCP URL must be an HTTP(S) /mcp endpoint")
        return value


def configured_gateway_mcp_endpoint() -> str:
    return GatewayMcpSettings().integration_gateway_mcp_url

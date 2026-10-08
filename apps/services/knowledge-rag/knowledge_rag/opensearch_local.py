import os
import re
import ssl
from collections.abc import Mapping
from urllib.parse import urlsplit

from dotenv import dotenv_values
from opensearchpy import OpenSearch
from opensearchpy.exceptions import ImproperlyConfigured


def create_local_opensearch_client(
    *,
    environment: Mapping[str, str | None] | None = None,
) -> OpenSearch:
    """Keep local defaults; require authenticated, verified TLS remotely.

    The historical name is retained for retrieval and publication callers.
    An injected mapping is isolated from both the process and its .env file.
    """
    values = (
        {**dotenv_values(".env"), **os.environ} if environment is None else environment
    )
    local = values.get("ENVIRONMENT_ID", "local") in {"local", "development"}
    endpoint = values.get("OPENSEARCH_ENDPOINT")
    username = values.get("OPENSEARCH_USERNAME")
    password = values.get("OPENSEARCH_PASSWORD")
    ca_certs = values.get("OPENSEARCH_CA_CERTS")

    if "OPENSEARCH_ENDPOINT" not in values:
        if not local:
            raise ValueError(
                "OPENSEARCH_ENDPOINT is required outside local development"
            )
        endpoint = "http://localhost:9200"

    # urlsplit normalizes some whitespace; reject it before parsing. Never
    # propagate parser errors, which can include sensitive configuration.
    if not endpoint or any(
        character.isspace() or ord(character) < 32 or ord(character) == 127
        for character in endpoint
    ):
        raise ValueError("Invalid OPENSEARCH_ENDPOINT")
    try:
        parsed = urlsplit(endpoint)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        raise ValueError("Invalid OPENSEARCH_ENDPOINT") from None
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or not re.fullmatch(r"[a-zA-Z0-9.-]+", host)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or "?" in endpoint
        or "#" in endpoint
        or parsed.netloc.endswith(":")
        or port == 0
    ):
        raise ValueError("Invalid OPENSEARCH_ENDPOINT")

    if parsed.scheme == "http":
        if not local or host != "localhost" or port != 9200:
            raise ValueError(
                "OpenSearch requires HTTPS outside localhost:9200 development"
            )
        if username is not None or password is not None or ca_certs is not None:
            raise ValueError("Credentials and CA settings require HTTPS")
        return OpenSearch(hosts=[{"host": "localhost", "port": 9200}], use_ssl=False)

    if (
        not username
        or not username.strip()
        or not password
        or not password.strip()
        or ":" in username
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in username + password
        )
    ):
        raise ValueError(
            "Valid OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD are required"
        )

    try:
        if ca_certs is not None:
            if not ca_certs:
                raise ValueError("A configured CA bundle must not be empty")
            # urllib3 delays CA loading until a request. Validate the configured
            # bundle now so missing or malformed trust roots fail closed.
            ssl.create_default_context(cafile=ca_certs)
        return OpenSearch(
            hosts=[{"host": host, "port": port or 443}],
            use_ssl=True,
            verify_certs=True,
            ssl_assert_hostname=host,
            http_auth=(username, password),
            ca_certs=ca_certs,
        )
    except (ImproperlyConfigured, OSError, ValueError, TypeError):
        # Client configuration errors can contain credential/CA values. Remote
        # authorization is checked by the server on use, never by falling back.
        raise ValueError("Unable to configure secure OpenSearch client") from None

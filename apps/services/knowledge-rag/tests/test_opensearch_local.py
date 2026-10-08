import base64
import ssl

import pytest

from knowledge_rag.opensearch_local import create_local_opensearch_client


@pytest.mark.parametrize("environment_id", [None, "local", "development"])
def test_local_defaults_remain_plaintext_loopback(environment_id):
    environment = {} if environment_id is None else {"ENVIRONMENT_ID": environment_id}
    client = create_local_opensearch_client(environment=environment)
    connection = client.transport.get_connection()
    assert connection.hostname == "localhost"
    assert connection.port == 9200
    assert connection.use_ssl is False
    assert "authorization" not in connection.headers
    client.close()


@pytest.mark.parametrize("environment_id", ["production", "staging", "", "test"])
def test_nonlocal_environment_requires_explicit_endpoint(environment_id):
    with pytest.raises(ValueError):
        create_local_opensearch_client(environment={"ENVIRONMENT_ID": environment_id})


def test_remote_uses_verified_https_and_basic_auth():
    client = create_local_opensearch_client(
        environment={
            "ENVIRONMENT_ID": "production",
            "OPENSEARCH_ENDPOINT": "https://search.example.com:9443",
            "OPENSEARCH_USERNAME": "rag-reader",
            "OPENSEARCH_PASSWORD": "test-only-password:with-colon",
        }
    )
    connection = client.transport.get_connection()
    assert connection.hostname == "search.example.com"
    assert connection.port == 9443
    assert connection.use_ssl is True
    assert connection.pool.cert_reqs == "CERT_REQUIRED"
    assert connection.pool.assert_hostname is not False
    expected = base64.b64encode(b"rag-reader:test-only-password:with-colon").decode()
    assert connection.headers["authorization"] == f"Basic {expected}"
    client.close()


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://search.example.com:9200",
        "http://127.0.0.1:9200",
        "http://localhost:9201",
        "https://",
        "search.example.com",
        "https://user:test-secret@search.example.com",
        "https://search.example.com/index",
        "https://search.example.com?secret=test-secret",
        "https://search.example.com#secret",
        "https://search.example.com:bad",
        "https://search.example.com:0",
        "https://search.example.com:65536",
        "",
        " https://search.example.com",
        "https://search.example.com\n",
        "https://bad host",
        "https://[invalid",
        "\x00https://search.example.com",
        "https://search.example.com:",
    ],
)
def test_invalid_endpoints_fail_without_echoing_configuration(endpoint, caplog):
    with pytest.raises(ValueError) as error:
        create_local_opensearch_client(
            environment={
                "OPENSEARCH_ENDPOINT": endpoint,
                "OPENSEARCH_USERNAME": "rag-reader",
                "OPENSEARCH_PASSWORD": "test-secret",
            }
        )
    assert "test-secret" not in str(error.value)
    assert "test-secret" not in caplog.text
    assert error.value.__suppress_context__ or error.value.__context__ is None


@pytest.mark.parametrize(
    "credentials",
    [
        {},
        {"OPENSEARCH_USERNAME": "reader"},
        {"OPENSEARCH_PASSWORD": "test-secret"},
        {"OPENSEARCH_USERNAME": "", "OPENSEARCH_PASSWORD": "test-secret"},
        {"OPENSEARCH_USERNAME": "reader", "OPENSEARCH_PASSWORD": "   "},
        {"OPENSEARCH_USERNAME": "reader:admin", "OPENSEARCH_PASSWORD": "test-secret"},
        {"OPENSEARCH_USERNAME": "reader", "OPENSEARCH_PASSWORD": "test-secret\n"},
    ],
)
def test_remote_rejects_missing_or_malformed_credentials(credentials):
    with pytest.raises(ValueError) as error:
        create_local_opensearch_client(
            environment={
                "OPENSEARCH_ENDPOINT": "https://search.example.com",
                **credentials,
            }
        )
    assert "test-secret" not in str(error.value)


def test_explicit_local_http_is_allowed_only_in_local_development():
    client = create_local_opensearch_client(
        environment={
            "ENVIRONMENT_ID": "development",
            "OPENSEARCH_ENDPOINT": "http://localhost:9200",
        }
    )
    assert client.transport.get_connection().use_ssl is False
    client.close()
    with pytest.raises(ValueError):
        create_local_opensearch_client(
            environment={
                "ENVIRONMENT_ID": "production",
                "OPENSEARCH_ENDPOINT": "http://localhost:9200",
            }
        )


@pytest.mark.parametrize("endpoint", [None, "http://localhost:9200"])
def test_plaintext_local_rejects_credentials(endpoint):
    environment = {
        "OPENSEARCH_USERNAME": "reader",
        "OPENSEARCH_PASSWORD": "test-secret",
    }
    if endpoint is not None:
        environment["OPENSEARCH_ENDPOINT"] = endpoint
    with pytest.raises(ValueError):
        create_local_opensearch_client(environment=environment)


def test_configured_ca_bundle_preserves_certificate_verification():
    import certifi

    client = create_local_opensearch_client(
        environment={
            "OPENSEARCH_ENDPOINT": "https://search.example.com",
            "OPENSEARCH_USERNAME": "reader",
            "OPENSEARCH_PASSWORD": "test-secret",
            "OPENSEARCH_CA_CERTS": certifi.where(),
        }
    )
    connection = client.transport.get_connection()
    assert connection.port == 443
    assert connection.pool.ca_certs == certifi.where()
    assert connection.pool.cert_reqs in ("CERT_REQUIRED", ssl.CERT_REQUIRED)
    client.close()


def test_missing_ca_bundle_fails_without_echoing_path():
    with pytest.raises(ValueError) as error:
        create_local_opensearch_client(
            environment={
                "OPENSEARCH_ENDPOINT": "https://search.example.com",
                "OPENSEARCH_USERNAME": "reader",
                "OPENSEARCH_PASSWORD": "test-secret",
                "OPENSEARCH_CA_CERTS": "/nonexistent/test-secret.pem",
            }
        )
    assert "test-secret" not in str(error.value)


@pytest.mark.parametrize("ca_value", ["", "invalid-pem"])
def test_invalid_ca_bundle_fails_closed(ca_value, tmp_path):
    ca_path = tmp_path / "bad-ca.pem"
    ca_path.write_text("not a certificate")
    with pytest.raises(ValueError):
        create_local_opensearch_client(
            environment={
                "OPENSEARCH_ENDPOINT": "https://search.example.com",
                "OPENSEARCH_USERNAME": "reader",
                "OPENSEARCH_PASSWORD": "test-secret",
                "OPENSEARCH_CA_CERTS": str(ca_path) if ca_value else "",
            }
        )


def test_dotenv_configuration_is_loaded_without_exporting_secrets(
    tmp_path, monkeypatch
):
    # Only synthetic credentials; the factory must not mutate process environment.
    (tmp_path / ".env").write_text(
        "ENVIRONMENT_ID=production\nOPENSEARCH_ENDPOINT=https://search.example.com\n"
        "OPENSEARCH_USERNAME=reader\nOPENSEARCH_PASSWORD=test-secret\n"
    )
    monkeypatch.chdir(tmp_path)
    for name in (
        "ENVIRONMENT_ID",
        "OPENSEARCH_ENDPOINT",
        "OPENSEARCH_USERNAME",
        "OPENSEARCH_PASSWORD",
        "OPENSEARCH_CA_CERTS",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENSEARCH_ENDPOINT", "https://override.example.com")
    client = create_local_opensearch_client()
    assert client.transport.get_connection().hostname == "override.example.com"
    import os

    assert "OPENSEARCH_PASSWORD" not in os.environ
    client.close()

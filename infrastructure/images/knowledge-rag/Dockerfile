# Use the isolated context staged by verify-knowledge-rag-container.mjs --run.
# Reuse the reviewed Agent Runtime Python manifest and uv version.
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3 AS python-runtime

FROM python-runtime AS build
RUN python -m pip install --no-cache-dir uv==0.11.16
WORKDIR /app/apps/services/knowledge-rag
COPY apps/services/knowledge-rag/pyproject.toml apps/services/knowledge-rag/uv.lock ./
COPY packages/python-observability/pyproject.toml /app/packages/python-observability/pyproject.toml
COPY packages/python-observability/cso_observability /app/packages/python-observability/cso_observability
# Preserve the checked-in lock, including platform-specific ML dependencies.
# No model weights, tokenizer cache, credentials or fixture documents are fetched.
RUN uv sync --frozen --no-dev --no-install-project --no-editable --python /usr/local/bin/python

FROM python-runtime AS runtime
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --home-dir /nonexistent --no-create-home app
WORKDIR /app/apps/services/knowledge-rag
COPY --from=build /app/apps/services/knowledge-rag/.venv ./.venv
COPY apps/services/knowledge-rag/knowledge_rag ./knowledge_rag
ENV PATH="/app/apps/services/knowledge-rag/.venv/bin:${PATH}" \
    PYTHONPATH=/app/apps/services/knowledge-rag \
    PYTHONDONTWRITEBYTECODE=1 \
    CSO_TELEMETRY_ENABLED=false \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1
USER app
# Real startup warms a retriever: requires runtime configuration, OpenSearch,
# and the revision-pinned cross-encoder cache from reranking.py must be
# provisioned separately. Offline defaults make a missing cache fail closed;
# this image neither packages nor downloads model weights. Offline proof skips
# lifespan and does not certify retrieval readiness or deployment suitability.
CMD ["uvicorn", "knowledge_rag.main:app", "--host", "0.0.0.0", "--port", "8000"]

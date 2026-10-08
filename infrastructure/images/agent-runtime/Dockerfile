# Build via tools/local/verify-agent-runtime-container.mjs --run. The script
# stages reviewed inputs only; this is local packaging proof, not deployment.
# Docker Hub library/python tag metadata verified for this manifest digest.
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3 AS python-runtime

FROM python-runtime AS build
RUN python -m pip install --no-cache-dir uv==0.11.16
WORKDIR /app/apps/services/agent-runtime
COPY apps/services/agent-runtime/pyproject.toml apps/services/agent-runtime/uv.lock ./
COPY packages/python-observability/pyproject.toml /app/packages/python-observability/pyproject.toml
COPY packages/python-observability/cso_observability /app/packages/python-observability/cso_observability
# Keep Agent Runtime source at its repository-relative location in the final
# image: refund policy resolves its catalog from __file__ there.
RUN uv sync --frozen --no-dev --no-install-project --no-editable --python /usr/local/bin/python

FROM python-runtime AS runtime
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --home-dir /nonexistent --no-create-home app
WORKDIR /app/apps/services/agent-runtime
COPY --from=build /app/apps/services/agent-runtime/.venv ./.venv
COPY apps/services/agent-runtime/agent_runtime ./agent_runtime
COPY packages/refund-policy/releases.json /app/packages/refund-policy/releases.json
ENV PATH="/app/apps/services/agent-runtime/.venv/bin:${PATH}" \
    PYTHONPATH=/app/apps/services/agent-runtime \
    PYTHONDONTWRITEBYTECODE=1 \
    CSO_TELEMETRY_ENABLED=false
USER app
CMD ["uvicorn", "agent_runtime.main:app", "--host", "0.0.0.0", "--port", "8000"]

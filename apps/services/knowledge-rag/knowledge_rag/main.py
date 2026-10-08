from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from cso_observability import TelemetryRuntime
from fastapi import FastAPI

from . import api as knowledge_api
from .observability import telemetry_runtime as default_telemetry_runtime


def create_app(
    telemetry_runtime: TelemetryRuntime = default_telemetry_runtime,
    *,
    warm_customer_evidence_retriever: Callable[[TelemetryRuntime], object]
    | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            warm_retriever: Callable[[TelemetryRuntime], object] = (
                knowledge_api._get_customer_evidence_retriever
            )
            if warm_customer_evidence_retriever is not None:
                warm_retriever = warm_customer_evidence_retriever
            warm_retriever(telemetry_runtime)
            yield
        finally:
            telemetry_runtime.shutdown()

    application = FastAPI(
        title="Customer Service OS Knowledge/RAG Service",
        lifespan=lifespan,
    )
    application.state.cso_telemetry_runtime = telemetry_runtime
    application.include_router(knowledge_api.router)

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"service": "knowledge-rag", "status": "ok"}

    telemetry_runtime.attach_asgi(application)
    return application


app = create_app()

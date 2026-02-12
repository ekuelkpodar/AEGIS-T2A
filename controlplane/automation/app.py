"""AEGIS-T2A Universal Automation Platform Application."""

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..common.auth.middleware import AuthMiddleware
from ..common.config.settings import get_settings
from ..common.db.database import get_db
from .handlers.automations import router as automation_router
from .services.automation_service import AutomationService

logger = logging.getLogger(__name__)


async def queue_worker(stop_event: asyncio.Event):
    """Background worker that continuously processes queued tasks."""
    db = get_db()

    while not stop_event.is_set():
        try:
            async with db.session() as session:
                service = AutomationService(session=session)
                outcome = await service.process_due_tasks(worker_id="automation-worker", batch_size=25)
                if outcome["processed"] > 0:
                    logger.info(f"Processed queue batch: {outcome}")
        except Exception as exc:
            logger.exception(f"Queue worker failed: {exc}")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            continue


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    db = get_db()

    logger.info(f"Starting Universal Automation Platform v{settings.service_version}")
    await db.connect()

    if settings.environment == "development":
        await db.create_tables()

    stop_event = asyncio.Event()
    worker_task = asyncio.create_task(queue_worker(stop_event))

    logger.info("Universal Automation Platform started")
    yield

    logger.info("Shutting down Universal Automation Platform")
    stop_event.set()
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass

    await db.disconnect()
    logger.info("Universal Automation Platform stopped")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="AEGIS-T2A Universal Automation Platform",
        description="""
        Industry-agnostic AI co-worker automation platform.

        Provides:
        - Flexible action definition, queueing, and triggering framework
        - Role-based task and workflow controls
        - Tamper-evident audit logging for all task lifecycle events
        - Modular integrations for HTTP, database, CRM, ERP, and custom systems
        - GDPR/HIPAA-aware compliance checks with data minimization
        - AI-assisted NLP task interpretation with mandatory human oversight gates
        """,
        version=settings.service_version,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_middleware(AuthMiddleware, settings=settings)
    app.include_router(automation_router, prefix=settings.api_prefix)

    @app.get("/health", tags=["health"])
    async def health_check():
        db = get_db()
        db_health = await db.health_check()

        queue = {"queued": 0, "waiting_review": 0, "running": 0, "failed": 0, "succeeded": 0}
        if db_health["status"] == "healthy":
            try:
                async with db.session() as session:
                    service = AutomationService(session=session)
                    queue = await service.queue_metrics()
            except Exception as exc:
                logger.warning(f"Failed to fetch queue metrics in health check: {exc}")

        return {
            "status": "healthy" if db_health["status"] == "healthy" else "degraded",
            "service": "universal-automation-platform",
            "version": settings.service_version,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "components": {
                "database": db_health,
                "queue": queue,
            },
        }

    @app.get("/ready", tags=["health"])
    async def readiness_check():
        db = get_db()
        db_health = await db.health_check()

        if db_health["status"] != "healthy":
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "reason": "database_unavailable"},
            )

        return {"status": "ready"}

    @app.exception_handler(Exception)
    async def generic_exception_handler(request: Request, exc: Exception):
        logger.exception(f"Unhandled exception: {exc}")
        return JSONResponse(
            status_code=500,
            content={
                "error": "Internal server error",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "controlplane.automation.app:app",
        host=settings.api_host,
        port=settings.api_port + 5,
        reload=settings.debug,
    )

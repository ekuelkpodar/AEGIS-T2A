"""
AEGIS-T2A Approval System Application

FastAPI application for human approval management.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .handlers.approvals import router as approvals_router
from .services.approval_service import get_approval_service
from ..common.config.settings import get_settings
from ..common.db.database import get_db
from ..common.auth.middleware import AuthMiddleware

logger = logging.getLogger(__name__)


async def expire_approvals_task():
    """Background task to expire stale approval requests."""
    while True:
        try:
            service = get_approval_service()
            count = await service.expire_requests()
            if count > 0:
                logger.info(f"Background task expired {count} approval requests")
        except Exception as e:
            logger.error(f"Approval expiration task failed: {e}")

        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle management."""
    settings = get_settings()
    db = get_db()

    logger.info(f"Starting Approval System v{settings.service_version}")
    await db.connect()

    if settings.environment == "development":
        await db.create_tables()

    expiration_task = asyncio.create_task(expire_approvals_task())

    logger.info("Approval System started")
    yield

    logger.info("Shutting down Approval System")
    expiration_task.cancel()
    try:
        await expiration_task
    except asyncio.CancelledError:
        pass

    await db.disconnect()
    logger.info("Approval System stopped")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="AEGIS-T2A Approval System",
        description="""
        Human Approval Management for AEGIS-T2A Control Plane.

        Provides:
        - Approval request creation and management
        - Multi-level escalation workflows
        - Timeout and expiration handling
        - Decision tracking and audit trail
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

    app.include_router(approvals_router, prefix=settings.api_prefix)

    @app.get("/health", tags=["health"])
    async def health_check():
        db = get_db()
        db_health = await db.health_check()

        return {
            "status": "healthy" if db_health["status"] == "healthy" else "degraded",
            "service": "approval-system",
            "version": settings.service_version,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "components": {"database": db_health},
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
        "controlplane.approval.app:app",
        host=settings.api_host,
        port=settings.api_port + 4,
        reload=settings.debug,
    )

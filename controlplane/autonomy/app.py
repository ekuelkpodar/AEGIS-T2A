"""
AEGIS-T2A Autonomy Manager Application

FastAPI application for lease-based autonomy control.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .handlers.leases import router as leases_router
from .services.lease_service import get_lease_service
from ..common.config.settings import get_settings
from ..common.db.database import get_db
from ..common.auth.middleware import AuthMiddleware

logger = logging.getLogger(__name__)


async def expire_leases_task():
    """Background task to expire stale leases."""
    while True:
        try:
            service = get_lease_service()
            count = await service.expire_leases()
            if count > 0:
                logger.info(f"Background task expired {count} leases")
        except Exception as e:
            logger.error(f"Lease expiration task failed: {e}")

        # Run every minute
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle management."""
    settings = get_settings()
    db = get_db()

    # Startup
    logger.info(f"Starting Autonomy Manager v{settings.service_version}")
    await db.connect()

    # Create tables if they don't exist (for development)
    if settings.environment == "development":
        await db.create_tables()

    # Start background task for lease expiration
    expiration_task = asyncio.create_task(expire_leases_task())

    logger.info("Autonomy Manager started")
    yield

    # Shutdown
    logger.info("Shutting down Autonomy Manager")
    expiration_task.cancel()
    try:
        await expiration_task
    except asyncio.CancelledError:
        pass

    await db.disconnect()
    logger.info("Autonomy Manager stopped")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="AEGIS-T2A Autonomy Manager",
        description="""
        Lease-based Autonomy Control for AEGIS-T2A Control Plane.

        Provides:
        - Time-limited autonomy leases for agents
        - Action and resource scoping
        - Rate limiting and action counting
        - Lease approval workflow
        - Revocation and suspension
        - Real-time autonomy checks
        """,
        version=settings.service_version,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Authentication middleware
    app.add_middleware(AuthMiddleware, settings=settings)

    # Include routers
    app.include_router(leases_router, prefix=settings.api_prefix)

    # Health check endpoints
    @app.get("/health", tags=["health"])
    async def health_check():
        """Basic health check."""
        db = get_db()
        db_health = await db.health_check()

        return {
            "status": "healthy" if db_health["status"] == "healthy" else "degraded",
            "service": "autonomy-manager",
            "version": settings.service_version,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "components": {
                "database": db_health,
            },
        }

    @app.get("/ready", tags=["health"])
    async def readiness_check():
        """Readiness check for Kubernetes."""
        db = get_db()
        db_health = await db.health_check()

        if db_health["status"] != "healthy":
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "reason": "database_unavailable"},
            )

        return {"status": "ready"}

    # Error handlers
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


# Create the application instance
app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "controlplane.autonomy.app:app",
        host=settings.api_host,
        port=settings.api_port + 3,  # Offset port for autonomy manager
        reload=settings.debug,
    )

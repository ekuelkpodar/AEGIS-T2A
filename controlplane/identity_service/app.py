"""
AEGIS-T2A Identity Service Application

FastAPI application for agent identity management.
"""

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .handlers.agents import router as agents_router
from ..common.config.settings import get_settings
from ..common.db.database import get_db
from ..common.auth.middleware import AuthMiddleware

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle management."""
    settings = get_settings()
    db = get_db()

    # Startup
    logger.info(f"Starting Identity Service v{settings.service_version}")
    await db.connect()

    # Create tables if they don't exist (for development)
    if settings.environment == "development":
        await db.create_tables()

    logger.info("Identity Service started")
    yield

    # Shutdown
    logger.info("Shutting down Identity Service")
    await db.disconnect()
    logger.info("Identity Service stopped")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="AEGIS-T2A Identity Service",
        description="""
        Agent Identity Management Service for AEGIS-T2A Control Plane.

        Provides:
        - Agent registration with DID and SPIFFE identity
        - Certificate issuance through HashiCorp Vault PKI
        - SPIFFE workload entry management via SPIRE
        - Key rotation and revocation
        - Identity verification
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
    app.include_router(agents_router, prefix=settings.api_prefix)

    # Health check endpoints
    @app.get("/health", tags=["health"])
    async def health_check():
        """Basic health check."""
        db = get_db()
        db_health = await db.health_check()

        return {
            "status": "healthy" if db_health["status"] == "healthy" else "degraded",
            "service": "identity-service",
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
        "controlplane.identity_service.app:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.debug,
    )

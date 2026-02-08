"""
AEGIS-T2A Policy Engine Application

FastAPI application for OPA-based policy management and evaluation.
"""

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .handlers.policies import router as policies_router
from .handlers.bundles import router as bundles_router
from .services.opa_client import get_opa_client
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
    logger.info(f"Starting Policy Engine v{settings.service_version}")
    await db.connect()

    # Create tables if they don't exist (for development)
    if settings.environment == "development":
        await db.create_tables()

    # Check OPA connection
    opa = get_opa_client()
    health = await opa.health()
    if health["status"] == "healthy":
        logger.info("Connected to OPA")

        # Sync policies on startup
        try:
            from .services.policy_service import get_policy_service
            service = get_policy_service()
            count = await service.sync_all_policies()
            logger.info(f"Synced {count} policies to OPA")
        except Exception as e:
            logger.warning(f"Failed to sync policies on startup: {e}")
    else:
        logger.warning(f"OPA not available: {health}")

    logger.info("Policy Engine started")
    yield

    # Shutdown
    logger.info("Shutting down Policy Engine")
    await opa.close()
    await db.disconnect()
    logger.info("Policy Engine stopped")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="AEGIS-T2A Policy Engine",
        description="""
        OPA-based Policy Enforcement for AEGIS-T2A Control Plane.

        Provides:
        - Policy CRUD with versioning
        - Real-time policy evaluation via OPA
        - Policy lifecycle management (draft, active, deprecated)
        - Pattern-based policy matching
        - Deny/Allow/Require-Approval decisions
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
    app.include_router(policies_router, prefix=settings.api_prefix)
    app.include_router(bundles_router, prefix=settings.api_prefix)

    # Health check endpoints
    @app.get("/health", tags=["health"])
    async def health_check():
        """Basic health check."""
        db = get_db()
        db_health = await db.health_check()

        opa = get_opa_client()
        opa_health = await opa.health()

        overall_status = "healthy"
        if db_health["status"] != "healthy":
            overall_status = "degraded"
        if opa_health["status"] != "healthy":
            overall_status = "degraded"

        return {
            "status": overall_status,
            "service": "policy-engine",
            "version": settings.service_version,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "components": {
                "database": db_health,
                "opa": opa_health,
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

        opa = get_opa_client()
        opa_health = await opa.health()

        if opa_health["status"] != "healthy":
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "reason": "opa_unavailable"},
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
        "controlplane.policyengine.app:app",
        host=settings.api_host,
        port=settings.api_port + 2,  # Offset port for policy engine
        reload=settings.debug,
    )

"""
AEGIS-T2A Event Store Application

FastAPI application for the compliance event store.
"""

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .handlers.events import router as events_router
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
    logger.info(f"Starting Event Store v{settings.service_version}")
    await db.connect()

    # Create tables if they don't exist (for development)
    if settings.environment == "development":
        await db.create_tables()

    # Initialize S3 bucket if configured
    if settings.s3_bucket:
        try:
            from .services.s3_storage import get_s3_storage
            storage = get_s3_storage()
            await storage.create_bucket_if_not_exists()
            logger.info("S3 storage initialized")
        except Exception as e:
            logger.warning(f"S3 storage not available: {e}")

    logger.info("Event Store started")
    yield

    # Shutdown
    logger.info("Shutting down Event Store")
    await db.disconnect()
    logger.info("Event Store stopped")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="AEGIS-T2A Event Store",
        description="""
        Compliance Event Store for AEGIS-T2A Control Plane.

        Provides:
        - Immutable, append-only event logging
        - Hash-chained events for tamper detection
        - Merkle tree proofs for auditing
        - Event export and verification
        - S3 storage for large payloads with Object Lock
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
    app.include_router(events_router, prefix=settings.api_prefix)

    # Health check endpoints
    @app.get("/health", tags=["health"])
    async def health_check():
        """Basic health check."""
        db = get_db()
        db_health = await db.health_check()

        components = {
            "database": db_health,
        }

        # Check S3 if configured
        if settings.s3_bucket:
            try:
                from .services.s3_storage import get_s3_storage
                storage = get_s3_storage()
                # Try to list bucket (fast operation)
                storage.client.head_bucket(Bucket=settings.s3_bucket)
                components["s3"] = {"status": "healthy"}
            except Exception as e:
                components["s3"] = {"status": "unhealthy", "error": str(e)}

        overall_status = "healthy"
        if db_health["status"] != "healthy":
            overall_status = "degraded"
        if "s3" in components and components["s3"]["status"] != "healthy":
            overall_status = "degraded"

        return {
            "status": overall_status,
            "service": "event-store",
            "version": settings.service_version,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "components": components,
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

    @app.get("/metrics", tags=["monitoring"])
    async def metrics():
        """Prometheus-compatible metrics endpoint."""
        from .services.event_service import get_event_service

        service = get_event_service()
        stats = await service.get_stats()

        metrics_lines = [
            "# HELP aegis_eventstore_total_events Total number of events",
            "# TYPE aegis_eventstore_total_events counter",
            f"aegis_eventstore_total_events {stats.get('total_events', 0)}",
            "",
            "# HELP aegis_eventstore_chain_valid Whether the chain is valid",
            "# TYPE aegis_eventstore_chain_valid gauge",
            f"aegis_eventstore_chain_valid {1 if stats.get('chain_valid', True) else 0}",
        ]

        # Add per-type counts
        if "events_by_type" in stats:
            metrics_lines.extend([
                "",
                "# HELP aegis_eventstore_events_by_type Events count by type",
                "# TYPE aegis_eventstore_events_by_type counter",
            ])
            for event_type, count in stats["events_by_type"].items():
                safe_type = event_type.replace(".", "_").replace("-", "_")
                metrics_lines.append(
                    f'aegis_eventstore_events_by_type{{type="{event_type}"}} {count}'
                )

        return "\n".join(metrics_lines) + "\n"

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
        "controlplane.eventstore.app:app",
        host=settings.api_host,
        port=settings.api_port + 1,  # Offset port for event store
        reload=settings.debug,
    )

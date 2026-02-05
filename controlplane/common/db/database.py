"""
AEGIS-T2A Database Module

Async database connection management using SQLAlchemy 2.0.
Supports PostgreSQL with connection pooling and health checks.
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional

from sqlalchemy import MetaData, text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    AsyncEngine,
    create_async_engine,
    async_sessionmaker,
)
from sqlalchemy.orm import DeclarativeBase

from ..config.settings import get_settings, Settings

logger = logging.getLogger(__name__)

# Naming convention for constraints (helps with migrations)
convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""
    metadata = MetaData(naming_convention=convention)


class Database:
    """
    Database connection manager.

    Manages async connection pool and session lifecycle.
    Thread-safe and suitable for use with FastAPI.
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self._engine: Optional[AsyncEngine] = None
        self._session_factory: Optional[async_sessionmaker[AsyncSession]] = None

    @property
    def engine(self) -> AsyncEngine:
        """Get the database engine, creating it if necessary."""
        if self._engine is None:
            self._engine = create_async_engine(
                self.settings.database.url,
                pool_size=self.settings.database.pool_size,
                max_overflow=self.settings.database.max_overflow,
                pool_pre_ping=True,
                echo=self.settings.debug,
            )
        return self._engine

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        """Get the session factory, creating it if necessary."""
        if self._session_factory is None:
            self._session_factory = async_sessionmaker(
                bind=self.engine,
                class_=AsyncSession,
                expire_on_commit=False,
                autoflush=False,
            )
        return self._session_factory

    async def connect(self) -> None:
        """Initialize database connection."""
        logger.info("Connecting to database...")
        # Create engine and verify connection
        async with self.engine.begin() as conn:
            await conn.execute(text("SELECT 1"))
        logger.info("Database connection established")

    async def disconnect(self) -> None:
        """Close database connection."""
        if self._engine:
            logger.info("Disconnecting from database...")
            await self._engine.dispose()
            self._engine = None
            self._session_factory = None
            logger.info("Database connection closed")

    async def health_check(self) -> dict:
        """Check database connectivity and return status."""
        try:
            async with self.engine.begin() as conn:
                result = await conn.execute(text("SELECT 1"))
                result.scalar()
            return {
                "status": "healthy",
                "database": "connected",
                "pool_size": self.engine.pool.size(),
            }
        except Exception as e:
            logger.error(f"Database health check failed: {e}")
            return {
                "status": "unhealthy",
                "database": "disconnected",
                "error": str(e),
            }

    @asynccontextmanager
    async def session(self) -> AsyncGenerator[AsyncSession, None]:
        """
        Get a database session as a context manager.

        Usage:
            async with db.session() as session:
                result = await session.execute(query)
        """
        session = self.session_factory()
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

    async def create_tables(self) -> None:
        """Create all tables defined in models."""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database tables created")

    async def drop_tables(self) -> None:
        """Drop all tables. USE WITH CAUTION."""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        logger.warning("Database tables dropped")


# Global database instance
_db: Optional[Database] = None


def get_db() -> Database:
    """Get the global database instance."""
    global _db
    if _db is None:
        _db = Database()
    return _db


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency for database sessions.

    Usage in FastAPI:
        @app.get("/items")
        async def get_items(session: AsyncSession = Depends(get_session)):
            ...
    """
    db = get_db()
    async with db.session() as session:
        yield session

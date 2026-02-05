"""
AEGIS-T2A Compliance Event Store

Immutable, append-only, hash-chained event storage for
audit trails, compliance, and deterministic replay.
"""

from .app import create_app, app

__all__ = ['create_app', 'app']

"""
AEGIS-T2A Agent Identity Service

Manages agent registration, identity verification, key management,
and certificate/SVID issuance through Vault or SPIRE integration.
"""

from .app import create_app, app

__all__ = ['create_app', 'app']
